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

function rolePlanEnvelope(seq = 91) {
  const value = envelope(seq, '明天下午三点提醒我把稿子发给编辑');
  value.protocolVersion = 2;
  value.kind = 'DIRECT_REPLY';
  value.context = {
    scene: {
      playerName: '阿予',
      characterName: '虞栖',
      relationshipStage: { id: 'familiar', label: '熟悉', content: '已有共同经历。' },
      stageCatalog: [{ id: 'familiar', label: '熟悉', content: '已有共同经历。' }],
      rolePlanCatalog: 'plan_old | private_message | ACTIVE | 今天 18:00 | 提醒吃饭',
      roleScheduleContext: '今天 18:00 提醒吃饭。'
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
    if (text instanceof Error) throw text;
    return { text };
  }
}

function withFixture(outputs, run, {
  clock = () => 1784400000000,
  lifePlanningEnabled = false
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-orchestrator-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const presets = new PresetRegistry({ presetDir, store, clock: () => 1784400000000 });
  const codex = new FakeCodex(outputs);
  const orchestrator = new YuqiOrchestrator({
    store, presets, codex, workerId: 'test-worker', clock, lifePlanningEnabled
  });
  return Promise.resolve(run({ store, presets, codex, orchestrator })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test('chat brain plans the next life window only when the approved horizon is short', async () => {
  const startAt = 1784400000000;
  await withFixture({
    brain: [JSON.stringify({
      action: 'skip',
      reply: '',
      paymentAction: null,
      usedFactIds: [],
      momentAction: null,
      lifePlan: {
        planKey: 'yuqi-plan-window-1',
        episodes: [{
          episodeId: 'life_ai_work',
          kind: 'work',
          title: '把今天剩下的稿件处理完',
          startAt,
          endAt: startAt + 8 * 60 * 60_000
        }]
      },
      lifeAdjustment: null
    })]
  }, async ({ store, codex, orchestrator }) => {
    const first = await orchestrator.ensureLifePlan('yuqi', startAt);
    const second = await orchestrator.ensureLifePlan('yuqi', startAt + 60_000);

    assert.equal(first.planned, true);
    assert.equal(second.planned, false);
    assert.equal(store.listLifeEpisodes('yuqi')[0].episodeId, 'life_ai_work');
    assert.equal(codex.calls.length, 1);
    assert.equal(codex.calls[0].role, 'brain');
    assert.equal(codex.calls[0].input.task, 'plan_yuqi_life');
  }, { lifePlanningEnabled: true });
});

test('an invalid visible planning response is rejected and enters a ten-minute retry cooldown', async () => {
  const startAt = 1784400000000;
  await withFixture({
    brain: [JSON.stringify({
      action: 'send',
      reply: '我要开始规划生活了。',
      paymentAction: null,
      usedFactIds: [],
      momentAction: null,
      lifePlan: {
        planKey: 'bad-visible-plan',
        episodes: [{
          episodeId: 'life_bad_visible',
          kind: 'work',
          title: '处理稿件',
          startAt,
          endAt: startAt + 8 * 60 * 60_000
        }]
      },
      lifeAdjustment: null
    })]
  }, async ({ store, codex, orchestrator }) => {
    await assert.rejects(
      orchestrator.ensureLifePlan('yuqi', startAt),
      /planning task must stay silent/
    );
    const retry = await orchestrator.ensureLifePlan('yuqi', startAt + 60_000);

    assert.equal(retry.reason, 'retry_cooldown');
    assert.equal(store.listLifeEpisodes('yuqi').length, 0);
    assert.equal(codex.calls.length, 1);
  }, { lifePlanningEnabled: true });
});

const normalOutputs = () => ({
  memory: ['{"query":"你好","keywords":["你好"],"candidates":[]}'],
  brain: ['{"reply":"你好。我是虞栖，你呢？","usedFactIds":[]}'],
  supervisor: ['{"approved":true,"issues":[]}']
});

test('a capacity error switches the same role to its alternate model once', async () => {
  const capacityError = Object.assign(
    new Error('Selected model is at capacity. Please try a different model.'),
    { name: 'CodexTurnError' }
  );
  await withFixture({
    memory: [capacityError, '{"query":"你好","keywords":["你好"],"candidates":[]}']
  }, async ({ codex, orchestrator }) => {
    orchestrator.accept(envelope(97));
    const result = await orchestrator.runStructuredRole(
      'memory',
      { task: 'retrieve' },
      'turn_phone_97_memory',
      { model: 'gpt-5.6-sol', effort: 'medium' },
      'memory_deep'
    );

    assert.equal(result.query, '你好');
    assert.deepEqual(codex.calls.map(call => call.options.model), [
      'gpt-5.6-sol',
      'gpt-5.6-terra'
    ]);
  });
});

test('an account usage limit never rotates through alternate models', async () => {
  const usageError = Object.assign(
    new Error('You have 0 weighted tokens left. Purchase more credits.'),
    { name: 'CodexTurnError' }
  );
  await withFixture({
    memory: [usageError]
  }, async ({ codex, orchestrator }) => {
    orchestrator.accept(envelope(98));
    await assert.rejects(
      orchestrator.runStructuredRole(
        'memory',
        { task: 'retrieve' },
        'turn_phone_98_memory',
        { model: 'gpt-5.6-sol', effort: 'medium' },
        'memory_deep'
      ),
      /purchase more credits/i
    );
    assert.deepEqual(codex.calls.map(call => call.options.model), ['gpt-5.6-sol']);
  });
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
    priorTopic: {
      status: 'open',
      summary: 'Yuqi was waiting for the user to continue the topic',
      waitingOn: 'user',
      evidenceMessageIds: ['msg_phone_11'],
      reason: 'the preceding exchange contains an unanswered hook'
    },
    interruption: {
      requiresReaction: true,
      reactionReason: 'an open topic resumed after a meaningful gap'
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
    assert.equal(brain.lifeContext.current, null);
    assert.equal(brain.lifeContext.needsPlan, true);
    assert.deepEqual(memoryPacket.conversationFrame, frame);
    assert.equal(store.listFacts('yuqi').some(fact => fact.predicate === 'possibleIntent'), false);
  });
});

test('an approved reply may reschedule Yuqi own plan and the decision persists', async () => {
  const frame = conversationFrame();
  await withFixture({
    memory: [JSON.stringify({
      query: 'change plan', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: ['placeholder'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    store.putLifePlan('yuqi', [{
      episodeId: 'life_direct_personal',
      kind: 'personal',
      title: '散步',
      startAt: 1784428800000,
      endAt: 1784432400000
    }]);
    const personal = store.listLifeEpisodes('yuqi').find(item => item.kind === 'personal');
    codex.outputs.brain[0] = JSON.stringify({
      action: 'send',
      reply: '那我晚一点再去散步，先陪你把这件事聊完。',
      paymentAction: null,
      usedFactIds: [],
      momentAction: null,
      lifePlan: null,
      lifeAdjustment: {
        type: 'reschedule',
        targetEpisodeId: personal.episodeId,
        startAt: personal.startAt + 60 * 60_000,
        endAt: personal.endAt + 60 * 60_000,
        reason: '虞栖自己决定晚一点散步'
      }
    });

    await orchestrator.process(envelope(13, '你先别走，陪我说会儿话'));

    const adjusted = store.getLifeEpisode(personal.episodeId);
    assert.equal(adjusted.startAt, personal.startAt + 60 * 60_000);
    assert.equal(adjusted.sourceTurnId, 'turn_phone_13');
  });
});

test('a fast reply containing a life decision is upgraded to supervisor before commit', async () => {
  const frame = conversationFrame();
  await withFixture({
    memory: [JSON.stringify({
      query: 'stay', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: [JSON.stringify({
      action: 'send',
      reply: '那我把散步推迟一会儿。',
      paymentAction: null,
      usedFactIds: [],
      momentAction: null,
      lifePlan: null,
      lifeAdjustment: {
        type: 'reschedule',
        targetEpisodeId: 'life_fast_personal',
        startAt: 1784432400000,
        endAt: 1784436000000,
        reason: '虞栖自己决定晚一点散步'
      }
    })],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    store.putLifePlan('yuqi', [{
      episodeId: 'life_fast_personal',
      kind: 'personal',
      title: '散步',
      startAt: 1784428800000,
      endAt: 1784432400000
    }]);

    await orchestrator.process(envelope(14, '再陪我一会儿'));

    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor']);
    assert.equal(store.getTurn('turn_phone_14').route, 'fast_to_deep');
  });
});

test('a conversational plan decision is supervised, delivered as a hidden operation, and kept out of durable chat', async () => {
  const input = rolePlanEnvelope();
  const operations = [{
    op: 'create',
    type: 'private_message',
    source: 'accepted_request',
    title: '提醒把稿子发给编辑',
    intent: '到时间后结合最新上下文，自然提醒阿予把稿子发给编辑',
    sourceQuote: '明天下午三点提醒我把稿子发给编辑',
    evidenceMessageIds: [input.message.messageId],
    schedule: { kind: 'once', at: '2026-07-24T15:00:00+08:00' },
    timeConfidence: 'explicit'
  }];
  await withFixture({
    memory: [JSON.stringify({
      query: '提醒发稿', keywords: ['发稿'], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: conversationFrame()
    })],
    brain: [JSON.stringify({
      action: 'send',
      reply: '好，我记着。明天下午三点提醒你。',
      paymentAction: null,
      usedFactIds: [],
      momentAction: null,
      lifePlan: null,
      lifeAdjustment: null,
      rolePlanOperationsJson: JSON.stringify(operations)
    })],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(input);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    const supervisor = codex.calls.find(call => call.role === 'supervisor').input;
    const saved = store.listMessages('yuqi').find(message => message.speakerId === 'yuqi');

    assert.equal(brain.scene.rolePlanCatalog, input.context.scene.rolePlanCatalog);
    assert.equal(brain.scene.roleScheduleContext, input.context.scene.roleScheduleContext);
    assert.equal(supervisor.scene.rolePlanCatalog, input.context.scene.rolePlanCatalog);
    assert.deepEqual(supervisor.draft.rolePlanOperations, operations);
    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor']);
    assert.equal(store.getTurn(input.turnId).route, 'fast_to_deep');
    assert.ok(store.getTurn(input.turnId).routeReasons.includes('role_plan_decision'));
    assert.deepEqual(result.rolePlanOperations, operations);
    assert.doesNotMatch(result.reply.content, /<al_plan>/);
    assert.equal(saved.content, '好，我记着。明天下午三点提醒你。');
    assert.doesNotMatch(saved.content, /<al_plan>/);
  });
});

test('a supervised moment interaction commits its matching life adjustment', async () => {
  const momentTurn = triggerEnvelope(97);
  momentTurn.kind = 'MOMENT_INTERACTION';
  momentTurn.trigger.triggerType = 'moment_interaction';
  momentTurn.trigger.context.input = { moment: { id: 'moment_97', text: '今晚散步吗' } };
  await withFixture({
    memory: ['{"query":"moment","keywords":[],"candidates":[]}'],
    brain: [JSON.stringify({
      action: 'send',
      reply: '',
      paymentAction: null,
      usedFactIds: [],
      momentAction: {
        momentId: 'moment_97',
        like: false,
        comment: '晚一点去，先把手上的稿子收掉',
        replyToCommentId: null
      },
      lifePlan: null,
      lifeAdjustment: {
        type: 'reschedule',
        targetEpisodeId: 'life_moment_walk',
        startAt: 1784432400000,
        endAt: 1784436000000,
        reason: '虞栖决定晚一点散步'
      }
    })],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, orchestrator }) => {
    store.putLifePlan('yuqi', [{
      episodeId: 'life_moment_walk',
      kind: 'personal',
      title: '散步',
      startAt: 1784428800000,
      endAt: 1784432400000
    }]);

    await orchestrator.process(momentTurn);

    assert.equal(store.getLifeEpisode('life_moment_walk').startAt, 1784432400000);
    assert.equal(store.getLifeEpisode('life_moment_walk').sourceTurnId, momentTurn.turnId);
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
    assert.deepEqual(codex.calls.find(call => call.role === 'supervisor').input.conversationFrame, frame);
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

test('supervisor gives the next brain an executable stable rewrite contract and reviews its resolution', async () => {
  await withFixture({
    memory: ['{"query":"看什么书","keywords":[],"candidates":[]}'],
    brain: [
      '{"reply":"一本悬疑小说。","usedFactIds":[]}',
      JSON.stringify({
        reply: '我在看《长夜难明》，刚翻到一半。',
        usedFactIds: [],
        rewriteResolution: {
          resolvedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
          resolutionNotes: [{
            issueId: 'CURRENT_INTERACTION_MISS:1',
            strategy: '补全虞栖自己的低风险生活细节',
            result: '已经正面回答书名'
          }],
          formedCharacterFacts: [{
            predicate: 'currently_reading',
            summary: '虞栖正在读《长夜难明》',
            detailsJson: '{"title":"长夜难明"}',
            evidenceQuote: '我在看《长夜难明》'
          }]
        }
      })
    ],
    supervisor: [
      JSON.stringify({
        decision: 'rewrite',
        reviewedIssueIds: [],
        resolvedIssueIds: [],
        issues: [{
          issueId: 'CURRENT_INTERACTION_MISS:1',
          code: 'CURRENT_INTERACTION_MISS',
          severity: 'soft',
          message: '没有回答书名',
          mustPreserve: ['不编造用户事实'],
          mustChange: ['回答虞栖正在看的书'],
          allowedStrategies: ['补全虞栖自己的低风险生活细节'],
          acceptanceCriteria: ['正文出现具体书名']
        }]
      }),
      JSON.stringify({
        decision: 'approve',
        reviewedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
        resolvedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
        issues: []
      })
    ]
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(401, '你答应过如实说，现在在看什么书？'));
    const brainCalls = codex.calls.filter(call => call.role === 'brain');
    const supervisorCalls = codex.calls.filter(call => call.role === 'supervisor');

    assert.equal(
      brainCalls[1].input.rewriteContract.issues[0].issueId,
      'CURRENT_INTERACTION_MISS:1'
    );
    assert.deepEqual(
      supervisorCalls[1].input.rewriteResolution.resolvedIssueIds,
      ['CURRENT_INTERACTION_MISS:1']
    );
    assert.equal(result.reply.content, '我在看《长夜难明》，刚翻到一半。');
    assert.equal(
      store.listFacts('yuqi', { status: 'verified' })
        .some(fact => fact.predicate === 'currently_reading'),
      true
    );
  });
});

test('three soft supervisor rewrites never swallow a direct reply', async () => {
  const issue = message => JSON.stringify({
    decision: 'rewrite',
    reviewedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
    resolvedIssueIds: [],
    issues: [{
      issueId: 'CURRENT_INTERACTION_MISS:1',
      code: 'CURRENT_INTERACTION_MISS',
      severity: 'soft',
      message,
      mustPreserve: ['不编造用户事实'],
      mustChange: ['直接回应'],
      allowedStrategies: ['用虞栖自己的自然口吻回答'],
      acceptanceCriteria: ['可见正文回应当前消息']
    }]
  });
  await withFixture({
    memory: ['{"query":"如实汇报","keywords":[],"candidates":[]}'],
    brain: [
      '{"reply":"第一版。","usedFactIds":[]}',
      '{"reply":"第二版。","usedFactIds":[]}',
      '{"reply":"第三版，已经直接回答。","usedFactIds":[]}'
    ],
    supervisor: [
      issue('还不够直接'),
      issue('仍需调整'),
      issue('还可以更自然')
    ]
  }, async ({ store, orchestrator }) => {
    const result = await orchestrator.process(envelope(402, '你答应过如实汇报'));
    const diagnostic = store.db.prepare(
      'SELECT stage FROM diagnostics WHERE turn_id = ? ORDER BY diagnostic_id DESC LIMIT 1'
    ).get(result.turnId);

    assert.equal(result.reply.content, '第三版，已经直接回答。');
    assert.equal(store.getTurn(result.turnId).state, 'committed');
    assert.equal(diagnostic.stage, 'soft_issue_fallback_selected');
  });
});

test('a direct hard issue gets one final repair and still returns a complete visible reply', async () => {
  const issue = JSON.stringify({
    decision: 'rewrite',
    reviewedIssueIds: ['SPEAKER_ATTRIBUTION:1'],
    resolvedIssueIds: [],
    issues: [{
      issueId: 'SPEAKER_ATTRIBUTION:1',
      code: 'SPEAKER_ATTRIBUTION',
      severity: 'hard',
      message: '说话者归属仍需修复',
      mustPreserve: ['当前问题'],
      mustChange: ['只用虞栖自身口吻陈述'],
      allowedStrategies: ['删除错误归属并重写'],
      acceptanceCriteria: ['没有把虞栖的话挂到用户头上']
    }]
  });
  await withFixture({
    memory: ['{"query":"你刚说什么","keywords":[],"candidates":[]}'],
    brain: [
      '{"reply":"第一版。","usedFactIds":[]}',
      '{"reply":"第二版。","usedFactIds":[]}',
      '{"reply":"第三版。","usedFactIds":[]}',
      '{"reply":"我刚才说的是：我会认真听你讲。","usedFactIds":[]}'
    ],
    supervisor: [issue, issue, issue, issue]
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(403, '你答应过认真听，你刚刚说什么？'));
    const stages = store.db.prepare(
      'SELECT stage FROM diagnostics WHERE turn_id = ? ORDER BY diagnostic_id ASC'
    ).all(result.turnId).map(row => row.stage);

    assert.equal(result.reply.content, '我刚才说的是：我会认真听你讲。');
    assert.equal(codex.calls.filter(call => call.role === 'brain').length, 4);
    assert.ok(stages.includes('hard_repair_requested'));
    assert.ok(stages.includes('hard_repair_fallback_selected'));
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

test('a proactive moment is returned as a public post without entering private-chat memory', async () => {
  const momentTurn = triggerEnvelope(98);
  momentTurn.kind = 'PROACTIVE_MOMENT';
  momentTurn.trigger.triggerType = 'proactive_moment';
  await withFixture({
    memory: ['{"query":"moment post","keywords":[],"candidates":[]}'],
    brain: [JSON.stringify({
      action: 'send',
      reply: '下班路上的风，终于有点像夏天了。',
      paymentAction: null,
      usedFactIds: [],
      momentAction: null,
      lifePlan: null,
      lifeAdjustment: null,
      rolePlanOperationsJson: '[]'
    })],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(momentTurn);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    assert.equal(result.reply.content, '下班路上的风，终于有点像夏天了。');
    assert.match(brain.preset, /朋友圈动态正文/);
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

test('a scheduled role-plan turn exposes the exact plan occurrence to brain and supervisor', async () => {
  const trigger = triggerEnvelope(67);
  trigger.kind = 'ROLE_PLAN_CHAT';
  trigger.trigger.triggerType = 'role_plan_chat';
  trigger.trigger.context = {
    input: {
      planId: 'plan_tea',
      occurrenceId: 'plan_tea:1784400000067',
      scheduledFor: 1784400000067,
      executedAt: 1784400300067
    },
    snapshot: {
      rolePlan: {
        planId: 'plan_tea',
        type: 'private_message',
        source: 'accepted_request',
        intent: '提醒用户喝茶',
        schedule: { kind: 'daily', time: '15:00' }
      },
      timingContext: 'scheduledFor=1784400000067;executedAt=1784400300067;delayMs=300000'
    }
  };
  await withFixture(normalOutputs(), async ({ codex, orchestrator }) => {
    await orchestrator.process(trigger);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    const supervisor = codex.calls.find(call => call.role === 'supervisor').input;
    assert.equal(brain.currentRolePlanExecution.plan.planId, 'plan_tea');
    assert.equal(brain.currentRolePlanExecution.occurrence.occurrenceId, 'plan_tea:1784400000067');
    assert.equal(supervisor.currentRolePlanExecution.plan.intent, '提醒用户喝茶');
  }, { clock: () => 1784400300067 });
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
