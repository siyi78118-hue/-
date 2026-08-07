const PRIVATE_FIELDS = new Set([
  'content', 'prompt', 'messages', 'message', 'memory', 'reply', 'preset',
  'systemPrompt', 'apiKey', 'authorization', 'plaintext'
]);
const DIRECTIONS = new Set(['phone_to_pc', 'pc_to_phone']);
const YUQI_RELAY_VERSION = '2026-07-19.1';
const MAX_RELAY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_KEYS = ['deviceId', 'messageId', 'idempotencyKey', 'direction', 'expiresAt'];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'Content-Type,Authorization,X-Yuqi-Registration'
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function validId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

function validNativeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function identityMatches(a, b) {
  return !!a && !!b && a.deviceId === b.deviceId && a.messageId === b.messageId &&
    a.idempotencyKey === b.idempotencyKey && a.direction === b.direction;
}

function contentMatches(a, b) {
  return !!a && !!b && a.ciphertext === b.ciphertext && a.nonce === b.nonce &&
    a.byteCount === b.byteCount;
}

function identityKey(envelope) {
  return `${envelope.deviceId}:${envelope.idempotencyKey}`;
}

class RelayInputError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function byteLengthFromBase64(value) {
  const text = String(value || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return -1;
  const padding = (text.match(/=+$/)?.[0].length || 0);
  return Math.max(0, Math.floor(text.length * 3 / 4) - padding);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function dayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return match?.[1] || '';
}

function warningLevel(ratio) {
  if (ratio >= 0.9) return 90;
  if (ratio >= 0.75) return 75;
  if (ratio >= 0.5) return 50;
  return 0;
}

function relayStore(env) {
  if (env?.YUQI_RELAY_STORE) return env.YUQI_RELAY_STORE;
  if (!env?.AL_TIMER_DB) throw new Error('AL_TIMER_DB binding is missing');
  return createD1RelayStore(env.AL_TIMER_DB);
}

async function authorize(request, env, deviceId) {
  if (!validId(deviceId)) return false;
  const token = bearerToken(request);
  if (token.length < 16) return false;
  const device = await relayStore(env).getDevice(deviceId);
  if (!device) return false;
  return device.tokenHash === await sha256(token);
}

async function readBody(request) {
  let body;
  try { body = await request.json(); } catch { throw new RelayInputError('invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RelayInputError('invalid body');
  return body;
}

async function handleRegister(request, env) {
  const configured = String(env.RELAY_REGISTRATION_SECRET || '');
  if (!configured || request.headers.get('x-yuqi-registration') !== configured) {
    return json({ ok: false, error: 'registration denied' }, 401);
  }
  const body = await readBody(request);
  const deviceId = String(body.deviceId || '');
  const deviceToken = String(body.deviceToken || '');
  if (!validId(deviceId) || deviceToken.length < 16) return json({ ok: false, error: 'invalid device registration' }, 400);
  const store = relayStore(env);
  const tokenHash = await sha256(deviceToken);
  const existing = await store.getDevice(deviceId);
  if (existing && existing.tokenHash !== tokenHash) return json({ ok: false, error: 'device already registered' }, 409);
  await store.saveDevice({ deviceId, tokenHash, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() });
  return json({ ok: true, deviceId, idempotent: !!existing });
}

async function handleEnqueue(request, env) {
  const body = await readBody(request);
  for (const field of Object.keys(body)) {
    if (PRIVATE_FIELDS.has(field)) return json({ ok: false, error: `plaintext field is forbidden: ${field}` }, 400);
  }
  const deviceId = String(body.deviceId || '');
  if (!await authorize(request, env, deviceId)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!validId(body.messageId) || !validId(body.idempotencyKey) || !DIRECTIONS.has(body.direction)) {
    return json({ ok: false, error: 'invalid envelope identity' }, 400);
  }
  const byteCount = byteLengthFromBase64(body.ciphertext);
  if (byteCount < 1 || byteCount > 512 * 1024 || byteLengthFromBase64(body.nonce) < 1) {
    return json({ ok: false, error: 'invalid encrypted payload' }, 400);
  }
  const expiresAt = Number(body.expiresAt);
  const now = Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 7 * 24 * 60 * 60 * 1000) {
    return json({ ok: false, error: 'invalid expiry' }, 400);
  }
  const saved = await relayStore(env).putEnvelope({
    deviceId,
    messageId: String(body.messageId),
    direction: body.direction,
    ciphertext: String(body.ciphertext),
    nonce: String(body.nonce),
    idempotencyKey: String(body.idempotencyKey),
    byteCount,
    createdAt: now,
    expiresAt
  });
  if (saved?.conflict) return json({ ok: false, error: 'relay identity conflict' }, 409);
  return json({ ok: true, messageId: body.messageId, idempotent: !!saved.idempotent }, saved.idempotent ? 200 : 201);
}

async function handleRefreshExpiry(request, env) {
  const body = await readBody(request);
  if (!hasExactKeys(body, REFRESH_KEYS) ||
      !validNativeId(body.deviceId) || !validNativeId(body.messageId) ||
      !validNativeId(body.idempotencyKey) || typeof body.direction !== 'string' ||
      !DIRECTIONS.has(body.direction) || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= 0) {
    return json({ ok: false, error: 'invalid refresh request' }, 400);
  }
  if (!await authorize(request, env, body.deviceId)) return json({ ok: false, error: 'unauthorized' }, 401);
  const now = Date.now();
  if (body.expiresAt <= now) return json({ ok: false, error: 'invalid expiry' }, 400);
  if (body.expiresAt > now + MAX_RELAY_EXPIRY_MS) return json({ ok: false, error: 'invalid expiry' }, 400);
  const result = await relayStore(env).refreshExpiry(body, now);
  if (result?.conflict) return json({ ok: false, error: 'relay identity conflict' }, 409);
  return json({ ok: true, messageId: body.messageId, expiresAt: result.expiresAt, idempotent: !!result.idempotent }, 200);
}

async function handlePoll(request, env, url) {
  const deviceId = String(url.searchParams.get('deviceId') || '');
  const direction = String(url.searchParams.get('direction') || '');
  if (!await authorize(request, env, deviceId)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!DIRECTIONS.has(direction)) return json({ ok: false, error: 'invalid direction' }, 400);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
  const messages = await relayStore(env).poll(deviceId, direction, Date.now(), limit);
  return json({ ok: true, messages });
}

async function handleAck(request, env) {
  const body = await readBody(request);
  const deviceId = String(body.deviceId || '');
  if (!await authorize(request, env, deviceId)) return json({ ok: false, error: 'unauthorized' }, 401);
  const messageIds = Array.isArray(body.messageIds) ? [...new Set(body.messageIds.map(String))].slice(0, 100) : [];
  if (!messageIds.length || messageIds.some(id => !validId(id))) return json({ ok: false, error: 'invalid message IDs' }, 400);
  const deleted = await relayStore(env).ack(deviceId, messageIds);
  return json({ ok: true, deleted });
}

async function handleQuota(request, env, url) {
  const deviceId = String(url.searchParams.get('deviceId') || '');
  if (!await authorize(request, env, deviceId)) return json({ ok: false, error: 'unauthorized' }, 401);
  const usage = await relayStore(env).usage(deviceId, dayKey());
  const byteBudget = Math.max(1, Number(env.RELAY_DAILY_BYTE_BUDGET) || 10 * 1024 * 1024);
  const writeBudget = Math.max(1, Number(env.RELAY_DAILY_WRITE_BUDGET) || 10_000);
  const ratio = Math.max(usage.bytes / byteBudget, usage.writes / writeBudget);
  return json({
    ok: true,
    date: dayKey(),
    bytes: usage.bytes,
    writes: usage.writes,
    byteBudget,
    writeBudget,
    usageRatio: ratio,
    warningLevel: warningLevel(ratio)
  });
}

async function handleSocket(request, env, url) {
  const deviceId = String(url.searchParams.get('deviceId') || '');
  const direction = String(url.searchParams.get('direction') || '');
  if (!await authorize(request, env, deviceId)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!DIRECTIONS.has(direction) || !env.YUQI_RELAY) return json({ ok: false, error: 'websocket relay unavailable' }, 503);
  const id = env.YUQI_RELAY.idFromName(deviceId);
  return env.YUQI_RELAY.get(id).fetch(request);
}

const relayWorker = {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response('', { headers: CORS });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/bridge/health') {
        return json({ ok: true, service: 'yuqi-relay', version: YUQI_RELAY_VERSION, storage: 'ciphertext-only' });
      }
      if (request.method === 'POST' && url.pathname === '/bridge/register') return await handleRegister(request, env);
      if (request.method === 'POST' && url.pathname === '/bridge/enqueue') return await handleEnqueue(request, env);
      if (request.method === 'POST' && url.pathname === '/bridge/refresh-expiry') return await handleRefreshExpiry(request, env);
      if (request.method === 'GET' && url.pathname === '/bridge/poll') return await handlePoll(request, env, url);
      if (request.method === 'POST' && url.pathname === '/bridge/ack') return await handleAck(request, env);
      if (request.method === 'GET' && url.pathname === '/bridge/quota') return await handleQuota(request, env, url);
      if (request.method === 'GET' && url.pathname === '/bridge/socket') return await handleSocket(request, env, url);
      return json({ ok: false, error: 'not found' }, 404);
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      return json({ ok: false, error: status >= 500 ? 'relay internal error' : String(error?.message || error).slice(0, 200) }, status);
    }
  }
};

export default relayWorker;

export class YuqiRelaySocket {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket upgrade required', { status: 426 });
    }
    const url = new URL(request.url);
    const direction = String(url.searchParams.get('direction') || 'unknown');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [direction]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(webSocket, message) {
    for (const socket of this.state.getWebSockets()) {
      if (socket !== webSocket) {
        try { socket.send(message); } catch {}
      }
    }
  }

  webSocketClose(webSocket, code, reason) {
    try { webSocket.close(code, reason); } catch {}
  }
}

export function createMemoryRelayStore() {
  const devices = new Map();
  const envelopes = new Map();
  const idempotency = new Map();
  const usageRows = new Map();
  function lookup(envelope) {
    const byMessage = envelopes.get(envelope.messageId) || null;
    const indexedMessageId = idempotency.get(identityKey(envelope));
    const byIdempotency = indexedMessageId ? (envelopes.get(indexedMessageId) || null) : null;
    return { byMessage, byIdempotency, indexedMessageId };
  }
  function removeEnvelope(item) {
    envelopes.delete(item.messageId);
    const key = identityKey(item);
    if (idempotency.get(key) === item.messageId) idempotency.delete(key);
  }
  return {
    async getDevice(deviceId) { return devices.get(deviceId) || null; },
    async saveDevice(device) { devices.set(device.deviceId, structuredClone(device)); return device; },
    async putEnvelope(envelope, now = Date.now()) {
      const { byMessage, byIdempotency, indexedMessageId } = lookup(envelope);
      if (indexedMessageId && !byIdempotency) return { conflict: true };
      if (byMessage && byIdempotency && byMessage.messageId !== byIdempotency.messageId) return { conflict: true };
      const existing = byMessage || byIdempotency;
      if (existing) {
        if (!identityMatches(existing, envelope)) return { conflict: true };
        if (existing.expiresAt > now) return contentMatches(existing, envelope) ? { idempotent: true } : { conflict: true };
      }
      const oldMessage = byMessage ? structuredClone(byMessage) : null;
      const oldIndexedMessageId = indexedMessageId || null;
      const usageKey = `${dayKey(envelope.createdAt)}:${envelope.deviceId}`;
      const oldUsage = usageRows.has(usageKey) ? structuredClone(usageRows.get(usageKey)) : null;
      try {
        if (existing) removeEnvelope(existing);
        envelopes.set(envelope.messageId, structuredClone(envelope));
        idempotency.set(identityKey(envelope), envelope.messageId);
        const current = usageRows.get(usageKey) || { bytes: 0, writes: 0 };
        usageRows.set(usageKey, { bytes: current.bytes + Number(envelope.byteCount || 0), writes: current.writes + 1 });
        return { idempotent: false };
      } catch (error) {
        envelopes.delete(envelope.messageId);
        idempotency.delete(identityKey(envelope));
        if (oldMessage) {
          envelopes.set(oldMessage.messageId, oldMessage);
          idempotency.set(identityKey(oldMessage), oldMessage.messageId);
        } else if (oldIndexedMessageId) {
          idempotency.set(identityKey(envelope), oldIndexedMessageId);
        }
        if (oldUsage) usageRows.set(usageKey, oldUsage); else usageRows.delete(usageKey);
        throw error;
      }
    },
    async refreshExpiry(identity, now = Date.now()) {
      const { byMessage, byIdempotency, indexedMessageId } = lookup(identity);
      if (indexedMessageId && !byIdempotency) return { conflict: true };
      if (!byMessage || !byIdempotency || byMessage.messageId !== byIdempotency.messageId || !identityMatches(byMessage, identity)) {
        return { conflict: true };
      }
      if (byMessage.expiresAt <= now) return { conflict: true };
      if (identity.expiresAt <= byMessage.expiresAt) return { idempotent: true, expiresAt: byMessage.expiresAt };
      if (identity.expiresAt > now + MAX_RELAY_EXPIRY_MS) return { conflict: true };
      byMessage.expiresAt = identity.expiresAt;
      return { idempotent: false, expiresAt: byMessage.expiresAt };
    },
    async poll(deviceId, direction, now, limit) {
      return [...envelopes.values()]
        .filter(item => item.deviceId === deviceId && item.direction === direction && item.expiresAt > now)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(item => structuredClone(item));
    },
    async ack(deviceId, messageIds) {
      let deleted = 0;
      for (const id of messageIds) {
        const item = envelopes.get(id);
        if (item?.deviceId === deviceId) { removeEnvelope(item); deleted += 1; }
      }
      return deleted;
    },
    async usage(deviceId, day) { return usageRows.get(`${day}:${deviceId}`) || { bytes: 0, writes: 0 }; }
  };
}

export function createD1RelayStore(db) {
  async function identityRows(identity) {
    const result = await db.prepare(`SELECT message_id, device_id, direction, ciphertext, nonce,
      idempotency_key, byte_count, created_at, expires_at FROM relay_messages
      WHERE message_id = ?1 OR (device_id = ?2 AND idempotency_key = ?3)`)
      .bind(identity.messageId, identity.deviceId, identity.idempotencyKey).all();
    return (result?.results || []).map(row => ({
      messageId: row.message_id, deviceId: row.device_id, direction: row.direction,
      ciphertext: row.ciphertext, nonce: row.nonce, idempotencyKey: row.idempotency_key,
      byteCount: row.byte_count, createdAt: row.created_at, expiresAt: row.expires_at
    }));
  }
  function classifyRows(rows, envelope, now) {
    if (!rows.length) return null;
    const byMessage = rows.find(row => row.messageId === envelope.messageId) || null;
    const byIdempotency = rows.find(row => row.deviceId === envelope.deviceId && row.idempotencyKey === envelope.idempotencyKey) || null;
    if (byMessage && byIdempotency && byMessage.messageId !== byIdempotency.messageId) return { conflict: true };
    const existing = byMessage || byIdempotency;
    if (!existing || !identityMatches(existing, envelope)) return { conflict: true };
    if (existing.expiresAt > now) return contentMatches(existing, envelope) ? { idempotent: true } : { conflict: true };
    return { expiredExact: true };
  }
  return {
    async getDevice(deviceId) {
      const row = await db.prepare('SELECT device_id, token_hash, created_at, updated_at FROM relay_devices WHERE device_id = ?1').bind(deviceId).first();
      return row ? { deviceId: row.device_id, tokenHash: row.token_hash, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },
    async saveDevice(device) {
      await db.prepare(`INSERT INTO relay_devices(device_id, token_hash, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash, updated_at=excluded.updated_at`)
        .bind(device.deviceId, device.tokenHash, device.createdAt, device.updatedAt).run();
      return device;
    },
    async putEnvelope(envelope, now = Date.now()) {
      const rows = await identityRows(envelope);
      const classification = classifyRows(rows, envelope, now);
      if (classification && !classification.expiredExact) return classification;
      if (typeof db.batch !== 'function') throw new Error('D1 transactional batch unavailable');
      const removeExpired = db.prepare(`DELETE FROM relay_messages
        WHERE message_id = ?1 AND device_id = ?2 AND idempotency_key = ?3 AND direction = ?4 AND expires_at <= ?5`)
        .bind(envelope.messageId, envelope.deviceId, envelope.idempotencyKey, envelope.direction, now);
      const insert = db.prepare(`INSERT INTO relay_messages
        (message_id, device_id, direction, ciphertext, nonce, idempotency_key, byte_count, created_at, expires_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
        .bind(envelope.messageId, envelope.deviceId, envelope.direction, envelope.ciphertext, envelope.nonce,
          envelope.idempotencyKey, envelope.byteCount, envelope.createdAt, envelope.expiresAt);
      const usage = db.prepare(`INSERT INTO relay_usage(usage_day, device_id, byte_count, write_count)
        VALUES (?1, ?2, ?3, 1)
        ON CONFLICT(usage_day, device_id) DO UPDATE SET
        byte_count=relay_usage.byte_count+excluded.byte_count, write_count=relay_usage.write_count+1`)
        .bind(dayKey(envelope.createdAt), envelope.deviceId, envelope.byteCount);
      try {
        await db.batch([removeExpired, insert, usage]);
        return { idempotent: false };
      } catch (error) {
        if (!/unique constraint|constraint failed/i.test(String(error?.message || error))) throw error;
        const after = await identityRows(envelope);
        const recovered = classifyRows(after, envelope, now);
        if (recovered?.idempotent) return recovered;
        if (recovered?.conflict && after.some(row => row.expiresAt > now)) return recovered;
        throw error;
      }
    },
    async refreshExpiry(identity, now = Date.now()) {
      const rows = await identityRows(identity);
      const byMessage = rows.find(row => row.messageId === identity.messageId) || null;
      const byIdempotency = rows.find(row => row.deviceId === identity.deviceId && row.idempotencyKey === identity.idempotencyKey) || null;
      if (!byMessage || !byIdempotency || byMessage.messageId !== byIdempotency.messageId || !identityMatches(byMessage, identity)) return { conflict: true };
      const current = byMessage;
      if (current.expiresAt <= now) return { conflict: true };
      if (identity.expiresAt <= current.expiresAt) return { idempotent: true, expiresAt: current.expiresAt };
      if (identity.expiresAt > now + MAX_RELAY_EXPIRY_MS) return { conflict: true };
      const result = await db.prepare(`UPDATE relay_messages SET expires_at = ?1
        WHERE device_id = ?2 AND message_id = ?3 AND idempotency_key = ?4 AND direction = ?5
          AND expires_at > ?6 AND ?1 > expires_at`)
        .bind(identity.expiresAt, identity.deviceId, identity.messageId, identity.idempotencyKey, identity.direction, now).run();
      if (Number(result?.meta?.changes || 0) !== 1) {
        const after = await identityRows(identity);
        const replay = after.find(row => identityMatches(row, identity));
        return replay && replay.expiresAt > now && identity.expiresAt <= replay.expiresAt
          ? { idempotent: true, expiresAt: replay.expiresAt } : { conflict: true };
      }
      return { idempotent: false, expiresAt: identity.expiresAt };
    },
    async poll(deviceId, direction, now, limit) {
      const result = await db.prepare(`SELECT message_id, device_id, direction, ciphertext, nonce,
        idempotency_key, byte_count, created_at, expires_at FROM relay_messages
        WHERE device_id = ?1 AND direction = ?2 AND expires_at > ?3
        ORDER BY created_at ASC LIMIT ?4`).bind(deviceId, direction, now, limit).all();
      return (result?.results || []).map(row => ({
        messageId: row.message_id, deviceId: row.device_id, direction: row.direction,
        ciphertext: row.ciphertext, nonce: row.nonce, idempotencyKey: row.idempotency_key,
        byteCount: row.byte_count, createdAt: row.created_at, expiresAt: row.expires_at
      }));
    },
    async ack(deviceId, messageIds) {
      const placeholders = messageIds.map((_, index) => `?${index + 2}`).join(',');
      const result = await db.prepare(`DELETE FROM relay_messages WHERE device_id = ?1 AND message_id IN (${placeholders})`)
        .bind(deviceId, ...messageIds).run();
      return Number(result?.meta?.changes || 0);
    },
    async usage(deviceId, day) {
      const row = await db.prepare('SELECT byte_count, write_count FROM relay_usage WHERE usage_day = ?1 AND device_id = ?2').bind(day, deviceId).first();
      return { bytes: Number(row?.byte_count || 0), writes: Number(row?.write_count || 0) };
    }
  };
}
