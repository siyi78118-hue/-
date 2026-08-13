import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateEnvelope } from '../src/protocol.mjs';
import { deriveAuthorityLineageKey, YuqiStore } from '../src/store.mjs';
import { currentUserInteractionForCognition } from '../src/current-user-batch.mjs';
import { materializeV3Draft } from '../src/cognition-v3-contract.mjs';
import { compileInteractionContract } from '../src/interaction-contract.mjs';
import { reduceCognitiveState } from '../src/cognitive-state.mjs';
import { materializeImageAttachments } from '../src/image-attachments.mjs';
import { normalizeCanonicalBrainDraft, YuqiOrchestrator } from '../src/orchestrator.mjs';

const JPEG_1X1 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEBAAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

function cursor() {
  return {
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
  };
}

function richMessages() {
  return [
    { messageId: 'msg_text', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: '先看一下', sentAt: 1784400000000, type: 'text' },
    { messageId: 'msg_image', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: '图片', sentAt: 1784400001000, type: 'image', attachments: [{ attachmentId: 'att_1', messageId: 'msg_image', kind: 'image', mime: 'image/jpeg', name: 'one.jpg', width: 1, height: 1, bytes: Buffer.from(JPEG_1X1, 'base64').length, dataUrl: `data:image/jpeg;base64,${JPEG_1X1}` }] },
    { messageId: 'msg_quote', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: '引用', sentAt: 1784400002000, type: 'quote', quote: { messageId: 'msg_original', speakerId: 'user', speakerType: 'user', text: '原话' } },
    { messageId: 'msg_voice', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: '语音', sentAt: 1784400003000, type: 'voice' },
    { messageId: 'msg_emoji', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: '🙂', sentAt: 1784400004000, type: 'emoji' },
    { messageId: 'msg_payment', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: '红包', sentAt: 1784400005000, type: 'payment', payment: { messageId: 'msg_payment', kind: 'redpacket', amount: 88, note: '', status: 'pending' } }
  ];
}

function richV3Envelope(overrides = {}) {
  const messages = richMessages();
  const message = messages.at(-1);
  const authority = {
    algorithm: 'al-authority-v1',
    roleId: 'yuqi',
    laneKey: 'private_chat',
    rootSourceId: message.messageId,
    lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: message.messageId }),
    claimedLineageRevision: 1,
    retryOfTurnId: null
  };
  return {
    protocolVersion: 3,
    turnId: 'turn_v3_rich',
    characterId: 'yuqi',
    deviceId: 'device_v3',
    deviceSeq: 1,
    createdAt: 1784400006000,
    kind: 'DIRECT_REPLY',
    message,
    context: {
      currentBatch: { batchId: 'batch_v3_rich', messageIds: messages.map(item => item.messageId), startedAt: messages[0].sentAt, committedAt: 1784400006000, messages },
      payment: { messageId: 'msg_payment', kind: 'redpacket', amount: 88, note: '', status: 'pending' },
      visibilityCursor: cursor()
    },
    authority,
    ...overrides
  };
}

function threeBubbleCanonicalV3Envelope() {
  const source = richV3Envelope();
  const messages = [0, 1, 2].map(index => ({
    messageId: `msg_v3_three_${index + 1}`,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: `第${index + 1}泡`,
    sentAt: 1784400010000 + index,
    type: 'text'
  }));
  const rootSourceId = messages.at(-1).messageId;
  return {
    ...source,
    turnId: 'turn_v3_three_bubble',
    deviceSeq: 7,
    message: messages.at(-1),
    context: {
      currentBatch: {
        batchId: 'batch_v3_three_bubble',
        messageIds: messages.map(message => message.messageId),
        startedAt: messages[0].sentAt,
        committedAt: 1784400011000,
        messages
      },
      visibilityCursor: cursor()
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey: 'private_chat',
      rootSourceId,
      lineageKey: deriveAuthorityLineageKey({
        roleId: 'yuqi',
        laneKey: 'private_chat',
        rootSourceId
      }),
      claimedLineageRevision: 1,
      retryOfTurnId: null
    }
  };
}

test('v3 preserves rich currentBatch projection, null voice transcript, quote/payment identity and raw emoji type', () => {
  const normalized = validateEnvelope(richV3Envelope());
  const batch = normalized.context.currentBatch;
  assert.equal(batch.messages.length, 6);
  assert.equal(batch.messages[2].quote.messageId, 'msg_original');
  assert.equal(batch.messages[3].transcript, null);
  assert.equal(batch.messages[4].type, 'emoji');
  assert.equal(batch.messages[4].emotion, undefined);
  assert.equal(batch.messages[5].payment.messageId, 'msg_payment');
  const interaction = currentUserInteractionForCognition({ ...batch, sourceMessageId: 'msg_payment' });
  assert.equal(interaction.messages[3].transcript, null);
  assert.equal(interaction.messages[4].type, 'emoji');
});

test('v3 normalizes deployed null and UI quote shapes without weakening the quote boundary', () => {
  const plain = threeBubbleCanonicalV3Envelope();
  plain.message = { ...plain.message, quote: null };
  plain.context.currentBatch.messages = plain.context.currentBatch.messages.map((message, index, messages) => (
    index === messages.length - 1 ? { ...message, quote: null } : message
  ));
  const normalizedPlain = validateEnvelope(plain);
  assert.equal(Object.hasOwn(normalizedPlain.message, 'quote'), false);
  assert.equal(Object.hasOwn(normalizedPlain.context.currentBatch.messages.at(-1), 'quote'), false);

  const quoted = threeBubbleCanonicalV3Envelope();
  const deployedQuote = {
    messageId: 'msg_original',
    speakerId: 'yuqi',
    speakerType: 'assistant',
    speakerName: '虞栖',
    contentType: 'text',
    content: '原话'
  };
  quoted.message = { ...quoted.message, quote: deployedQuote };
  quoted.context.currentBatch.messages = quoted.context.currentBatch.messages.map((message, index, messages) => (
    index === messages.length - 1 ? { ...message, quote: deployedQuote } : message
  ));
  const normalizedQuoted = validateEnvelope(quoted);
  assert.deepEqual(normalizedQuoted.message.quote, {
    messageId: 'msg_original',
    speakerId: 'yuqi',
    speakerType: 'character',
    text: '原话'
  });
  assert.deepEqual(normalizedQuoted.context.currentBatch.messages.at(-1).quote, normalizedQuoted.message.quote);

  const malformed = structuredClone(quoted);
  malformed.message.quote.secret = 'leak';
  malformed.context.currentBatch.messages.at(-1).quote.secret = 'leak';
  assert.throws(() => validateEnvelope(malformed), /quote|key|identity/i);
});

test('v3 unwraps the deployed native reply item id to its canonical message id', () => {
  const envelope = threeBubbleCanonicalV3Envelope();
  const canonicalMessageId = `msg_${'a'.repeat(64)}`;
  const deployedQuote = {
    messageId: `native_turn_msg_1786624829345_hjuj14_${canonicalMessageId}_2`,
    speakerId: 'yuqi',
    speakerType: 'assistant',
    speakerName: '虞栖',
    contentType: 'text',
    content: '被引用的原话'
  };
  envelope.message = { ...envelope.message, quote: deployedQuote };
  envelope.context.currentBatch.messages = envelope.context.currentBatch.messages.map(
    (message, index, messages) => index === messages.length - 1
      ? { ...message, quote: deployedQuote }
      : message
  );

  const normalized = validateEnvelope(envelope);

  assert.equal(normalized.message.quote.messageId, canonicalMessageId);
  assert.equal(normalized.context.currentBatch.messages.at(-1).quote.messageId, canonicalMessageId);

  for (const forged of [
    `native_turn_msg_1786624829345_hjuj14_${canonicalMessageId}_0`,
    `native_fake_${canonicalMessageId}_2`,
    `native_turn_msg_1786624829345_hjuj14_msg_not_a_checksum_2`
  ]) {
    const changed = structuredClone(envelope);
    changed.message.quote.messageId = forged;
    changed.context.currentBatch.messages.at(-1).quote.messageId = forged;
    assert.throws(() => validateEnvelope(changed), /quote messageId/);
  }
});

test('v3 rejects unknown rich keys, non-native transcript, duplicate/incomplete batches and payment/quote identity mutation', () => {
  assert.throws(() => validateEnvelope(richV3Envelope({ context: { ...richV3Envelope().context, currentBatch: { ...richV3Envelope().context.currentBatch, messages: richMessages().map((item, index) => index === 0 ? { ...item, privateSecret: 'x' } : item) } } })), /key|rich|batch/i);
  assert.throws(() => validateEnvelope(richV3Envelope({ context: { ...richV3Envelope().context, currentBatch: { ...richV3Envelope().context.currentBatch, messages: richMessages().map((item, index) => index === 3 ? { ...item, transcript: 42 } : item) } } })), /transcript|type|voice/i);
  assert.throws(() => validateEnvelope(richV3Envelope({ context: { ...richV3Envelope().context, currentBatch: { ...richV3Envelope().context.currentBatch, messageIds: ['msg_text', 'msg_text', 'msg_payment'], messages: [richMessages()[0], richMessages()[0], richMessages()[5]] } } })), /duplicate|message/i);
  assert.throws(() => validateEnvelope(richV3Envelope({ context: { ...richV3Envelope().context, payment: { ...richV3Envelope().context.payment, amount: 99 } } })), /payment|batch|source/i);
  assert.throws(() => validateEnvelope(richV3Envelope({ context: { ...richV3Envelope().context, currentBatch: { ...richV3Envelope().context.currentBatch, messages: richMessages().map((item, index) => index === 2 ? { ...item, quote: { ...item.quote, speakerId: 'yuqi' } } : item) } } })), /quote|identity|batch/i);
});

test('v3 context payment is closed and preserves native immutable types', () => {
  const base = richV3Envelope().context;
  const cases = [
    ['coerced amount', { ...base.payment, amount: '88' }],
    ['unknown key', { ...base.payment, secret: 'leak' }],
    ['missing status', Object.fromEntries(Object.entries(base.payment).filter(([key]) => key !== 'status'))],
    ['non-string note', { ...base.payment, note: 1 }],
    ['non-string status', { ...base.payment, status: 1 }]
  ];
  for (const [label, payment] of cases) {
    assert.throws(
      () => validateEnvelope(richV3Envelope({ context: { ...base, payment } })),
      /payment|keys|amount|status|note/i,
      label
    );
  }
  assert.deepEqual(validateEnvelope(richV3Envelope()).context.payment, base.payment);
});

test('v3 payment intent is canonical even when expression prose disagrees', () => {
  const draft = materializeV3Draft({
    cognitionPacket: {
      schemaVersion: 3,
      packetChecksum: 'packet_v3',
      cognitionResult: {
        interactionDecision: { intendedResponse: 'send' },
        actionIntent: { payment: { action: 'received', messageId: 'msg_payment', kind: 'redpacket', amount: 88 } },
        statePatch: {}
      }
    },
    expressionResult: { action: 'send', reply: '我先不收', usedFactIds: [], bubblePlan: [{ text: '我先不收', purpose: 'reply' }], incompatibility: null }
  });
  const normalized = normalizeCanonicalBrainDraft(draft);
  assert.equal(normalized.paymentAction, 'received');
  assert.deepEqual(normalized.actionIntent.payment, { action: 'received', messageId: 'msg_payment', kind: 'redpacket', amount: 88 });
});

test('v3 canonical action set maps an authorized payment intent to one persisted target', () => {
  const orchestrator = Object.create(YuqiOrchestrator.prototype);
  orchestrator.store = {
    resolveCanonicalActionTargetInternal: ({ action }) => ({
      targetKey: `payment:${action.payload.messageId}`,
      targetRevision: '1'
    })
  };
  const actions = orchestrator.canonicalActionSet(
    { turnId: 'turn_payment', rolloutKey: 'DIRECT_REPLY' },
    {
      paymentAction: 'received',
      actionIntent: { payment: { action: 'received', messageId: 'msg_payment', kind: 'redpacket', amount: 88 } }
    }
  );
  assert.deepEqual(actions, [{
    kind: 'payment_accept',
    targetKey: 'payment:msg_payment',
    targetRevision: '1',
    payload: { messageId: 'msg_payment' }
  }]);
});

test('responseRisks are advisory-only and never forbidden moves or durable cognitive state', () => {
  const contract = compileInteractionContract({ conversationFrame: { responseRisks: ['do not over-contact'] } });
  assert.deepEqual(contract.forbiddenMoves, []);
  assert.deepEqual(contract.advisories.responseRisks, ['do not over-contact']);
  const state = reduceCognitiveState({
    previous: {},
    cognitionPacket: { cognitionResult: { selfState: {}, decision: {}, interactionDecision: { intendedResponse: 'send' }, actionIntent: {}, statePatch: {} } },
    committedTurn: { turnId: 'turn_risk', state: 'committed', kind: 'PROACTIVE_CHAT' },
    now: 1000
  });
  assert.equal(JSON.stringify(state).includes('do not over-contact'), false);
});

test('image materialization uses deterministic checksum receipt across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-task16-image-'));
  const attachment = { attachmentId: 'att_restart', kind: 'image', mime: 'image/jpeg', name: 'one.jpg', dataUrl: `data:image/jpeg;base64,${JPEG_1X1}` };
  try {
    const first = await materializeImageAttachments([attachment], { rootDir: root, turnId: 'turn_image_restart', retainReceipt: true });
    const second = await materializeImageAttachments([attachment], { rootDir: root, turnId: 'turn_image_restart', retainReceipt: true });
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(second.receipt.turnId, 'turn_image_restart');
    assert.equal(existsSync(second.receipt.path), true);
    await first.cleanup();
    await second.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v3 production canonical run commits three bubbles as one authority group and replays it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-task16-canonical-run-'));
  const path = join(root, 'runtime.sqlite');
  let store = new YuqiStore(path);
  const draft = {
    action: 'send',
    reply: '第1泡\n第2泡\n第3泡',
    bubblePlan: [
      { text: '第1泡', purpose: 'reply' },
      { text: '第2泡', purpose: 'reply' },
      { text: '第3泡', purpose: 'reply' }
    ],
    usedFactIds: [],
    actionIntent: {}
  };
  const releaseExecutor = {
    executeTurn: async () => ({ draft }),
    executeLife: async () => { throw new Error('life execution is not used'); }
  };
  try {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: 'a'.repeat(64)
      }],
      now: 1
    });
    const laneBeforeInput = store.getInteractionLane('yuqi', 'private_chat');
    store.claimInteractionLaneInternal({
      roleId: 'yuqi',
      laneKey: 'private_chat',
      expectedRevision: Number(laneBeforeInput?.revision || 0),
      localSequence: 1,
      now: 2
    });
    const envelope = threeBubbleCanonicalV3Envelope();
    const initialLane = store.getInteractionLane('yuqi', 'private_chat');
    envelope.context.visibilityCursor.localSequence = Number(initialLane?.localSequence || 0) + 1;
    assert.doesNotThrow(() => validateEnvelope(envelope));
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const lane = initialLane;
    const agency = store.readAgencyAuthoritySnapshotInternal({
      roleId: 'yuqi',
      at: envelope.message.sentAt
    });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: Number(lane?.revision || 0),
      inputUserBatchId: envelope.context.currentBatch.batchId,
      inputVisibilitySequence: envelope.context.visibilityCursor.localSequence,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    }).turn;
    const orchestrator = new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {},
      releaseExecutor,
      clock: () => 1784400012000,
      lifePlanningEnabled: false
    });
    const receipt = await orchestrator.run(turn.turnId);
    const groupCount = Number(store.db.prepare(
      'SELECT COUNT(*) AS value FROM visible_result_groups WHERE lineage_key = ?'
    ).get(turn.authorityLineageKey).value);
    assert.equal(groupCount, 1);
    const group = store.db.prepare(
      'SELECT group_id, item_count FROM visible_result_groups WHERE lineage_key = ?'
    ).get(turn.authorityLineageKey);
    assert.equal(group.item_count, 3);
    assert.equal(Number(store.db.prepare(
      'SELECT COUNT(*) AS value FROM visible_result_items WHERE group_id = ?'
    ).get(group.group_id).value), 3);
    const receiptRow = store.db.prepare(
      'SELECT commit_checksum FROM visible_commit_receipts WHERE group_id = ?'
    ).get(group.group_id);
    assert.equal(receiptRow.commit_checksum, receipt.commitChecksum);

    store.close();
    store = new YuqiStore(path);
    const reopened = store.readCanonicalCommitOutcomeInternal({
      lineageKey: turn.authorityLineageKey,
      expectedTurnId: turn.turnId
    });
    assert.equal(reopened.status, 'already_committed');
    const authorityReceipt = ({ committed, ...value }) => value;
    assert.deepEqual(reopened.receipt, authorityReceipt(receipt));
    const replay = await new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {},
      releaseExecutor,
      clock: () => 1784400013000,
      lifePlanningEnabled: false
    }).run(turn.turnId);
    assert.deepEqual(replay, authorityReceipt(receipt));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
