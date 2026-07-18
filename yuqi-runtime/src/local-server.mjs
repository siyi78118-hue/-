import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

function bodyHash(body) {
  return createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

export function signBridgeRequest({ secret, method, path, timestamp, nonce, body = '' }) {
  const canonical = `${timestamp}\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(body)}`;
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createYuqiServer({
  secret,
  store,
  orchestrator,
  reconciler = null,
  clock = Date.now,
  maxBodyBytes = 256 * 1024,
  maxClockSkewMs = 5 * 60 * 1000
}) {
  if (!secret || String(secret).length < 12) throw new Error('pairing secret must contain at least 12 characters');
  if (!store || !orchestrator) throw new Error('store and orchestrator are required');
  const nonces = new Map();

  function purgeNonces(now) {
    for (const [nonce, expiresAt] of nonces) if (expiresAt <= now) nonces.delete(nonce);
  }

  function authenticate(request, rawBody) {
    const timestamp = Number(request.headers['x-yuqi-timestamp']);
    const nonce = String(request.headers['x-yuqi-nonce'] || '');
    const supplied = String(request.headers['x-yuqi-signature'] || '');
    const now = clock();
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxClockSkewMs) {
      return { ok: false, status: 401, error: 'stale request' };
    }
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(nonce)) return { ok: false, status: 401, error: 'invalid nonce' };
    purgeNonces(now);
    if (nonces.has(nonce)) return { ok: false, status: 409, error: 'replayed request' };
    const expected = signBridgeRequest({
      secret,
      method: request.method,
      path: request.url,
      timestamp,
      nonce,
      body: rawBody
    });
    if (!safeEqual(supplied, expected)) return { ok: false, status: 401, error: 'invalid signature' };
    nonces.set(nonce, now + maxClockSkewMs);
    return { ok: true };
  }

  async function handle(request, response, rawBody) {
    if (request.method === 'GET' && request.url === '/v1/health') {
      const roleThreads = Object.fromEntries(['memory', 'brain', 'supervisor'].map(role => [
        role,
        typeof store.getSession === 'function' ? !!store.getSession(role) : false
      ]));
      return json(response, 200, {
        ok: true,
        service: 'yuqi-runtime',
        version: 1,
        roleThreads,
        presetVersion: typeof store.getCurrentPresetVersion === 'function' ? store.getCurrentPresetVersion() : '',
        contextLimit: 200
      });
    }
    const auth = authenticate(request, rawBody);
    if (!auth.ok) return json(response, auth.status, { ok: false, error: auth.error });

    const url = new URL(request.url, 'http://localhost');
    let body = null;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { return json(response, 400, { ok: false, error: 'invalid JSON' }); }
    }

    if (request.method === 'POST' && url.pathname === '/v1/turns') {
      let recoveryAckSeq = 0;
      if (reconciler && body?.recovery && Array.isArray(body.recovery.entries)) {
        const recovery = await reconciler.reconcileFrom(body.recovery);
        recoveryAckSeq = recovery.ackSeq;
      }
      const result = await orchestrator.process(body);
      return json(response, 201, { ok: true, ...result, recoveryAckSeq });
    }
    const turnMatch = /^\/v1\/turns\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && turnMatch) {
      const turn = store.getTurn(decodeURIComponent(turnMatch[1]));
      return turn ? json(response, 200, { ok: true, turn }) : json(response, 404, { ok: false, error: 'turn not found' });
    }
    const cancelMatch = /^\/v1\/turns\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === 'POST' && cancelMatch) {
      const turnId = decodeURIComponent(cancelMatch[1]);
      const cancelled = orchestrator.cancel?.(turnId) === true;
      return cancelled
        ? json(response, 200, { ok: true, turnId, cancelled: true })
        : json(response, 409, { ok: false, error: 'turn cannot be cancelled' });
    }
    if (request.method === 'GET' && url.pathname === '/v1/sync') {
      const after = Number(url.searchParams.get('after') || 0);
      const limit = Number(url.searchParams.get('limit') || 500);
      return json(response, 200, { ok: true, entries: store.getSyncDelta(after, limit) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/sync/ack') {
      if (!body?.peerId || !Number.isSafeInteger(Number(body.seq))) return json(response, 400, { ok: false, error: 'invalid ack' });
      return json(response, 200, { ok: true, ackSeq: store.ackSync(String(body.peerId), Number(body.seq)) });
    }
    return json(response, 404, { ok: false, error: 'not found' });
  }

  const httpServer = createServer((request, response) => {
    const declaredLength = Number(request.headers['content-length'] || 0);
    if (declaredLength > maxBodyBytes) {
      request.resume();
      return json(response, 413, { ok: false, error: 'request body too large' });
    }
    let rawBody = '';
    let received = 0;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      received += Buffer.byteLength(chunk);
      if (received <= maxBodyBytes) rawBody += chunk;
    });
    request.on('end', () => {
      if (received > maxBodyBytes) return json(response, 413, { ok: false, error: 'request body too large' });
      Promise.resolve(handle(request, response, rawBody)).catch(error => {
        if (!response.headersSent) json(response, 500, { ok: false, error: error.message });
        else response.destroy();
      });
    });
  });

  return {
    listen({ host = '127.0.0.1', port = 17891 } = {}) {
      return new Promise((resolve, reject) => {
        const onError = error => { httpServer.off('listening', onListening); reject(error); };
        const onListening = () => { httpServer.off('error', onError); resolve(this); };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },
    address: () => httpServer.address(),
    close() {
      return new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
    },
    raw: httpServer
  };
}
