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

test('reconciles the phone journal before processing the new turn and returns its acknowledgement', async () => {
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    reconciler: {
      async reconcileFrom(packet) {
        events.push(`reconcile:${packet.peerId}`);
        return { ackSeq: 88 };
      }
    },
    orchestrator: {
      async process(value) {
        events.push(`turn:${value.turnId}`);
        return { turnId: value.turnId, reply: { content: '收到' } };
      }
    }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const result = await call(server.address().port, {
      method: 'POST', path: '/v1/turns', secret: 'test-pairing-secret', nonce: 'recovery-nonce',
      body: {
        protocolVersion: 1, turnId: 'turn_phone_88',
        recovery: { peerId: 'phone_a', lastCommonSeq: 80, entries: [] }
      }
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.recoveryAckSeq, 88);
    assert.deepEqual(events, ['reconcile:phone_a', 'turn:turn_phone_88']);
  } finally {
    await server.close();
  }
});

test('v2 accepts a background turn immediately and exposes signed polling status', async () => {
  const accepted = [];
  let stored = {
    turnId: 'turn_phone_async_1', state: 'queued', origin: 'codex',
    replyJson: null, errorJson: null, updatedAt: 1784400000000
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: {
      getTurn: () => stored,
      getTurnStages: () => [{
        stage: 'memory', ordinal: 1, model: 'gpt-5.6-terra', effort: 'medium',
        startedAt: 1784400000000, finishedAt: null, durationMs: null
      }],
      getSyncDelta: () => [],
      ackSync: () => 0
    },
    orchestrator: { process: async () => { throw new Error('v2 must not call synchronous process'); } },
    dispatcher: {
      accept(value) {
        accepted.push(value.turnId);
        return stored;
      }
    }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const payload = {
      protocolVersion: 2,
      turnId: 'turn_phone_async_1',
      characterId: 'yuqi',
      deviceId: 'phone_a',
      deviceSeq: 1,
      createdAt: 1784400000000,
      kind: 'DIRECT_REPLY',
      message: {
        messageId: 'msg_phone_async_1', speakerId: 'user', speakerType: 'user',
        recipientId: 'yuqi', content: '你好', sentAt: 1784400000000
      }
    };
    const submitted = await call(server.address().port, {
      method: 'POST', path: '/v2/turns', body: payload,
      secret: 'test-pairing-secret', nonce: 'async-submit'
    });
    assert.equal(submitted.status, 202);
    assert.equal(submitted.body.terminal, false);
    assert.equal(submitted.body.displayStage, '正在翻一下我们以前说过的话…');
    assert.equal(submitted.body.stageModel, 'gpt-5.6-terra');
    assert.deepEqual(accepted, ['turn_phone_async_1']);

    stored = {
      ...stored,
      state: 'committed',
      replyJson: JSON.stringify({
        turnId: stored.turnId,
        reply: { content: '你好呀', origin: 'codex' }
      }),
      updatedAt: 1784400001000
    };
    const polled = await call(server.address().port, {
      method: 'GET', path: '/v2/turns/turn_phone_async_1',
      secret: 'test-pairing-secret', nonce: 'async-poll'
    });
    assert.equal(polled.status, 200);
    assert.equal(polled.body.terminal, true);
    assert.equal(polled.body.reply.content, '你好呀');
    assert.equal(polled.body.origin, 'codex');
  } finally {
    await server.close();
  }
});
