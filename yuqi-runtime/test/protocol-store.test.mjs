import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TURN_STATES,
  canonicalJson,
  contentHash,
  validateEnvelope
} from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';

function validEnvelope(overrides = {}) {
  return {
    protocolVersion: 1,
    turnId: 'turn_device1_1',
    characterId: 'yuqi',
    deviceId: 'device1',
    deviceSeq: 1,
    createdAt: 1784400000000,
    message: {
      messageId: 'msg_device1_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你好',
      sentAt: 1784400000000
    },
    ...overrides
  };
}

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-store-'));
  const file = join(dir, 'runtime.sqlite');
  const store = new YuqiStore(file);
  try {
    return run({ store, file });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('canonical JSON and hash are stable across object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));
});

test('rejects an envelope whose speaker identity conflicts with its type', () => {
  const value = validEnvelope({
    message: {
      ...validEnvelope().message,
      speakerId: 'yuqi',
      speakerType: 'user'
    }
  });
  assert.throws(() => validateEnvelope(value), /speaker mismatch/i);
});

test('accepts only known durable turn states', () => {
  assert.deepEqual(TURN_STATES, [
    'queued',
    'memory_running',
    'memory_done',
    'brain_running',
    'brain_done',
    'supervisor_running',
    'approved',
    'committed',
    'delivered',
    'completed',
    'fallback',
    'failed'
  ]);
});

test('submitTurn is idempotent and survives reopening', () => withStore(({ store, file }) => {
  const first = store.submitTurn(validEnvelope());
  const second = store.submitTurn(validEnvelope());
  assert.equal(first.turnId, second.turnId);
  assert.equal(store.listMessages('yuqi', 10).length, 1);

  store.close();
  const reopened = new YuqiStore(file);
  try {
    assert.equal(reopened.getTurn(first.turnId).state, 'queued');
    assert.equal(reopened.listMessages('yuqi', 10)[0].speakerId, 'user');
  } finally {
    reopened.close();
  }
}));

test('the same device sequence cannot be attached to a different message', () => withStore(({ store }) => {
  store.submitTurn(validEnvelope());
  const conflicting = validEnvelope({
    turnId: 'turn_device1_2',
    message: {
      ...validEnvelope().message,
      messageId: 'msg_device1_other',
      content: '另一条'
    }
  });
  assert.throws(() => store.submitTurn(conflicting), /device sequence conflict/i);
}));

test('state transitions use compare-and-set semantics', () => withStore(({ store }) => {
  store.submitTurn(validEnvelope());
  const claimed = store.claimTurn('worker-a');
  assert.equal(claimed.state, 'memory_running');
  assert.equal(claimed.workerId, 'worker-a');
  assert.throws(
    () => store.advanceTurn(claimed.turnId, 'queued', 'memory_done', {}),
    /stale turn state/i
  );
  const advanced = store.advanceTurn(claimed.turnId, 'memory_running', 'memory_done', {
    memoryPacketJson: '{"facts":[]}'
  });
  assert.equal(advanced.state, 'memory_done');
}));

test('sync deltas are ordered, checksummed, and acknowledged independently', () => withStore(({ store }) => {
  store.submitTurn(validEnvelope());
  store.putMessage({
    messageId: 'msg_yuqi_1',
    turnId: 'turn_device1_1',
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '你好呀',
    sentAt: 1784400001000,
    origin: 'codex'
  });
  const delta = store.getSyncDelta(0, 20);
  assert.ok(delta.length >= 3);
  assert.deepEqual(delta.map(item => item.seq), [...delta.map(item => item.seq)].sort((a, b) => a - b));
  assert.ok(delta.every(item => /^[a-f0-9]{64}$/.test(item.checksum)));
  assert.equal(store.ackSync('phone', delta.at(-1).seq), delta.at(-1).seq);
  assert.equal(store.getSyncCursor('phone'), delta.at(-1).seq);
}));

