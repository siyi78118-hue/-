import assert from 'node:assert/strict';
import test from 'node:test';

import relayWorker, { createMemoryRelayStore } from '../yuqi-relay-worker.js';

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
