import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';

import { decryptRelayPayload } from '../src/cloud-relay-pump.mjs';
import { createYuqiServer, signBridgeRequest } from '../src/local-server.mjs';
import { contentHash, deriveYuqiBackupReceiptId, validateEnvelope } from '../src/protocol.mjs';
import { ResultOutbox } from '../src/result-outbox.mjs';
import { V3DiagnosticAuthorityConflict } from '../src/v3-diagnostics.mjs';

const keyBase64 = Buffer.alloc(32, 9).toString('base64');

function frozenCanonicalBridgeResult() {
  return Object.freeze({
    protocolVersion: 3,
    turnId: 'turn_canonical_transport_1',
    roleId: 'yuqi',
    authorityOrigin: 'pc',
    authorityLineageKey: 'lin_canonical_transport_1',
    visibleGroupId: 'group_canonical_transport_1',
    lineageRevision: 2,
    turnRevision: 4,
    laneKey: 'private_chat',
    laneRevision: 3,
    inputVisibilitySequence: 7,
    inputClearEpoch: 0,
    generationFingerprint: null,
    releaseId: 'release_test',
    commitPayloadVersion: 'pc-visible-commit-v2',
    commitChecksum: 'a'.repeat(64),
    terminalDisposition: 'visible',
    replyParts: [
      { ordinal: 0, messageId: 'msg_canonical_transport_1', content: '第一段', itemChecksum: 'b'.repeat(64) },
      { ordinal: 1, messageId: 'msg_canonical_transport_2', content: '第二段', itemChecksum: 'c'.repeat(64) }
    ],
    actions: [{
      ordinal: 0,
      actionId: 'action_canonical_transport_1',
      kind: 'moment_create',
      targetKey: 'moment:m_1',
      targetRevision: 'd'.repeat(64),
      payload: { momentId: 'm_1', text: '桥接动态' },
      actionChecksum: 'e'.repeat(64)
    }]
  });
}

function authorityDeliveryReceipt(overrides = {}) {
  return {
    protocolVersion: 3,
    type: 'AUTHORITY_DELIVERY_RECEIPT',
    peerId: 'phone_canonical',
    turnId: 'turn_canonical_transport_1',
    authorityLineageKey: 'lin_canonical_transport_1',
    visibleGroupId: 'group_canonical_transport_1',
    commitChecksum: 'a'.repeat(64),
    terminalDisposition: 'visible',
    deliveredAt: 1784400000000,
    ...overrides
  };
}

function conversationClearControl(overrides = {}) {
  const base = {
    protocolVersion: 3,
    type: 'CONVERSATION_CLEAR',
    controlVersion: 'conversation_clear_v1',
    roleId: 'yuqi',
    peerId: 'phone_lan',
    clearEpoch: 1,
    clearedThroughSequence: 3,
    requestedAt: 1784400000000,
    inputCursorChecksum: 'a'.repeat(64)
  };
  const value = { ...base, ...overrides };
  value.controlId = `ctl_${contentHash({
    contract: 'android-lifecycle-control-id-v1',
    controlKind: 'conversation_clear_v1',
    characterId: value.roleId,
    peerId: value.peerId,
    clearEpoch: value.clearEpoch,
    clearedThroughSequence: value.clearedThroughSequence,
    requestedAt: value.requestedAt,
    inputCursorChecksum: value.inputCursorChecksum
  })}`;
  value.checksum = contentHash(value);
  return value;
}

function conversationClearApplied(control, appliedAt = 1784400000100) {
  const body = {
    protocolVersion: 3,
    type: 'CONVERSATION_CLEAR_APPLIED',
    controlId: control.controlId,
    controlChecksum: control.checksum,
    roleId: control.roleId,
    peerId: control.peerId,
    clearEpoch: control.clearEpoch,
    clearedThroughSequence: control.clearedThroughSequence,
    appliedAt
  };
  return { ...body, checksum: contentHash(body) };
}

function androidRoomBackupHead(overrides = {}) {
  const cursor = {
    characterId: 'yuqi',
    nativeCompletedTurnId: null,
    nativeCompletedGroupId: null,
    nativeCompletedSequence: 0,
    uiAppliedTurnId: null,
    uiAppliedGroupId: null,
    uiAppliedSequence: 0,
    localSequence: 0,
    clearedThroughSequence: 0,
    clearEpoch: 0,
    clearedAt: 0,
    chatOpen: false,
    updatedAt: 1784400000000
  };
  cursor.cursorChecksum = contentHash({ contract: 'conversation-cursor-clear-v1', ...cursor });
  const basis = {
    headVersion: 'android-room-backup-head-v1',
    roleId: 'yuqi',
    roomSchemaVersion: 14,
    cursor,
    lifecycleHead: null,
    capturedAt: 1784400000100,
    ...overrides
  };
  return { ...basis, checksum: contentHash(basis) };
}

function yuqiBackupRequest(overrides = {}) {
  const basis = {
    protocolVersion: 3,
    type: 'YUQI_BACKUP_REQUEST',
    requestVersion: 'yuqi-backup-request-v1',
    roleId: 'yuqi',
    peerId: 'phone_lan',
    requestedAt: 1784400000100,
    androidRoomHead: androidRoomBackupHead(),
    ...overrides
  };
  return { ...basis, checksum: contentHash(basis) };
}

function yuqiBackupReceipt(request) {
  const manifestChecksum = 'a'.repeat(64);
  const snapshotSha256 = 'b'.repeat(64);
  const logicalChecksum = 'c'.repeat(64);
  const basis = {
    receiptVersion: 'yuqi-backup-receipt-v1',
    receiptId: deriveYuqiBackupReceiptId({
      roleId: request.roleId,
      manifestChecksum,
      snapshotSha256,
      logicalChecksum,
      createdAt: request.requestedAt
    }),
    roleId: request.roleId,
    manifestChecksum,
    snapshotSha256,
    logicalChecksum,
    createdAt: request.requestedAt
  };
  return { ...basis, receiptChecksum: contentHash(basis) };
}

function roleDeleteControl(overrides = {}) {
  const request = yuqiBackupRequest();
  const backupReceipt = yuqiBackupReceipt(request);
  const basis = {
    protocolVersion: 3,
    type: 'ROLE_DELETE',
    controlVersion: 'role_delete_v1',
    roleId: request.roleId,
    peerId: request.peerId,
    requestedAt: request.requestedAt + 100,
    backupReceipt,
    ...overrides
  };
  basis.controlId = `ctl_${contentHash({
    contract: 'android-lifecycle-control-id-v1',
    controlKind: 'role_delete_v1',
    roleId: basis.roleId,
    peerId: basis.peerId,
    requestedAt: basis.requestedAt,
    backupReceiptChecksum: basis.backupReceipt.receiptChecksum
  })}`;
  basis.checksum = contentHash(basis);
  return basis;
}

function roleDeletePending(control, pendingRetractions = 1) {
  const basis = {
    protocolVersion: 3,
    type: 'ROLE_DELETE_PENDING',
    controlId: control.controlId,
    controlChecksum: control.checksum,
    roleId: control.roleId,
    peerId: control.peerId,
    state: 'pending_retractions',
    pendingRetractions,
    requestedAt: control.requestedAt
  };
  return { ...basis, checksum: contentHash(basis) };
}

function roleDeleteApplied(control, appliedAt = 1784400000300) {
  const basis = {
    protocolVersion: 3,
    type: 'ROLE_DELETE_APPLIED',
    controlId: control.controlId,
    controlChecksum: control.checksum,
    roleId: control.roleId,
    peerId: control.peerId,
    backupReceiptId: control.backupReceipt.receiptId,
    appliedAt
  };
  return { ...basis, checksum: contentHash(basis) };
}

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

    const payload = {
      protocolVersion: 1, turnId: 'turn_phone_1', characterId: 'yuqi', deviceId: 'phone_a',
      deviceSeq: 1, createdAt: 1784400000000,
      message: {
        messageId: 'msg_phone_1', speakerId: 'user', speakerType: 'user',
        recipientId: 'yuqi', content: '你好', sentAt: 1784400000000
      }
    };
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

test('authenticated v3 diagnostics reads the store-owned sanitized projection', async () => {
  const turnId = 'turn_diagnostic_http/1';
  const projection = {
    turn: {
      turnId,
      kind: 'legacy_turn_identity',
      state: 'completed',
      protocolVersion: 1,
      resultAuthorityVersion: 0,
      turnRevision: 1,
      inputVisibilitySequence: 0,
      inputClearEpoch: 0,
      createdAt: 1784400000000,
      updatedAt: 1784400000100
    },
    authority: {
      kind: 'legacy_turn_identity',
      lineageKey: null,
      lineageRevision: null,
      origin: 'legacy',
      commitPayloadVersion: null,
      commitChecksum: null,
      chainValid: true,
      errorCode: null,
      retryAllowed: null
    },
    visibleGroup: null,
    outbox: null,
    lane: null,
    pipeline: { turnPin: null, currentRollout: null },
    comparison: null,
    timings: { acceptedAt: null, updatedAt: 1784400000100, committedAt: null }
  };
  let reads = 0;
  const store = {
    loadTurnDiagnosticsAuthorityInternal(id) {
      reads += 1;
      return id === turnId ? projection : null;
    },
    getSyncDelta: () => [],
    ackSync: (_peer, seq) => seq
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store,
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await call(server.address().port, {
      method: 'GET',
      path: `/v3/diagnostics/turns/${encodeURIComponent(turnId)}`,
      secret: 'test-pairing-secret',
      nonce: 'diagnostic-http-1'
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.authority.kind, 'legacy_turn_identity');
    assert.equal(reads, 1);
  } finally {
    await server.close();
  }
});

test('v3 diagnostics keeps typed conflicts at 409 and unknown errors at 500', async () => {
  const makeServer = error => createYuqiServer({
    secret: 'test-pairing-secret',
    store: { loadTurnDiagnosticsAuthorityInternal: () => { throw error; }, getSyncDelta: () => [], ackSync: (_peer, seq) => seq },
    orchestrator: { process: async () => ({}) }
  });
  const requestDiagnostic = async (server, nonce) => call(server.address().port, {
    method: 'GET', path: '/v3/diagnostics/turns/unknown', secret: 'test-pairing-secret', nonce
  });
  const typed = makeServer(new V3DiagnosticAuthorityConflict('canonical visible group authority conflict'));
  const unknown = makeServer(new Error('canonical made_up conflict'));
  await typed.listen({ host: '127.0.0.1', port: 0 });
  await unknown.listen({ host: '127.0.0.1', port: 0 });
  try {
    const typedResponse = await requestDiagnostic(typed, 'diagnostic-typed-conflict');
    const unknownResponse = await requestDiagnostic(unknown, 'diagnostic-unknown-error');
    assert.equal(typedResponse.status, 409);
    assert.deepEqual(typedResponse.body, { ok: false, error: 'V3_DIAGNOSTIC_AUTHORITY_CONFLICT' });
    assert.equal(unknownResponse.status, 500);
    assert.notDeepEqual(unknownResponse.body, { ok: false, error: 'V3_DIAGNOSTIC_AUTHORITY_CONFLICT' });
  } finally {
    await typed.close();
    await unknown.close();
  }
});

test('legacy RA0 redacted GET and POST return a semantic-free 410', async () => {
  let dispatches = 0;
  const turn = {
    turnId: 'turn_legacy_redacted_http', state: 'cancelled', protocolVersion: 1,
    resultAuthorityVersion: 0, characterId: 'yuqi', deviceId: 'phone_legacy'
  };
  const store = {
    getTurn: id => id === turn.turnId ? turn : null,
    publicLegacyRedactedTurnStatusInternal: id => {
      if (id !== turn.turnId) throw new Error('not found');
      return { status: 'redacted', deliverable: false, terminal: true };
    },
    getSyncDelta: () => [],
    ackSync: (_peer, seq) => seq
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret', store,
    orchestrator: { async process() { return turn; } },
    dispatcher: { accept: () => { dispatches += 1; return turn; } }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const get = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${turn.turnId}`,
      secret: 'test-pairing-secret', nonce: 'legacy-redacted-get'
    });
    const post = await call(server.address().port, {
      method: 'POST', path: '/v2/turns', body: {
        protocolVersion: 1, turnId: turn.turnId, characterId: 'yuqi',
        deviceId: 'phone_legacy', deviceSeq: 1, createdAt: 1784400000000,
        message: {
          messageId: 'msg_legacy_redacted_http', speakerId: 'user', speakerType: 'user',
          recipientId: 'yuqi', content: 'legacy', sentAt: 1784400000000
        }
      },
      secret: 'test-pairing-secret', nonce: 'legacy-redacted-post'
    });
    assert.equal(get.status, 410);
    assert.deepEqual(get.body, { ok: false, error: 'LEGACY_RESULT_REDACTED' });
    assert.equal(post.status, 410);
    assert.deepEqual(post.body, { ok: false, error: 'LEGACY_RESULT_REDACTED' });
    assert.equal(dispatches, 0);
  } finally {
    await server.close();
  }
});

test('malformed RA0 redaction is a stable authority conflict and never dispatches or reads reply JSON', async () => {
  let dispatches = 0;
  const turn = {
    turnId: 'turn_legacy_corrupt_http', state: 'cancelled', protocolVersion: 1,
    resultAuthorityVersion: 0, characterId: 'yuqi', deviceId: 'phone_legacy',
    envelopeJson: JSON.stringify({ redacted: true }),
    authorityRedactedAt: 1784400000000,
    replyJson: JSON.stringify({ secret: 'must-not-be-read' })
  };
  const store = {
    getTurn: id => id === turn.turnId ? turn : null,
    publicLegacyRedactedTurnStatusInternal() {
      throw new Error('legacy redaction authority conflict');
    },
    getSyncDelta: () => [],
    ackSync: (_peer, seq) => seq
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret', store,
    orchestrator: { async process() { return turn; } },
    dispatcher: { accept: () => { dispatches += 1; return turn; } }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${turn.turnId}`,
      secret: 'test-pairing-secret', nonce: 'legacy-corrupt-get'
    });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { ok: false, error: 'LEGACY_AUTHORITY_CONFLICT' });
    assert.equal(JSON.stringify(response.body).includes('must-not-be-read'), false);
    assert.equal(dispatches, 0);
  } finally {
    await server.close();
  }
});

test('health exposes only the non-sensitive cloud relay connection summary', async () => {
  const relayStatus = {
    enabled: true,
    proxyEnabled: true,
    connected: false,
    lastSuccessAt: 0,
    lastErrorAt: 1784512000000,
    lastError: 'connect timeout',
    pendingProcessed: 0
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: { getSyncDelta: () => [], ackSync: () => 0, getSession: () => null },
    orchestrator: { process: async () => ({}) },
    getCloudRelayStatus: () => relayStatus
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const health = await call(server.address().port, { path: '/v1/health' });
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.cloudRelay, relayStatus);
    assert.equal(JSON.stringify(health.body).includes('device-token'), false);
  } finally {
    await server.close();
  }
});

test('accepts a signed exact delivery receipt through the shared store path', async () => {
  const received = [];
  const store = {
    getSyncDelta: () => [],
    ackSync: () => 0,
    recordDeliveryReceipt: value => {
      received.push(value);
      return { turnId: value.turnId, complete: true, pendingItems: [] };
    }
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store,
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = {
      protocolVersion: 1,
      turnId: 'turn_phone_receipt_1',
      deliveredAt: 1784400000000,
      items: [{ kind: 'message', id: 'msg_1', checksum: 'a'.repeat(64) }]
    };
    const response = await call(server.address().port, {
      method: 'POST',
      path: '/v2/turns/turn_phone_receipt_1/delivery-receipt',
      body,
      secret: 'test-pairing-secret',
      nonce: 'receipt-nonce'
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.delivery.complete, true);
    assert.deepEqual(received, [body]);
  } finally {
    await server.close();
  }
});

test('routes a canonical v2 simple receipt to its authority adapter without touching the legacy writer', async () => {
  const received = [];
  const store = {
    getSyncDelta: () => [],
    ackSync: () => 0,
    getTurn: turnId => ({ turnId, resultAuthorityVersion: 1, protocolVersion: 2, deviceId: 'phone_v2' }),
    confirmCanonicalV2SimpleDeliveryInternal(turnId, peerId, value) {
      received.push({ turnId, peerId, value });
      return { turnId, state: 'confirmed' };
    },
    recordDeliveryReceipt() { throw new Error('legacy receipt writer must not run'); }
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret', store, orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = {
      turnId: 'turn_phone_receipt_canonical_v2',
      messageId: 'msg_phone_receipt_canonical_v2',
      contentSha256: 'a'.repeat(64),
      receivedAt: 1784400000100
    };
    const response = await call(server.address().port, {
      method: 'POST',
      path: `/v2/turns/${body.turnId}/delivery-receipt`,
      body,
      secret: 'test-pairing-secret',
      nonce: 'canonical-v2-simple-receipt-nonce'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, [{ turnId: body.turnId, peerId: 'phone_v2', value: body }]);
  } finally {
    await server.close();
  }
});

test('accepts a signed v3 authority delivery receipt only through the canonical store writer', async () => {
  const received = [];
  const store = {
    getSyncDelta: () => [],
    ackSync: () => 0,
    confirmAuthorityCloudDeliveryInternal: value => {
      received.push(value);
      return { state: 'confirmed', visibleGroupId: value.visibleGroupId };
    },
    recordDeliveryReceipt() { throw new Error('legacy receipt writer must not run'); }
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret', store, orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = authorityDeliveryReceipt();
    const response = await call(server.address().port, {
      method: 'POST',
      path: `/v3/groups/${body.visibleGroupId}/delivery-receipt`,
      body,
      secret: 'test-pairing-secret',
      nonce: 'canonical-receipt-nonce'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, [body]);
  } finally {
    await server.close();
  }
});

test('v3 authority receipt target-set conflicts never report either foreign or persisted peer as delivered', async () => {
  const attemptedPeers = [];
  const store = {
    getSyncDelta: () => [],
    ackSync: () => 0,
    confirmAuthorityCloudDeliveryInternal(value) {
      attemptedPeers.push(value.peerId);
      throw new Error('canonical visible delivery target conflict');
    },
    recordDeliveryReceipt() { throw new Error('legacy receipt writer must not run'); }
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret', store, orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    for (const [index, peerId] of ['phone_canonical', 'foreign_phone'].entries()) {
      const body = authorityDeliveryReceipt({ peerId });
      const response = await call(server.address().port, {
        method: 'POST',
        path: `/v3/groups/${body.visibleGroupId}/delivery-receipt`,
        body,
        secret: 'test-pairing-secret',
        nonce: `canonical-target-conflict-${index}`
      });
      assert.equal(response.status, 409);
    }
    assert.deepEqual(attemptedPeers, ['phone_canonical', 'foreign_phone']);
  } finally {
    await server.close();
  }
});

test('rejects every non-native v3 receipt disposition before the canonical store writer', async () => {
  let calls = 0;
  const store = {
    getSyncDelta: () => [],
    ackSync: () => 0,
    confirmAuthorityCloudDeliveryInternal() { calls += 1; throw new Error('must not write'); }
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret', store, orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    for (const [index, terminalDisposition] of [
      ['skip'], { value: 'skip' }, 1, true, null
    ].entries()) {
      const body = { ...authorityDeliveryReceipt(), terminalDisposition };
      const response = await call(server.address().port, {
        method: 'POST',
        path: `/v3/groups/${body.visibleGroupId}/delivery-receipt`,
        body,
        secret: 'test-pairing-secret',
        nonce: `canonical-invalid-disposition-${index}`
      });
      assert.equal(response.status, 409);
    }
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('v3 authority receipt path mismatch rejects before the canonical store writer', async () => {
  let calls = 0;
  const store = {
    getSyncDelta: () => [],
    ackSync: () => 0,
    confirmAuthorityCloudDeliveryInternal() { calls += 1; }
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret', store, orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const body = authorityDeliveryReceipt();
    const response = await call(server.address().port, {
      method: 'POST', path: '/v3/groups/group_other/delivery-receipt', body,
      secret: 'test-pairing-secret', nonce: 'canonical-receipt-mismatch-nonce'
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
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
        protocolVersion: 1, turnId: 'turn_phone_88', characterId: 'yuqi', deviceId: 'phone_a',
        deviceSeq: 1, createdAt: 1784400000000,
        message: {
          messageId: 'msg_phone_88', speakerId: 'user', speakerType: 'user',
          recipientId: 'yuqi', content: '继续说', sentAt: 1784400000000
        },
        recovery: { peerId: 'phone_a', lastCommonSeq: 80, lastSeq: 80, entries: [] }
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

test('canonical v3 POST, GET, and cloud delivery use the same closed result instead of reply_json', async () => {
  const canonical = frozenCanonicalBridgeResult();
  const stored = {
    turnId: canonical.turnId,
    state: 'committed',
    protocolVersion: 3,
    resultAuthorityVersion: 1,
    replyJson: '{ definitely-not-authoritative-json',
    errorJson: '{ likewise-not-authoritative',
    createdAt: 1784400000000,
    updatedAt: 1784400001000
  };
  const store = {
    getTurn: () => stored,
    getTurnStages: () => [],
    getSyncDelta: () => [],
    ackSync: () => 0,
    loadCanonicalBridgeResultInternal(turnId) {
      assert.equal(turnId, canonical.turnId);
      return canonical;
    },
    listPendingAuthorityCloudDeliveries: () => [{
      authorityGroupId: canonical.visibleGroupId,
      turnId: canonical.turnId,
      peerId: 'phone_a',
      authorityCommitChecksum: canonical.commitChecksum,
      recoveryAckSeq: 31,
      updatedAt: 1
    }],
    listPendingCanonicalFailureCloudDeliveries: () => [],
    listPendingCloudDeliveries: () => [],
    prepareAuthorityCloudDelivery() { return { checksum: 'f'.repeat(64) }; },
    markAuthorityCloudDeliveryAttempt() {},
    markAuthorityCloudDeliveryMailboxed() {}
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store,
    dispatcher: { accept: () => stored },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const payload = {
      protocolVersion: 2,
      turnId: canonical.turnId,
      characterId: 'yuqi', deviceId: 'phone_a', deviceSeq: 1, createdAt: 1784400000000,
      kind: 'DIRECT_REPLY',
      message: {
        messageId: 'msg_transport_user', speakerId: 'user', speakerType: 'user',
        recipientId: 'yuqi', content: '你好', sentAt: 1784400000000
      }
    };
    const posted = await call(server.address().port, {
      method: 'POST', path: '/v2/turns', body: payload,
      secret: 'test-pairing-secret', nonce: 'canonical-transport-post'
    });
    const polled = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${canonical.turnId}`,
      secret: 'test-pairing-secret', nonce: 'canonical-transport-get'
    });
    assert.equal(posted.status, 200);
    assert.equal(polled.status, 200);
    assert.deepEqual(
      (({ ok, accepted, recoveryAckSeq, ...status }) => status)(posted.body),
      (({ ok, ...status }) => status)(polled.body)
    );
    assert.deepEqual(posted.body.replyParts, canonical.replyParts);
    assert.equal('replyJson' in posted.body, false);
    assert.equal('errorJson' in posted.body, false);

    const deliveries = [];
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'phone_a',
      deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
      fetchImpl: async (_url, request) => {
        deliveries.push(JSON.parse(request.body));
        return Response.json({ ok: true }, { status: 201 });
      }
    });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 1, failed: 0, waiting: 0 });
    assert.equal(deliveries.length, 1);
    const cloud = decryptRelayPayload(deliveries[0], keyBase64);
    assert.deepEqual(cloud, { ok: true, ...canonical, recoveryAckSeq: 31 });
  } finally {
    await server.close();
  }
});

test('canonical terminal LAN responses distinguish redacted authority from a corrupt live authority without leaking semantics', async () => {
  const redactedTurn = {
    turnId: 'turn_canonical_redacted_terminal', state: 'committed', protocolVersion: 3,
    resultAuthorityVersion: 1, replyJson: JSON.stringify({ reply: 'must not leak' }), errorJson: null
  };
  const corruptTurn = {
    turnId: 'turn_canonical_corrupt_terminal', state: 'committed', protocolVersion: 3,
    resultAuthorityVersion: 1, replyJson: JSON.stringify({ reply: 'must not fall back' }), errorJson: null
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: {
      getTurn(turnId) {
        return turnId === redactedTurn.turnId ? redactedTurn : corruptTurn;
      },
      getTurnStages: () => [], getSyncDelta: () => [], ackSync: () => 0,
      loadCanonicalBridgeResultInternal(turnId) {
        if (turnId === redactedTurn.turnId) return { status: 'redacted' };
        throw new Error('canonical visible group item authority conflict');
      }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const redacted = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${redactedTurn.turnId}`,
      secret: 'test-pairing-secret', nonce: 'canonical-redacted-terminal'
    });
    assert.deepEqual(redacted, {
      status: 410,
      body: { ok: false, error: 'CANONICAL_RESULT_REDACTED' }
    });
    const corrupt = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${corruptTurn.turnId}`,
      secret: 'test-pairing-secret', nonce: 'canonical-corrupt-terminal'
    });
    assert.deepEqual(corrupt, {
      status: 409,
      body: { ok: false, error: 'CANONICAL_AUTHORITY_CONFLICT' }
    });
  } finally {
    await server.close();
  }
});

test('canonical terminal LAN maps only closed authority errors to 409 and leaves runtime failures as 5xx', async () => {
  const turns = {
    authority: { turnId: 'turn_terminal_authority_error', state: 'committed', protocolVersion: 3, resultAuthorityVersion: 1 },
    type: { turnId: 'turn_terminal_type_error', state: 'committed', protocolVersion: 3, resultAuthorityVersion: 1 },
    sqlite: { turnId: 'turn_terminal_sqlite_error', state: 'committed', protocolVersion: 3, resultAuthorityVersion: 1 },
    arbitrary: { turnId: 'turn_terminal_arbitrary_error', state: 'committed', protocolVersion: 3, resultAuthorityVersion: 1 },
    prefix: { turnId: 'turn_terminal_prefix_error', state: 'committed', protocolVersion: 3, resultAuthorityVersion: 1 }
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: {
      getTurn(turnId) { return Object.values(turns).find(turn => turn.turnId === turnId) || null; },
      getTurnStages: () => [], getSyncDelta: () => [], ackSync: () => 0,
      loadCanonicalBridgeResultInternal(turnId) {
        if (turnId === turns.authority.turnId) throw new Error('canonical visible group item authority conflict');
        if (turnId === turns.type.turnId) throw new TypeError('bridge adapter was undefined');
        if (turnId === turns.sqlite.turnId) throw new Error('SQLITE_BUSY: database is locked');
        if (turnId === turns.prefix.turnId) throw new Error('canonical visible group arbitrary fault conflict');
        throw new Error('ordinary unexpected failure');
      }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const responses = await Promise.all(Object.values(turns).map((turn, index) => call(server.address().port, {
      method: 'GET', path: `/v2/turns/${turn.turnId}`,
      secret: 'test-pairing-secret', nonce: `canonical-terminal-classify-${index}`
    })));
    assert.deepEqual(responses[0], { status: 409, body: { ok: false, error: 'CANONICAL_AUTHORITY_CONFLICT' } });
    for (const response of responses.slice(1)) assert.equal(response.status, 500);
  } finally {
    await server.close();
  }
});

test('canonical v3 failed LAN responses classify cancelled or corrupt authority without parsing legacy error JSON', async () => {
  const redactedTurn = {
    turnId: 'turn_canonical_failed_redacted', state: 'failed', protocolVersion: 3,
    resultAuthorityVersion: 1, errorJson: JSON.stringify({ message: 'must not leak' })
  };
  const corruptTurn = {
    turnId: 'turn_canonical_failed_corrupt', state: 'failed', protocolVersion: 3,
    resultAuthorityVersion: 1, errorJson: JSON.stringify({ message: 'must not fall back' })
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: {
      getTurn(turnId) { return turnId === redactedTurn.turnId ? redactedTurn : corruptTurn; },
      getTurnStages: () => [], getSyncDelta: () => [], ackSync: () => 0,
      loadCanonicalFailureForBridgeInternal(turnId) {
        if (turnId === redactedTurn.turnId) return { status: 'redacted' };
        throw new Error('canonical failure delivery authority conflict');
      }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const redacted = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${redactedTurn.turnId}`,
      secret: 'test-pairing-secret', nonce: 'canonical-failed-redacted'
    });
    assert.deepEqual(redacted, {
      status: 410,
      body: { ok: false, error: 'CANONICAL_RESULT_REDACTED' }
    });
    const corrupt = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${corruptTurn.turnId}`,
      secret: 'test-pairing-secret', nonce: 'canonical-failed-corrupt'
    });
    assert.deepEqual(corrupt, {
      status: 409,
      body: { ok: false, error: 'CANONICAL_AUTHORITY_CONFLICT' }
    });
  } finally {
    await server.close();
  }
});

test('wire-v3 canonical failure is projected from its closed authority before error_json parsing', async () => {
  const closedFailure = Object.freeze({
    protocolVersion: 3,
    type: 'BACKLOG_FAILED',
    turnId: 'turn_canonical_failure_transport',
    roleId: 'yuqi',
    authorityLineageKey: 'lin_canonical_failure_transport',
    lineageRevision: 1,
    turnRevision: 2,
    laneKey: 'private_chat',
    laneRevision: 1,
    retryOfTurnId: null,
    inputVisibilitySequence: 4,
    inputClearEpoch: 0,
    generationFingerprint: null,
    releaseId: 'release_test',
    state: 'failed',
    errorCode: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
    failureClass: 'transient',
    retryAllowed: true,
    failedAt: 1784400001000,
    rawStatusChecksum: 'a'.repeat(64)
  });
  const stored = {
    turnId: closedFailure.turnId,
    state: 'failed', protocolVersion: 3, resultAuthorityVersion: 1,
    replyJson: '{ invalid old reply json', errorJson: '{ invalid old error json'
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: {
      getTurn: () => stored,
      getTurnStages: () => [], getSyncDelta: () => [], ackSync: () => 0,
      loadCanonicalFailureForBridgeInternal: () => closedFailure
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${stored.turnId}`,
      secret: 'test-pairing-secret', nonce: 'canonical-failure-transport'
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.type, 'BACKLOG_FAILED');
    assert.equal(response.body.errorCode, 'YUQI_TRANSIENT_EXECUTION_FAILURE');
    assert.equal(response.body.allowFallback, false);
    assert.equal('reply' in response.body, false);
    assert.equal('errorJson' in response.body, false);
  } finally {
    await server.close();
  }
});

test('wire-v2 authority failure retains the legacy error status compatibility branch', async () => {
  const stored = {
    turnId: 'turn_canonical_v2_failure', state: 'failed', protocolVersion: 2, resultAuthorityVersion: 1,
    origin: 'codex', createdAt: 1, updatedAt: 2,
    replyJson: null,
    errorJson: JSON.stringify({ name: 'LegacyProviderTimeout', code: 'LEGACY_TIMEOUT' })
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: {
      getTurn: () => stored,
      getTurnStages: () => [], getSyncDelta: () => [], ackSync: () => 0,
      loadCanonicalFailureForBridgeInternal: () => { throw new Error('wire-v2 must retain legacy status'); }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await call(server.address().port, {
      method: 'GET', path: `/v2/turns/${stored.turnId}`,
      secret: 'test-pairing-secret', nonce: 'canonical-v2-failure-compat'
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.errorCode, 'LEGACY_TIMEOUT');
    assert.equal(response.body.allowFallback, true);
    assert.equal(response.body.terminal, true);
  } finally {
    await server.close();
  }
});

test('v2 reconciles phone-only messages before accepting the new turn', async () => {
  const events = [];
  const stored = {
    turnId: 'turn_phone_async_recovery', state: 'queued', origin: 'codex', route: 'fast',
    routeReasons: [], replyJson: null, errorJson: null, createdAt: 1784400000000, updatedAt: 1784400000000
  };
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: { getTurn: () => stored, getTurnStages: () => [], getSyncDelta: () => [], ackSync: () => 0 },
    reconciler: {
      async reconcileFrom(packet) {
        events.push(`reconcile:${packet.peerId}`);
        return { ackSeq: 23 };
      }
    },
    dispatcher: {
      accept(value) {
        events.push(`turn:${value.turnId}`);
        return stored;
      }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const result = await call(server.address().port, {
      method: 'POST', path: '/v2/turns', secret: 'test-pairing-secret', nonce: 'v2-recovery',
      body: {
        protocolVersion: 2,
        turnId: stored.turnId,
        characterId: 'yuqi', deviceId: 'phone_a', deviceSeq: 24, createdAt: 1784400000000,
        kind: 'DIRECT_REPLY',
        message: {
          messageId: 'msg_phone_async_recovery', speakerId: 'user', speakerType: 'user',
          recipientId: 'yuqi', content: '继续说', sentAt: 1784400000000
        },
        recovery: { peerId: 'phone_a', lastCommonSeq: 20, lastSeq: 20, entries: [] }
      }
    });
    assert.equal(result.status, 202);
    assert.equal(result.body.recoveryAckSeq, 23);
    assert.deepEqual(events, ['reconcile:phone_a', `turn:${stored.turnId}`]);
  } finally {
    await server.close();
  }
});

test('v2 rejects a malformed v3 envelope before reconciliation or durable dispatch', async () => {
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: {
      getTurnStages() { events.push('store'); return []; },
      getSyncDelta: () => [], ackSync: () => 0
    },
    reconciler: {
      async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; }
    },
    dispatcher: {
      accept() { events.push('accept'); return { turnId: 'turn_bad_v3', state: 'queued' }; }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const result = await call(server.address().port, {
      method: 'POST', path: '/v2/turns', secret: 'test-pairing-secret', nonce: 'malformed-v3-preflight',
      body: {
        protocolVersion: 3,
        turnId: 'turn_bad_v3', characterId: 'yuqi', deviceId: 'phone_a', deviceSeq: 1,
        createdAt: 1784400000000, kind: 'DIRECT_REPLY',
        message: {
          messageId: 'msg_bad_v3', speakerId: 'user', speakerType: 'user',
          recipientId: 'yuqi', content: '不能先写入', sentAt: 1784400000000
        },
        recovery: { peerId: 'phone_a', lastCommonSeq: 0, entries: [] }
      }
    });
    assert.equal(result.status, 400);
    assert.deepEqual(events, []);
  } finally {
    await server.close();
  }
});

test('v1 rejects a malformed v3 envelope before reconciliation or legacy processing', async () => {
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    reconciler: {
      async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; }
    },
    orchestrator: {
      async process() { events.push('process'); return { turnId: 'turn_bad_v3' }; }
    }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const result = await call(server.address().port, {
      method: 'POST', path: '/v1/turns', secret: 'test-pairing-secret', nonce: 'malformed-v3-v1-preflight',
      body: {
        protocolVersion: 3,
        turnId: 'turn_bad_v3', characterId: 'yuqi', deviceId: 'phone_a', deviceSeq: 1,
        createdAt: 1784400000000, kind: 'DIRECT_REPLY',
        message: {
          messageId: 'msg_bad_v3', speakerId: 'user', speakerType: 'user',
          recipientId: 'yuqi', content: '不能进入旧入口', sentAt: 1784400000000
        },
        recovery: { peerId: 'phone_a', lastCommonSeq: 0, entries: [] }
      }
    });
    assert.equal(result.status, 400);
    assert.deepEqual(events, []);
  } finally {
    await server.close();
  }
});

test('recovery metadata is validated separately and never changes normalized turn identity', async () => {
  const base = {
    protocolVersion: 2, turnId: 'turn_recovery_identity', characterId: 'yuqi', deviceId: 'phone_a',
    deviceSeq: 1, createdAt: 1784400000000, kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_recovery_identity', speakerId: 'user', speakerType: 'user',
      recipientId: 'yuqi', content: '同一条消息', sentAt: 1784400000000
    }
  };
  const earlier = { ...base, recovery: { peerId: 'phone_a', lastCommonSeq: 1, entries: [] } };
  const later = { ...base, recovery: { peerId: 'phone_a', lastCommonSeq: 99, entries: [] } };
  assert.deepEqual(validateEnvelope(earlier), validateEnvelope(later));
  assert.equal(contentHash(validateEnvelope(earlier)), contentHash(validateEnvelope(later)));
});

test('v2 rejects a foreign recovery peer before reconciliation or durable dispatch', async () => {
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } },
    dispatcher: { accept() { events.push('accept'); return { turnId: 'turn_foreign_recovery', state: 'queued' }; } },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const result = await call(server.address().port, {
      method: 'POST', path: '/v2/turns', secret: 'test-pairing-secret', nonce: 'foreign-recovery-peer',
      body: {
        protocolVersion: 2, turnId: 'turn_foreign_recovery', characterId: 'yuqi', deviceId: 'phone_a',
        deviceSeq: 1, createdAt: 1784400000000, kind: 'DIRECT_REPLY',
        message: {
          messageId: 'msg_foreign_recovery', speakerId: 'user', speakerType: 'user',
          recipientId: 'yuqi', content: '不应进入恢复', sentAt: 1784400000000
        },
        recovery: { peerId: 'other_phone', lastCommonSeq: 10, entries: [] }
      }
    });
    assert.equal(result.status, 400);
    assert.deepEqual(events, []);
  } finally {
    await server.close();
  }
});

test('v2 rejects an invalid recovery cursor before reconciliation or durable dispatch', async () => {
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } },
    dispatcher: { accept() { events.push('accept'); return { turnId: 'turn_invalid_recovery_cursor', state: 'queued' }; } },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const result = await call(server.address().port, {
      method: 'POST', path: '/v2/turns', secret: 'test-pairing-secret', nonce: 'invalid-recovery-cursor',
      body: {
        protocolVersion: 2, turnId: 'turn_invalid_recovery_cursor', characterId: 'yuqi', deviceId: 'phone_a',
        deviceSeq: 1, createdAt: 1784400000000, kind: 'DIRECT_REPLY',
        message: {
          messageId: 'msg_invalid_recovery_cursor', speakerId: 'user', speakerType: 'user',
          recipientId: 'yuqi', content: '不能确认游标', sentAt: 1784400000000
        },
        recovery: { peerId: 'phone_a', lastCommonSeq: '100', entries: [] }
      }
    });
    assert.equal(result.status, 400);
    assert.deepEqual(events, []);
  } finally {
    await server.close();
  }
});

test('v2 rejects forged Android lastSeq recovery variants before any side effect', async () => {
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } },
    dispatcher: { accept() { events.push('accept'); return { turnId: 'turn_invalid_last_seq', state: 'queued' }; } },
    orchestrator: { process: async () => ({}) }
  });
  const variants = [
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: 9, entries: [] },
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: 11, entries: [] },
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: '10', entries: [] },
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: 10, entries: [], extra: true }
  ];
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    for (const [index, recovery] of variants.entries()) {
      const result = await call(server.address().port, {
        method: 'POST', path: '/v2/turns', secret: 'test-pairing-secret', nonce: `invalid-last-seq-${index}`,
        body: {
          protocolVersion: 2, turnId: `turn_invalid_last_seq_${index}`, characterId: 'yuqi', deviceId: 'phone_a',
          deviceSeq: index + 1, createdAt: 1784400000000, kind: 'DIRECT_REPLY',
          message: {
            messageId: `msg_invalid_last_seq_${index}`, speakerId: 'user', speakerType: 'user',
            recipientId: 'yuqi', content: '不应进入恢复', sentAt: 1784400000000
          },
          recovery
        }
      });
      assert.equal(result.status, 400);
    }
    assert.deepEqual(events, []);
  } finally {
    await server.close();
  }
});

test('conversation clear LAN route validates before side effects and returns the exact applied proof', async () => {
  const control = conversationClearControl();
  const proof = conversationClearApplied(control);
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    clock: () => 1784400000100,
    store: {
      getSyncDelta: () => [],
      ackSync: () => 0,
      applyConversationClearInternal(value, options) {
        events.push({ kind: 'apply', value, options });
        return proof;
      }
    },
    reconciler: { reconcileFrom: async () => { events.push({ kind: 'reconcile' }); } },
    dispatcher: { accept: () => { events.push({ kind: 'dispatch' }); } },
    orchestrator: { process: async () => { events.push({ kind: 'orchestrator' }); } }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await call(server.address().port, {
      method: 'POST',
      path: '/v3/controls/conversation-clear',
      body: control,
      secret: 'test-pairing-secret',
      timestamp: 1784400000100,
      nonce: 'conversation-clear-valid'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, proof);
    assert.deepEqual(events, [{ kind: 'apply', value: control, options: { appliedAt: 1784400000100 } }]);
  } finally {
    await server.close();
  }
});

test('conversation clear rejects malformed controls before reconcile, dispatch, orchestrator, or diagnostic writes', async () => {
  const valid = conversationClearControl();
  const events = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    clock: () => 1784400000100,
    store: {
      getSyncDelta: () => [],
      ackSync: () => 0,
      applyConversationClearInternal: () => { events.push('apply'); },
      recordDiagnostic: () => { events.push('diagnostic'); }
    },
    reconciler: { reconcileFrom: async () => { events.push('reconcile'); } },
    dispatcher: { accept: () => { events.push('dispatch'); } },
    orchestrator: { process: async () => { events.push('orchestrator'); } }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const variants = [
      { ...valid, controlId: 7, checksum: contentHash({ ...valid, controlId: 7 }) },
      { ...valid, requestedAt: String(valid.requestedAt), checksum: contentHash({ ...valid, requestedAt: String(valid.requestedAt) }) },
      { ...valid, unknown: true, checksum: contentHash({ ...valid, unknown: true }) },
      { ...valid, checksum: 'b'.repeat(64) }
    ];
    for (const [index, body] of variants.entries()) {
      const response = await call(server.address().port, {
        method: 'POST',
        path: '/v3/controls/conversation-clear',
        body,
        secret: 'test-pairing-secret',
        timestamp: 1784400000100,
        nonce: `conversation-clear-invalid-${index}`
      });
      assert.equal(response.status, 400);
    }
    assert.deepEqual(events, []);
  } finally {
    await server.close();
  }
});

test('conversation clear maps known authority conflicts to fixed 409 and leaves runtime failures as 500', async () => {
  const control = conversationClearControl();
  const cases = [
    { error: new Error('conversation clear epoch conflict'), status: 409 },
    { error: new Error('canonical conversation clear lineage conflict: lin_1'), status: 409 },
    { error: new TypeError('conversation clear authority conflict'), status: 500 },
    { error: new Error('SQLITE_BUSY: database is locked'), status: 500 }
  ];
  for (const [index, expected] of cases.entries()) {
    const server = createYuqiServer({
      secret: 'test-pairing-secret',
      clock: () => 1784400000100,
      store: {
        getSyncDelta: () => [],
        ackSync: () => 0,
        applyConversationClearInternal: () => { throw expected.error; }
      },
      orchestrator: { process: async () => ({}) }
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await call(server.address().port, {
        method: 'POST',
        path: '/v3/controls/conversation-clear',
        body: control,
        secret: 'test-pairing-secret',
        timestamp: 1784400000100,
        nonce: `conversation-clear-error-${index}`
      });
      assert.equal(response.status, expected.status);
      if (expected.status === 409) assert.deepEqual(response.body, {
        ok: false,
        error: 'CONVERSATION_CLEAR_AUTHORITY_CONFLICT'
      });
    } finally {
      await server.close();
    }
  }
});

test('conversation clear exact replay returns the persisted proof bytes without an ok wrapper', async () => {
  const control = conversationClearControl();
  const proof = conversationClearApplied(control);
  let calls = 0;
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    clock: () => 1784400000100,
    store: {
      getSyncDelta: () => [],
      ackSync: () => 0,
      applyConversationClearInternal: () => { calls += 1; return proof; }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const requests = await Promise.all(['conversation-clear-replay-a', 'conversation-clear-replay-b'].map(nonce => call(
      server.address().port,
      {
        method: 'POST',
        path: '/v3/controls/conversation-clear',
        body: control,
        secret: 'test-pairing-secret',
        timestamp: 1784400000100,
        nonce
      }
    )));
    assert.deepEqual(requests, [
      { status: 200, body: proof },
      { status: 200, body: proof }
    ]);
    assert.equal(calls, 2);
    assert.equal('ok' in requests[0].body, false);
  } finally {
    await server.close();
  }
});

test('Android backup request validates the Room head before creating one verified receipt', async () => {
  const requestBody = yuqiBackupRequest();
  const expectedReceipt = yuqiBackupReceipt(requestBody);
  const calls = [];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    clock: () => requestBody.requestedAt,
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    orchestrator: { process: async () => ({}) },
    createVerifiedBackup: async options => {
      calls.push(options);
      return { receipt: expectedReceipt };
    }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await call(server.address().port, {
      method: 'POST', path: '/v3/backups/yuqi', body: requestBody,
      secret: 'test-pairing-secret', timestamp: requestBody.requestedAt,
      nonce: 'android-backup-valid'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, expectedReceipt);
    assert.deepEqual(calls, [{
      roleId: 'yuqi', peerId: 'phone_lan', requestedAt: requestBody.requestedAt,
      androidRoomHead: requestBody.androidRoomHead
    }]);
  } finally {
    await server.close();
  }
});

test('Android backup request rejects changed or missing Room authority before snapshot work', async () => {
  const valid = yuqiBackupRequest();
  let calls = 0;
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    clock: () => valid.requestedAt,
    store: { getSyncDelta: () => [], ackSync: () => 0 },
    orchestrator: { process: async () => ({}) },
    createVerifiedBackup: async () => { calls += 1; throw new Error('must not run'); }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const variants = [
      { ...valid, androidRoomHead: null },
      { ...valid, requestedAt: valid.requestedAt + 1 },
      { ...valid, roleId: 'other' },
      { ...valid, androidRoomHead: { ...valid.androidRoomHead, secret: 'leak' } },
      { ...valid, checksum: 'f'.repeat(64) }
    ];
    for (const [index, body] of variants.entries()) {
      const response = await call(server.address().port, {
        method: 'POST', path: '/v3/backups/yuqi', body,
        secret: 'test-pairing-secret', timestamp: valid.requestedAt,
        nonce: `android-backup-invalid-${index}`
      });
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('role delete LAN route returns closed pending and applied proofs with distinct status codes', async () => {
  const control = roleDeleteControl();
  const pending = roleDeletePending(control, 2);
  const applied = roleDeleteApplied(control);
  const calls = [];
  const proofs = [pending, applied];
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    clock: () => applied.appliedAt,
    store: {
      getSyncDelta: () => [],
      ackSync: () => 0,
      applyRoleDeleteInternal(value, options) {
        calls.push({ value, options });
        return proofs.shift();
      }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const first = await call(server.address().port, {
      method: 'POST', path: '/v3/controls/role-delete', body: control,
      secret: 'test-pairing-secret', timestamp: applied.appliedAt,
      nonce: 'role-delete-pending'
    });
    const second = await call(server.address().port, {
      method: 'POST', path: '/v3/controls/role-delete', body: control,
      secret: 'test-pairing-secret', timestamp: applied.appliedAt,
      nonce: 'role-delete-applied'
    });
    assert.deepEqual(first, { status: 202, body: pending });
    assert.deepEqual(second, { status: 200, body: applied });
    assert.deepEqual(calls, [
      { value: control, options: { appliedAt: applied.appliedAt } },
      { value: control, options: { appliedAt: applied.appliedAt } }
    ]);
  } finally {
    await server.close();
  }
});

test('role delete LAN route rejects malformed control before store work', async () => {
  const control = roleDeleteControl();
  let calls = 0;
  const server = createYuqiServer({
    secret: 'test-pairing-secret',
    clock: () => 1784400000300,
    store: {
      getSyncDelta: () => [],
      ackSync: () => 0,
      applyRoleDeleteInternal() { calls += 1; }
    },
    orchestrator: { process: async () => ({}) }
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await call(server.address().port, {
      method: 'POST', path: '/v3/controls/role-delete', body: { ...control, secret: 'leak' },
      secret: 'test-pairing-secret', timestamp: 1784400000300,
      nonce: 'role-delete-invalid'
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});
