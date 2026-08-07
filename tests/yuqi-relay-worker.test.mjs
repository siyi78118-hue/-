import assert from 'node:assert/strict';
import test from 'node:test';

import relayWorker, { createD1RelayStore, createMemoryRelayStore } from '../yuqi-relay-worker.js';

function envFixture(overrides = {}) {
  return {
    YUQI_RELAY_STORE: createMemoryRelayStore(),
    RELAY_REGISTRATION_SECRET: 'registration-secret',
    RELAY_DAILY_BYTE_BUDGET: '1000',
    RELAY_DAILY_WRITE_BUDGET: '100',
    ...overrides
  };
}

function request(path, { method = 'GET', token = '', body, registrationSecret = '' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (registrationSecret) headers['x-yuqi-registration'] = registrationSecret;
  return new Request(`https://relay.example${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function register(env, deviceId = 'device_123456', token = 'device-token-123456789') {
  return jsonResponse(await relayWorker.fetch(request('/bridge/register', {
    method: 'POST',
    registrationSecret: 'registration-secret',
    body: { deviceId, deviceToken: token }
  }), env));
}

function relayEnvelope(overrides = {}) {
  return {
    deviceId: 'device_123456',
    messageId: 'relay_message_1',
    idempotencyKey: 'idem_1',
    direction: 'phone_to_pc',
    ciphertext: 'Y2lwaGVyLWE=',
    nonce: 'bm9uY2U=',
    byteCount: 8,
    createdAt: 100,
    expiresAt: 10_000,
    ...overrides
  };
}

function createFakeD1() {
  const devices = new Map();
  const messages = new Map();
  const usage = new Map();
  let failBatch = false;
  let failInsert = false;
  let failUsage = false;

  function cloneState() {
    return {
      devices: new Map([...devices].map(([key, value]) => [key, structuredClone(value)])),
      messages: new Map([...messages].map(([key, value]) => [key, structuredClone(value)])),
      usage: new Map([...usage].map(([key, value]) => [key, structuredClone(value)]))
    };
  }

  function restoreState(snapshot) {
    devices.clear();
    messages.clear();
    usage.clear();
    for (const [key, value] of snapshot.devices) devices.set(key, value);
    for (const [key, value] of snapshot.messages) messages.set(key, value);
    for (const [key, value] of snapshot.usage) usage.set(key, value);
  }

  function statement(sql, bound = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const values = bound;
    return {
      bind(...next) { return statement(sql, next); },
      async first() {
        if (normalized.startsWith('select device_id')) {
          const row = devices.get(values[0]);
          return row ? structuredClone(row) : null;
        }
        if (normalized.startsWith('select byte_count, write_count')) {
          const row = usage.get(`${values[1]}:${values[0]}`);
          return row ? structuredClone(row) : null;
        }
        if (normalized.startsWith('select message_id')) {
          const row = [...messages.values()].find(item =>
            item.device_id === values[0] && item.message_id === values[1] &&
            item.idempotency_key === values[2] && item.direction === values[3]);
          return row ? structuredClone(row) : null;
        }
        return null;
      },
      async all() {
        if (normalized.startsWith('select message_id')) {
          if (normalized.includes(' or ')) {
            const rows = [...messages.values()].filter(item =>
              item.message_id === values[0] ||
              (item.device_id === values[1] && item.idempotency_key === values[2]));
            return { results: rows.map(row => structuredClone(row)) };
          }
          const rows = [...messages.values()]
            .filter(item => item.device_id === values[0] && item.direction === values[1] && item.expires_at > values[2])
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, values[3]);
          return { results: rows.map(row => structuredClone(row)) };
        }
        return { results: [] };
      },
      async run() {
        if (normalized.startsWith('insert into relay_devices')) {
          devices.set(values[0], {
            device_id: values[0], token_hash: values[1], created_at: values[2], updated_at: values[3]
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.includes('insert') && normalized.includes('relay_messages')) {
          if (failInsert) {
            failInsert = false;
            throw new Error('injected D1 insert failure');
          }
          const row = {
            message_id: values[0], device_id: values[1], direction: values[2], ciphertext: values[3],
            nonce: values[4], idempotency_key: values[5], byte_count: values[6], created_at: values[7], expires_at: values[8]
          };
          const collision = [...messages.values()].some(item =>
            item.message_id === row.message_id ||
            (item.device_id === row.device_id && item.idempotency_key === row.idempotency_key));
          if (collision) {
            if (normalized.includes('insert or ignore')) return { meta: { changes: 0 } };
            throw new Error('UNIQUE constraint failed: relay_messages');
          }
          messages.set(row.message_id, row);
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('insert into relay_usage')) {
          if (failUsage) {
            failUsage = false;
            throw new Error('UNIQUE constraint failed: relay_usage');
          }
          const key = `${values[0]}:${values[1]}`;
          const current = usage.get(key) || { byte_count: 0, write_count: 0 };
          usage.set(key, { byte_count: current.byte_count + values[2], write_count: current.write_count + 1 });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith('delete from relay_messages where expires_at')) {
          let changes = 0;
          for (const [key, row] of messages) {
            if (row.expires_at <= values[0]) { messages.delete(key); changes += 1; }
          }
          return { meta: { changes } };
        }
        if (normalized.startsWith('delete from relay_messages where message_id')) {
          let changes = 0;
          for (const [key, row] of messages) {
            if (row.message_id === values[0] && row.device_id === values[1] &&
                row.idempotency_key === values[2] && row.direction === values[3] && row.expires_at <= values[4]) {
              messages.delete(key);
              changes += 1;
            }
          }
          return { meta: { changes } };
        }
        if (normalized.startsWith('delete from relay_messages where device_id')) {
          let changes = 0;
          const ids = values.slice(1);
          for (const [key, row] of messages) {
            if (row.device_id === values[0] && ids.includes(row.message_id)) { messages.delete(key); changes += 1; }
          }
          return { meta: { changes } };
        }
        if (normalized.startsWith('update relay_messages set expires_at')) {
          const row = [...messages.values()].find(item =>
            item.device_id === values[1] && item.message_id === values[2] &&
            item.idempotency_key === values[3] && item.direction === values[4] && item.expires_at > values[5]);
          if (!row || values[0] <= row.expires_at) return { meta: { changes: 0 } };
          row.expires_at = values[0];
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
    };
  }

  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      const snapshot = cloneState();
      try {
        if (failBatch) {
          failBatch = false;
          throw new Error('injected D1 batch failure');
        }
        const results = [];
        for (const item of statements) results.push(await item.run());
        return results;
      } catch (error) {
        restoreState(snapshot);
        throw error;
      }
    },
    failNextBatch() { failBatch = true; },
    failNextInsert() { failInsert = true; },
    failNextUsage() { failUsage = true; },
    snapshot() { return cloneState(); }
  };
}

test('health check declares the ciphertext-only relay without authentication', async () => {
  const result = await jsonResponse(await relayWorker.fetch(request('/bridge/health'), envFixture()));
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.service, 'yuqi-relay');
  assert.equal(result.body.storage, 'ciphertext-only');
});

test('registers a device but stores only a token hash', async () => {
  const env = envFixture();
  const result = await register(env);
  assert.equal(result.status, 200);
  const stored = await env.YUQI_RELAY_STORE.getDevice('device_123456');
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(stored), /device-token-123456789/);
});

test('persists ciphertext-only envelopes idempotently and rejects plaintext fields', async () => {
  const env = envFixture();
  await register(env);
  const encrypted = {
    deviceId: 'device_123456',
    messageId: 'relay_message_1',
    idempotencyKey: 'idem_1',
    direction: 'phone_to_pc',
    ciphertext: 'b3BhcXVlLWNpcGhlcnRleHQ=',
    nonce: 'bm9uY2UxMjM0NTY3OA==',
    expiresAt: Date.now() + 60_000
  };
  const first = await jsonResponse(await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: encrypted
  }), env));
  const second = await jsonResponse(await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: encrypted
  }), env));
  assert.equal(first.status, 201);
  assert.equal(second.body.idempotent, true);
  const rows = await env.YUQI_RELAY_STORE.poll('device_123456', 'phone_to_pc', Date.now(), 10);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(JSON.stringify(rows), /prompt|memory|你好|reply/);

  const plaintext = await jsonResponse(await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: { ...encrypted, messageId: 'relay_message_2', content: '你好' }
  }), env));
  assert.equal(plaintext.status, 400);
});

test('enforces device ownership and deletes acknowledged envelopes', async () => {
  const env = envFixture();
  await register(env);
  await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: {
      deviceId: 'device_123456', messageId: 'relay_message_1', idempotencyKey: 'idem_1',
      direction: 'pc_to_phone', ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=', expiresAt: Date.now() + 60_000
    }
  }), env);

  const unauthorized = await relayWorker.fetch(request('/bridge/poll?deviceId=device_123456&direction=pc_to_phone', {
    token: 'wrong-device-token'
  }), env);
  assert.equal(unauthorized.status, 401);

  const polled = await jsonResponse(await relayWorker.fetch(request('/bridge/poll?deviceId=device_123456&direction=pc_to_phone', {
    token: 'device-token-123456789'
  }), env));
  assert.equal(polled.body.messages.length, 1);

  const acked = await jsonResponse(await relayWorker.fetch(request('/bridge/ack', {
    method: 'POST', token: 'device-token-123456789',
    body: { deviceId: 'device_123456', messageIds: ['relay_message_1'] }
  }), env));
  assert.equal(acked.body.deleted, 1);
  assert.equal((await env.YUQI_RELAY_STORE.poll('device_123456', 'pc_to_phone', Date.now(), 10)).length, 0);
});

test('omits expired messages and returns 50/75/90 quota warning levels', async () => {
  const env = envFixture({ RELAY_DAILY_BYTE_BUDGET: '20', RELAY_DAILY_WRITE_BUDGET: '4' });
  await register(env);
  const base = {
    deviceId: 'device_123456', direction: 'phone_to_pc', nonce: 'bm9uY2U=',
    ciphertext: 'MTIzNDU2Nzg5MA=='
  };
  for (let index = 1; index <= 2; index += 1) {
    await relayWorker.fetch(request('/bridge/enqueue', {
      method: 'POST', token: 'device-token-123456789', body: {
        ...base, messageId: `relay_message_${index}`, idempotencyKey: `idem_${index}`,
        expiresAt: Date.now() + 60_000
      }
    }), env);
  }
  const quota = await jsonResponse(await relayWorker.fetch(request('/bridge/quota?deviceId=device_123456', {
    token: 'device-token-123456789'
  }), env));
  assert.equal(quota.status, 200);
  assert.equal(quota.body.warningLevel, 90);

  await env.YUQI_RELAY_STORE.putEnvelope({
    ...base, messageId: 'expired', idempotencyKey: 'expired', expiresAt: Date.now() - 1,
    byteCount: 10, createdAt: Date.now() - 10
  });
  const polled = await jsonResponse(await relayWorker.fetch(request('/bridge/poll?deviceId=device_123456&direction=phone_to_pc', {
    token: 'device-token-123456789'
  }), env));
  assert.ok(polled.body.messages.every(message => message.messageId !== 'expired'));
});

test('websocket endpoint routes an authenticated device to its durable object', async () => {
  const env = envFixture();
  await register(env);
  let routedName = '';
  env.YUQI_RELAY = {
    idFromName(name) { routedName = name; return `id:${name}`; },
    get() { return { fetch: async () => new Response(null, { status: 204 }) }; }
  };
  const response = await relayWorker.fetch(request('/bridge/socket?deviceId=device_123456&direction=phone_to_pc', {
    token: 'device-token-123456789'
  }), env);
  assert.equal(response.status, 204);
  assert.equal(routedName, 'device_123456');
});

test('refresh-expiry updates only a live exact envelope and lower replay keeps the persisted expiry', async () => {
  const env = envFixture();
  await register(env);
  const now = Date.now();
  const original = {
    deviceId: 'device_123456', messageId: 'relay_message_1', idempotencyKey: 'idem_1',
    direction: 'phone_to_pc', ciphertext: 'Y2lwaGVyLWE=', nonce: 'bm9uY2U=', expiresAt: now + 60_000
  };
  await relayWorker.fetch(request('/bridge/enqueue', { method: 'POST', token: 'device-token-123456789', body: original }), env);
  const before = (await env.YUQI_RELAY_STORE.poll(original.deviceId, original.direction, now, 10))[0];
  const requestedExpiry = now + 120_000;
  const refreshed = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
    method: 'POST', token: 'device-token-123456789',
    body: { deviceId: original.deviceId, messageId: original.messageId, idempotencyKey: original.idempotencyKey,
      direction: original.direction, expiresAt: requestedExpiry }
  }), env));
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.expiresAt, requestedExpiry);
  const after = (await env.YUQI_RELAY_STORE.poll(original.deviceId, original.direction, now, 10))[0];
  assert.deepEqual({ ...after, expiresAt: before.expiresAt }, before);

  const replay = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
    method: 'POST', token: 'device-token-123456789',
    body: { deviceId: original.deviceId, messageId: original.messageId, idempotencyKey: original.idempotencyKey,
      direction: original.direction, expiresAt: requestedExpiry - 1 }
  }), env));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.expiresAt, requestedExpiry);
  assert.equal(replay.body.idempotent, true);
});

test('refresh-expiry rejects unknown keys and coerced native fields before any store write', async () => {
  const env = envFixture();
  await register(env);
  const body = { deviceId: 'device_123456', messageId: 'relay_message_1', idempotencyKey: 'idem_1',
    direction: 'phone_to_pc', expiresAt: Date.now() + 60_000 };
  for (const invalid of [
    { ...body, extra: true },
    { ...body, expiresAt: String(body.expiresAt) },
    { ...body, direction: {} },
    { ...body, messageId: null },
    { ...body, idempotencyKey: undefined }
  ]) {
    const result = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
      method: 'POST', token: 'device-token-123456789', body: invalid
    }), env));
    assert.equal(result.status, 400);
  }
});

test('refresh-expiry preserves the 401/409/200 boundary', async () => {
  const env = envFixture();
  await register(env);
  const now = Date.now();
  const body = { deviceId: 'device_123456', messageId: 'relay_message_1', idempotencyKey: 'idem_1',
    direction: 'phone_to_pc', expiresAt: now + 60_000 };
  const unauthorized = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
    method: 'POST', token: 'wrong-device-token', body
  }), env));
  assert.equal(unauthorized.status, 401);
  await env.YUQI_RELAY_STORE.putEnvelope({ ...relayEnvelope({ expiresAt: now - 1, createdAt: now - 10 }) }, now);
  const expired = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
    method: 'POST', token: 'device-token-123456789', body
  }), env));
  assert.equal(expired.status, 409);
  const changed = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
    method: 'POST', token: 'device-token-123456789', body: { ...body, idempotencyKey: 'idem_2' }
  }), env));
  assert.equal(changed.status, 409);
  for (const invalidExpiry of [now, 0, -1, Number.MAX_SAFE_INTEGER + 1, String(now + 60_000)]) {
    const invalid = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
      method: 'POST', token: 'device-token-123456789', body: { ...body, expiresAt: invalidExpiry }
    }), env));
    assert.equal(invalid.status, 400);
  }
  const tooFar = await jsonResponse(await relayWorker.fetch(request('/bridge/refresh-expiry', {
    method: 'POST', token: 'device-token-123456789', body: { ...body, expiresAt: now + 7 * 24 * 60 * 60 * 1000 + 60_000 }
  }), env));
  assert.equal(tooFar.status, 400);
});

test('live changed enqueue and partial identity conflicts never replace ciphertext', async () => {
  const env = envFixture();
  await register(env);
  const original = {
    deviceId: 'device_123456', messageId: 'relay_message_1', idempotencyKey: 'idem_1',
    direction: 'phone_to_pc', ciphertext: 'Y2lwaGVyLWE=', nonce: 'bm9uY2U=', expiresAt: Date.now() + 60_000
  };
  await relayWorker.fetch(request('/bridge/enqueue', { method: 'POST', token: 'device-token-123456789', body: original }), env);
  const changedCiphertext = await jsonResponse(await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: { ...original, ciphertext: 'Y2lwaGVyLWI=' }
  }), env));
  assert.equal(changedCiphertext.status, 409);
  const partialIdentity = await jsonResponse(await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: { ...original, idempotencyKey: 'idem_2' }
  }), env));
  assert.equal(partialIdentity.status, 409);
  const rows = await env.YUQI_RELAY_STORE.poll(original.deviceId, original.direction, Date.now(), 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ciphertext, original.ciphertext);
});

test('expired exact enqueue and ACK remove the memory envelope and live identity index atomically', async () => {
  const store = createMemoryRelayStore();
  const now = Date.now();
  const expired = relayEnvelope({ expiresAt: now - 1, createdAt: now - 10 });
  await store.putEnvelope(expired, now);
  const rebuilt = await store.putEnvelope({ ...expired, ciphertext: 'Y2lwaGVyLWI=', createdAt: now, expiresAt: now + 10_000 }, now);
  assert.equal(rebuilt.idempotent, false);
  const rebuiltRow = (await store.poll(expired.deviceId, expired.direction, now, 10))[0];
  assert.equal(rebuiltRow.ciphertext, 'Y2lwaGVyLWI=');
  assert.equal(await store.ack(expired.deviceId, [expired.messageId]), 1);
  const afterAck = await store.putEnvelope({ ...expired, ciphertext: 'Y2lwaGVyLWM=', createdAt: now + 1, expiresAt: now + 11_000 }, now + 1);
  assert.equal(afterAck.idempotent, false);
});

test('partial expired identity does not delete the expired row or its index', async () => {
  const store = createMemoryRelayStore();
  const now = Date.now();
  const expired = relayEnvelope({ expiresAt: now - 1, createdAt: now - 10 });
  await store.putEnvelope(expired, now);
  const sameMessage = await store.putEnvelope({ ...expired, idempotencyKey: 'idem_2', ciphertext: 'Y2lwaGVyLWI=', expiresAt: now + 10_000 }, now);
  assert.equal(sameMessage.conflict, true);
  const sameIdempotency = await store.putEnvelope({ ...expired, messageId: 'relay_message_2', ciphertext: 'Y2lwaGVyLWM=', expiresAt: now + 10_000 }, now);
  assert.equal(sameIdempotency.conflict, true);
  const rebuilt = await store.putEnvelope({ ...expired, ciphertext: 'Y2lwaGVyLWEy', expiresAt: now + 10_000 }, now);
  assert.equal(rebuilt.idempotent, false);
});

test('D1 store refreshes exact expiry and keeps memory-equivalent expired rebuild semantics', async () => {
  const db = createFakeD1();
  const store = createD1RelayStore(db);
  const now = Date.now();
  const original = relayEnvelope({ expiresAt: now + 10_000, createdAt: now });
  await store.putEnvelope(original, now);
  assert.equal([...db.snapshot().usage.values()][0].write_count, 1);
  const duplicate = await store.putEnvelope(original, now);
  assert.equal(duplicate.idempotent, true);
  assert.equal([...db.snapshot().usage.values()][0].write_count, 1);
  const refreshed = await store.refreshExpiry({ ...original, expiresAt: now + 20_000 }, now);
  assert.equal(refreshed.expiresAt, now + 20_000);
  const replay = await store.refreshExpiry({ ...original, expiresAt: now + 19_000 }, now);
  assert.equal(replay.expiresAt, now + 20_000);
  const expired = { ...original, expiresAt: now - 1 };
  const expiredStore = createD1RelayStore(createFakeD1());
  await expiredStore.putEnvelope(expired, now);
  const rebuilt = await expiredStore.putEnvelope({ ...expired, ciphertext: 'Y2lwaGVyLWI=', createdAt: now + 1, expiresAt: now + 40_000 }, now + 1);
  assert.equal(rebuilt.idempotent, false);
});

test('D1 expired cleanup and replacement are one rollback unit', async () => {
  const db = createFakeD1();
  const store = createD1RelayStore(db);
  const now = Date.now();
  const expired = relayEnvelope({ expiresAt: now - 1, createdAt: now - 10 });
  await store.putEnvelope(expired, now);
  const before = db.snapshot();
  db.failNextBatch();
  await assert.rejects(() => store.putEnvelope({ ...expired, ciphertext: 'Y2lwaGVyLWI=', createdAt: now, expiresAt: now + 10_000 }, now), /injected D1 batch failure/);
  assert.deepEqual(db.snapshot(), before);
  db.failNextInsert();
  await assert.rejects(() => store.putEnvelope({ ...expired, ciphertext: 'Y2lwaGVyLWI=', createdAt: now, expiresAt: now + 10_000 }, now), /injected D1 insert failure/);
  assert.deepEqual(db.snapshot(), before);
});

test('unknown D1 batch failures surface as 5xx instead of input 400', async () => {
  const db = createFakeD1();
  const env = envFixture({ YUQI_RELAY_STORE: undefined, AL_TIMER_DB: db });
  await register(env);
  db.failNextBatch();
  const result = await jsonResponse(await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: {
      deviceId: 'device_123456', messageId: 'relay_message_1', idempotencyKey: 'idem_1',
      direction: 'phone_to_pc', ciphertext: 'Y2lwaGVy', nonce: 'bm9uY2U=', expiresAt: Date.now() + 60_000
    }
  }), env));
  assert.equal(result.status, 500);
});

test('D1 usage constraint failure after expired delete rolls back and surfaces 5xx', async () => {
  const db = createFakeD1();
  const env = envFixture({ YUQI_RELAY_STORE: undefined, AL_TIMER_DB: db });
  await register(env);
  const now = Date.now();
  const store = createD1RelayStore(db);
  const expired = relayEnvelope({ expiresAt: now - 1, createdAt: now - 10 });
  await store.putEnvelope(expired, now);
  const before = db.snapshot();
  db.failNextUsage();
  const result = await jsonResponse(await relayWorker.fetch(request('/bridge/enqueue', {
    method: 'POST', token: 'device-token-123456789', body: {
      deviceId: expired.deviceId, messageId: expired.messageId, idempotencyKey: expired.idempotencyKey,
      direction: expired.direction, ciphertext: 'Y2lwaGVyLWI=', nonce: expired.nonce, expiresAt: now + 10_000
    }
  }), env));
  assert.equal(result.status, 500);
  assert.deepEqual(db.snapshot(), before);
});
