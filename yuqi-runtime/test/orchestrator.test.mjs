import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as orchestratorModule from '../src/orchestrator.mjs';
import {
  hardValidateReply,
  normalizeBrainDraft,
  normalizeCanonicalBrainDraft,
  YuqiOrchestrator
} from '../src/orchestrator.mjs';
import { materializeBrainDraft } from '../src/cognition-contract.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { PresetRegistry } from '../src/preset-registry.mjs';
import { deriveAuthorityLineageKey, YuqiStore } from '../src/store.mjs';
import { resolvePipelinePair } from '../src/release-pair.mjs';
import { contentHash } from '../src/protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const presetDir = join(here, '..', 'presets');

test('legacy brain normalization accepts a cognition-v2 materialized draft', () => {
  const cognitionPacket = {
    packetChecksum: 'a'.repeat(64),
    cognitionResult: {
      relationshipStageReview: { base: null, phase: null },
      actionIntent: {
        paymentAction: null,
        momentIntent: null,
        rolePlanOperationsJson: '[]',
        lifePlan: null,
        lifeAdjustment: null
      }
    }
  };
  const materialized = materializeBrainDraft(cognitionPacket, {
    action: 'send',
    reply: '还真让你抢先了。',
    usedFactIds: [],
    rewriteResolution: null
  });
  const normalized = normalizeBrainDraft(materialized);
  assert.equal(normalized.action, 'send');
  assert.equal(normalized.reply, '还真让你抢先了。');
  assert.deepEqual(normalized.rolePlanOperations, []);
  assert.deepEqual(normalized.relationshipStageReview, { base: null, phase: null });
});

test('v3 authorized action intent is normalized into canonical moment and relationship sources', () => {
  const normalized = normalizeBrainDraft({
    action: 'send',
    reply: '是呀。',
    actionIntent: {
      moment: {
        momentId: 'moment_1',
        like: false,
        comment: '是呀。',
        replyToCommentId: 'comment_1'
      },
      relationshipReview: {
        base: {
          recommended: 'acquainted',
          confidence: 0.91,
          reason: '共同经历充分',
          evidenceMessageIds: ['msg_1', 'msg_2'],
          explicitMutualChange: false
        },
        phase: null
      }
    }
  });
  assert.deepEqual(normalized.momentAction, {
    momentId: 'moment_1',
    like: false,
    comment: '是呀。',
    replyToCommentId: 'comment_1'
  });
  assert.equal(normalized.relationshipStageReview.base.recommended, 'acquainted');
});

test('canonical social actions preserve combined intent and project relationship transitions', () => {
  const calls = [];
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal({ action }) {
      calls.push(structuredClone(action));
      return {
        targetKey: action.kind === 'moment_reply'
          ? `comment:${action.payload.replyToCommentId}`
          : action.kind === 'relationship_transition'
            ? 'relationship:yuqi'
            : `moment:${action.payload.momentId}`,
        targetRevision: `revision:${action.kind}`
      };
    }
  };
  const relationshipStageAction = {
    baseAction: {
      from: 'new',
      to: 'acquainted',
      label: '熟悉',
      reason: '已经积累了真实共同经历',
      confidence: 0.91,
      evidenceMessageIds: ['msg_1', 'msg_2'],
      explicitMutualChange: false,
      changedAt: 1000
    },
    phaseAction: null,
    expectedSceneRevision: 4,
    label: '熟悉',
    changedAt: 1000,
    from: 'new',
    to: 'acquainted',
    reason: 'legacy flattened fields must not enter canonical payload',
    confidence: 0.91,
    evidenceMessageIds: ['msg_1', 'msg_2'],
    explicitMutualChange: false
  };
  const actions = orchestrator.canonicalActionSet({ characterId: 'yuqi' }, {
    momentAction: {
      momentId: 'moment_1',
      like: true,
      comment: '我也喜欢这一张。',
      replyToCommentId: null
    },
    relationshipStageAction
  });
  assert.deepEqual(actions.map(action => action.kind), [
    'moment_comment',
    'relationship_transition'
  ]);
  assert.equal(actions[0].payload.like, true, 'comment classification must retain the like intent');
  assert.deepEqual(Object.keys(actions[0].payload), [
    'momentId', 'like', 'comment', 'replyToCommentId'
  ]);
  assert.deepEqual(actions[1].payload, {
    baseAction: relationshipStageAction.baseAction,
    phaseAction: null,
    expectedSceneRevision: 4,
    label: '熟悉',
    changedAt: 1000
  });
  assert.equal(calls.length, 2);

  const reply = orchestrator.canonicalActionSet({ characterId: 'yuqi' }, {
    momentAction: {
      momentId: 'moment_1',
      like: false,
      comment: '是呀。',
      replyToCommentId: 'comment_1'
    }
  });
  assert.equal(reply[0].kind, 'moment_reply');
  assert.equal(reply[0].targetKey, 'comment:comment_1');

  const like = orchestrator.canonicalActionSet({ characterId: 'yuqi' }, {
    momentAction: {
      momentId: 'moment_1',
      like: true,
      comment: '',
      replyToCommentId: null
    }
  });
  assert.equal(like[0].kind, 'moment_like');

  assert.throws(() => orchestrator.canonicalActionSet({ characterId: 'yuqi' }, {
    momentAction: {
      momentId: 'moment_1',
      like: true,
      comment: '这条回复同时要求点赞，不能静默丢失。',
      replyToCommentId: 'comment_1'
    }
  }), /moment reply cannot also like/i);
});

test('canonical v3 direct role-plan operations become store-resolved action descriptors', () => {
  const calls = [];
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal({ action }) {
      calls.push(action);
      return {
        targetKey: action.kind === 'role_plan_create'
          ? 'lineage_create:lineage_1:role_plan_create'
          : 'role_plan:plan_7',
        targetRevision: action.kind === 'role_plan_create' ? '1' : 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      };
    }
  };
  const actions = orchestrator.canonicalActionSet({
    protocolVersion: 3,
    rolloutKey: 'DIRECT_REPLY',
    authorityLineageKey: 'lineage_1'
  }, {
    rolePlanOperations: [{
      op: 'create', type: 'private_message', source: 'spoken',
      title: '提醒', intent: '提醒', schedule: { kind: 'once', at: '2026-07-24T15:00:00+08:00' },
      timeConfidence: 'explicit'
    }]
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'role_plan_create');
  assert.equal(actions[0].targetKey, 'lineage_create:lineage_1:role_plan_create');
  assert.equal(calls[0].payload.op, 'create');
});

test('all v3 role-plan lanes preserve canonical role-plan action descriptors', () => {
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal() {
      return { targetKey: 'role_plan:plan_7', targetRevision: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' };
    }
  };
  const operation = {
    op: 'cancel', planId: 'plan_7', source: 'private_decision'
  };
  for (const rolloutKey of [
    'ROLE_PLAN_CHAT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'
  ]) {
    assert.equal(orchestrator.canonicalActionSet({ protocolVersion: 3, rolloutKey }, {
      rolePlanOperations: [operation]
    })[0].kind, 'role_plan_cancel');
  }
});

test('canonical v3 role-plan normalization rejects malformed or over-limit operation lists', () => {
  assert.equal(typeof orchestratorModule.normalizeCanonicalV3RolePlanOperations, 'function');
  const operation = {
    op: 'cancel', planId: 'plan_7', source: 'private_decision'
  };
  assert.throws(() => orchestratorModule.normalizeCanonicalV3RolePlanOperations(
    Array.from({ length: 13 }, () => operation)
  ), /role plan operations|too many|authority conflict/i);
  assert.throws(() => orchestratorModule.normalizeCanonicalV3RolePlanOperations({ ...operation }),
    /role plan operations|array|authority conflict/i);
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal() {
      return { targetKey: 'role_plan:plan_7', targetRevision: 'sha256:' + 'a'.repeat(64) };
    }
  };
  assert.throws(() => orchestrator.canonicalRolePlanActionBundle(
    { protocolVersion: 3, rolloutKey: 'DIRECT_REPLY' },
    { rolePlanOperations: Array.from({ length: 13 }, () => operation) }
  ), /role plan operations|too many|authority conflict/i);
});

test('canonical action sources reject fields and native-type bypasses before target resolution', () => {
  let targetCalls = 0;
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal({ action }) {
      targetCalls += 1;
      return {
        targetKey: action.kind === 'relationship_transition'
          ? 'relationship:yuqi'
          : 'moment:moment_1',
        targetRevision: `revision:${action.kind}`
      };
    }
  };
  const moment = {
    momentId: 'moment_1', like: true, comment: '', replyToCommentId: null
  };
  const inheritedMoment = Object.assign(Object.create({ secret: 'prototype' }), moment);
  const relationship = {
    baseAction: {
      from: 'new', to: 'acquainted', label: '熟悉', reason: '共同经历充分',
      confidence: 0.9, evidenceMessageIds: ['msg_1', 'msg_2'],
      explicitMutualChange: false, changedAt: 2000
    },
    phaseAction: null,
    expectedSceneRevision: 4,
    label: '熟悉',
    changedAt: 2000,
    from: 'new',
    to: 'acquainted',
    reason: '共同经历充分',
    confidence: 0.9,
    evidenceMessageIds: ['msg_1', 'msg_2'],
    explicitMutualChange: false
  };
  const inheritedRelationship = Object.assign(
    Object.create({ secret: 'prototype' }),
    relationship
  );
  const invalidDrafts = [
    { actionIntent: { moment: { ...moment, secret: 'leak' } } },
    { momentAction: { ...moment, secret: 'leak' } },
    { momentAction: inheritedMoment },
    { momentAction: { ...moment, comment: 1 } },
    { momentAction: { ...moment, comment: ['array'] } },
    { relationshipStageAction: { ...relationship, expectedSceneRevision: '4' } },
    { relationshipStageAction: { ...relationship, secret: 'leak' } },
    { relationshipStageAction: inheritedRelationship }
  ];
  for (const draft of invalidDrafts) {
    assert.throws(
      () => normalizeCanonicalBrainDraft(draft),
      /canonical (moment|relationship)/i
    );
    if (draft.momentAction || draft.relationshipStageAction) {
      assert.throws(
        () => orchestrator.canonicalActionSet({ characterId: 'yuqi' }, draft),
        /canonical (moment|relationship)/i
      );
    }
  }
  assert.equal(targetCalls, 0);
  assert.equal(normalizeBrainDraft({ momentAction: { ...moment, comment: 1 } }).momentAction.comment, '1');
});

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
  lifePlanningEnabled = false,
  cognitivePipeline = null
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-orchestrator-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const presets = new PresetRegistry({ presetDir, store, clock: () => 1784400000000 });
  const codex = new FakeCodex(outputs);
  const orchestrator = new YuqiOrchestrator({
    store, presets, codex, workerId: 'test-worker', clock, lifePlanningEnabled, cognitivePipeline
  });
  return Promise.resolve(run({ store, presets, codex, orchestrator })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function commitProactiveResult(store, seq, action = 'skip') {
  const saved = store.submitTurn(triggerEnvelope(seq));
  store.claimTurnById(saved.turnId, 'history-worker');
  store.advanceTurn(saved.turnId, 'memory_running', 'memory_done', {
    memoryPacketJson: JSON.stringify({ query: 'historical proactive task' })
  });
  store.advanceTurn(saved.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(saved.turnId, 'brain_running', 'brain_done', {
    brainDraftJson: JSON.stringify({
      action,
      reply: action === 'skip' ? '' : '之前发出的一条主动消息',
      usedFactIds: []
    })
  });
  store.advanceTurn(saved.turnId, 'brain_done', 'approved');
  store.advanceTurn(saved.turnId, 'approved', 'committed', {
    replyJson: JSON.stringify({
      turnId: saved.turnId,
      action,
      reply: action === 'skip' ? null : { content: '之前发出的一条主动消息' }
    })
  });
  return saved;
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

test('legacy release provider runs memory brain supervisor as a side-effect-free draft', async () => {
  await withFixture(normalOutputs(), async ({ store, presets, codex, orchestrator }) => {
    const request = stagedEnvelope(198);
    const beforeChanges = Number(store.db.prepare('SELECT total_changes() AS value').get().value);

    const draft = await orchestrator.executeLegacyReleaseTurnDraft({
      release: {
        releaseId: 'stable-r2',
        presetVersion: presets.current().version
      },
      execution: {
        turn: {
          turnId: request.turnId,
          characterId: request.characterId,
          route: 'deep'
        },
        envelope: request,
        routeDecision: { route: 'deep' }
      },
      dryRun: false,
      capabilities: {
        visibleCommit: true,
        action: true,
        state: true,
        fact: true,
        memory: true,
        outbox: true,
        notification: true
      }
    });
    const afterChanges = Number(store.db.prepare('SELECT total_changes() AS value').get().value);

    assert.equal(draft.action, 'send');
    assert.equal(draft.reply, '你好。我是虞栖，你呢？');
    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor']);
    assert.equal(afterChanges, beforeChanges);
    assert.equal(store.getTurn(request.turnId), null);
  });
});

const JPEG_1X1 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

test('a direct image is shown to every role as a local image without leaking base64 into role text', async () => {
  await withFixture(normalOutputs(), async ({ codex, orchestrator }) => {
    const request = stagedEnvelope(199);
    request.message.content = '[图片]';
    request.message.attachments = [{
      attachmentId: 'att_msg_phone_199',
      messageId: request.message.messageId,
      kind: 'image',
      mime: 'image/jpeg',
      name: 'one.jpg',
      width: 1,
      height: 1,
      bytes: Buffer.from(JPEG_1X1, 'base64').length,
      dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
    }];
    orchestrator.accept(request);
    await orchestrator.run(request.turnId);

    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain']);
    for (const call of codex.calls) {
      assert.equal(call.options.localImagePaths.length, 1);
      assert.equal(existsSync(call.options.localImagePaths[0]), false, 'image temp file must be cleaned after the turn');
      assert.doesNotMatch(JSON.stringify(call.input), /base64,/);
    }
    const brainBatch = codex.calls.find(call => call.role === 'brain').input.currentUserBatch;
    const brainMessage = brainBatch.messages[0];
    assert.equal(brainMessage.attachments[0].attachmentId, 'att_msg_phone_199');
    assert.equal('dataUrl' in brainMessage.attachments[0], false);
    assert.equal(codex.calls.find(call => call.role === 'brain').input.currentUserMessage, undefined);
  });
});

test('every role receives one ordered current user batch without duplicating it in recent history', async () => {
  await withFixture({
    memory: ['{"query":"","keywords":[],"candidates":[]}'],
    brain: ['{"reply":"我听见了。","usedFactIds":[]}'],
    supervisor: ['{"approved":true,"issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const request = envelope(299, '算了');
    request.protocolVersion = 2;
    request.kind = 'DIRECT_REPLY';
    const first = {
      ...request.message,
      messageId: 'msg_phone_299_first',
      content: '你明明答应过我，我真的很失望',
      sentAt: request.message.sentAt - 1_000
    };
    request.context = {
      currentBatch: {
        batchId: 'batch_phone_299',
        messageIds: [first.messageId, request.message.messageId],
        startedAt: first.sentAt,
        committedAt: request.createdAt,
        messages: [first, request.message]
      }
    };
    store.putMessage({
      ...first,
      turnId: 'turn_legacy_msg_phone_299_first',
      characterId: request.characterId,
      origin: 'phone'
    });

    const result = await orchestrator.process(request);
    const roleCalls = codex.calls.filter(call => ['memory', 'brain', 'supervisor'].includes(call.role));
    const expectedIds = [first.messageId, request.message.messageId];

    assert.deepEqual(roleCalls.map(call => call.role), ['memory', 'brain', 'supervisor']);
    for (const call of roleCalls) {
      assert.deepEqual(
        call.input.currentUserBatch.messages.map(message => message.messageId),
        expectedIds
      );
      assert.equal(
        call.input.recentMessages.some(message => expectedIds.includes(message.messageId)),
        false
      );
      assert.equal(call.input.currentUserMessage, undefined);
    }
    assert.equal(
      JSON.parse(store.getTurn(result.turnId).memoryPacketJson).query,
      '你明明答应过我，我真的很失望\n算了'
    );
  });
});

test('an image in a non-final batch bubble is materialized for every role and removed from role JSON', async () => {
  await withFixture(normalOutputs(), async ({ codex, orchestrator }) => {
    const request = envelope(300, '然后呢');
    request.protocolVersion = 2;
    request.kind = 'DIRECT_REPLY';
    const first = {
      ...request.message,
      messageId: 'msg_phone_300_image',
      content: '[图片]',
      sentAt: request.message.sentAt - 1_000,
      attachments: [{
        attachmentId: 'att_msg_phone_300_image',
        messageId: 'msg_phone_300_image',
        kind: 'image',
        mime: 'image/jpeg',
        name: 'one.jpg',
        width: 1,
        height: 1,
        bytes: Buffer.from(JPEG_1X1, 'base64').length,
        dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
      }]
    };
    request.context = {
      currentBatch: {
        batchId: 'batch_phone_300',
        messageIds: [first.messageId, request.message.messageId],
        startedAt: first.sentAt,
        committedAt: request.createdAt,
        messages: [first, request.message]
      }
    };

    await orchestrator.process(request);

    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain']);
    for (const call of codex.calls) {
      assert.equal(call.options.localImagePaths.length, 1);
      assert.doesNotMatch(JSON.stringify(call.input), /base64,/);
      assert.equal(
        call.input.currentUserBatch.messages[0].attachments[0].attachmentId,
        'att_msg_phone_300_image'
      );
    }
  });
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
    const result = await orchestrator.runStructuredRole({
      turnId: 'turn_phone_97',
      role: 'memory',
      request: { task: 'retrieve' },
      clientUserMessageId: 'turn_phone_97_memory',
      profile: { model: 'gpt-5.6-sol', effort: 'medium' },
      stage: 'memory_deep'
    });

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
      orchestrator.runStructuredRole({
        turnId: 'turn_phone_98',
        role: 'memory',
        request: { task: 'retrieve' },
        clientUserMessageId: 'turn_phone_98_memory',
        profile: { model: 'gpt-5.6-sol', effort: 'medium' },
        stage: 'memory_deep'
      }),
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

test('ephemeral analysis becomes a compact brain contract and never becomes a durable fact', async () => {
  const frame = conversationFrame();
  await withFixture({
    memory: [JSON.stringify({
      query: 'continue', keywords: ['continue'], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: ['{"action":"send","reply":"Then I will keep going.","paymentAction":null,"usedFactIds":[],"momentAction":null}'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(11, 'go on'));
    const brain = codex.calls.find(call => call.role === 'brain').input;
    const memoryPacket = JSON.parse(store.getTurn(result.turnId).memoryPacketJson);

    assert.equal(brain.conversationFrame, undefined);
    assert.equal(brain.interactionContract.primaryIntent, frame.intentHypotheses[0].intent);
    assert.equal(brain.interactionContract.activeIssue, frame.priorTopic.summary);
    assert.equal(brain.lifeContext.current, null);
    assert.equal(brain.lifeContext.needsPlan, true);
    assert.equal(memoryPacket.conversationFrame.surfaceAct, frame.surfaceAct);
    assert.deepEqual(memoryPacket.conversationFrame.intentHypotheses, frame.intentHypotheses);
    assert.deepEqual(memoryPacket.conversationFrame.explicitBoundaries, []);
    assert.equal(memoryPacket.conversationFrame.recentCorrection.active, false);
    assert.deepEqual(brain.interactionContract, memoryPacket.interactionContract);
    assert.equal(store.listFacts('yuqi').some(fact => fact.predicate === 'possibleIntent'), false);
  });
});

test('dedicated runtime sends the same interaction contract to brain and supervisor', async () => {
  const frame = conversationFrame({
    intentHypotheses: [
      {
        intent: '询问虞栖此刻在做什么',
        confidence: 0.70,
        evidenceMessageIds: ['msg_phone_212']
      },
      {
        intent: '质问虞栖为何无视仍未解决的争执',
        confidence: 0.42,
        evidenceMessageIds: ['msg_phone_212']
      }
    ],
    priorTopic: {
      status: 'open',
      summary: '双方争执仍未解决',
      waitingOn: 'user',
      evidenceMessageIds: ['msg_phone_212'],
      reason: '用户仍在质疑争执期间的互动'
    },
    needsNuanceReview: true
  });
  await withFixture({
    memory: [JSON.stringify({
      query: '当前互动', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: ['{"action":"send","reply":"我知道你问的不只是我在做什么。","usedFactIds":[]}'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ codex, orchestrator }) => {
    const request = envelope(212, '你干嘛？');
    request.protocolVersion = 2;
    request.kind = 'DIRECT_REPLY';
    request.context = {
      scene: {
        relationshipStage: {
          id: 'new',
          phase: { id: 'conflict', label: '闹矛盾期' }
        }
      }
    };

    await orchestrator.process(request);
    const brain = codex.calls.find(call => call.role === 'brain').input;
    const supervisor = codex.calls.find(call => call.role === 'supervisor').input;

    assert.equal(brain.conversationFrame, undefined);
    assert.equal(brain.interactionContract.activeIssue, '双方争执仍未解决');
    assert.equal(brain.interactionContract.preserveAmbiguity, true);
    assert.deepEqual(supervisor.interactionContract, brain.interactionContract);
  });
});

test('structural silence commits before brain and does not consume the ordinary proactive skip budget', async () => {
  const frame = conversationFrame({
    intentHypotheses: [{
      intent: '在明确暂停后判断是否仍应主动联系',
      confidence: 0.92,
      evidenceMessageIds: ['msg_pause']
    }],
    interactionMode: 'unresolved_conflict_pause',
    initiative: {
      topicIntroducedBy: 'user',
      suggestedNextCarrier: 'user',
      reason: '用户明确要求条件变化后再谈'
    },
    priorTopic: {
      status: 'open',
      summary: '双方争执尚未解决',
      waitingOn: 'user',
      evidenceMessageIds: ['msg_pause'],
      reason: '用户要求暂停，当前没有新的回应'
    },
    explicitBoundaries: [{
      type: 'pause_requested',
      active: true,
      reason: '用户要求在虞栖愿意退让后再谈',
      evidenceMessageIds: ['msg_pause']
    }]
  });
  await withFixture({
    memory: [JSON.stringify({
      query: '主动联系', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: ['{"action":"skip","reply":"","usedFactIds":[]}'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    store.putMessage({
      messageId: 'msg_pause',
      turnId: 'turn_pause',
      characterId: 'yuqi',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '等你愿意稍作退让，我们再谈',
      sentAt: 1784399000000,
      origin: 'phone'
    });
    store.putMessage({
      messageId: 'msg_unanswered_yuqi',
      turnId: 'turn_unanswered_yuqi',
      characterId: 'yuqi',
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user',
      content: '我去改稿了',
      sentAt: 1784399500000,
      origin: 'codex'
    });
    const before = store.getProactiveChatDeliveryPolicy('yuqi');
    const result = await orchestrator.process(triggerEnvelope(213));
    const after = store.getProactiveChatDeliveryPolicy('yuqi');
    const diagnostic = store.db.prepare(
      "SELECT detail_json FROM diagnostics WHERE turn_id = ? AND stage = 'structural_silence'"
    ).get(result.turnId);

    assert.equal(result.action, 'skip');
    assert.deepEqual(codex.calls.map(call => call.role), ['memory']);
    assert.equal(before.usedSkips, 0);
    assert.equal(after.usedSkips, 0);
    assert.equal(JSON.parse(diagnostic.detail_json).action, 'structural_silence');
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

test('v3 direct role-plan confirmation is code-owned, explicit, and ordinal', () => {
  assert.equal(typeof orchestratorModule.renderRolePlanConfirmation, 'function');
  assert.equal(typeof orchestratorModule.requiresUserConfirmation, 'function');
  const operations = [{
    op: 'create',
    type: 'private_message',
    source: 'accepted_request',
    title: '提醒把稿子发给编辑',
    intent: '到时间后结合最新上下文，自然提醒阿予把稿子发给编辑',
    sourceQuote: '明天下午三点提醒我把稿子发给编辑',
    evidenceMessageIds: ['msg_phone_92'],
    schedule: { kind: 'once', at: '2026-07-24T15:00:00+08:00' },
    timeConfidence: 'explicit'
  }];
  assert.equal(orchestratorModule.requiresUserConfirmation({
    protocolVersion: 3, kind: 'DIRECT_REPLY', operations, targetSnapshots: [null]
  }), true);
  const rendered = orchestratorModule.renderRolePlanConfirmation(
    {
      kind: 'role_plan_create',
      targetKey: 'lineage_create:lineage_1:role_plan_create',
      targetRevision: '1',
      payload: operations[0]
    },
    null,
    'Asia/Shanghai'
  );
  assert.equal(rendered, '好的，我会在2026年7月24日（周五）15:00提醒你「提醒把稿子发给编辑」。');
  assert.doesNotMatch(rendered, /下周一|四点/);
});

test('v3 role-plan confirmation keeps inferred schedules silent while legacy lanes stay unchanged', () => {
  const inferred = {
    op: 'create', type: 'private_message', source: 'spoken', title: '提醒',
    intent: '明早问候', schedule: { kind: 'once', at: '2026-07-24T15:00:00+08:00' },
    timeConfidence: 'inferred'
  };
  assert.equal(orchestratorModule.requiresUserConfirmation({
    protocolVersion: 3, kind: 'DIRECT_REPLY', operations: [inferred], targetSnapshots: [null]
  }), false);
  for (const kind of ['ROLE_PLAN_CHAT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE']) {
    assert.equal(orchestratorModule.requiresUserConfirmation({
      protocolVersion: 3, kind, operations: [inferred], targetSnapshots: [null]
    }), false);
  }
  assert.equal(orchestratorModule.requiresUserConfirmation({
    protocolVersion: 2, kind: 'DIRECT_REPLY', operations: [inferred], targetSnapshots: [null]
  }), false);
});

test('v3 role-plan updates use the pinned target identity and render multiple operations in order', () => {
  const target = {
    planId: 'plan_7',
    source: 'user_created',
    title: '晨间提醒',
    targetRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  };
  const operations = [
    { op: 'update', planId: 'plan_7', patch: { title: '晨间提醒' }, source: 'user_created' },
    { op: 'cancel', planId: 'plan_7', source: 'user_created' }
  ];
  assert.equal(orchestratorModule.requiresUserConfirmation({
    protocolVersion: 3,
    kind: 'DIRECT_REPLY',
    operations,
    targetSnapshots: [target, target]
  }), true);
  assert.equal(
    orchestratorModule.renderRolePlanConfirmation({
      kind: 'role_plan_update', targetKey: 'role_plan:plan_7',
      targetRevision: target.targetRevision, payload: operations[0]
    }, target),
    '好的，已更新「晨间提醒」。'
  );
  assert.equal(
    orchestratorModule.renderRolePlanConfirmation({
      kind: 'role_plan_cancel', targetKey: 'role_plan:plan_7',
      targetRevision: target.targetRevision, payload: operations[1]
    }, target),
    '好的，已取消「晨间提醒」。'
  );
  assert.throws(() => orchestratorModule.requiresUserConfirmation({
    protocolVersion: 3,
    kind: 'DIRECT_REPLY',
    operations: [{ ...operations[1], planId: 'plan_forged', source: 'private_decision' }],
    targetSnapshots: [target]
  }), /role plan confirmation authority conflict/);
});

test('private role-plan operations keep their action without confirmation renderer, while mixed sources fail closed', () => {
  const privateOperation = { op: 'cancel', planId: 'plan_private', source: 'private_decision' };
  const target = {
    planId: 'plan_private', source: 'private_decision', title: '内部安排',
    targetRevision: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
  };
  assert.equal(orchestratorModule.requiresUserConfirmation({
    protocolVersion: 3, kind: 'DIRECT_REPLY', operations: [privateOperation], targetSnapshots: [target]
  }), false);
  assert.throws(() => orchestratorModule.requiresUserConfirmation({
    protocolVersion: 3,
    kind: 'DIRECT_REPLY',
    operations: [
      { op: 'cancel', planId: 'plan_private', source: 'private_decision' },
      { op: 'cancel', planId: 'plan_user', source: 'spoken' }
    ],
    targetSnapshots: [target, { ...target, planId: 'plan_user', source: 'spoken', title: '公开安排' }]
  }), /role plan confirmation authority conflict/);
});

test('role-plan confirmation renders every closed schedule kind deterministically', () => {
  const schedules = [
    ['once', { kind: 'once', at: '2026-07-24T15:00:00+08:00', endsAt: '2026-07-31T15:00:00+08:00' }, /2026年7月24日/, /截至2026年7月31日/],
    ['interval', { kind: 'interval', startsAt: '2026-07-24T15:00:00+08:00', intervalMs: 3600000, endsAt: '2026-07-31T15:00:00+08:00' }, /每60分钟/, /截至2026年7月31日/],
    ['daily', { kind: 'daily', time: '15:00', endsAt: '2026-07-31T15:00:00+08:00' }, /每天15:00/, /截至2026年7月31日/],
    ['weekly', { kind: 'weekly', weekdays: [1, 5], time: '15:00', endsAt: '2026-07-31T15:00:00+08:00' }, /每周周一、周五15:00/, /截至2026年7月31日/],
    ['monthly', { kind: 'monthly', day: 24, time: '15:00', endsAt: '2026-07-31T15:00:00+08:00' }, /每月24日15:00/, /截至2026年7月31日/]
  ];
  for (const [kind, schedule, expected, expectedEndsAt] of schedules) {
    const rendered = orchestratorModule.renderRolePlanConfirmation({
      kind: 'role_plan_create', targetKey: `create:${kind}`, targetRevision: '1',
      payload: {
        op: 'create', type: 'private_message', source: 'spoken', title: `安排-${kind}`,
        intent: '确定执行', schedule, timeConfidence: 'explicit'
      }
    }, null, 'Asia/Shanghai');
    assert.match(rendered, expected);
    assert.match(rendered, expectedEndsAt);
  }
  assert.match(orchestratorModule.renderRolePlanConfirmation({
    kind: 'role_plan_create', targetKey: 'create:tz', targetRevision: '1',
    payload: {
      op: 'create', type: 'private_message', source: 'spoken', title: '无时区',
      intent: '确定执行', schedule: { kind: 'once', at: '2026-07-24T15:00:00', endsAt: '2026-07-24T16:00:00' },
      timeConfidence: 'explicit'
    }
  }, null, 'Asia/Shanghai'), /2026年7月24日（周五）15:00/);
  assert.match(orchestratorModule.renderRolePlanConfirmation({
    kind: 'role_plan_create', targetKey: 'create:precision', targetRevision: '1',
    payload: {
      op: 'create', type: 'private_message', source: 'spoken', title: '精度',
      intent: '确定执行', schedule: { kind: 'interval', startsAt: '2026-07-24T07:00:00Z', intervalMs: 301000 },
      timeConfidence: 'explicit'
    }
  }, null, 'Asia/Shanghai'), /每301秒/);
  assert.match(orchestratorModule.renderRolePlanConfirmation({
    kind: 'role_plan_create', targetKey: 'create:precision-ms', targetRevision: '1',
    payload: {
      op: 'create', type: 'private_message', source: 'spoken', title: '毫秒精度',
      intent: '确定执行', schedule: { kind: 'interval', startsAt: '2026-07-24T07:00:00Z', intervalMs: 300001 },
      timeConfidence: 'explicit'
    }
  }, null, 'Asia/Shanghai'), /每300001毫秒/);
});

test('role-plan renderer consumes only the resolved descriptor and computes post-update text', () => {
  const target = {
    planId: 'plan_pinned', source: 'spoken', title: '旧备份',
    targetRevision: 'rev-7',
    schedule: { kind: 'daily', time: '08:00', endsAt: '2026-07-31T08:00:00+08:00' }
  };
  const canonicalPayload = {
    op: 'update', source: 'spoken',
    patch: {
      title: '服务器备份',
      schedule: { kind: 'daily', time: '09:00', endsAt: '2026-08-01T09:00:00+08:00' }
    },
    timeConfidence: 'explicit'
  };
  const descriptor = {
    kind: 'role_plan_update', targetKey: 'role_plan:plan_pinned', targetRevision: 'rev-7',
    payload: structuredClone(canonicalPayload)
  };
  // A raw caller patch is never passed to the renderer and cannot alter the
  // already-resolved descriptor.
  canonicalPayload.patch.title = 'caller forged';
  canonicalPayload.patch.schedule = {
    kind: 'once', at: '2030-01-01T00:00:00Z', endsAt: '2030-01-02T00:00:00Z'
  };
  const rendered = orchestratorModule.renderRolePlanConfirmation(descriptor, target, 'Asia/Shanghai');
  assert.match(rendered, /服务器备份/);
  assert.match(rendered, /每天09:00/);
  assert.match(rendered, /截至2026年8月1日/);
  assert.doesNotMatch(rendered, /caller forged|2030年/);
});

test('role-plan confirmation target snapshots come from resolver canonical targets, not envelope caller fields', () => {
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal() {
      return {
        targetKey: 'role_plan:plan_pinned',
        targetRevision: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        canonicalTarget: {
          planId: 'plan_pinned', source: 'spoken', title: '权威安排'
        }
      };
    }
  };
  const bundle = orchestrator.canonicalRolePlanActionBundle({
    protocolVersion: 3, rolloutKey: 'DIRECT_REPLY'
  }, {
    rolePlanOperations: [{ op: 'cancel', planId: 'plan_pinned', source: 'spoken' }]
  });
  assert.equal(bundle.targetSnapshots[0].title, '权威安排');
  assert.equal(bundle.targetSnapshots[0].planId, 'plan_pinned');
});

test('canonical role-plan bundle resolves each action once and freezes descriptor plus sidecar', () => {
  let resolverCalls = 0;
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal() {
      resolverCalls += 1;
      return resolverCalls === 1
        ? {
            targetKey: 'role_plan:plan_once',
            targetRevision: 'rev-1',
            canonicalTarget: {
              planId: 'plan_once', source: 'spoken', title: '旧标题',
              schedule: { kind: 'daily', time: '08:00', endsAt: '2026-08-01T08:00:00+08:00' }
            }
          }
        : {
            targetKey: 'role_plan:plan_changed',
            targetRevision: 'rev-2',
            canonicalTarget: {
              planId: 'plan_once', source: 'spoken', title: '不应采用',
              schedule: { kind: 'once', at: '2030-01-01T00:00:00Z' }
            }
          };
    }
  };
  const draft = {
    rolePlanOperations: [{
      op: 'update', planId: 'plan_once', source: 'spoken',
      patch: {
        title: '规范标题',
        schedule: { kind: 'daily', time: '09:00', endsAt: '2026-08-02T09:00:00+08:00' }
      },
      timeConfidence: 'explicit'
    }]
  };
  const bundle = orchestrator.canonicalResolvedActionBundle(
    { protocolVersion: 3, rolloutKey: 'DIRECT_REPLY' }, draft
  );
  draft.rolePlanOperations[0].patch.title = '草稿篡改';
  draft.rolePlanOperations[0].patch.schedule.time = '23:00';
  assert.equal(resolverCalls, 1);
  assert.equal(bundle.actions[0].targetKey, 'role_plan:plan_once');
  assert.equal(bundle.actions[0].targetRevision, 'rev-1');
  assert.equal(bundle.actions[0].payload.patch.title, '规范标题');
  assert.equal(bundle.rolePlan[0].targetSnapshot.title, '旧标题');
  assert.equal(bundle.rolePlan[0].targetSnapshot.targetRevision, 'rev-1');
  assert.equal(Object.isFrozen(bundle.actions[0]), true);
  assert.equal(Object.isFrozen(bundle.actions[0].payload.patch), true);
  const rendered = orchestratorModule.renderRolePlanConfirmation(
    bundle.actions[0], bundle.rolePlan[0].targetSnapshot, 'Asia/Shanghai'
  );
  assert.match(rendered, /规范标题/);
  assert.match(rendered, /每天09:00/);
  assert.throws(() => orchestratorModule.renderRolePlanConfirmation(
    bundle.actions[0], { ...bundle.rolePlan[0].targetSnapshot, targetRevision: 'rev-2' }, 'Asia/Shanghai'
  ), /target revision/);
});

test('runCanonicalReleaseTurn confirms explicit operations and silently commits inferred operations', async () => {
  const explicitOperation = {
    op: 'create', type: 'private_message', source: 'spoken', title: '发稿提醒',
    intent: '明天下午提醒发稿', schedule: { kind: 'once', at: '2026-07-24T15:00:00+08:00' },
    timeConfidence: 'explicit'
  };
  const inferredOperation = {
    op: 'create', type: 'private_message', source: 'spoken', title: '早安',
    intent: '明早问候', schedule: { kind: 'once', at: '2026-07-25T08:00:00+08:00' },
    timeConfidence: 'inferred'
  };
  const envelope = {
    protocolVersion: 3,
    turnId: 'turn_role_plan_v3',
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 1784400000000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_role_plan_v3', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
      content: '明天下午提醒我发稿', sentAt: 1784400000000
    },
    context: {}
  };
  const turn = {
    turnId: envelope.turnId,
    protocolVersion: 3,
    resultAuthorityVersion: 1,
    rolloutKey: 'DIRECT_REPLY',
    envelopeJson: JSON.stringify(envelope),
    authorityLineageKey: 'lineage_role_plan_v3',
    characterId: 'yuqi',
    laneKey: 'direct',
    inputUserBatchId: envelope.message.messageId,
    inputVisibilitySequence: 1,
    inputClearEpoch: 0,
    agencySnapshotChecksum: 'a'.repeat(64),
    authoritativeReleaseId: 'cognition-v3',
    authoritativePipelineChecksum: 'b'.repeat(64),
    comparisonReleaseId: null,
    comparisonMode: 'none',
    state: 'open',
    turnRevision: 1
  };
  let committed;
  let resolverCalls = 0;
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.clock = () => 1784400000000;
  orchestrator.turnImagePaths = new Map();
  orchestrator.store = {
    getTurn() { return turn; },
    getTurnAuthorityLineage() {
      return { state: 'open', revision: 1, latestTurnId: turn.turnId, committedGroupId: null };
    },
    assertCanonicalTurnInputAuthorityInternal({ storedTurn, incomingEnvelope }) {
      assert.equal(contentHash(incomingEnvelope), contentHash(JSON.parse(storedTurn.envelopeJson)));
    },
    readCanonicalCommitOutcomeInternal() { return null; },
    getCurrentUserBatch() { return null; },
    readAgencyAuthoritySnapshotInternal() {
      return { checksum: turn.agencySnapshotChecksum, constraints: [], preferenceFacts: [], stances: [] };
    },
    getCognitiveState() { return { revision: 0 }; },
    getInteractionLane() { return { revision: 0 }; },
    resolveCanonicalActionTargetInternal() {
      resolverCalls += 1;
      return {
        targetKey: 'lineage_create:lineage_role_plan_v3:role_plan_create',
        targetRevision: resolverCalls === 1 ? '1' : 'changed',
        canonicalTarget: { lineageKey: turn.authorityLineageKey, actionKind: 'role_plan_create' }
      };
    }
  };
  orchestrator.releaseExecutor = {
    async executeTurn() {
      return {
        draft: {
          action: 'send', reply: '模型自由回复不应提交',
          rolePlanOperations: [explicitOperation, inferredOperation]
        }
      };
    }
  };
  orchestrator.commitCanonicalVisibleResult = input => {
    committed = input;
    return { status: 'committed', visibleGroupId: 'group_role_plan_v3' };
  };
  const result = await orchestrator.runCanonicalReleaseTurn(turn);
  assert.equal(result.status, 'committed');
  assert.equal(resolverCalls, 2);
  assert.equal(committed.visibleGroup.items[0].content,
    '好的，我会在2026年7月24日（周五）15:00提醒你「发稿提醒」。');
  assert.doesNotMatch(committed.visibleGroup.items[0].content, /早安|08:00/);
  assert.equal(committed.actionSet.length, 2);
  assert.equal(committed.actionSet[0].kind, 'role_plan_create');
  assert.equal(committed.actionSet[0].payload.op, 'create');
  assert.equal(committed.actionSet[1].kind, 'role_plan_create');
  assert.equal(committed.actionSet[1].payload.timeConfidence, 'inferred');
  assert.equal(committed.generationFingerprint, generationFingerprint({
    roleId: turn.characterId,
    laneKey: turn.laneKey,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    visibleGroup: committed.visibleGroup,
    actionSet: committed.actionSet,
    contextRevision: turn.agencySnapshotChecksum
  }));
});

test('runCanonicalReleaseTurn preserves a direct reply while committing an inferred schedule', async () => {
  const operation = {
    op: 'create', type: 'private_message', source: 'spoken', title: '早安',
    intent: '明天早上发早安', schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' },
    timeConfidence: 'inferred'
  };
  const envelope = {
    protocolVersion: 3,
    turnId: 'turn_inferred_role_plan_v3',
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 1786646002626,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_inferred_role_plan_v3', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
      content: '晚安虞姐姐 明天我还能收到你的早安吗？🥺', sentAt: 1786646002626
    },
    context: {}
  };
  const turn = {
    turnId: envelope.turnId,
    protocolVersion: 3,
    resultAuthorityVersion: 1,
    rolloutKey: 'DIRECT_REPLY',
    envelopeJson: JSON.stringify(envelope),
    authorityLineageKey: 'lineage_inferred_role_plan_v3',
    characterId: 'yuqi',
    laneKey: 'direct',
    inputUserBatchId: envelope.message.messageId,
    inputVisibilitySequence: 1,
    inputClearEpoch: 0,
    agencySnapshotChecksum: 'a'.repeat(64),
    authoritativeReleaseId: 'cognition-v3',
    authoritativePipelineChecksum: 'b'.repeat(64),
    comparisonReleaseId: null,
    comparisonMode: 'none',
    state: 'open',
    turnRevision: 1
  };
  let committed;
  let resolverCalls = 0;
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.clock = () => 1786646002626;
  orchestrator.turnImagePaths = new Map();
  orchestrator.store = {
    getTurn() { return turn; },
    getTurnAuthorityLineage() {
      return { state: 'open', revision: 1, latestTurnId: turn.turnId, committedGroupId: null };
    },
    assertCanonicalTurnInputAuthorityInternal({ storedTurn, incomingEnvelope }) {
      assert.equal(contentHash(incomingEnvelope), contentHash(JSON.parse(storedTurn.envelopeJson)));
    },
    readCanonicalCommitOutcomeInternal() { return null; },
    getCurrentUserBatch() { return null; },
    readAgencyAuthoritySnapshotInternal() {
      return { checksum: turn.agencySnapshotChecksum, constraints: [], preferenceFacts: [], stances: [] };
    },
    getCognitiveState() { return { revision: 0 }; },
    getInteractionLane() { return { revision: 0 }; },
    resolveCanonicalActionTargetInternal() {
      resolverCalls += 1;
      return {
        targetKey: 'lineage_create:lineage_inferred_role_plan_v3:role_plan_create',
        targetRevision: '1',
        canonicalTarget: { lineageKey: turn.authorityLineageKey, actionKind: 'role_plan_create' }
      };
    }
  };
  orchestrator.releaseExecutor = {
    async executeTurn() {
      return {
        draft: {
          action: 'send',
          reply: '嗯，明天醒了就来找你。晚安。',
          rolePlanOperations: [operation]
        }
      };
    }
  };
  orchestrator.commitCanonicalVisibleResult = input => {
    committed = input;
    return { status: 'committed', visibleGroupId: 'group_inferred_role_plan_v3' };
  };

  const result = await orchestrator.runCanonicalReleaseTurn(turn);

  assert.equal(result.status, 'committed');
  assert.equal(resolverCalls, 1);
  assert.equal(committed.visibleGroup.items[0].content, '嗯，明天醒了就来找你。晚安。');
  assert.equal(committed.actionSet.length, 1);
  assert.equal(committed.actionSet[0].kind, 'role_plan_create');
  assert.equal(committed.actionSet[0].payload.timeConfidence, 'inferred');
  assert.equal(committed.actionSet[0].payload.schedule.at, '2026-08-15T08:00:00+08:00');
});

test('canonical v3 direct provider receives formal relationship scene plus separate expression sidecar', async () => {
  const envelope = {
    protocolVersion: 3,
    turnId: 'turn_relationship_views',
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 1784400000000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_relationship_views', speakerId: 'user', speakerType: 'user',
      recipientId: 'yuqi', content: '继续聊', sentAt: 1784400000000
    },
    context: {
      scene: {
        relationshipStage: {
          base: { id: 'familiar', label: '熟悉', content: '还没到阶段，不允许靠近' },
          phase: { id: 'normal', label: '正常', content: '阶段门槛词不应泄漏' }
        },
        stageCatalog: [{ id: 'familiar', label: '熟悉', content: '还没到阶段，不允许靠近' }],
        phaseCatalog: [{ id: 'normal', label: '正常', content: '阶段门槛词不应泄漏' }],
        stagePersonaRevision: 12,
        effectiveStagePersona: '温和直接，不是硬约束',
        stagePersona: { toneTendencies: ['温和', '直接'], forbiddenMoves: ['private'] }
      }
    }
  };
  const turn = {
    turnId: envelope.turnId,
    protocolVersion: 3,
    resultAuthorityVersion: 1,
    rolloutKey: 'DIRECT_REPLY',
    envelopeJson: JSON.stringify(envelope),
    authorityLineageKey: 'lineage_relationship_views',
    characterId: 'yuqi',
    laneKey: 'conversation:yuqi',
    inputUserBatchId: envelope.message.messageId,
    turnRevision: 1,
    agencySnapshotChecksum: 'a'.repeat(64),
    authoritativeReleaseId: 'release_v3',
    authoritativePipelineChecksum: 'b'.repeat(64),
    comparisonReleaseId: null,
    comparisonMode: 'none',
    inputVisibilitySequence: 1,
    inputClearEpoch: 0,
    state: 'queued'
  };
  let capturedScene;
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.clock = () => 1784400000000;
  orchestrator.turnImagePaths = new Map();
  orchestrator.store = {
    getTurn() { return turn; },
    getTurnAuthorityLineage() {
      return { state: 'open', revision: 1, latestTurnId: turn.turnId, committedGroupId: null };
    },
    assertCanonicalTurnInputAuthorityInternal({ storedTurn, incomingEnvelope }) {
      assert.equal(contentHash(incomingEnvelope), contentHash(JSON.parse(storedTurn.envelopeJson)));
    },
    readCanonicalCommitOutcomeInternal() { return null; },
    getCurrentUserBatch() { return null; },
    readAgencyAuthoritySnapshotInternal() {
      return { checksum: turn.agencySnapshotChecksum, constraints: [], preferenceFacts: [], stances: [] };
    },
    getCognitiveState() { return { revision: 0 }; },
    getInteractionLane() { return { revision: 0 }; }
  };
  orchestrator.releaseExecutor = {
    async executeTurn({ execution }) {
      capturedScene = structuredClone(execution.scene);
      return { draft: { action: 'send', reply: '继续聊', rolePlanOperations: [] } };
    }
  };
  orchestrator.canonicalVisibleGroup = () => ({
    items: [{ itemId: 'item_relationship_views', kind: 'text', content: '继续聊' }]
  });
  orchestrator.commitCanonicalVisibleResult = () => ({
    status: 'committed', visibleGroupId: 'group_relationship_views'
  });

  const result = await orchestrator.runCanonicalReleaseTurn(turn);
  assert.equal(result.status, 'committed');
  assert.deepEqual(capturedScene.relationshipStage, {
    base: { id: 'familiar' },
    phase: { id: 'normal' },
    formalFacts: [],
    allowedFormalTransitions: [],
    stagePersonaRevision: 12
  });
  assert.deepEqual(capturedScene.relationshipExpression, {
    formalFacts: [],
    toneTendencies: [
      '温和', '直接', '温和直接，不是硬约束', '还没到阶段，不允许靠近'
    ]
  });
  assert.equal(JSON.stringify(capturedScene.relationshipStage).includes('还没到阶段'), false);
  assert.equal(JSON.stringify(capturedScene).includes('forbiddenMoves'), false);
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
    const supervisorFrame = codex.calls.find(call => call.role === 'supervisor').input.conversationFrame;
    assert.equal(supervisorFrame.interactionMode, frame.interactionMode);
    assert.deepEqual(supervisorFrame.intentHypotheses, frame.intentHypotheses);
    assert.deepEqual(supervisorFrame.explicitBoundaries, []);
    assert.equal(supervisorFrame.recentCorrection.active, false);
    assert.equal(codex.calls.filter(call => call.role === 'memory').length, 1);
    assert.equal(store.getTurn(result.turnId).route, 'fast_to_deep');
    assert.ok(store.getTurn(result.turnId).routeReasons.includes('conversation_nuance'));
  });
});

test('an interaction contract requiring ambiguity handling upgrades a fast turn to supervisor', async () => {
  const frame = conversationFrame({
    intentHypotheses: [
      {
        intent: '接受表面提议',
        confidence: 0.58,
        evidenceMessageIds: ['msg_phone_214']
      },
      {
        intent: '带着未解决情绪暂时结束争论',
        confidence: 0.46,
        evidenceMessageIds: ['msg_phone_214']
      }
    ],
    needsNuanceReview: false,
    ambiguities: ['表面同意与带情绪收束同时可能']
  });
  await withFixture({
    memory: [JSON.stringify({
      query: '继续互动', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: ['{"action":"send","reply":"行。","usedFactIds":[]}'],
    supervisor: ['{"decision":"approve","issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    await orchestrator.process(envelope(214, '行'));

    assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor']);
    assert.equal(store.getTurn('turn_phone_214').route, 'fast_to_deep');
    assert.ok(store.getTurn('turn_phone_214').routeReasons.includes('interaction_contract'));
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

test('keeps 200 evidence messages but gives brain and supervisor 20 complete history messages', async () => {
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
    assert.equal(brainInput.recentMessages.length, 20);
    assert.equal(supervisorInput.recentMessages.length, 20);
    assert.equal(brainInput.recentMessages.some(message => message.messageId === input.message.messageId), false);
    assert.equal(supervisorInput.recentMessages.some(message => message.messageId === input.message.messageId), false);
    assert.equal(brainInput.currentUserBatch.sourceMessageId, input.message.messageId);
    assert.deepEqual(brainInput.currentUserBatch.messages.map(message => message.messageId), [input.message.messageId]);
    assert.equal(brainInput.currentUserMessage, undefined);
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

test('report-like dialogue receives an executable contract-aware rewrite instead of approval', async () => {
  const frame = conversationFrame({
    intentHypotheses: [{
      intent: '要求虞栖正视仍未解决的互动问题',
      confidence: 0.94,
      evidenceMessageIds: ['msg_phone_404']
    }],
    priorTopic: {
      status: 'open',
      summary: '双方仍在处理争执',
      waitingOn: 'yuqi',
      evidenceMessageIds: ['msg_phone_404'],
      reason: '用户要求虞栖回应当前矛盾'
    },
    needsNuanceReview: true
  });
  await withFixture({
    memory: [JSON.stringify({
      query: '回应争执', keywords: [], candidates: [], requiresDeepMemory: false,
      escalationReasons: [], speakerAmbiguity: false, commitmentRisk: false,
      relationshipStageReview: null, conversationFrame: frame
    })],
    brain: [
      '{"action":"send","reply":"我想继续说话，又不想面对争执，所以显得像在装没事。","usedFactIds":[]}',
      JSON.stringify({
        action: 'send',
        reply: '……我知道。刚才是我在躲。',
        usedFactIds: [],
        rewriteResolution: {
          resolvedIssueIds: ['DIALOGUE_META_NARRATION:1'],
          resolutionNotes: [{
            issueId: 'DIALOGUE_META_NARRATION:1',
            strategy: '只留下当下承认，不再总结互动机制',
            visibleResult: '正文直接承认回避'
          }]
        }
      })
    ],
    supervisor: [
      JSON.stringify({
        decision: 'rewrite',
        issues: [{
          issueId: 'DIALOGUE_META_NARRATION:1',
          code: 'DIALOGUE_META_NARRATION',
          severity: 'soft',
          message: '草稿在总结自己的互动行为',
          mustPreserve: ['仍然在意并想继续联系'],
          mustChange: ['删除对回复策略和外在观感的完整因果总结'],
          allowedStrategies: ['只留下当下承认、停顿或回避'],
          acceptanceCriteria: ['正文不再概括自己为什么这样说以及看起来像什么']
        }]
      }),
      JSON.stringify({
        decision: 'approve',
        reviewedIssueIds: ['DIALOGUE_META_NARRATION:1'],
        resolvedIssueIds: ['DIALOGUE_META_NARRATION:1'],
        issues: []
      })
    ]
  }, async ({ codex, orchestrator }) => {
    const result = await orchestrator.process(envelope(404, '我们还在吵架吧，你到底在干嘛？'));
    const brainCalls = codex.calls.filter(call => call.role === 'brain');
    const supervisorCalls = codex.calls.filter(call => call.role === 'supervisor');

    assert.equal(
      brainCalls[1].input.rewriteContract.issues[0].code,
      'DIALOGUE_META_NARRATION'
    );
    assert.deepEqual(
      brainCalls[1].input.interactionContract,
      brainCalls[0].input.interactionContract
    );
    assert.deepEqual(
      supervisorCalls[1].input.interactionContract,
      supervisorCalls[0].input.interactionContract
    );
    assert.equal(result.reply.content, '……我知道。刚才是我在躲。');
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

test('proactive skip budget rewrites a forbidden brain skip into a visible message', async () => {
  await withFixture({
    memory: ['{"query":"check in","keywords":[],"candidates":[]}'],
    brain: [
      '{"action":"skip","reply":"","usedFactIds":[]}',
      '{"action":"send","reply":"我刚忙完，忽然想起你。","usedFactIds":[],"rewriteResolution":{"resolvedIssueIds":["PROACTIVE_DELIVERY_REQUIRED:1"]}}'
    ],
    supervisor: ['{"decision":"approve","approved":true,"issues":[]}']
  }, async ({ store, codex, orchestrator }) => {
    commitProactiveResult(store, 70, 'skip');

    const result = await orchestrator.process(triggerEnvelope(71));
    const brainCalls = codex.calls.filter(call => call.role === 'brain');

    assert.equal(brainCalls[0].input.deliveryPolicy.skipAllowed, false);
    assert.equal(brainCalls[1].input.task, 'rewrite_as_yuqi');
    assert.equal(
      brainCalls[1].input.rewriteContract.issues[0].code,
      'PROACTIVE_DELIVERY_REQUIRED'
    );
    assert.equal(result.action, 'send');
    assert.equal(result.reply.content, '我刚忙完，忽然想起你。');
  });
});

test('proactive skip budget turns a supervisor skip into actionable brain feedback', async () => {
  await withFixture({
    memory: ['{"query":"check in","keywords":[],"candidates":[]}'],
    brain: [
      '{"action":"send","reply":"刚才想发点什么，又觉得算了。","usedFactIds":[]}',
      '{"action":"send","reply":"忙完抬头的时候，窗外居然已经黑了。","usedFactIds":[],"rewriteResolution":{"resolvedIssueIds":["PROACTIVE_DELIVERY_REQUIRED:1"]}}'
    ],
    supervisor: [
      '{"decision":"skip","approved":false,"issues":[]}',
      '{"decision":"approve","approved":true,"issues":[]}'
    ]
  }, async ({ store, codex, orchestrator }) => {
    commitProactiveResult(store, 72, 'skip');

    const result = await orchestrator.process(triggerEnvelope(73));
    const brainCalls = codex.calls.filter(call => call.role === 'brain');

    assert.equal(brainCalls[1].input.task, 'rewrite_as_yuqi');
    assert.equal(
      brainCalls[1].input.supervisorIssues[0].code,
      'PROACTIVE_DELIVERY_REQUIRED'
    );
    assert.equal(result.action, 'send');
    assert.equal(result.reply.content, '忙完抬头的时候，窗外居然已经黑了。');
  });
});

test('proactive skip budget selects the last visible draft after repeated soft supervisor skips', async () => {
  await withFixture({
    memory: ['{"query":"check in","keywords":[],"candidates":[]}'],
    brain: [
      '{"action":"send","reply":"第一版主动消息","usedFactIds":[]}',
      '{"action":"send","reply":"第二版主动消息","usedFactIds":[],"rewriteResolution":{"resolvedIssueIds":["PROACTIVE_DELIVERY_REQUIRED:1"]}}',
      '{"action":"send","reply":"第三版主动消息","usedFactIds":[],"rewriteResolution":{"resolvedIssueIds":["PROACTIVE_DELIVERY_REQUIRED:1"]}}'
    ],
    supervisor: [
      '{"decision":"skip","approved":false,"issues":[]}',
      '{"decision":"skip","approved":false,"issues":[]}',
      '{"decision":"skip","approved":false,"issues":[]}'
    ]
  }, async ({ store, orchestrator }) => {
    commitProactiveResult(store, 74, 'skip');

    const result = await orchestrator.process(triggerEnvelope(75));
    const diagnostics = store.db.prepare(
      'SELECT stage FROM diagnostics WHERE turn_id = ? ORDER BY diagnostic_id ASC'
    ).all(result.turnId);

    assert.equal(result.action, 'send');
    assert.equal(result.reply.content, '第三版主动消息');
    assert.ok(diagnostics.some(
      entry => entry.stage === 'proactive_soft_fallback_selected'
    ));
  });
});

test('proactive skip budget blocks hard safety failures instead of committing silence', async () => {
  await withFixture({
    memory: ['{"query":"check in","keywords":[],"candidates":[]}'],
    brain: [
      '{"action":"send","reply":"第一版含内部格式","usedFactIds":[]}',
      '{"action":"send","reply":"第二版仍含内部格式","usedFactIds":[]}',
      '{"action":"send","reply":"第三版仍含内部格式","usedFactIds":[]}'
    ],
    supervisor: [
      '{"decision":"rewrite","issues":[{"code":"INTERNAL_FORMAT_LEAKAGE","severity":"hard","message":"仍包含内部格式"}]}',
      '{"decision":"rewrite","issues":[{"code":"INTERNAL_FORMAT_LEAKAGE","severity":"hard","message":"仍包含内部格式"}]}',
      '{"decision":"rewrite","issues":[{"code":"INTERNAL_FORMAT_LEAKAGE","severity":"hard","message":"仍包含内部格式"}]}'
    ]
  }, async ({ store, orchestrator }) => {
    commitProactiveResult(store, 76, 'skip');
    const current = triggerEnvelope(77);

    await assert.rejects(
      orchestrator.process(current),
      /PROACTIVE_DELIVERY_BLOCKED/
    );
    assert.equal(store.getTurn(current.turnId).state, 'failed');
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
    assert.equal(brain.deliveryPolicy, undefined);
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
    assert.equal(brain.currentUserBatch, undefined);
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
    assert.equal(brain.deliveryPolicy, undefined);
    assert.equal(supervisor.deliveryPolicy, undefined);
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

test('only a turn pinned active uses cognition for a direct reply and preserves structured payment', async () => {
  await withFixture({}, async ({ store, orchestrator, codex }) => {
    const value = envelope(120, '请你喝一杯');
    value.protocolVersion = 2;
    value.kind = 'DIRECT_REPLY';
    value.context = {
      payment: {
        kind: 'redpacket',
        amount: 20,
        note: '请你喝一杯',
        messageId: value.message.messageId,
        status: 'pending'
      }
    };
    const saved = store.submitTurn(value, {
      pipelineMode: 'active',
      presetVersion: '2.0.0',
      annotationSnapshot: { ids: ['annotation_live'] }
    });
    store.setTurnRoute(saved.turnId, 'fast', ['simple_direct']);
    let calls = 0;
    orchestrator.cognitivePipeline = {
      async runForeground({ turn }) {
        calls += 1;
        let current = store.getTurn(turn.turnId);
        if (current.state === 'queued') {
          store.advanceTurn(turn.turnId, 'queued', 'memory_running');
          current = store.getTurn(turn.turnId);
        }
        if (current.state === 'memory_running') {
          store.advanceTurn(turn.turnId, 'memory_running', 'memory_done', {
            memoryPacketJson: JSON.stringify({
              packetType: 'cognition-v2',
              query: '红包',
              keywords: ['红包'],
              relationshipStageAction: null,
              packet: {
                packetChecksum: 'packet',
                cognitionResult: {
                  conversationFrame: {
                    activeHooks: [{ summary: '红包已经收下', waitingOn: 'none' }],
                    explicitBoundaries: [],
                    recentCorrection: { active: false }
                  },
                  selfState: {
                    mood: '开心',
                    moodCause: '收到姜隽倚的红包',
                    intensity: 0.6,
                    bodyState: '正常',
                    attention: '聊天',
                    ownNeed: '继续聊两句',
                    stanceTowardUser: '亲近'
                  },
                  decision: { shouldRespond: true }
                }
              }
            })
          });
        }
        return {
          draft: {
            action: 'send',
            reply: '那我就收下了。',
            paymentAction: 'received',
            usedFactIds: [],
            momentAction: null,
            lifePlan: null,
            lifeAdjustment: null,
            rolePlanOperationsJson: '[]',
            rewriteResolution: null
          }
        };
      }
    };

    const result = await orchestrator.run(saved.turnId);
    assert.equal(calls, 1);
    assert.equal(result.reply.content, '那我就收下了。');
    assert.equal(result.paymentAction, 'received');
    assert.equal(codex.calls.length, 0);
    const cognitiveState = store.getCognitiveState('yuqi');
    assert.equal(cognitiveState.lastTurnId, saved.turnId);
    assert.equal(cognitiveState.revision, 1);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM consolidation_jobs WHERE turn_id = ?')
        .get(saved.turnId).count,
      1
    );
  });
});

test('a legacy direct turn ignores an available cognition pipeline', async () => {
  await withFixture({
    memory: [JSON.stringify({
      query: '普通回复',
      keywords: ['普通回复'],
      candidates: [],
      requiresDeepMemory: false,
      escalationReasons: [],
      speakerAmbiguity: false,
      commitmentRisk: false,
      relationshipStageReview: null,
      conversationFrame: conversationFrame()
    })],
    brain: [JSON.stringify({
      action: 'send',
      reply: '走旧管线。',
      paymentAction: null,
      usedFactIds: [],
      momentAction: null,
      lifePlan: null,
      lifeAdjustment: null,
      rolePlanOperationsJson: '[]',
      rewriteResolution: null
    })],
    supervisor: [JSON.stringify({
      decision: 'approve',
      reviewedIssueIds: [],
      resolvedIssueIds: [],
      issues: []
    })]
  }, async ({ orchestrator }) => {
    let calls = 0;
    orchestrator.cognitivePipeline = {
      async runForeground() {
        calls += 1;
        throw new Error('must not run');
      }
    };
    const result = await orchestrator.process(envelope(121, '普通回复'));
    assert.equal(result.reply.content, '走旧管线。');
    assert.equal(calls, 0);
  });
});

for (const [mode, jobType] of [
  ['cognition_compare', 'shadow_cognition'],
  ['legacy_compare', 'active_canary_compare']
]) {
  test(`comparison ${mode} draft uses only commit-owned production identity fields`, () => {
    const orchestrator = Object.create(YuqiOrchestrator.prototype);
    const turn = {
      turnId: `turn_${mode}`,
      authorityLineageKey: `lineage_${mode}`,
      comparisonMode: mode,
      authoritativeReleaseId: 'release_authoritative',
      comparisonReleaseId: 'release_comparison',
      authoritativePipelineChecksum: 'a'.repeat(64),
      comparisonPipelineChecksum: 'b'.repeat(64),
      rolloutRevision: 3,
      rolloutEvidenceEpoch: 4,
      shadowEpoch: 5,
      canaryEpoch: mode === 'legacy_compare' ? 6 : null,
      canarySlot: mode === 'legacy_compare' ? 2 : null,
      annotationSnapshot: { authority: 'closed' }
    };
    const draft = orchestrator.comparisonJobDraftFromCanonicalTurn(turn, {
      protocolVersion: 3,
      turnId: turn.turnId,
      message: { messageId: 'msg_input', content: 'input' }
    });
    assert.equal(draft.jobType, jobType);
    assert.deepEqual(Object.keys(draft.payload).sort(), [
      'annotationSnapshotChecksum', 'canaryEpoch', 'canarySlot',
      'comparisonDirection', 'comparisonReleaseId', 'inputChecksum',
      'rolloutEvidenceEpoch', 'shadowEpoch', 'turnId'
    ]);
    assert.equal(draft.payload.turnId, turn.turnId);
    assert.equal(Object.hasOwn(draft.payload, 'subjectType'), false);
    assert.equal(Object.hasOwn(draft.payload, 'subjectId'), false);
    assert.equal(Object.hasOwn(draft.payload, 'authoritativeReleaseId'), false);
  });
}

for (const [phase, expectedMode, expectedJobType] of [
  ['shadow', 'cognition_compare', 'shadow_cognition'],
  ['canary', 'legacy_compare', 'active_canary_compare']
]) {
  test(`real ${phase} comparison writer commits one production job for diagnostics`, async () => {
    const root = mkdtempSync(join(tmpdir(), `yuqi-comparison-${phase}-`));
    const store = new YuqiStore(join(root, 'runtime.sqlite'));
    try {
      store.initializeCognitionRolloutsInternal({ rows: [{
        rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable',
        presetVersion: '1.9.2', pipelineChecksum: 'a'.repeat(64)
      }], now: 1 });
      const stable = store.getCognitionRollout('DIRECT_REPLY');
      const candidate = store.listPipelineReleases().find(release => release.releaseId !== stable.stableReleaseId);
      assert.ok(candidate);
      store.db.prepare(`UPDATE cognition_kind_rollouts
        SET current_mode = ?, rollout_phase = ?, candidate_release_id = ?, candidate_phase = ?,
            pipeline_checksum = ?, revision = revision + 1, shadow_epoch = ?, canary_epoch = ?,
            canary_started_count = 0, canary_completed_count = 0, canary_failure_count = 0,
            canary_started_at = NULL, canary_observe_until = 0
        WHERE rollout_key = 'DIRECT_REPLY'`).run(
        phase === 'shadow' ? 'shadow' : 'active', phase === 'shadow' ? 'collecting' : 'canary', candidate.releaseId, phase,
        phase === 'shadow' ? stable.pipelineChecksum : candidate.releaseChecksum,
        phase === 'shadow' ? 1 : 0, phase === 'canary' ? 1 : 0
      );
      store.claimInteractionLaneInternal({ roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0,
        localSequence: 0, now: 1000 });
      const message = {
        messageId: `msg_compare_${phase}`, speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
        content: 'comparison input', sentAt: 1000
      };
      const envelopeValue = {
        protocolVersion: 3, turnId: `turn_compare_${phase}`, characterId: 'yuqi', deviceId: 'device_compare',
        deviceSeq: 1, createdAt: 1000, kind: 'DIRECT_REPLY', message,
        context: { currentBatch: { batchId: `batch_compare_${phase}`, messageIds: [message.messageId],
          startedAt: 1000, committedAt: 1000, messages: [message] }, visibilityCursor: {
            nativeCompletedTurnId: null, nativeCompletedGroupId: null, nativeCompletedSequence: 0,
            uiAppliedTurnId: null, uiAppliedGroupId: null, uiAppliedSequence: 0, localSequence: 1,
            clearedThroughSequence: 0, clearEpoch: 0, clearedAt: 0, chatOpen: true, quotedMessageId: null
          } },
        authority: { algorithm: 'al-authority-v1', roleId: 'yuqi', laneKey: 'private_chat',
          rootSourceId: message.messageId,
          lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: message.messageId }),
          claimedLineageRevision: 1, retryOfTurnId: null }
      };
      const rollout = store.getCognitionRollout('DIRECT_REPLY');
      const pair = resolvePipelinePair(rollout);
      const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1000 });
      const turn = store.createCanonicalVisibleTurnInternal({
        envelope: envelopeValue, rolloutKey: 'DIRECT_REPLY', expectedRolloutRevision: rollout.revision,
        authoritativeReleaseId: pair.visibleReleaseId, comparisonReleaseId: pair.comparisonReleaseId,
        comparisonDirection: pair.comparisonDirection, laneKey: 'private_chat', expectedLaneRevision: 1,
        inputUserBatchId: envelopeValue.context.currentBatch.batchId, inputVisibilitySequence: 1,
        agencySnapshotChecksum: agency.checksum, annotationSnapshot: {}
      }).turn;
      const orchestrator = new YuqiOrchestrator({
        store, presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) }, codex: {},
        releaseExecutor: { executeTurn: async () => ({ draft: {
          action: 'send', reply: 'comparison reply', bubblePlan: [{ text: 'comparison reply', purpose: 'reply' }],
          usedFactIds: [], actionIntent: {}
        } }), executeLife: async () => { throw new Error('unused'); } },
        clock: () => 1001, lifePlanningEnabled: false
      });
      await orchestrator.run(turn.turnId);
      const committed = store.getTurn(turn.turnId);
      const receipt = store.getVisibleCommitReceipt(committed.authorityLineageKey);
      const jobs = store.comparisonJobsForGroup(receipt.visibleGroupId);
      assert.equal(committed.comparisonMode, expectedMode);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].jobType, expectedJobType);
      assert.equal(jobs[0].subjectId, committed.authorityLineageKey);
      const comparison = store.loadTurnComparisonDiagnosticsInternal({
        turnId: committed.turnId, lineageKey: committed.authorityLineageKey,
        rolloutKey: committed.rolloutKey, groupId: receipt.visibleGroupId,
        turnPin: {
          authoritativeReleaseId: committed.authoritativeReleaseId,
          comparisonReleaseId: committed.comparisonReleaseId,
          rolloutRevision: committed.rolloutRevision,
          evidenceEpoch: committed.rolloutEvidenceEpoch,
          shadowEpoch: committed.shadowEpoch ?? 0,
          canaryEpoch: committed.canaryEpoch ?? 0,
          canarySlot: committed.canarySlot,
          authoritativePipelineChecksum: committed.authoritativePipelineChecksum,
          comparisonPipelineChecksum: committed.comparisonPipelineChecksum
        }
      });
      assert.deepEqual(comparison.stateCounts, {});
      assert.equal(comparison.criticalCodes.length, 0);
      assert.equal(contentHash(jobs[0].payload), jobs[0].payloadChecksum);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('canonical runtime consumes the shared persisted release execution builder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-canonical-execution-builder-'));
  const store = new YuqiStore(join(root, 'store.sqlite'));
  try {
    store.initializeCognitionRolloutsInternal({ rows: [{
      rolloutKey: 'DIRECT_REPLY',
      currentMode: 'legacy',
      rolloutPhase: 'stable',
      presetVersion: '1.9.2',
      pipelineChecksum: 'a'.repeat(64)
    }], now: 1 });
    store.claimInteractionLaneInternal({
      roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0,
      localSequence: 0, now: 1000
    });
    const messages = [
      { messageId: 'msg_builder_1', content: '你', sentAt: 998 },
      { messageId: 'msg_builder_2', content: '回来', sentAt: 999 },
      { messageId: 'msg_builder_3', content: '了吗', sentAt: 1000 }
    ].map(value => ({
      ...value, speakerId: 'user', speakerType: 'user', recipientId: 'yuqi'
    }));
    const message = messages.at(-1);
    const envelope = {
      protocolVersion: 3,
      turnId: 'turn_builder_1',
      characterId: 'yuqi',
      deviceId: 'phone',
      deviceSeq: 1,
      createdAt: 1000,
      kind: 'DIRECT_REPLY',
      message,
      context: {
        currentBatch: {
          batchId: 'batch_builder_1',
          messageIds: messages.map(item => item.messageId),
          startedAt: 998,
          committedAt: 1000,
          messages
        },
        visibilityCursor: {
          nativeCompletedTurnId: null,
          nativeCompletedGroupId: null,
          nativeCompletedSequence: 0,
          uiAppliedTurnId: null,
          uiAppliedGroupId: null,
          uiAppliedSequence: 0,
          localSequence: 1,
          clearedThroughSequence: 0,
          clearEpoch: 0,
          clearedAt: 0,
          chatOpen: true,
          quotedMessageId: null
        }
      },
      authority: {
        algorithm: 'al-authority-v1',
        roleId: 'yuqi',
        laneKey: 'private_chat',
        rootSourceId: message.messageId,
        lineageKey: deriveAuthorityLineageKey({
          roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: message.messageId
        }),
        claimedLineageRevision: 1,
        retryOfTurnId: null
      }
    };
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const pair = resolvePipelinePair(rollout);
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1000 });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: pair.visibleReleaseId,
      comparisonReleaseId: pair.comparisonReleaseId,
      comparisonDirection: pair.comparisonDirection,
      laneKey: 'private_chat',
      expectedLaneRevision: 1,
      inputUserBatchId: envelope.context.currentBatch.batchId,
      inputVisibilitySequence: 1,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    }).turn;
    const orchestrator = new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {},
      releaseExecutor: {
        executeTurn: async () => { throw new Error('not called by builder'); },
        executeLife: async () => { throw new Error('not called by builder'); }
      },
      clock: () => 1001,
      lifePlanningEnabled: false
    });

    const execution = orchestrator.buildCanonicalReleaseExecution(turn.turnId);

    assert.deepEqual(Object.keys(execution).sort(), [
      'agencyView', 'currentBatch', 'envelope', 'inputChecksum', 'localImagePaths',
      'routeDecision', 'scene', 'turn'
    ]);
    assert.equal(execution.turn.turnId, turn.turnId);
    assert.equal(execution.envelope.turnId, turn.turnId);
    assert.deepEqual(execution.currentBatch.messageIds, messages.map(item => item.messageId));
    assert.deepEqual(execution.localImagePaths, []);
    assert.equal(execution.routeDecision.route, turn.route);
    assert.deepEqual(execution.routeDecision.allowedActionTargets, {});

    assert.throws(
      () => orchestrator.buildCanonicalReleaseExecution('turn_builder_missing'),
      /canonical release execution authority conflict/
    );
    store.db.exec('SAVEPOINT canonical_builder_batch_corruption');
    try {
      store.db.prepare(`
        DELETE FROM current_user_batch_items
        WHERE turn_id = ? AND sequence = 1
      `).run(turn.turnId);
      assert.throws(
        () => orchestrator.buildCanonicalReleaseExecution(turn.turnId),
        /canonical turn input authority conflict/
      );
    } finally {
      store.db.exec('ROLLBACK TO canonical_builder_batch_corruption');
      store.db.exec('RELEASE canonical_builder_batch_corruption');
    }
    const realGetTurn = store.getTurn.bind(store);
    for (const [name, mutation] of [
      ['authority-v0', { resultAuthorityVersion: 0 }],
      ['redacted', { authorityRedactedAt: 1002 }],
      ['foreign-lineage', { authorityLineageKey: 'lineage_foreign_builder' }]
    ]) {
      store.getTurn = id => {
        const stored = realGetTurn(id);
        return stored?.turnId === turn.turnId ? { ...stored, ...mutation } : stored;
      };
      assert.throws(
        () => orchestrator.buildCanonicalReleaseExecution(turn.turnId),
        /canonical release execution authority conflict/,
        name
      );
    }
    store.getTurn = realGetTurn;
    const realAgencyRead = store.readAgencyAuthoritySnapshotInternal.bind(store);
    store.readAgencyAuthoritySnapshotInternal = input => ({
      ...realAgencyRead(input), checksum: 'f'.repeat(64)
    });
    assert.throws(
      () => orchestrator.buildCanonicalReleaseExecution(turn.turnId),
      /canonical agency authority is stale/
    );
    store.readAgencyAuthoritySnapshotInternal = realAgencyRead;
    assert.throws(
      () => orchestrator.buildCanonicalReleaseExecution(turn.turnId, {
        localImagePaths: ['C:/unexpected/image.png']
      }),
      /canonical release execution image paths conflict/
    );
    assert.throws(
      () => orchestrator.buildCanonicalReleaseExecution(turn.turnId, {
        localImageReceipt: {
          turnId: turn.turnId,
          attachmentChecksum: 'a'.repeat(64),
          path: 'C:/unexpected/image.png'
        }
      }),
      /canonical release execution image receipt conflict/
    );

    const build = orchestrator.buildCanonicalReleaseExecution.bind(orchestrator);
    let builderCalls = 0;
    let receivedExecution = null;
    let corruptExecutionTurn = true;
    orchestrator.buildCanonicalReleaseExecution = (...args) => {
      builderCalls += 1;
      const built = build(...args);
      return corruptExecutionTurn
        ? {
            ...built,
            turn: { ...built.turn, authoritativeReleaseId: 'foreign_release' }
          }
        : built;
    };
    let modelCalls = 0;
    orchestrator.releaseExecutor = {
      async executeTurn() {
        modelCalls += 1;
        throw new Error('release executor must not receive a mixed authority snapshot');
      },
      async executeLife() { throw new Error('unused'); }
    };
    await assert.rejects(
      () => orchestrator.run(turn.turnId),
      /canonical release execution identity conflict/
    );
    assert.equal(modelCalls, 0);
    corruptExecutionTurn = false;
    orchestrator.releaseExecutor = {
      async executeTurn(input) {
        modelCalls += 1;
        receivedExecution = structuredClone(input.execution);
        return { draft: {
          action: 'send',
          reply: '回来了。',
          bubblePlan: [{ text: '回来了。', purpose: 'reply' }],
          usedFactIds: [],
          actionIntent: {}
        } };
      },
      async executeLife() { throw new Error('unused'); }
    };

    await orchestrator.run(turn.turnId);

    assert.equal(builderCalls, 2);
    assert.equal(modelCalls, 1);
    assert.deepEqual(receivedExecution, execution);
    assert.throws(
      () => build(turn.turnId),
      /canonical release execution authority conflict/
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
