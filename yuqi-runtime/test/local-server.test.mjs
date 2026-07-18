import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

import { createYuqiServer, signBridgeRequest } from '../src/local-server.mjs';

function call(port, { method = 'GET', path = '/', body = '', secret = '', nonce = 'nonce-1', timestamp = Date.now() }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (secret) {
    headers['x-yuqi-timestamp'] = String(timestamp);
    headers['x-yuqi-nonce'] = nonce;
    headers['x-yuqi-signature'] = signBridgeRequest({ secret, method, path, timestamp, nonce, body: payload });
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('serves health and accepts one signed turn without exposing unsigned APIs', async () => {
  const processed = [];
  const store = {
    getTurn: id => ({ turnId: id, state: 'committed' }),
    getSyncDelta: () => [],
    ackSync: (_peer, seq) => seq
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store,
    orchestrator: { process: async value => { processed.push(value); return { turnId: value.turnId, reply: { content: '收到' } }; } }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const port = server.address().port;
  try {
    const health = await call(port, { path: '/v1/health' });
    assert.equal(health.status, 200);
    assert.equal(health.body.service, 'yuqi-runtime');

    const unsigned = await call(port, { method: 'GET', path: '/v1/turns/turn_1' });
    assert.equal(unsigned.status, 401);

    const payload = { protocolVersion: 1, turnId: 'turn_phone_1' };
    const signed = await call(port, {
      method: 'POST', path: '/v1/turns', body: payload,
      secret: 'test-pairing-secret', nonce: 'unique-nonce'
    });
    assert.equal(signed.status, 201);
    assert.equal(processed.length, 1);

    const replay = await call(port, {
      method: 'POST', path: '/v1/turns', body: payload,
      secret: 'test-pairing-secret', nonce: 'unique-nonce'
    });
    assert.equal(replay.status, 409);
    assert.equal(processed.length, 1);
  } finally {
    await server.close();
  }
});

test('rejects stale, tampered, and oversized requests', async () => {
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    maxBodyBytes: 64,
    clock: () => 1784400000000,
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const port = server.address().port;
  try {
    const stale = await call(port, {
      method: 'GET', path: '/v1/sync?after=0', secret: 'test-pairing-secret',
      timestamp: 1784390000000, nonce: 'stale'
    });
    assert.equal(stale.status, 401);

    const oversized = await call(port, {
      method: 'POST', path: '/v1/turns', body: { data: 'x'.repeat(100) },
      secret: 'test-pairing-secret', timestamp: 1784400000000, nonce: 'large'
    });
    assert.equal(oversized.status, 413);
  } finally {
    await server.close();
  }
});
