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

function triggerEnvelope(seq = 20) {
  return {
    protocolVersion: 2,
    turnId: `turn_phone_trigger_${seq}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: seq,
    createdAt: 1784400000000 + seq,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId: `trigger_phone_${seq}`,
      triggerType: 'proactive_chat',
      scheduledFor: 1784399999000 + seq,
      executedAt: 1784400000000 + seq,
      context: { reason: 'scheduled_check_in' }
    }
  };
}

class FakeCodex {
  constructor(outputs = {}) {
    this.outputs = Object.fromEntries(Object.entries(outputs).map(([role, values]) => [role, [...values]]));
    this.calls = [];
  }

  async runTurn(role, input, options = {}) {
    this.calls.push({ role, input: JSON.parse(input), options });
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

test('fast route runs Terra memory and Sol brain without supervisor', async () => {
  await withFixture(normalOutputs(), async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope());
    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain']);
    assert.deepEqual(codex.calls.map(call => [call.options.model, call.options.effort]), [
      ['gpt-5.6-terra', 'medium'],
      ['gpt-5.6-sol', 'medium']
    ]);
    assert.equal(store.getTurn(result.turnId).route, 'fast');
    assert.equal(result.reply.speakerId, 'yuqi');
    assert.equal(result.reply.content, '你好。我是虞栖，你呢？');
    assert.equal(store.getTurn(result.turnId).state, 'committed');
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerId === 'yuqi').length, 1);
  });
});

test('deep relationship route runs Sol memory, Sol brain and Terra supervisor', async () => {
  await withFixture(normalOutputs(), async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(2, '你答应过的呢'));
    assert.deepEqual(codex.calls.map(call => [call.role, call.options.model, call.options.effort]), [
      ['memory', 'gpt-5.6-sol', 'medium'],
      ['brain', 'gpt-5.6-sol', 'medium'],
      ['supervisor', 'gpt-5.6-terra', 'medium']
    ]);
    assert.equal(store.getTurn(result.turnId).route, 'deep');
  });
});

test('fast memory escalation starts a new Sol memory turn before brain', async () => {
  await withFixture({
    memory: [
      '{"query":"在吗","keywords":[],"candidates":[],"requiresDeepMemory":true,"escalationReasons":["commitment_context"],"speakerAmbiguity":false,"commitmentRisk":true}',
      '{"query":"在吗","keywords":[],"candidates":[],"requiresDeepMemory":false,"escalationReasons":[],"speakerAmbiguity":false,"commitmentRisk":false}'
    ],
    brain: ['{"reply":"我在呢。","usedFactIds":[]}'],
    supervisor: ['{"approved":true,"issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(3, '在吗'));
    assert.deepEqual(codex.calls.map(call => [call.role, call.options.model]), [
      ['memory', 'gpt-5.6-terra'],
      ['memory', 'gpt-5.6-sol'],
      ['brain', 'gpt-5.6-sol'],
      ['supervisor', 'gpt-5.6-terra']
    ]);
    assert.equal(store.getTurn(result.turnId).route, 'fast_to_deep');
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
    const result = await orchestrator.process(envelope(40, '你答应过要认真回复我的'));
    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor', 'brain', 'supervisor']);
    assert.equal(result.reply.content, '你好呀。我叫虞栖，你怎么称呼？');
  });
});

test('resumes at brain without repeating memory when a memory checkpoint exists', async () => {
  await withFixture({
    brain: ['{"reply":"继续回复","usedFactIds":[]}'],
    supervisor: ['{"approved":true,"issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const accepted = store.submitTurn(envelope(30));
    store.claimTurnById(accepted.turnId, 'crashed-worker');
    store.advanceTurn(accepted.turnId, 'memory_running', 'memory_done', {
      memoryPacketJson: '{"query":"你好","keywords":[],"committedFacts":{"verified":[],"provisional":[],"rejected":[]}}'
    });

    const result = await orchestrator.run(accepted.turnId);

    assert.equal(result.reply.content, '继续回复');
    assert.deepEqual(codex.calls.map(call => call.role), ['brain', 'supervisor']);
  });
});

test('repairs one invalid brain response under the strict schema before failing the turn', async () => {
  await withFixture({
    memory: ['{"query":"你好","keywords":[],"candidates":[]}'],
    brain: ['收到，看起来链路很顺畅。', '{"reply":"你好呀","usedFactIds":[]}'],
    supervisor: ['{"approved":true,"issues":[]}']
  }, async ({ codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(31));
    const brainCalls = codex.calls.filter(call => call.role === 'brain');
    assert.equal(result.reply.content, '你好呀');
    assert.equal(brainCalls.length, 2);
    assert.ok(brainCalls.every(call => call.options.outputSchema));
    assert.equal(brainCalls[1].input.protocolRepair.attempt, 2);
  });
});

test('automatic trigger reaches brain as currentTrigger and never becomes user evidence', async () => {
  await withFixture(normalOutputs(), async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(triggerEnvelope());
    const memory = codex.calls.find(call => call.role === 'memory').input;
    const brain = codex.calls.find(call => call.role === 'brain').input;
    assert.equal(result.reply.speakerId, 'yuqi');
    assert.equal(memory.currentMessageId, undefined);
    assert.equal(memory.currentTrigger.triggerId, 'trigger_phone_20');
    assert.equal(brain.currentUserMessage, undefined);
    assert.equal(brain.currentTrigger.triggerType, 'proactive_chat');
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerType === 'user').length, 0);
  });
});
