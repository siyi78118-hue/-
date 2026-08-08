import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TURN_STATES,
  canonicalJson,
  contentHash,
  deliveryItemsForResult,
  validateConversationClearControl,
  validateConversationClearApplied,
  validateRoleDeleteApplied,
  validateRoleDeleteControl,
  validateEnvelope
} from '../src/protocol.mjs';
import { deriveAuthorityLineageKey, YuqiStore } from '../src/store.mjs';
import { publicTurnStatus } from '../src/turn-status.mjs';

function validConversationClearControl(overrides = {}) {
  const body = {
    protocolVersion: 3,
    type: 'CONVERSATION_CLEAR',
    controlVersion: 'conversation_clear_v1',
    roleId: 'yuqi',
    peerId: 'device1',
    clearEpoch: 1,
    clearedThroughSequence: 4,
    requestedAt: 1784400000000,
    inputCursorChecksum: 'a'.repeat(64),
    ...overrides
  };
  if (!Object.hasOwn(overrides, 'controlId')) {
    body.controlId = `ctl_${contentHash({
      contract: 'android-lifecycle-control-id-v1',
      controlKind: 'conversation_clear_v1',
      characterId: body.roleId,
      peerId: body.peerId,
      clearEpoch: body.clearEpoch,
      clearedThroughSequence: body.clearedThroughSequence,
      requestedAt: body.requestedAt,
      inputCursorChecksum: body.inputCursorChecksum
    })}`;
  }
  return { ...body, checksum: contentHash(body) };
}

test('conversation clear validator is exact, native, and checksum closed', () => {
  const valid = validConversationClearControl();
  assert.deepEqual(validateConversationClearControl(valid), valid);
  assert.deepEqual(validateConversationClearControl(JSON.stringify(valid)), valid);

  const invalid = [
    ['unknown key', { extra: true }],
    ['missing key', { peerId: undefined }],
    ['coerced protocol', { protocolVersion: '3' }],
    ['coerced epoch', { clearEpoch: '1' }],
    ['coerced timestamp', { requestedAt: '1784400000000' }],
    ['wrong type', { type: 'CONVERSATION_CLEAR_APPLIED' }],
    ['wrong checksum', { checksum: 'b'.repeat(64) }],
    ['negative boundary', { clearedThroughSequence: -1 }],
    ['zero request time', { requestedAt: 0 }]
  ];
  for (const [label, changes] of invalid) {
    const candidate = validConversationClearControl();
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete candidate[key];
      else candidate[key] = value;
    }
    assert.throws(() => validateConversationClearControl(candidate), /conversation clear/i, label);
  }
});

test('conversation clear validator rejects coerced native ids and times with a self-consistent checksum', () => {
  const cases = [
    ['numeric control id', { controlId: 17 }],
    ['array role id', { roleId: ['yuqi'] }],
    ['object peer id', { peerId: { value: 'device1' } }],
    ['string requestedAt', { requestedAt: '1784400000000' }],
    ['wrapped requestedAt', { requestedAt: { value: 1784400000000 } }]
  ];
  for (const [label, change] of cases) {
    const candidate = validConversationClearControl(change);
    const withoutChecksum = { ...candidate };
    delete withoutChecksum.checksum;
    candidate.checksum = contentHash(withoutChecksum);
    assert.throws(
      () => validateConversationClearControl(candidate),
      /conversation clear/i,
      label
    );
  }
});

test('conversation clear controlId is the frozen cross-end authority identity, not caller text', () => {
  const valid = validConversationClearControl();
  assert.equal(valid.controlId, 'ctl_c8590195cf5a91c4e857796e051b7bae4754f9929ac06d2d4839c06d95671e19');
  const forged = { ...valid, controlId: 'ctl_' + '0'.repeat(64) };
  delete forged.checksum;
  forged.checksum = contentHash(forged);
  assert.throws(
    () => validateConversationClearControl(forged),
    /control id|authority identity|conversation clear/i
  );
});

function validConversationClearApplied(overrides = {}) {
  const body = {
    protocolVersion: 3,
    type: 'CONVERSATION_CLEAR_APPLIED',
    controlId: 'clear_device1_1',
    controlChecksum: validConversationClearControl().checksum,
    roleId: 'yuqi',
    peerId: 'device1',
    clearEpoch: 1,
    clearedThroughSequence: 4,
    appliedAt: 1784400000100,
    ...overrides
  };
  return { ...body, checksum: contentHash(body) };
}

test('conversation clear applied validator is exact ten-key native and checksum closed', () => {
  const valid = validConversationClearApplied();
  assert.deepEqual(validateConversationClearApplied(valid), valid);
  assert.deepEqual(validateConversationClearApplied(JSON.stringify(valid)), valid);
  const invalid = [
    ['unknown key', { extra: true }],
    ['missing control checksum', { controlChecksum: undefined }],
    ['coerced protocol', { protocolVersion: '3' }],
    ['array control id', { controlId: ['clear_device1_1'] }],
    ['object peer id', { peerId: { value: 'device1' } }],
    ['fractional epoch', { clearEpoch: 1.5 }],
    ['string applied time', { appliedAt: '1784400000100' }],
    ['wrong type', { type: 'CONVERSATION_CLEAR' }],
    ['wrong checksum', { checksum: 'b'.repeat(64) }]
  ];
  for (const [label, changes] of invalid) {
    const candidate = validConversationClearApplied();
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete candidate[key];
      else candidate[key] = value;
    }
    if (label !== 'wrong checksum') {
      const withoutChecksum = { ...candidate };
      delete withoutChecksum.checksum;
      candidate.checksum = contentHash(withoutChecksum);
    }
    assert.throws(() => validateConversationClearApplied(candidate), /conversation clear applied/i, label);
  }
  assert.throws(() => validateConversationClearApplied(validConversationClearControl()), /conversation clear applied/i);
});

function validBackupReceipt(roleId = 'yuqi', createdAt = 1784400000200) {
  const body = {
    receiptVersion: 'yuqi-backup-receipt-v1',
    roleId,
    manifestChecksum: 'b'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
    logicalChecksum: 'd'.repeat(64),
    createdAt
  };
  body.receiptId = `bkrcpt_${contentHash({
    contract: 'yuqi-backup-receipt-id-v1',
    roleId,
    manifestChecksum: body.manifestChecksum,
    snapshotSha256: body.snapshotSha256,
    logicalChecksum: body.logicalChecksum,
    createdAt
  }).slice(0, 24)}`;
  return { ...body, receiptChecksum: contentHash(body) };
}

function validRoleDeleteControl(overrides = {}) {
  const body = {
    protocolVersion: 3,
    type: 'ROLE_DELETE',
    controlVersion: 'role_delete_v1',
    roleId: 'yuqi',
    peerId: 'device1',
    requestedAt: 1784400000300,
    backupReceipt: validBackupReceipt(),
    ...overrides
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'controlId')) {
    body.controlId = `ctl_${contentHash({
      contract: 'android-lifecycle-control-id-v1',
      controlKind: 'role_delete_v1',
      roleId: body.roleId,
      peerId: body.peerId,
      requestedAt: body.requestedAt,
      backupReceiptChecksum: body.backupReceipt.receiptChecksum
    })}`;
  }
  return { ...body, checksum: contentHash(body) };
}

test('role delete control validator closes the backup-bound nine-key authority wire', () => {
  const valid = validRoleDeleteControl();
  assert.deepEqual(validateRoleDeleteControl(valid), valid);
  assert.deepEqual(validateRoleDeleteControl(JSON.stringify(valid)), valid);
  for (const [label, changes] of [
    ['unknown key', { extra: true }],
    ['missing receipt', { backupReceipt: undefined }],
    ['coerced protocol', { protocolVersion: '3' }],
    ['array role', { roleId: ['yuqi'] }],
    ['string time', { requestedAt: '1784400000300' }],
    ['postdated receipt', { backupReceipt: validBackupReceipt('yuqi', 1784400000301) }],
    ['foreign receipt', { backupReceipt: validBackupReceipt('other', 1784400000200) }],
    ['wrong checksum', { checksum: 'f'.repeat(64) }]
  ]) {
    const candidate = validRoleDeleteControl();
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete candidate[key];
      else candidate[key] = value;
    }
    if (label !== 'wrong checksum') {
      const withoutChecksum = { ...candidate };
      delete withoutChecksum.checksum;
      candidate.checksum = contentHash(withoutChecksum);
    }
    assert.throws(() => validateRoleDeleteControl(candidate), /role delete|backup receipt/i, label);
  }
});

function validRoleDeleteApplied(overrides = {}) {
  const control = validRoleDeleteControl();
  const body = {
    protocolVersion: 3,
    type: 'ROLE_DELETE_APPLIED',
    controlId: control.controlId,
    controlChecksum: control.checksum,
    roleId: control.roleId,
    peerId: control.peerId,
    backupReceiptId: control.backupReceipt.receiptId,
    appliedAt: 1784400000400,
    ...overrides
  };
  return { ...body, checksum: contentHash(body) };
}

test('role delete applied proof is an exact native checksum-closed response', () => {
  const valid = validRoleDeleteApplied();
  assert.deepEqual(validateRoleDeleteApplied(valid), valid);
  assert.deepEqual(validateRoleDeleteApplied(JSON.stringify(valid)), valid);
  for (const [label, changes] of [
    ['unknown key', { extra: true }],
    ['missing receipt id', { backupReceiptId: undefined }],
    ['coerced protocol', { protocolVersion: '3' }],
    ['array peer', { peerId: ['device1'] }],
    ['string time', { appliedAt: '1784400000400' }],
    ['wrong checksum', { checksum: 'e'.repeat(64) }]
  ]) {
    const candidate = validRoleDeleteApplied();
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete candidate[key];
      else candidate[key] = value;
    }
    if (label !== 'wrong checksum') {
      const withoutChecksum = { ...candidate };
      delete withoutChecksum.checksum;
      candidate.checksum = contentHash(withoutChecksum);
    }
    assert.throws(() => validateRoleDeleteApplied(candidate), /role delete applied/i, label);
  }
});

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

function validV2Envelope(overrides = {}) {
  return {
    protocolVersion: 2,
    turnId: 'turn_device2_1',
    characterId: 'yuqi',
    deviceId: 'device2',
    deviceSeq: 1,
    createdAt: 1784400000000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_device2_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你好',
      sentAt: 1784400000000
    },
    ...overrides
  };
}

function validBatchedV2Envelope(overrides = {}) {
  const source = validV2Envelope(overrides);
  const first = {
    messageId: 'msg_device2_batch_1',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: source.characterId,
    content: '第一条',
    sentAt: source.message.sentAt - 1_000
  };
  source.context = {
    ...(source.context || {}),
    currentBatch: {
      batchId: 'batch_device2_1',
      messageIds: [first.messageId, source.message.messageId],
      startedAt: first.sentAt,
      committedAt: source.createdAt,
      messages: [first, source.message]
    }
  };
  return source;
}

function validV3Envelope(overrides = {}) {
  const source = validBatchedV2Envelope();
  source.protocolVersion = 3;
  source.context.visibilityCursor = {
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
  source.authority = {
    algorithm: 'al-authority-v1',
    roleId: source.characterId,
    laneKey: 'private_chat',
    rootSourceId: source.message.messageId,
    lineageKey: deriveAuthorityLineageKey({
      roleId: source.characterId,
      laneKey: 'private_chat',
      rootSourceId: source.message.messageId
    }),
    claimedLineageRevision: 1,
    retryOfTurnId: null
  };
  return { ...source, ...overrides };
}

const V3_AUTOMATIC_KINDS = Object.freeze([
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY'
]);

function v3LaneForKind(kind) {
  if (['ROLE_PLAN_CHAT', 'ROLE_PLAN_CHAT_PRIVATE', 'PROACTIVE_CHAT'].includes(kind)) {
    return 'private_chat';
  }
  if (['ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_MOMENT'].includes(kind)) {
    return 'public_moment';
  }
  return 'moment_interaction:moment_protocol_v3';
}

function validV3AutomaticEnvelope(kind, overrides = {}) {
  const source = validTriggerEnvelope({
    protocolVersion: 3,
    turnId: `turn_v3_${kind.toLowerCase()}`,
    kind,
    trigger: {
      triggerId: `trigger_v3_${kind.toLowerCase()}`,
      triggerType: kind.toLowerCase(),
      scheduledFor: 1784400000000,
      executedAt: 1784400001000,
      context: ['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(kind)
        ? {
            targetMoment: {
              momentId: 'moment_protocol_v3',
              authorType: 'character',
              authorId: 'yuqi',
              text: '公开动态',
              createdAt: 1784400000000,
              likes: ['user'],
              comments: [{
                commentId: 'comment_protocol_v3',
                authorType: 'user',
                authorId: 'user',
                text: '看到了',
                createdAt: 1784400000001,
                replyToCommentId: null
              }]
            },
            targetComment: kind === 'MOMENT_REPLY' ? {
              commentId: 'comment_protocol_v3',
              authorType: 'user',
              authorId: 'user',
              text: '看到了',
              createdAt: 1784400000001,
              replyToCommentId: null
            } : null
          }
        : {}
    }
  });
  const laneKey = v3LaneForKind(kind);
  source.context = {
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
      chatOpen: false,
      quotedMessageId: null
    }
  };
  source.authority = {
    algorithm: 'al-authority-v1',
    roleId: source.characterId,
    laneKey,
    rootSourceId: source.trigger.triggerId,
    lineageKey: deriveAuthorityLineageKey({
      roleId: source.characterId,
      laneKey,
      rootSourceId: source.trigger.triggerId
    }),
    claimedLineageRevision: 1,
    retryOfTurnId: null
  };
  return { ...source, ...overrides };
}

function cloned(value) {
  return structuredClone(value);
}

function validDynamicScene(overrides = {}) {
  return {
    playerName: '姜隽倚',
    characterName: '虞栖',
    relationshipStage: {
      id: 'new',
      label: '初识',
      content: '还在慢慢了解彼此。',
      since: 1784300000000,
      reason: '初次见面',
      confidence: 0.7
    },
    conversationExtraPrompt: '',
    globalExtraPrompt: '',
    rolePlanCatalog: '',
    roleScheduleContext: '',
    momentContext: '',
    stageCatalog: [{ id: 'new', label: '初识', content: '慢慢熟悉。' }],
    phaseCatalog: [{ id: 'normal', label: '正常相处', content: '' }],
    currentPhase: 'normal',
    effectiveStagePersona: '当前有效的阶段人设。',
    stagePersonaRevision: 7,
    ...overrides
  };
}

const JPEG_1X1 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

test('direct text messages normalize a legacy empty attachment array to no attachment field', () => {
  const value = validV2Envelope();
  value.message.attachments = [];
  const normalized = validateEnvelope(value);
  assert.equal(Object.hasOwn(normalized.message, 'attachments'), false);
});

test('direct messages accept one bounded raster image attachment and normalize its metadata', () => {
  const value = validV2Envelope();
  value.message.attachments = [{
    attachmentId: 'att_msg_device2_1',
    messageId: value.message.messageId,
    kind: 'image',
    mime: 'image/jpeg',
    name: 'one.jpg',
    width: 1,
    height: 1,
    bytes: Buffer.from(JPEG_1X1, 'base64').length,
    dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
  }];
  const normalized = validateEnvelope(value);
  assert.equal(normalized.message.attachments.length, 1);
  assert.equal(normalized.message.attachments[0].mime, 'image/jpeg');
  assert.match(normalized.message.attachments[0].dataUrl, /^data:image\/jpeg;base64,/);
});

test('direct messages reject oversized, forged, or multiple image attachments before persistence', () => {
  const make = attachments => {
    const value = validV2Envelope();
    value.message.attachments = attachments;
    return value;
  };
  const valid = {
    attachmentId: 'att_msg_device2_1',
    messageId: 'msg_device2_1',
    kind: 'image',
    mime: 'image/jpeg',
    name: 'one.jpg',
    width: 1,
    height: 1,
    bytes: Buffer.from(JPEG_1X1, 'base64').length,
    dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
  };
  assert.throws(() => validateEnvelope(make([valid, { ...valid, attachmentId: 'att_second' }])), /one image/i);
  assert.throws(() => validateEnvelope(make([{ ...valid, mime: 'image/svg+xml' }])), /image attachment/i);
  assert.throws(() => validateEnvelope(make([{
    ...valid,
    bytes: Buffer.from('not jpeg').length,
    dataUrl: `data:image/jpeg;base64,${Buffer.from('not jpeg').toString('base64')}`
  }])), /signature/i);
});

function validTriggerEnvelope(overrides = {}) {
  return {
    protocolVersion: 2,
    turnId: 'turn_device2_proactive_1',
    characterId: 'yuqi',
    deviceId: 'device2',
    deviceSeq: 2,
    createdAt: 1784400001000,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId: 'trigger_device2_proactive_1',
      triggerType: 'proactive_chat',
      scheduledFor: 1784400000000,
      executedAt: 1784400001000
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
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error?.code !== 'EPERM') throw error;
        if (attempt === 9 && process.platform === 'win32') break;
        if (attempt === 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
}

function commitAutomaticTurn(store, {
  seq,
  kind = 'PROACTIVE_CHAT',
  action = 'send',
  state = 'committed'
}) {
  const createdAt = 1784400000000 + seq * 1000;
  const saved = store.submitTurn(validTriggerEnvelope({
    turnId: `turn_policy_${kind.toLowerCase()}_${seq}`,
    deviceSeq: seq,
    createdAt,
    kind,
    trigger: {
      triggerId: `trigger_policy_${kind.toLowerCase()}_${seq}`,
      triggerType: kind.toLowerCase(),
      scheduledFor: createdAt - 1000,
      executedAt: createdAt
    }
  }));
  store.claimTurnById(saved.turnId, 'worker-policy');
  if (state === 'failed') {
    store.advanceTurn(saved.turnId, 'memory_running', 'failed', {
      errorJson: JSON.stringify({ name: 'Error', message: 'intentional failure' })
    });
    return store.getTurn(saved.turnId);
  }
  store.advanceTurn(saved.turnId, 'memory_running', 'memory_done', {
    memoryPacketJson: JSON.stringify({ query: 'proactive policy test' })
  });
  store.advanceTurn(saved.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(saved.turnId, 'brain_running', 'brain_done', {
    brainDraftJson: JSON.stringify({ action, reply: action === 'skip' ? '' : '一条主动消息' })
  });
  store.advanceTurn(saved.turnId, 'brain_done', 'approved');
  store.advanceTurn(saved.turnId, 'approved', 'committed', {
    replyJson: JSON.stringify({ turnId: saved.turnId, action, reply: action === 'skip' ? null : {} })
  });
  return store.getTurn(saved.turnId);
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

test('protocol v2 direct turn preserves the exact user message and kind', () => {
  const value = validateEnvelope(validV2Envelope());
  assert.equal(value.protocolVersion, 2);
  assert.equal(value.kind, 'DIRECT_REPLY');
  assert.equal(value.message.speakerId, 'user');
  assert.equal(value.message.content, '你好');
  assert.equal(value.trigger, undefined);
});

test('protocol v2 preserves and normalizes a self-contained ordered current batch', () => {
  const first = {
    messageId: 'msg_device2_batch_1',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '你明明答应过我，我真的很失望',
    sentAt: 1784399999000
  };
  const second = validV2Envelope().message;
  const value = validateEnvelope(validV2Envelope({
    context: {
      currentBatch: {
        batchId: 'batch_device2_1',
        messageIds: [first.messageId, second.messageId],
        startedAt: first.sentAt,
        committedAt: 1784400000000,
        messages: [first, second]
      }
    }
  }));

  assert.deepEqual(value.context.currentBatch.messageIds, [
    'msg_device2_batch_1',
    'msg_device2_1'
  ]);
  assert.deepEqual(
    value.context.currentBatch.messages.map(message => message.content),
    ['你明明答应过我，我真的很失望', '你好']
  );
  assert.equal(value.context.currentBatch.startedAt, first.sentAt);
  assert.equal(value.context.currentBatch.committedAt, 1784400000000);
});

test('protocol v3 preserves a complete verified authority and visibility cursor', () => {
  const source = validV3Envelope();
  const normalized = validateEnvelope(source);

  assert.equal(normalized.protocolVersion, 3);
  assert.deepEqual(normalized.authority, source.authority);
  assert.deepEqual(normalized.context.visibilityCursor, source.context.visibilityCursor);
  assert.equal(normalized.context.currentBatch.messages.length, 2);
  assert.equal(Object.hasOwn(normalized, 'resultAuthorityVersion'), false);
  assert.deepEqual(validateEnvelope(cloned(normalized)), normalized);
});

test('protocol v3 preserves one closed native stage persona revision in direct and automatic scenes', () => {
  const direct = validV3Envelope();
  direct.context.scene = validDynamicScene();
  const normalizedDirect = validateEnvelope(direct);
  assert.equal(normalizedDirect.context.scene.stagePersonaRevision, 7);
  assert.equal(normalizedDirect.context.scene.effectiveStagePersona, '当前有效的阶段人设。');

  const automatic = validV3AutomaticEnvelope('ROLE_PLAN_MOMENT');
  automatic.trigger.context.scene = validDynamicScene({ stagePersonaRevision: 8 });
  const normalizedAutomatic = validateEnvelope(automatic);
  assert.equal(normalizedAutomatic.trigger.context.scene.stagePersonaRevision, 8);
});

test('protocol v3 rejects a missing coercible or unknown scene revision without widening v2', () => {
  for (const [label, mutate] of [
    ['missing', scene => { delete scene.stagePersonaRevision; }],
    ['inherited', scene => {
      delete scene.stagePersonaRevision;
      Object.setPrototypeOf(scene, { stagePersonaRevision: 7 });
    }],
    ['string', scene => { scene.stagePersonaRevision = '7'; }],
    ['negative', scene => { scene.stagePersonaRevision = -1; }],
    ['unsafe', scene => { scene.stagePersonaRevision = Number.MAX_SAFE_INTEGER + 1; }],
    ['unknown', scene => { scene.unexpectedSceneField = true; }]
  ]) {
    const source = validV3Envelope();
    source.context.scene = validDynamicScene();
    mutate(source.context.scene);
    assert.throws(
      () => validateEnvelope(source),
      /stagePersonaRevision|scene.*keys/i,
      label
    );
  }

  const v2A = validV2Envelope({
    context: { scene: validDynamicScene({ stagePersonaRevision: 7, unexpectedSceneField: 'old' }) }
  });
  const v2B = cloned(v2A);
  v2B.context.scene.stagePersonaRevision = 'legacy-coerced-or-ignored';
  v2B.context.scene.unexpectedSceneField = 'different-old-value';
  assert.deepEqual(validateEnvelope(v2A), validateEnvelope(v2B));
  assert.equal(Object.hasOwn(validateEnvelope(v2A).context.scene, 'stagePersonaRevision'), false);
});

test('protocol v3 support leaves complete protocol v1 and v2 normalization unchanged', () => {
  const v1 = validEnvelope();
  const v2 = validBatchedV2Envelope();
  assert.deepEqual(validateEnvelope(cloned(v1)), validateEnvelope(v1));
  assert.deepEqual(validateEnvelope(cloned(v2)), validateEnvelope(v2));
  assert.equal(Object.hasOwn(validateEnvelope(v2), 'authority'), false);
  assert.equal(Object.hasOwn(validateEnvelope(v2).context, 'visibilityCursor'), false);
  assert.throws(() => validateEnvelope({ ...v2, protocolVersion: 4 }), /protocolVersion/i);
});

test('protocol v3 closes direct and automatic context keys without changing v2 normalization', () => {
  const directUnknown = validV3Envelope();
  directUnknown.context.unexpectedContextField = true;
  assert.throws(() => validateEnvelope(directUnknown), /context.*keys/i);

  const automaticUnknown = validV3AutomaticEnvelope('PROACTIVE_CHAT');
  automaticUnknown.context.unexpectedContextField = true;
  assert.throws(() => validateEnvelope(automaticUnknown), /context.*keys/i);

  const v2 = validBatchedV2Envelope();
  v2.context.unexpectedContextField = true;
  assert.doesNotThrow(() => validateEnvelope(v2));
});

test('protocol v3 rejects forged authority, impossible cursor, and authority selectors', () => {
  const forged = validV3Envelope();
  forged.authority.lineageKey = 'lin_forged';
  assert.throws(() => validateEnvelope(forged), /authority lineage mismatch/i);

  const impossible = validV3Envelope();
  impossible.context.visibilityCursor.uiAppliedSequence = 1;
  impossible.context.visibilityCursor.nativeCompletedSequence = 0;
  assert.throws(() => validateEnvelope(impossible), /uiApplied.*nativeCompleted/i);

  const selector = validV3Envelope({ resultAuthorityVersion: 1 });
  assert.throws(() => validateEnvelope(selector), /resultAuthorityVersion/i);
});

test('protocol v3 validates every automatic kind and never skips its top-level cursor', () => {
  for (const kind of V3_AUTOMATIC_KINDS) {
    const source = validV3AutomaticEnvelope(kind);
    const normalized = validateEnvelope(source);
    assert.equal(normalized.kind, kind);
    assert.equal(normalized.authority.laneKey, v3LaneForKind(kind));
    assert.equal(normalized.context.visibilityCursor.localSequence, 1);

    const missing = cloned(source);
    delete missing.context.visibilityCursor;
    assert.throws(() => validateEnvelope(missing), /visibility cursor/i, kind);

    const impossible = cloned(source);
    impossible.context.visibilityCursor.uiAppliedSequence = 1;
    assert.throws(() => validateEnvelope(impossible), /uiApplied.*nativeCompleted/i, kind);
  }

  for (const [kind, anchorId] of [
    ['PROACTIVE_CHAT', 'cloud_alarm_protocol_v3'],
    ['ROLE_PLAN_CHAT', 'plan_alarm_protocol_v3']
  ]) {
    const source = validV3AutomaticEnvelope(kind);
    source.context.visibilityCursor.nativeCompletedTurnId = anchorId;
    source.context.visibilityCursor.nativeCompletedGroupId = anchorId;
    source.context.visibilityCursor.uiAppliedTurnId = anchorId;
    source.context.visibilityCursor.uiAppliedGroupId = anchorId;
    const normalized = validateEnvelope(source);
    assert.equal(
      normalized.context.visibilityCursor.nativeCompletedTurnId,
      `turn_${anchorId}`
    );
    assert.equal(
      normalized.context.visibilityCursor.nativeCompletedGroupId,
      `turn_${anchorId}`
    );
  }
});

test('protocol v3 direct requires the complete current batch by count identity and order', () => {
  const missingMessages = validV3Envelope();
  delete missingMessages.context.currentBatch.messages;
  assert.throws(() => validateEnvelope(missingMessages), /current batch messages/i);

  const missingItem = validV3Envelope();
  missingItem.context.currentBatch.messages.pop();
  assert.throws(() => validateEnvelope(missingItem), /current batch messages/i);

  const wrongOrder = validV3Envelope();
  wrongOrder.context.currentBatch.messages.reverse();
  assert.throws(() => validateEnvelope(wrongOrder), /current batch message order/i);

  const wrongIds = validV3Envelope();
  wrongIds.context.currentBatch.messageIds[0] = 'msg_forged_batch_member';
  assert.throws(() => validateEnvelope(wrongIds), /current batch message order/i);

  const wrongSource = validV3Envelope();
  wrongSource.context.currentBatch.messages[wrongSource.context.currentBatch.messages.length - 1] = {
    ...wrongSource.context.currentBatch.messages.at(-1),
    content: '篡改后的最后一条'
  };
  assert.throws(() => validateEnvelope(wrongSource), /current batch source message/i);

  const payment = validV3Envelope();
  payment.message.messageId = 'pay_protocol_v3';
  payment.context.currentBatch.messageIds[1] = 'pay_protocol_v3';
  payment.context.currentBatch.messages[1].messageId = 'pay_protocol_v3';
  payment.authority.rootSourceId = 'msg_pay_protocol_v3';
  payment.authority.lineageKey = deriveAuthorityLineageKey({
    roleId: payment.characterId,
    laneKey: payment.authority.laneKey,
    rootSourceId: 'msg_pay_protocol_v3'
  });
  const normalizedPayment = validateEnvelope(payment);
  assert.equal(normalizedPayment.message.messageId, 'msg_pay_protocol_v3');
  assert.equal(normalizedPayment.context.currentBatch.messageIds.at(-1), 'msg_pay_protocol_v3');
  assert.equal(normalizedPayment.authority.rootSourceId, 'msg_pay_protocol_v3');
});

test('protocol v3 rejects a final envelope message whose attachment differs from its complete batch', () => {
  const forged = validV3Envelope();
  forged.message = {
    ...forged.message,
    attachments: [{
      attachmentId: 'att_protocol_v3_final',
      messageId: forged.message.messageId,
      kind: 'image',
      mime: 'image/jpeg',
      name: 'final.jpg',
      width: 1,
      height: 1,
      bytes: Buffer.from(JPEG_1X1, 'base64').length,
      dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
    }]
  };
  assert.throws(() => validateEnvelope(forged), /current batch source message mismatch/i);
});

test('protocol v3 cursor enforces closed keys, integer domains, boolean type, and ordering', () => {
  const unknown = validV3Envelope();
  unknown.context.visibilityCursor.unknown = true;
  assert.throws(() => validateEnvelope(unknown), /visibility cursor.*keys/i);

  for (const field of [
    'nativeCompletedSequence', 'uiAppliedSequence', 'localSequence',
    'clearedThroughSequence', 'clearEpoch', 'clearedAt'
  ]) {
    const negative = validV3Envelope();
    negative.context.visibilityCursor[field] = -1;
    assert.throws(() => validateEnvelope(negative), new RegExp(field, 'i'));
    const stringValue = validV3Envelope();
    stringValue.context.visibilityCursor[field] = '0';
    assert.throws(() => validateEnvelope(stringValue), new RegExp(field, 'i'));
    const fraction = validV3Envelope();
    fraction.context.visibilityCursor[field] = 0.5;
    assert.throws(() => validateEnvelope(fraction), new RegExp(field, 'i'));
    const unsafe = validV3Envelope();
    unsafe.context.visibilityCursor[field] = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => validateEnvelope(unsafe), new RegExp(field, 'i'));
  }

  const nonBoolean = validV3Envelope();
  nonBoolean.context.visibilityCursor.chatOpen = 1;
  assert.throws(() => validateEnvelope(nonBoolean), /chatOpen/i);

  const nativeAhead = validV3Envelope();
  nativeAhead.context.visibilityCursor.nativeCompletedSequence = 1;
  nativeAhead.context.visibilityCursor.nativeCompletedTurnId = 'turn_native_1';
  nativeAhead.context.visibilityCursor.nativeCompletedGroupId = 'grp_native_1';
  assert.throws(() => validateEnvelope(nativeAhead), /nativeCompleted.*localSequence/i);

  const clearedAhead = validV3Envelope();
  clearedAhead.context.visibilityCursor.clearedThroughSequence = 2;
  assert.throws(() => validateEnvelope(clearedAhead), /clearedThrough.*localSequence/i);
});

test('protocol v3 cursor closes canonical identities while permitting one legacy sequence-zero anchor shape', () => {
  const missingNativeIdentity = validV3Envelope();
  missingNativeIdentity.context.visibilityCursor.nativeCompletedSequence = 1;
  missingNativeIdentity.context.visibilityCursor.localSequence = 2;
  assert.throws(() => validateEnvelope(missingNativeIdentity), /nativeCompleted.*identity/i);

  const partialNativeIdentity = validV3Envelope();
  partialNativeIdentity.context.visibilityCursor.nativeCompletedTurnId = 'turn_legacy_1';
  assert.throws(() => validateEnvelope(partialNativeIdentity), /nativeCompleted.*identity/i);

  const partialUiIdentity = validV3Envelope();
  partialUiIdentity.context.visibilityCursor.uiAppliedTurnId = 'turn_legacy_1';
  assert.throws(() => validateEnvelope(partialUiIdentity), /uiApplied.*identity/i);

  const legacy = validV3Envelope();
  legacy.context.visibilityCursor.nativeCompletedTurnId = 'turn_legacy_1';
  legacy.context.visibilityCursor.nativeCompletedGroupId = 'turn_legacy_1';
  legacy.context.visibilityCursor.uiAppliedTurnId = 'turn_legacy_1';
  legacy.context.visibilityCursor.uiAppliedGroupId = 'turn_legacy_1';
  const normalized = validateEnvelope(legacy);
  assert.equal(normalized.context.visibilityCursor.nativeCompletedSequence, 0);
  assert.equal(normalized.context.visibilityCursor.nativeCompletedGroupId, 'turn_legacy_1');

  const mismatchedLegacy = cloned(legacy);
  mismatchedLegacy.context.visibilityCursor.nativeCompletedGroupId = 'turn_other_legacy';
  assert.throws(() => validateEnvelope(mismatchedLegacy), /legacy.*anchor/i);

  const samePositiveSequenceDifferentIdentity = validV3Envelope();
  samePositiveSequenceDifferentIdentity.context.visibilityCursor = {
    ...samePositiveSequenceDifferentIdentity.context.visibilityCursor,
    nativeCompletedTurnId: 'turn_native_cursor_1',
    nativeCompletedGroupId: `grp_${'a'.repeat(64)}`,
    nativeCompletedSequence: 1,
    uiAppliedTurnId: 'turn_ui_cursor_1',
    uiAppliedGroupId: `grp_${'b'.repeat(64)}`,
    uiAppliedSequence: 1,
    localSequence: 2
  };
  assert.throws(
    () => validateEnvelope(samePositiveSequenceDifferentIdentity),
    /positive.*cursor.*identity|cursor.*identity/i
  );

  const samePositiveGroupDifferentSequence = validV3Envelope();
  samePositiveGroupDifferentSequence.context.visibilityCursor = {
    ...samePositiveGroupDifferentSequence.context.visibilityCursor,
    nativeCompletedTurnId: 'turn_cursor_group_1',
    nativeCompletedGroupId: `grp_${'c'.repeat(64)}`,
    nativeCompletedSequence: 2,
    uiAppliedTurnId: 'turn_cursor_group_1',
    uiAppliedGroupId: `grp_${'c'.repeat(64)}`,
    uiAppliedSequence: 1,
    localSequence: 3
  };
  assert.throws(
    () => validateEnvelope(samePositiveGroupDifferentSequence),
    /positive.*cursor.*identity|cursor.*identity/i
  );
});

test('protocol v3 authority and cursor reject unknown keys, mismatched retry, and nested selectors', () => {
  const authorityUnknown = validV3Envelope();
  authorityUnknown.authority.extra = true;
  assert.throws(() => validateEnvelope(authorityUnknown), /authority.*keys/i);

  for (const [field, value] of [
    ['algorithm', 'al-authority-v2'],
    ['roleId', 'other'],
    ['laneKey', 'public_moment'],
    ['rootSourceId', 'msg_other'],
    ['claimedLineageRevision', 0]
  ]) {
    const invalid = validV3Envelope();
    invalid.authority[field] = value;
    assert.throws(() => validateEnvelope(invalid), /authority/i, field);
  }

  for (const revision of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    const invalid = validV3Envelope();
    invalid.authority.claimedLineageRevision = revision;
    assert.throws(() => validateEnvelope(invalid), /authority.*revision/i);
  }

  const retry = validV3Envelope();
  retry.context.retry = {
    retryOfTurnId: 'turn_parent_v3',
    canonicalMessageId: retry.message.messageId
  };
  retry.authority.retryOfTurnId = 'turn_different_parent';
  assert.throws(() => validateEnvelope(retry), /authority retry mismatch/i);

  const nestedSelector = validV3Envelope();
  nestedSelector.authority.resultAuthorityVersion = 1;
  assert.throws(() => validateEnvelope(nestedSelector), /resultAuthorityVersion/i);

  const cursorSelector = validV3Envelope();
  cursorSelector.context.visibilityCursor.resultAuthorityVersion = 1;
  assert.throws(() => validateEnvelope(cursorSelector), /resultAuthorityVersion/i);
});

test('protocol v2 rejects malformed current batch identity, ordering, and timing', () => {
  const source = validV2Envelope().message;
  const earlier = {
    ...source,
    messageId: 'msg_device2_batch_earlier',
    content: '第一条',
    sentAt: source.sentAt - 1_000
  };
  const withBatch = currentBatch => validV2Envelope({ context: { currentBatch } });

  assert.throws(() => validateEnvelope(withBatch({
    batchId: 'batch_device2_duplicate',
    messageIds: [earlier.messageId, earlier.messageId],
    startedAt: earlier.sentAt,
    committedAt: source.sentAt,
    messages: [earlier, earlier]
  })), /duplicate batch messageId/i);

  assert.throws(() => validateEnvelope(withBatch({
    batchId: 'batch_device2_wrong_source',
    messageIds: [source.messageId, earlier.messageId],
    startedAt: earlier.sentAt,
    committedAt: source.sentAt,
    messages: [source, earlier]
  })), /source message/i);

  assert.throws(() => validateEnvelope(withBatch({
    batchId: 'batch_device2_bad_time',
    messageIds: [earlier.messageId, source.messageId],
    startedAt: source.sentAt + 1,
    committedAt: source.sentAt,
    messages: [earlier, source]
  })), /batch timing/i);
});

test('protocol v2 keeps id-only current batches compatible with an existing client', () => {
  const value = validateEnvelope(validV2Envelope({
    context: {
      currentBatch: {
        batchId: 'batch_legacy_phone',
        messageIds: ['msg_legacy_first', 'msg_device2_1'],
        startedAt: 1784399999000,
        committedAt: 1784400000000
      }
    }
  }));

  assert.deepEqual(value.context.currentBatch.messageIds, ['msg_legacy_first', 'msg_device2_1']);
  assert.equal('messages' in value.context.currentBatch, false);
});

test('protocol v2 preserves validated retry lineage for a direct turn', () => {
  const value = validateEnvelope(validV2Envelope({
    context: {
      retry: {
        retryOfTurnId: 'turn_device2_original',
        canonicalMessageId: 'msg_device2_1'
      }
    }
  }));
  assert.deepEqual(value.context.retry, {
    retryOfTurnId: 'turn_device2_original',
    canonicalMessageId: 'msg_device2_1'
  });
});

test('a retry creates a new turn while reusing one canonical user message', () => {
  withStore(({ store }) => {
    store.migrate();
    const original = validV2Envelope();
    store.submitTurn(original);
    const retry = validV2Envelope({
      turnId: 'turn_device2_retry_1',
      deviceSeq: 2,
      createdAt: original.createdAt + 1_000,
      context: {
        retry: {
          retryOfTurnId: original.turnId,
          canonicalMessageId: original.message.messageId
        }
      }
    });

    const saved = store.submitTurn(retry);

    assert.equal(saved.turnId, retry.turnId);
    assert.equal(saved.sourceMessageId, original.message.messageId);
    assert.equal(store.listMessages('yuqi', 20).filter(row => row.speakerType === 'user').length, 1);
  });
});

test('a retry can reuse a reconciled canonical message when its original turn is missing', () => {
  withStore(({ store }) => {
    store.migrate();
    const original = validV2Envelope();
    store.putMessage({
      ...original.message,
      turnId: original.turnId,
      characterId: original.characterId,
      origin: 'phone',
      deviceId: original.deviceId,
      deviceSeq: original.deviceSeq
    });
    const retry = validV2Envelope({
      turnId: 'turn_device2_recovered_retry',
      deviceSeq: 2,
      createdAt: original.createdAt + 1_000,
      context: {
        retry: {
          retryOfTurnId: original.turnId,
          canonicalMessageId: original.message.messageId
        }
      }
    });

    const saved = store.submitTurn(retry);

    assert.equal(saved.turnId, retry.turnId);
    assert.equal(saved.state, 'queued');
    assert.equal(saved.sourceMessageId, original.message.messageId);
    assert.equal(store.listMessages('yuqi', 20).filter(row => row.speakerType === 'user').length, 1);
  });
});

test('a retry cannot claim an unrelated missing turn through a reconciled message', () => {
  withStore(({ store }) => {
    store.migrate();
    const original = validV2Envelope();
    store.putMessage({
      ...original.message,
      turnId: original.turnId,
      characterId: original.characterId,
      origin: 'phone',
      deviceId: original.deviceId,
      deviceSeq: original.deviceSeq
    });
    const retry = validV2Envelope({
      turnId: 'turn_device2_unrelated_retry',
      deviceSeq: 2,
      createdAt: original.createdAt + 1_000,
      context: {
        retry: {
          retryOfTurnId: 'turn_device2_different_missing_parent',
          canonicalMessageId: original.message.messageId
        }
      }
    });

    assert.throws(() => store.submitTurn(retry), /retry turn lineage mismatch/i);
  });
});

test('a current user batch persists independently from legacy message turn ids across reopening', () => {
  withStore(({ store, file }) => {
    store.migrate();
    const input = validBatchedV2Envelope();
    store.putMessage({
      ...input.context.currentBatch.messages[0],
      turnId: 'turn_legacy_msg_device2_batch_1',
      characterId: input.characterId,
      origin: 'phone'
    });
    store.submitTurn(input);

    assert.equal(store.getMessage('msg_device2_batch_1').turnId, 'turn_legacy_msg_device2_batch_1');
    store.close();

    const reopened = new YuqiStore(file);
    try {
      reopened.migrate();
      const batch = reopened.getCurrentUserBatch(input.turnId);
      assert.equal(batch.batchId, 'batch_device2_1');
      assert.equal(batch.sourceMessageId, input.message.messageId);
      assert.deepEqual(batch.messages.map(message => message.messageId), [
        'msg_device2_batch_1',
        input.message.messageId
      ]);
      const history = reopened.listMessages(input.characterId, 20);
      assert.deepEqual(
        history.filter(message => batch.messageIds.includes(message.messageId))
          .map(message => [message.messageId, message.batchId, message.batchSequence]),
        [
          ['msg_device2_batch_1', 'batch_device2_1', 0],
          [input.message.messageId, 'batch_device2_1', 1]
        ]
      );
    } finally {
      reopened.close();
    }
  });
});

test('a retry persists a second turn reference to the same immutable current batch', () => {
  withStore(({ store }) => {
    store.migrate();
    const original = validBatchedV2Envelope();
    store.submitTurn(original);
    const retry = validBatchedV2Envelope({
      turnId: 'turn_device2_batch_retry',
      deviceSeq: 2,
      createdAt: original.createdAt + 1_000
    });
    retry.context.retry = {
      retryOfTurnId: original.turnId,
      canonicalMessageId: original.message.messageId
    };
    retry.context.currentBatch.committedAt = original.context.currentBatch.committedAt;

    store.submitTurn(retry);

    assert.equal(store.getCurrentUserBatch(original.turnId).batchId, 'batch_device2_1');
    assert.equal(store.getCurrentUserBatch(retry.turnId).batchId, 'batch_device2_1');
    assert.equal(store.listMessages('yuqi', 20).filter(row => row.speakerType === 'user').length, 1);
  });
});

test('a retry cannot mutate an earlier message in its canonical current batch', () => {
  withStore(({ store }) => {
    store.migrate();
    const original = validBatchedV2Envelope();
    store.submitTurn(original);
    const retry = validBatchedV2Envelope({
      turnId: 'turn_device2_batch_retry_mutated',
      deviceSeq: 3,
      createdAt: original.createdAt + 2_000
    });
    retry.context.retry = {
      retryOfTurnId: original.turnId,
      canonicalMessageId: original.message.messageId
    };
    retry.context.currentBatch.messages[0].content = '被错误改写的第一条';
    retry.context.currentBatch.committedAt = original.context.currentBatch.committedAt;

    assert.throws(() => store.submitTurn(retry), /retry current batch conflict/i);
  });
});

test('protocol v2 direct turn preserves validated pending payment context', () => {
  const envelope = validateEnvelope(validV2Envelope({
    context: {
      payment: {
        kind: 'redpacket', amount: 20, note: '请你喝一杯',
        messageId: 'pay_1784713105609_3qb4xo', status: 'pending'
      }
    }
  }));

  assert.deepEqual(envelope.context.payment, {
    kind: 'redpacket', amount: 20, note: '请你喝一杯',
    messageId: 'pay_1784713105609_3qb4xo', status: 'pending'
  });
});

test('protocol v2 direct turn preserves a validated dynamic relationship scene', () => {
  const envelope = validateEnvelope(validV2Envelope({
    context: {
      scene: {
        playerName: '姜隽倚',
        characterName: '虞栖',
        relationshipStage: {
          id: 'familiar', label: '熟悉 · 闹矛盾期', content: '双方已经形成稳定聊天习惯。\n仍有矛盾。',
          since: 1784300000000, reason: '持续交流', confidence: 0.9,
          base: {
            id: 'familiar', label: '熟悉', content: '双方已经形成稳定聊天习惯。',
            since: 1784300000000, reason: '持续交流', confidence: 0.9
          },
          phase: {
            id: 'conflict', label: '闹矛盾期', content: '仍有矛盾。',
            since: 1784390000000, reason: '连续两轮争执', confidence: 0.88
          }
        },
        conversationExtraPrompt: '她今天有点忙。',
        globalExtraPrompt: '保持自然。',
        rolePlanCatalog: 'plan_tea | private_message | 2026-07-24 18:30 | ACTIVE | 提醒喝茶',
        roleScheduleContext: '今天 18:30 提醒喝茶；明天 09:00 去编辑部。',
        momentContext: '虞栖：下班路上的风，终于有点像夏天了。',
        stageCatalog: [
          { id: 'new', label: '初识', content: '保持普通社交边界。' },
          { id: 'familiar', label: '熟悉', content: '双方已经形成稳定聊天习惯。' }
        ],
        phaseCatalog: [
          { id: 'normal', label: '正常相处', content: '' },
          { id: 'conflict', label: '闹矛盾期', content: '仍有矛盾。' }
        ],
        currentPhase: 'conflict',
        ignoredBackstageField: 'must not survive'
      }
    }
  }));

  assert.deepEqual(envelope.context.scene, {
    playerName: '姜隽倚',
    characterName: '虞栖',
    relationshipStage: {
      id: 'familiar', label: '熟悉 · 闹矛盾期', content: '双方已经形成稳定聊天习惯。\n仍有矛盾。',
      since: 1784300000000, reason: '持续交流', confidence: 0.9,
      base: {
        id: 'familiar', label: '熟悉', content: '双方已经形成稳定聊天习惯。',
        since: 1784300000000, reason: '持续交流', confidence: 0.9
      },
      phase: {
        id: 'conflict', label: '闹矛盾期', content: '仍有矛盾。',
        since: 1784390000000, reason: '连续两轮争执', confidence: 0.88
      }
    },
    conversationExtraPrompt: '她今天有点忙。',
    globalExtraPrompt: '保持自然。',
    rolePlanCatalog: 'plan_tea | private_message | 2026-07-24 18:30 | ACTIVE | 提醒喝茶',
    roleScheduleContext: '今天 18:30 提醒喝茶；明天 09:00 去编辑部。',
    momentContext: '虞栖：下班路上的风，终于有点像夏天了。',
    stageCatalog: [
      { id: 'new', label: '初识', content: '保持普通社交边界。' },
      { id: 'familiar', label: '熟悉', content: '双方已经形成稳定聊天习惯。' }
    ],
    phaseCatalog: [
      { id: 'normal', label: '正常相处', content: '' },
      { id: 'conflict', label: '闹矛盾期', content: '仍有矛盾。' }
    ],
    currentPhase: 'conflict'
  });
});

test('public committed status exposes the structured payment action', () => {
  const status = publicTurnStatus({
    turnId: 'turn_payment_status_1',
    state: 'committed',
    origin: 'codex',
    route: 'fast',
    routeReasons: [],
    createdAt: 1000,
    updatedAt: 2000,
    replyJson: JSON.stringify({
      action: 'send',
      paymentAction: 'received',
      rolePlanOperations: [{ op: 'cancel', planId: 'plan_old' }],
      reply: { content: '那我就收了', origin: 'codex' }
    })
  }, { clock: () => 2000 });

  assert.equal(status.paymentAction, 'received');
  assert.deepEqual(status.rolePlanOperations, [{ op: 'cancel', planId: 'plan_old' }]);
});

test('protocol v2 accepts legacy payment ids by canonicalizing them before validation', () => {
  const value = validateEnvelope(validV2Envelope({
    turnId: 'turn_pay_1784713105609_3qb4xo',
    message: {
      ...validV2Envelope().message,
      messageId: 'pay_1784713105609_3qb4xo',
      content: '姜隽倚给虞栖发了一个红包：¥20.00'
    }
  }));

  assert.equal(value.message.messageId, 'msg_pay_1784713105609_3qb4xo');
});

test('canonical payment recovery suppresses the already-ingested legacy alias', () => withStore(({ store }) => {
  store.putMessage({
    messageId: 'pay_1784713105609_3qb4xo',
    turnId: 'turn_pay_1784713105609_3qb4xo',
    characterId: 'yuqi',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '姜隽倚给虞栖发了一个红包：¥20.00',
    sentAt: 1784713109805,
    origin: 'phone',
    deviceId: 'device2',
    deviceSeq: 1784713105609
  });
  store.submitTurn(validV2Envelope({
    turnId: 'turn_pay_1784713105609_3qb4xo',
    deviceSeq: 1784713105609,
    createdAt: 1784713105609,
    message: {
      ...validV2Envelope().message,
      messageId: 'pay_1784713105609_3qb4xo',
      content: '姜隽倚给虞栖发了一个红包：¥20.00',
      sentAt: 1784713105609
    }
  }));

  assert.deepEqual(store.listMessages('yuqi', 10).map(message => message.messageId), [
    'msg_pay_1784713105609_3qb4xo'
  ]);
  assert.equal(store.isMessageSuppressed('pay_1784713105609_3qb4xo'), true);
}));

test('protocol v2 automatic turn persists a trigger without creating a user message', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  assert.equal(turn.sourceMessageId, 'trigger_device2_proactive_1');
  assert.equal(store.listMessages('yuqi', 10).length, 0);
}));

test('normalizes authenticated legacy Android automatic turn IDs without widening direct-message IDs', () => {
  const automatic = validateEnvelope(validTriggerEnvelope({ turnId: 'cloud_proactive_job_1' }));
  assert.equal(automatic.turnId, 'turn_cloud_proactive_job_1');
  assert.throws(
    () => validateEnvelope(validV2Envelope({ turnId: 'cloud_direct_1' })),
    /invalid turnId/i
  );
});

test('protocol v2 automatic turn rejects a fabricated user message', () => {
  assert.throws(
    () => validateEnvelope(validTriggerEnvelope({ message: validV2Envelope().message })),
    /automatic turn cannot contain a message/i
  );
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

test('persists the selected route and completed stage timings', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.setTurnRoute(turn.turnId, 'fast', ['ordinary_chat']);
  store.beginStage(turn.turnId, 'memory', 'gpt-5.6-terra', 'medium', 1000);
  store.finishStage(turn.turnId, 'memory', 1450);

  const saved = store.getTurn(turn.turnId);
  assert.equal(saved.route, 'fast');
  assert.deepEqual(saved.routeReasons, ['ordinary_chat']);
  assert.deepEqual(store.getTurnStages(turn.turnId), [{
    stage: 'memory',
    ordinal: 1,
    model: 'gpt-5.6-terra',
    effort: 'medium',
    startedAt: 1000,
    finishedAt: 1450,
    durationMs: 450
  }]);
}));

test('public turn status separates immersive copy from technical details', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.setTurnRoute(turn.turnId, 'fast', ['ordinary_chat']);
  store.beginStage(turn.turnId, 'memory', 'gpt-5.6-terra', 'medium', 1784400000000);

  const status = publicTurnStatus(store.getTurn(turn.turnId), {
    stages: store.getTurnStages(turn.turnId),
    clock: () => 1784400000600
  });
  assert.equal(status.route, 'fast');
  assert.equal(status.displayStage, '正在翻一下我们以前说过的话…');
  assert.equal(status.technicalStage, 'memory');
  assert.equal(status.stageModel, 'gpt-5.6-terra');
  assert.equal(status.stageEffort, 'medium');
  assert.equal(status.stageElapsedMs, 600);
  assert.equal(status.totalElapsedMs, 600);
}));

test('lists every nonterminal turn for dispatcher recovery and excludes committed turns', () => withStore(({ store }) => {
  const first = store.submitTurn(validEnvelope());
  const second = store.submitTurn(validV2Envelope({
    turnId: 'turn_device2_2',
    deviceSeq: 2,
    message: { ...validV2Envelope().message, messageId: 'msg_device2_2' }
  }));
  store.claimTurnById(first.turnId, 'worker-a');
  store.claimTurnById(second.turnId, 'worker-a');
  store.advanceTurn(second.turnId, 'memory_running', 'memory_done', { memoryPacketJson: '{}' });
  store.advanceTurn(second.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(second.turnId, 'brain_running', 'brain_done', { brainDraftJson: '{"reply":"ok"}' });
  store.advanceTurn(second.turnId, 'brain_done', 'supervisor_running');
  store.advanceTurn(second.turnId, 'supervisor_running', 'approved', { supervisorJson: '{"approved":true}' });
  store.advanceTurn(second.turnId, 'approved', 'committed', { replyJson: '{"reply":{"content":"ok"}}' });

  assert.deepEqual(store.listRecoverableTurns().map(turn => turn.turnId), [first.turnId]);
}));

test('persists one cloud delivery target per turn and peer across reopening', () => withStore(({ store, file }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 44);
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 44);
  assert.equal(store.listCloudDeliveries(turn.turnId).length, 1);

  store.close();
  const reopened = new YuqiStore(file);
  try {
    const [delivery] = reopened.listCloudDeliveries(turn.turnId);
    assert.equal(delivery.peerId, 'phone_peer');
    assert.equal(delivery.recoveryAckSeq, 44);
    assert.equal(delivery.state, 'waiting');
  } finally {
    reopened.close();
  }
}));

test('delivery receipts merge partial out-of-order items idempotently and reject foreign items', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  const reply = store.putMessage({
    messageId: 'msg_yuqi_delivery_1',
    turnId: turn.turnId,
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '好呀，我记住了。',
    sentAt: 1784400001000,
    origin: 'codex'
  });
  store.quarantinePendingReply(reply.messageId);
  const result = {
    turnId: turn.turnId,
    reply,
    paymentAction: {
      messageId: 'pay_1', kind: 'redpacket', amount: 20, status: 'received'
    },
    momentAction: null,
    lifeAdjustment: null,
    relationshipStageAction: null,
    rolePlanOperations: []
  };
  store.db.prepare(
    "UPDATE turns SET state = 'committed', reply_json = ? WHERE turn_id = ?"
  ).run(JSON.stringify(result), turn.turnId);
  const [messageItem, actionItem] = deliveryItemsForResult(result);
  const receipt = items => ({
    protocolVersion: 1,
    turnId: turn.turnId,
    deliveredAt: 1784400002000,
    items
  });

  const actionOnly = store.recordDeliveryReceipt(receipt([actionItem]));
  assert.equal(actionOnly.complete, false);
  assert.deepEqual(actionOnly.pendingItems, [messageItem]);
  assert.equal(store.isMessageSuppressed(reply.messageId), true);

  store.recordDeliveryReceipt(receipt([actionItem]));
  const complete = store.recordDeliveryReceipt(receipt([messageItem]));
  assert.equal(complete.complete, true);
  assert.equal(complete.deliveredItems.length, 2);
  assert.equal(store.isMessageSuppressed(reply.messageId), false);

  assert.throws(() => store.recordDeliveryReceipt(receipt([{
    kind: 'action',
    id: `${turn.turnId}:foreign`,
    checksum: '0'.repeat(64)
  }])), /does not belong/i);
}));

test('recovers a failed brain draft as one committed reply and resets cloud delivery', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  store.claimTurnById(turn.turnId, 'worker-a');
  store.advanceTurn(turn.turnId, 'memory_running', 'memory_done', { memoryPacketJson: '{}' });
  store.advanceTurn(turn.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(turn.turnId, 'brain_running', 'brain_done', {
    brainDraftJson: JSON.stringify({ reply: '原来是AI短剧。小团队还负责得多，难怪你忙成这样😂', usedFactIds: [] })
  });
  store.advanceTurn(turn.turnId, 'brain_done', 'failed', {
    errorJson: JSON.stringify({ name: 'Error', message: 'hard validation failed: BACKSTAGE_LEAK' })
  });
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 42);
  const failedDelivery = store.prepareCloudDelivery(turn.turnId, 'phone_peer', {
    turnId: turn.turnId, state: 'failed', terminal: true
  });
  store.markCloudDeliveryAttempt(turn.turnId, 'phone_peer');
  store.markCloudDeliveryMailboxed(turn.turnId, 'phone_peer', failedDelivery.checksum);

  const recovered = store.recoverFailedDraft(turn.turnId, {
    peerId: 'phone_peer', sentAt: 1784400004000
  });
  const repeated = store.recoverFailedDraft(turn.turnId, {
    peerId: 'phone_peer', sentAt: 1784400005000
  });
  const [delivery] = store.listCloudDeliveries(turn.turnId);

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.result.reply.content, '原来是AI短剧。小团队还负责得多，难怪你忙成这样😂');
  assert.equal(store.getTurn(turn.turnId).state, 'committed');
  assert.equal(store.getMessage(recovered.result.reply.messageId)?.turnId, turn.turnId);
  assert.equal(delivery.state, 'waiting');
  assert.equal(delivery.recoveryAckSeq, 42);
  assert.equal(delivery.checksum, '');
  assert.equal(repeated.recovered, false);
  assert.equal(repeated.result.reply.messageId, recovered.result.reply.messageId);
}));

test('requeues a transient brain timeout from the completed memory checkpoint', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.claimTurnById(turn.turnId, 'worker-a');
  store.advanceTurn(turn.turnId, 'memory_running', 'memory_done', {
    memoryPacketJson: JSON.stringify({ query: '睡了吗？', candidates: [] })
  });
  store.advanceTurn(turn.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(turn.turnId, 'brain_running', 'failed', {
    errorJson: JSON.stringify({ name: 'CodexTurnError', message: 'Codex turn timed out' })
  });
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 42);
  const failedDelivery = store.prepareCloudDelivery(turn.turnId, 'phone_peer', {
    turnId: turn.turnId, state: 'failed', terminal: true
  });
  store.markCloudDeliveryAttempt(turn.turnId, 'phone_peer');
  store.markCloudDeliveryMailboxed(turn.turnId, 'phone_peer', failedDelivery.checksum);

  const recovered = store.requeueTransientFailedTurn(turn.turnId);
  const saved = store.getTurn(turn.turnId);
  const [delivery] = store.listCloudDeliveries(turn.turnId);

  assert.equal(recovered.requeued, true);
  assert.equal(saved.state, 'memory_done');
  assert.deepEqual(JSON.parse(saved.memoryPacketJson), { query: '睡了吗？', candidates: [] });
  assert.equal(saved.workerId, '');
  assert.equal(saved.errorJson, null);
  assert.equal(delivery.state, 'waiting');
  assert.equal(delivery.recoveryAckSeq, 42);
  assert.equal(delivery.checksum, '');
  assert.equal(delivery.attempts, 0);
  assert.equal(store.requeueTransientFailedTurn(turn.turnId).requeued, false);
}));

test('requeues a model-capacity failure and resets its stale cloud delivery', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.claimTurnById(turn.turnId, 'worker-a');
  store.advanceTurn(turn.turnId, 'memory_running', 'failed', {
    errorJson: JSON.stringify({
      name: 'CodexTurnError',
      message: 'Selected model is at capacity. Please try a different model.'
    })
  });
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 43);
  const failedDelivery = store.prepareCloudDelivery(turn.turnId, 'phone_peer', {
    turnId: turn.turnId, state: 'failed', terminal: true
  });
  store.markCloudDeliveryAttempt(turn.turnId, 'phone_peer');
  store.markCloudDeliveryMailboxed(turn.turnId, 'phone_peer', failedDelivery.checksum);

  const recovered = store.requeueTransientFailedTurn(turn.turnId);
  const [delivery] = store.listCloudDeliveries(turn.turnId);

  assert.equal(recovered.requeued, true);
  assert.equal(recovered.turn.state, 'queued');
  assert.equal(delivery.state, 'waiting');
  assert.equal(delivery.checksum, '');
  assert.equal(delivery.attempts, 0);
}));

test('requeues a usage-limit failure only after an explicit operator recovery', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.claimTurnById(turn.turnId, 'worker-a');
  store.advanceTurn(turn.turnId, 'memory_running', 'memory_done', {
    memoryPacketJson: JSON.stringify({ query: '接受红包吗？', candidates: [] })
  });
  store.advanceTurn(turn.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(turn.turnId, 'brain_running', 'failed', {
    errorJson: JSON.stringify({
      name: 'CodexTurnError',
      message: "You've hit your usage limit. Try again later."
    })
  });
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 42);
  const failedDelivery = store.prepareCloudDelivery(turn.turnId, 'phone_peer', {
    turnId: turn.turnId, state: 'failed', terminal: true
  });
  store.markCloudDeliveryAttempt(turn.turnId, 'phone_peer');
  store.markCloudDeliveryMailboxed(turn.turnId, 'phone_peer', failedDelivery.checksum);

  const recovered = store.requeueUsageLimitFailedTurn(turn.turnId);
  const saved = store.getTurn(turn.turnId);
  const [delivery] = store.listCloudDeliveries(turn.turnId);

  assert.equal(recovered.requeued, true);
  assert.equal(saved.state, 'memory_done');
  assert.deepEqual(JSON.parse(saved.memoryPacketJson), { query: '接受红包吗？', candidates: [] });
  assert.equal(saved.errorJson, null);
  assert.equal(delivery.state, 'waiting');
  assert.equal(delivery.recoveryAckSeq, 42);
  assert.equal(delivery.checksum, '');
  assert.equal(delivery.attempts, 0);
}));

test('does not requeue a permanent orchestration failure', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.claimTurnById(turn.turnId, 'worker-a');
  store.advanceTurn(turn.turnId, 'memory_running', 'failed', {
    errorJson: JSON.stringify({ name: 'Error', message: 'invalid memory packet' })
  });

  const result = store.requeueTransientFailedTurn(turn.turnId);

  assert.equal(result.requeued, false);
  assert.equal(store.getTurn(turn.turnId).state, 'failed');
}));

test('a proactive reply stays outside shared memory until the phone confirms persistence', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  const reply = store.putMessage({
    messageId: 'msg_yuqi_pending_phone_1',
    turnId: turn.turnId,
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '这是只在手机确认后才算说过的话',
    sentAt: 1784400002000,
    origin: 'codex'
  });

  store.quarantinePendingReply(reply.messageId);
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 0);
  const prepared = store.prepareCloudDelivery(turn.turnId, 'phone_peer', { turnId: turn.turnId });
  store.markCloudDeliveryAttempt(turn.turnId, 'phone_peer');
  store.markCloudDeliveryMailboxed(turn.turnId, 'phone_peer', prepared.checksum);

  assert.equal(store.listMessages('yuqi', 20).some(message => message.messageId === reply.messageId), false);

  const confirmed = store.confirmCloudDelivery(turn.turnId, 'phone_peer', {
    messageId: reply.messageId,
    contentSha256: createHash('sha256').update(reply.content, 'utf8').digest('hex'),
    receivedAt: 1784400003000
  });

  assert.equal(confirmed.state, 'confirmed');
  assert.equal(store.listMessages('yuqi', 20).some(message => message.messageId === reply.messageId), true);
}));

test('facts supported by an unconfirmed reply stay outside retrieval', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  const reply = store.putMessage({
    messageId: 'msg_yuqi_pending_fact_1', turnId: turn.turnId, characterId: 'yuqi',
    speakerId: 'yuqi', speakerType: 'character', recipientId: 'user',
    content: '我说我已经买了饭团', sentAt: 1784400002000, origin: 'codex'
  });
  store.putFact({
    factId: 'fact_pending_delivery_1', characterId: 'yuqi', subjectId: 'yuqi',
    predicate: 'bought', object: { item: '饭团' }, evidenceMode: 'exact',
    sourceMessageIds: [reply.messageId], exactQuotes: [{ messageId: reply.messageId, text: reply.content }],
    status: 'verified', confidence: 0.99, origin: 'memory'
  });

  store.quarantinePendingReply(reply.messageId);

  assert.deepEqual(store.listRetrievableFacts('yuqi'), []);
  assert.equal(store.listFacts('yuqi').length, 1);
}));

test('proactive chat delivery policy allows at most one committed skip in the latest four turns', () => withStore(({ store }) => {
  store.submitTurn(validV2Envelope({
    turnId: 'turn_policy_direct_1',
    deviceSeq: 1,
    createdAt: 1784400001000,
    message: {
      ...validV2Envelope().message,
      messageId: 'msg_policy_direct_1',
      sentAt: 1784400001000
    }
  }));
  commitAutomaticTurn(store, { seq: 2, action: 'send' });
  commitAutomaticTurn(store, { seq: 3, action: 'skip' });
  commitAutomaticTurn(store, { seq: 4, action: 'send' });
  commitAutomaticTurn(store, { seq: 5, action: 'send' });

  const policy = store.getProactiveChatDeliveryPolicy('yuqi');

  assert.equal(policy.kind, 'proactive_chat');
  assert.equal(policy.windowSize, 4);
  assert.equal(policy.maxSkips, 1);
  assert.equal(policy.usedSkips, 1);
  assert.equal(policy.skipAllowed, false);
  assert.deepEqual(policy.inspectedTurnIds, [
    'turn_policy_proactive_chat_5',
    'turn_policy_proactive_chat_4',
    'turn_policy_proactive_chat_3',
    'turn_policy_proactive_chat_2'
  ]);
  assert.equal(policy.resetAfterTurnId, null);
}));

test('proactive chat delivery policy is not reset by a new canonical direct user message', () => withStore(({ store }) => {
  commitAutomaticTurn(store, { seq: 2, action: 'skip' });
  store.submitTurn(validV2Envelope({
    turnId: 'turn_policy_direct_reset',
    deviceSeq: 6,
    createdAt: 1784400006000,
    message: {
      ...validV2Envelope().message,
      messageId: 'msg_policy_direct_reset',
      sentAt: 1784400006000
    }
  }));

  const policy = store.getProactiveChatDeliveryPolicy('yuqi');

  assert.equal(policy.usedSkips, 1);
  assert.equal(policy.skipAllowed, false);
  assert.deepEqual(policy.inspectedTurnIds, ['turn_policy_proactive_chat_2']);
  assert.equal(policy.resetAfterTurnId, null);
}));

test('proactive chat delivery policy ignores failed turns and other automatic kinds', () => withStore(({ store }) => {
  commitAutomaticTurn(store, { seq: 2, action: 'skip', state: 'failed' });
  commitAutomaticTurn(store, { seq: 3, action: 'skip', kind: 'PROACTIVE_MOMENT' });

  const policy = store.getProactiveChatDeliveryPolicy('yuqi');

  assert.equal(policy.usedSkips, 0);
  assert.equal(policy.skipAllowed, true);
  assert.deepEqual(policy.inspectedTurnIds, []);
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

test('role session turn counts reset and increment independently', () => withStore(({ store }) => {
  store.setSession('brain', 'thr_brain');
  assert.deepEqual(store.getSessionState('brain'), { threadId: 'thr_brain', turnCount: 0 });

  store.incrementSessionTurnCount('brain');
  store.incrementSessionTurnCount('brain');
  assert.deepEqual(store.getSessionState('brain'), { threadId: 'thr_brain', turnCount: 2 });

  store.setSession('brain', 'thr_replacement');
  assert.deepEqual(store.getSessionState('brain'), { threadId: 'thr_replacement', turnCount: 0 });
  assert.equal(store.getSessionState('memory'), null);
}));

test('v2 normalization remains byte-compatible with the frozen literal projection', () => {
  const input = validV2Envelope({
    message: {
      messageId: 'msg_device2_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你好',
      sentAt: 1784400000000
    }
  });
  const expected = {
    protocolVersion: 2,
    turnId: 'turn_device2_1',
    characterId: 'yuqi',
    deviceId: 'device2',
    deviceSeq: 1,
    createdAt: 1784400000000,
    message: {
      messageId: 'msg_device2_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你好',
      sentAt: 1784400000000
    },
    kind: 'DIRECT_REPLY'
  };
  assert.deepEqual(validateEnvelope(input), expected);
});

test('v1 normalization remains byte-compatible with the frozen literal projection', () => {
  const input = validEnvelope({
    message: {
      messageId: 'msg_device1_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你好',
      sentAt: 1784400000000
    }
  });
  const expected = {
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
    }
  };
  assert.deepEqual(validateEnvelope(input), expected);
});
