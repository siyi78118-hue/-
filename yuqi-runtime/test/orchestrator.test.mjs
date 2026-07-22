import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { hardValidateReply, YuqiOrchestrator } from '../src/orchestrator.mjs';
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

function stagedEnvelope(seq = 90) {
  const value = envelope(seq, '我们好像比刚认识时熟多了');
  value.protocolVersion = 2;
  value.kind = 'DIRECT_REPLY';
  value.context = {
    scene: {
      playerName: '阿予',
      characterName: '虞栖',
      relationshipStage: { id: 'new', label: '初识', content: '谨慎、保留。' },
      stageCatalog: [
        { id: 'new', label: '初识', content: '谨慎、保留。' },
        { id: 'acquainted', label: '熟悉', content: '已有共同经历，语气自然。' }
      ]
    }
  };
  return value;
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

function withFixture(outputs, run, { clock = () => 1784400000000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-orchestrator-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const presets = new PresetRegistry({ presetDir, store, clock: () => 1784400000000 });
  const codex = new FakeCodex(outputs);
  const orchestrator = new YuqiOrchestrator({ store, presets, codex, workerId: 'test-worker', clock });
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

function conversationFrame(overrides = {}) {
  return {
    surfaceAct: 'brief continuation',
    intentHypotheses: [{
      intent: 'keep the exchange moving without introducing a new topic',
      confidence: 0.78,
      evidenceMessageIds: ['msg_phone_11']
    }],
    interactionMode: 'light_conversation',
    emotionalTone: 'playful',
    relationshipMove: 'invite_continuation',
    initiative: {
      topicIntroducedBy: 'yuqi',
      suggestedNextCarrier: 'yuqi',
      reason: 'the user is responding to the existing hook'
    },
    activeHooks: ['continue the existing exchange'],
    ambiguities: ['literal and relational readings are both possible'],
    responseRisks: ['merely classifying or scoring the message'],
    needsNuanceReview: false,
    ...overrides
  };
}

test('ephemeral conversation frame reaches the brain but never becomes a durable fact', async () => {
  const frame = conversationFrame();
  await withFixture({
    memory: [JSON.stringify({
      query: 'continue', keywords: ['continue'], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: ['{"action":"send","reply":"Then I will keep going.","paymentAction":null,"usedFactIds":[],"momentAction":null}']
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(11, 'go on'));
    const brain = codex.calls.find(call => call.role === 'brain').input;
    const memoryPacket = JSON.parse(store.getTurn(result.turnId).memoryPacketJson);

    assert.deepEqual(brain.conversationFrame, frame);
    assert.deepEqual(memoryPacket.conversationFrame, frame);
    assert.equal(store.listFacts('yuqi').some(fact => fact.predicate === 'possibleIntent'), false);
  });
});

test('a nuanced fast turn upgrades to supervisor without repeating memory', async () => {
  const frame = conversationFrame({
    interactionMode: 'ambiguous_banter',
    ambiguities: ['literal and affiliative readings remain plausible'],
    responseRisks: ['answering only the surface wording'],
    needsNuanceReview: true
  });
  await withFixture({
    memory: [JSON.stringify({
      query: 'brief response', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: ['{"action":"send","reply":"I caught the tone; I will carry this one.","paymentAction":null,"usedFactIds":[],"momentAction":null}'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(12, 'sure, go ahead'));

    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor']);
    assert.equal(codex.calls.filter(call => call.role === 'memory').length, 1);
    assert.equal(store.getTurn(result.turnId).route, 'fast_to_deep');
    assert.ok(store.getTurn(result.turnId).routeReasons.includes('conversation_nuance'));
  });
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

test('an evidence-backed stage review becomes the authoritative scene for brain, supervisor and result', async () => {
  const staged = stagedEnvelope();
  await withFixture({
    memory: [JSON.stringify({
      query: '关系阶段', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: {
        current: 'new', recommended: 'acquainted', confidence: 0.91,
        reason: '双方已有多次真实交流', evidenceMessageIds: [staged.message.messageId, 'msg_stage_history'],
        explicitMutualChange: false
      }
    })],
    brain: ['{"action":"send","reply":"确实，已经不像刚认识了。","paymentAction":null,"usedFactIds":[]}'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    store.putMessage({
      messageId: 'msg_stage_history', turnId: 'turn_stage_history', characterId: 'yuqi', speakerId: 'yuqi',
      speakerType: 'character', recipientId: 'user', content: '上次的聊天', sentAt: staged.message.sentAt - 1000, origin: 'codex'
    });
    orchestrator.accept(staged);
    store.setTurnRoute(staged.turnId, 'deep', ['relationship_stage_test']);
    const result = await orchestrator.run(staged.turnId);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    const supervisor = codex.calls.find(call => call.role === 'supervisor').input;
    assert.equal(brain.scene.relationshipStage.id, 'acquainted');
    assert.match(brain.preset, /已有共同经历/);
    assert.equal(supervisor.scene.relationshipStage.id, 'acquainted');
    assert.equal(result.relationshipStageAction.to, 'acquainted');
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

test('keeps 200 evidence messages but gives brain and supervisor 24 deduplicated history messages', async () => {
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
    const input = envelope();
    orchestrator.accept(input);
    store.setTurnRoute(input.turnId, 'deep', ['context_window_test']);
    await orchestrator.run(input.turnId);
    const memoryInput = codex.calls.find(call => call.role === 'memory').input;
    const brainInput = codex.calls.find(call => call.role === 'brain').input;
    const supervisorInput = codex.calls.find(call => call.role === 'supervisor').input;
    assert.equal(memoryInput.recentMessages.length, 200);
    assert.ok(memoryInput.recentMessages.every(message => message.messageId && message.speakerId));
    assert.equal(brainInput.recentMessages.length, 24);
    assert.equal(supervisorInput.recentMessages.length, 24);
    assert.equal(brainInput.recentMessages.some(message => message.messageId === input.message.messageId), false);
    assert.equal(supervisorInput.recentMessages.some(message => message.messageId === input.message.messageId), false);
    assert.equal(brainInput.currentUserMessage.messageId, input.message.messageId);
  });
});

test('runtime validation allows AI topics and AI self-identification', async () => {
  for (const [index, reply] of [
    '原来是AI短剧。小团队还负责得多，难怪你忙成这样。',
    '我是一个AI模型，刚检查了记忆库。'
  ].entries()) {
    const outputs = normalOutputs();
    outputs.brain = [JSON.stringify({ reply, usedFactIds: [] })];
    await withFixture(outputs, async ({ store, orchestrator }) => {
      const result = await orchestrator.process(envelope(index + 50, '制作ai短剧'));
      assert.equal(result.reply.content, reply);
      assert.equal(store.getTurn(result.turnId).state, 'committed');
    });
  }
});

test('runtime validation still rejects technically undeliverable replies', () => {
  assert.deepEqual(hardValidateReply('').issues.map(issue => issue.code), ['EMPTY_REPLY']);
  assert.deepEqual(hardValidateReply('x'.repeat(20_001)).issues.map(issue => issue.code), ['REPLY_TOO_LARGE']);
});

test('technically undeliverable replies are repaired and committed instead of failing the turn', async () => {
  for (const [index, reply] of ['', 'x'.repeat(20_001)].entries()) {
    const outputs = normalOutputs();
    outputs.brain = [JSON.stringify({ reply, usedFactIds: [] })];
    await withFixture(outputs, async ({ store, orchestrator }) => {
      const result = await orchestrator.process(envelope(index + 60, '继续'));
      assert.ok(result.reply.content.trim());
      assert.ok(result.reply.content.length <= 20_000);
      assert.equal(store.getTurn(result.turnId).state, 'committed');
    });
  }
});

test('an automatic empty brain envelope becomes a deliberate skip without a visible fallback message', async () => {
  await withFixture({
    memory: ['{"query":"主动联系","keywords":[],"candidates":[]}'],
    brain: ['{"reply":"{\\"reply\\":\\"\\",\\"usedFactIds\\":[]}","usedFactIds":[]}'],
    supervisor: ['{"approved":true,"issues":[]}']
  }, async ({ store, orchestrator }) => {
    const result = await orchestrator.process(triggerEnvelope(62));

    assert.equal(result.action, 'skip');
    assert.equal(result.reply, null);
    assert.equal(store.getTurn(result.turnId).state, 'committed');
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerId === 'yuqi').length, 0);
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

test('a third supervisor rejection vetoes an automatic message instead of force-sending it', async () => {
  await withFixture({
    memory: ['{"query":"hello","keywords":[],"candidates":[]}'],
    brain: [
      '{"reply":"first draft","usedFactIds":[]}',
      '{"reply":"rewritten draft","usedFactIds":[]}',
      '{"reply":"final rewritten draft","usedFactIds":[]}'
    ],
    supervisor: [
      '{"approved":false,"issues":[{"code":"TONE","message":"rewrite"}]}',
      '{"approved":false,"issues":[{"code":"TONE","message":"still imperfect"}]}',
      '{"approved":false,"issues":[{"code":"TONE","message":"still rejected"}]}'
    ]
  }, async ({ store, orchestrator }) => {
    const result = await orchestrator.process(triggerEnvelope(61));
    assert.equal(result.action, 'skip');
    assert.equal(result.reply, null);
    assert.equal(store.getTurn(result.turnId).state, 'committed');
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerId === 'yuqi').length, 0);
  });
});

test('an automatic brain may deliberately stay silent', async () => {
  await withFixture({
    memory: ['{"query":"check in","keywords":[],"candidates":[]}'],
    brain: ['{"action":"skip","reply":"","usedFactIds":[]}'],
    supervisor: ['{"approved":true,"issues":[]}']
  }, async ({ store, orchestrator }) => {
    const result = await orchestrator.process(triggerEnvelope(64));
    assert.deepEqual({ action: result.action, reply: result.reply }, { action: 'skip', reply: null });
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerId === 'yuqi').length, 0);
  });
});

test('moment interaction is handled by the chat brain as a structured phone action, not a private message', async () => {
  const momentTurn = triggerEnvelope(96);
  momentTurn.kind = 'MOMENT_INTERACTION';
  momentTurn.trigger.triggerType = 'moment_interaction';
  momentTurn.trigger.context.input = { moment: { id: 'moment_96', text: '新买的乌龙奶茶' } };
  await withFixture({
    memory: ['{"query":"moment","keywords":[],"candidates":[]}'],
    brain: ['{"action":"send","reply":"","paymentAction":null,"usedFactIds":[],"momentAction":{"momentId":"moment_96","like":true,"comment":"这杯看着确实不错","replyToCommentId":null}}'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(momentTurn);
    assert.equal(result.momentAction.momentId, 'moment_96');
    assert.equal(result.momentAction.like, true);
    assert.equal(result.reply, null);
    assert.equal(codex.calls.find(call => call.role === 'brain').input.currentTrigger.context.input.moment.id, 'moment_96');
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerId === 'yuqi').length, 0);
  });
});

test('a second supervisor rejection requests one final rewrite instead of sending the rejected draft', async () => {
  await withFixture({
    memory: ['{"query":"回见","keywords":[],"candidates":[]}'],
    brain: [
      '{"reply":"不追发消息。","usedFactIds":[]}',
      '{"reply":"留出各自上班的空档。","usedFactIds":[]}',
      '{"reply":"去忙吧，等你有空再聊。","usedFactIds":[]}'
    ],
    supervisor: [
      '{"approved":false,"issues":[{"code":"INTERNAL_FORMAT_LEAKAGE","message":"不是聊天正文"}]}',
      '{"approved":false,"issues":[{"code":"INTERNAL_FORMAT_LEAKAGE","message":"仍是内部决定"}]}',
      '{"approved":true,"issues":[]}'
    ]
  }, async ({ codex, orchestrator }) => {
    const result = await orchestrator.process(triggerEnvelope(63));

    assert.equal(result.reply.content, '去忙吧，等你有空再聊。');
    assert.equal(codex.calls.filter(call => call.role === 'brain').length, 3);
    assert.equal(codex.calls.filter(call => call.role === 'supervisor').length, 3);
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
    const supervisor = codex.calls.find(call => call.role === 'supervisor').input;
    assert.equal(result.reply.speakerId, 'yuqi');
    assert.equal(memory.currentMessageId, undefined);
    assert.equal(memory.currentTrigger.triggerId, 'trigger_phone_20');
    assert.equal(brain.currentUserMessage, undefined);
    assert.equal(brain.currentTrigger.triggerType, 'proactive_chat');
    assert.match(brain.preset, /action.*skip.*不发送|不发送.*action.*skip/s);
    assert.equal(brain.interactionState.computedAt, 1784400000020);
    assert.equal(brain.interactionState.unansweredOutgoingCount, 0);
    assert.deepEqual(supervisor.recentMessages, brain.recentMessages);
    assert.deepEqual(supervisor.interactionState, brain.interactionState);
    assert.match(supervisor.preset, /监督.*skip|skip.*监督/s);
    assert.equal(store.listMessages('yuqi').filter(message => message.speakerType === 'user').length, 0);
  }, { clock: () => 1784400000020 });
});

test('automatic interaction state is recomputed from current stored messages instead of a stale trigger snapshot', async () => {
  await withFixture(normalOutputs(), async ({ store, codex, orchestrator }) => {
    store.putMessage({
      messageId: 'msg_user_live', turnId: 'turn_live_1', characterId: 'yuqi', speakerId: 'user',
      speakerType: 'user', recipientId: 'yuqi', content: '晚点聊', sentAt: 1784390000000, origin: 'phone'
    });
    store.putMessage({
      messageId: 'msg_yuqi_live', turnId: 'turn_live_2', characterId: 'yuqi', speakerId: 'yuqi',
      speakerType: 'character', recipientId: 'user', content: '好', sentAt: 1784395000000, origin: 'codex'
    });
    const trigger = triggerEnvelope(65);
    trigger.trigger.context = { snapshot: { lastMessageAt: 1, unansweredOutgoingCount: 0 } };
    await orchestrator.process(trigger);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    assert.equal(brain.interactionState.lastMessageId, 'msg_yuqi_live');
    assert.equal(brain.interactionState.unansweredOutgoingCount, 1);
    assert.equal(brain.interactionState.waitingForUserReply, true);
    assert.equal(brain.interactionState.silenceMsSinceLastMessage, 5_000_065);
    assert.equal(brain.interactionState.triggerSnapshotIsAdvisory, true);
  }, { clock: () => 1784400000065 });
});

test('a delayed direct reply is grounded in the actual processing time instead of the old message time', async () => {
  const sentAt = 1784713105609;
  const processingAt = sentAt + (2 * 60 * 60 * 1000) + (39 * 60 * 1000);
  const delayed = envelope(66, '请你喝一杯');
  delayed.createdAt = sentAt;
  delayed.message.sentAt = sentAt;

  await withFixture(normalOutputs(), async ({ codex, orchestrator }) => {
    await orchestrator.process(delayed);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    assert.equal(brain.interactionState.computedAt, processingAt);
    assert.equal(brain.interactionState.sourceOccurredAt, sentAt);
    assert.equal(brain.interactionState.processingDelayMs, 9_540_000);
    assert.equal(brain.interactionState.processingDelayText, '2小时39分钟');
    assert.equal(brain.interactionState.replyFromPresent, true);
  }, { clock: () => processingAt });
});

test('a payment reply commits the structured payment action beside visible text', async () => {
  const paymentEnvelope = envelope(67, '姜隽倚给虞栖发了一个红包：¥20.00，备注：请你喝一杯');
  paymentEnvelope.protocolVersion = 2;
  paymentEnvelope.kind = 'DIRECT_REPLY';
  paymentEnvelope.context = {
    payment: {
      kind: 'redpacket', amount: 20, note: '请你喝一杯',
      messageId: 'pay_1784713105609_3qb4xo', status: 'pending'
    }
  };
  const outputs = normalOutputs();
  outputs.brain = [JSON.stringify({
    action: 'send',
    reply: '你还真请啊😂\n那我就收了',
    paymentAction: 'received',
    usedFactIds: []
  })];

  await withFixture(outputs, async ({ codex, orchestrator }) => {
    const result = await orchestrator.process(paymentEnvelope);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    assert.equal(brain.currentPayment.status, 'pending');
    assert.equal(result.paymentAction, 'received');
    assert.equal(result.reply.content, '你还真请啊😂\n那我就收了');
  });
});

test('accepting the same envelope again requeues a transient brain timeout', async () => {
  const input = envelope(68, '睡了吗？');
  await withFixture(normalOutputs(), async ({ store, orchestrator }) => {
    const turn = orchestrator.accept(input);
    store.claimTurnById(turn.turnId, 'worker-a');
    store.advanceTurn(turn.turnId, 'memory_running', 'memory_done', {
      memoryPacketJson: JSON.stringify({ query: '睡了吗？', candidates: [] })
    });
    store.advanceTurn(turn.turnId, 'memory_done', 'brain_running');
    store.advanceTurn(turn.turnId, 'brain_running', 'failed', {
      errorJson: JSON.stringify({ name: 'CodexTurnError', message: 'Codex turn timed out' })
    });

    const retried = orchestrator.accept(input);

    assert.equal(retried.state, 'memory_done');
    assert.equal(retried.errorJson, null);
  });
});
