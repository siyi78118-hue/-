import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { YuqiOrchestrator } from '../src/orchestrator.mjs';
import { PresetRegistry } from '../src/preset-registry.mjs';
import { YuqiStore } from '../src/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const presetDir = join(here, '..', 'presets');

function envelope(seq = 1, content = '你好') {
  return {
    protocolVersion: 1,
    turnId: `turn_phone_${seq}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: seq,
    createdAt: 1784400000000 + seq,
    message: {
      messageId: `msg_phone_${seq}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content,
      sentAt: 1784400000000 + seq
    }
  };
}

class FakeCodex {
  constructor(outputs = {}) {
    this.outputs = Object.fromEntries(Object.entries(outputs).map(([role, values]) => [role, [...values]]));
    this.calls = [];
  }

  async runTurn(role, input) {
    this.calls.push({ role, input: JSON.parse(input) });
    const text = this.outputs[role]?.shift();
    if (text === undefined) throw new Error(`missing fake output for ${role}`);
    return { text };
  }
}

function withFixture(outputs, run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-orchestrator-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const presets = new PresetRegistry({ presetDir, store, clock: () => 1784400000000 });
  const codex = new FakeCodex(outputs);
  const orchestrator = new YuqiOrchestrator({ store, presets, codex, workerId: 'test-worker' });
  return Promise.resolve(run({ store, presets, codex, orchestrator })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

const normalOutputs = () => ({
  memory: ['{"query":"你好","keywords":["你好"],"candidates":[]}'],
  brain: ['{"reply":"你好。我是虞栖，你呢？","usedFactIds":[]}'],
  supervisor: ['{"approved":true,"issues":[]}']
});

test('runs memory, brain, hard check, supervisor and commits exactly one reply', async () => {
  await withFixture(normalOutputs(), async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope());
    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor']);
    assert.equal(result.reply.speakerId, 'yuqi');
    assert.equal(result.reply.content, '你好。我是虞栖，你呢？');
    assert.equal(store.getTurn(result.turnId).state, 'committed');
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerId === 'yuqi').length, 1);
  });
});

test('passes at most 200 recent raw messages with stable speaker identities', async () => {
  await withFixture(normalOutputs(), async ({ store, codex, orchestrator }) => {
    for (let index = 1; index <= 205; index += 1) {
      store.putMessage({
        messageId: `msg_history_${index}`,
        turnId: `turn_history_${index}`,
        characterId: 'yuqi',
        speakerId: index % 2 ? 'user' : 'yuqi',
        speakerType: index % 2 ? 'user' : 'character',
        recipientId: index % 2 ? 'yuqi' : 'user',
        content: `历史消息 ${index}`,
        sentAt: 1784300000000 + index,
        origin: 'phone'
      });
    }
    await orchestrator.process(envelope());
    const memoryInput = codex.calls.find(call => call.role === 'memory').input;
    assert.equal(memoryInput.recentMessages.length, 200);
    assert.ok(memoryInput.recentMessages.every(message => message.messageId && message.speakerId));
  });
});

test('hard validation blocks backstage leakage before supervisor', async () => {
  const outputs = normalOutputs();
  outputs.brain = ['{"reply":"我是一个AI模型，刚检查了记忆库。","usedFactIds":[]}'];
  await withFixture(outputs, async ({ store, codex, orchestrator }) => {
    await assert.rejects(() => orchestrator.process(envelope()), /hard validation/i);
    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain']);
    assert.equal(store.getTurn('turn_phone_1').state, 'failed');
  });
});

test('supervisor rejection asks the brain to rewrite once under the same preset', async () => {
  await withFixture({
    memory: ['{"query":"你好","keywords":[],"candidates":[]}'],
    brain: [
      '{"reply":"您好，请问需要什么帮助？","usedFactIds":[]}',
      '{"reply":"你好呀。我叫虞栖，你怎么称呼？","usedFactIds":[]}'
    ],
    supervisor: [
      '{"approved":false,"issues":[{"code":"SERVICE_TONE","message":"像客服"}]}',
      '{"approved":true,"issues":[]}'
    ]
  }, async ({ codex, orchestrator }) => {
    const result = await orchestrator.process(envelope());
    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor', 'brain', 'supervisor']);
    assert.equal(result.reply.content, '你好呀。我叫虞栖，你怎么称呼？');
  });
});
