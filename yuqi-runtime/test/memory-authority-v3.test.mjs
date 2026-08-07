import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitVerifiedFacts,
  validateConsolidationCandidate
} from '../src/evidence-memory.mjs';
import { buildEvidencePack } from '../src/retrieval.mjs';

function deliveredMessage(overrides = {}) {
  const groupId = overrides.authorityGroupId || 'grp_1';
  const lineageKey = overrides.authorityLineageKey || `lin_${groupId}`;
  return {
    messageId: overrides.messageId || `msg_${groupId}`,
    turnId: overrides.turnId || `turn_${lineageKey}`,
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: overrides.content || '我已经把周六的安排记下来了',
    sentAt: overrides.sentAt || 1784400001000,
    committed: true,
    resultAuthorityVersion: 1,
    turnState: 'committed',
    authorityGroupId: groupId,
    authorityLineageKey: lineageKey,
    authorityCommitChecksum: 'a'.repeat(64),
    authorityVerified: true,
    deliveryState: 'confirmed',
    redacted: false,
    ...overrides
  };
}

function candidate(type, sourceMessages, overrides = {}) {
  const base = {
    factId: overrides.factId || `fact_${type}`,
    characterId: 'yuqi',
    type,
    subjectId: 'user',
    predicate: 'weekend_plan',
    object: { day: 'saturday' },
    evidenceMode: 'direct',
    confidence: 0.9,
    origin: 'consolidation',
    authorityContractVersion: 'v3',
    evidenceSource: sourceMessages.some(message => message.speakerType === 'character')
      ? 'yuqi_delivered_message'
      : 'user_visible_message'
  };
  if (sourceMessages.length) {
    base.sourceMessageIds = sourceMessages.map(message => message.messageId);
    base.exactQuotes = sourceMessages.map(message => ({
      messageId: message.messageId,
      speakerId: message.speakerId,
      text: message.content
    }));
  }
  return { ...base, ...overrides };
}

function deliveredAction(overrides = {}) {
  return {
    evidenceKind: 'action',
    actionId: 'action_event_1',
    kind: 'moment_comment',
    targetKey: 'moment:moment_1',
    targetRevision: 'rev_1',
    payload: { text: '周六一起吃饭' },
    actionChecksum: 'b'.repeat(64),
    authorityVerified: true,
    resultAuthorityVersion: 1,
    turnState: 'committed',
    authorityGroupId: 'grp_action_1',
    authorityLineageKey: 'lin_action_1',
    authorityCommitChecksum: 'c'.repeat(64),
    authorityRoleId: 'yuqi',
    deliveryState: 'confirmed',
    redacted: false,
    ...overrides
  };
}

test('closed validator accepts only delivered canonical evidence', () => {
  const message = deliveredMessage();
  const result = validateConsolidationCandidate(
    candidate('delivered_yuqi_life_fact', [message]),
    [message]
  );
  assert.equal(result.status, 'verified');
  assert.equal(result.fact.evidenceAuthority.authorityGroupIds[0], 'grp_1');

  const draft = deliveredMessage({ committed: false, turnState: 'brain_done' });
  const draftResult = validateConsolidationCandidate(
    candidate('delivered_yuqi_life_fact', [draft]),
    [draft]
  );
  assert.equal(draftResult.status, 'rejected');

  const inferred = validateConsolidationCandidate(
    candidate('mood', [message], { mood: 'soft' }),
    [message]
  );
  assert.equal(inferred.status, 'rejected');
});

test('closed validator rejects lifecycle-invalid evidence and structural model fields', () => {
  for (const message of [
    deliveredMessage({ committed: false, turnState: 'brain_done' }),
    deliveredMessage({ redacted: true, content: '' }),
    deliveredMessage({ deliveryState: 'waiting' }),
    deliveredMessage({ terminalDisposition: 'skip' })
  ]) {
    const result = validateConsolidationCandidate(
      candidate('delivered_yuqi_life_fact', [message]),
      [message]
    );
    assert.equal(result.status, 'rejected');
  }
  const inferred = validateConsolidationCandidate(
    candidate('mood', [deliveredMessage()], { mood: 'soft', responseRisks: ['x'] }),
    [deliveredMessage()]
  );
  assert.equal(inferred.status, 'rejected');
});

test('v3 consolidation candidates have an exact closed key set', () => {
  const message = deliveredMessage();
  for (const extra of [
    { mood: 'soft' },
    { responseRisks: ['监督评价'] },
    { currentStances: ['temporary'] },
    { secret: 'not-for-memory' }
  ]) {
    const result = validateConsolidationCandidate(
      candidate('delivered_yuqi_life_fact', [message], extra),
      [message]
    );
    assert.equal(result.status, 'rejected');
    assert.match(result.reasons.join(' '), /unknown|field|closed/i);
  }
});

test('v3 candidate type fixes speaker authority and required commitment identity', () => {
  const yuqi = deliveredMessage({ messageId: 'msg_yuqi_authority' });
  const user = deliveredMessage({
    messageId: 'msg_user_authority',
    speakerId: 'user',
    speakerType: 'user',
    content: '我喜欢周六一起吃饭'
  });

  assert.equal(
    validateConsolidationCandidate(candidate('user_fact', [user]), [user]).status,
    'verified'
  );
  assert.equal(
    validateConsolidationCandidate(candidate('user_fact', [yuqi]), [yuqi]).status,
    'rejected'
  );
  assert.equal(
    validateConsolidationCandidate(candidate('delivered_yuqi_life_fact', [user]), [user]).status,
    'rejected'
  );
  assert.equal(
    validateConsolidationCandidate(
      candidate('formal_commitment', [yuqi], { promisedTo: 'user' }),
      [yuqi]
    ).status,
    'rejected'
  );
  const userPromise = {
    ...user,
    content: '我答应周六一起吃饭'
  };
  assert.equal(
    validateConsolidationCandidate(
      candidate('formal_commitment', [userPromise], {
        promisedBy: 'user',
        promisedTo: 'yuqi',
        exactQuotes: [{ messageId: userPromise.messageId, speakerId: 'user', text: userPromise.content }]
      }),
      [userPromise]
    ).status,
    'verified'
  );
  assert.equal(
    validateConsolidationCandidate(
      candidate('formal_commitment', [userPromise], {
        promisedBy: 'other-user',
        promisedTo: 'yuqi',
        exactQuotes: [{ messageId: userPromise.messageId, speakerId: 'user', text: userPromise.content }]
      }),
      [userPromise]
    ).status,
    'rejected'
  );
});

test('unconfirmed character evidence cannot create positive facts while user input remains valid', () => {
  const undelivered = deliveredMessage({
    messageId: 'msg_character_unconfirmed',
    deliveryState: 'committed'
  });
  const secondUndelivered = deliveredMessage({
    messageId: 'msg_character_unconfirmed_2',
    authorityGroupId: 'grp_character_unconfirmed_2',
    authorityLineageKey: 'lin_character_unconfirmed_2',
    deliveryState: 'waiting'
  });
  const cases = [
    ['formal_commitment', [undelivered], { promisedBy: 'yuqi', promisedTo: 'user' }],
    ['retrievable_event', [undelivered], {}],
    ['stable_preference', [undelivered, secondUndelivered], {}]
  ];
  for (const [type, messages, overrides] of cases) {
    assert.equal(
      validateConsolidationCandidate(candidate(type, messages, overrides), messages).status,
      'rejected'
    );
  }

  const user = deliveredMessage({
    messageId: 'msg_user_input_valid',
    speakerId: 'user',
    speakerType: 'user',
    content: '我已经决定周六去吃饭',
    deliveryState: 'input'
  });
  assert.equal(
    validateConsolidationCandidate(candidate('user_fact', [user]), [user]).status,
    'verified'
  );
});

test('canonical action evidence is closed, durable, and cannot support user facts', () => {
  const action = deliveredAction();
  const exactAction = {
    actionId: action.actionId,
    kind: action.kind,
    targetKey: action.targetKey,
    targetRevision: action.targetRevision,
    payload: action.payload,
    actionChecksum: action.actionChecksum
  };
  const valid = validateConsolidationCandidate(
    candidate('retrievable_event', [], {
      sourceActionIds: [action.actionId],
      exactActions: [exactAction],
      evidenceSource: 'yuqi_delivered_action'
    }),
    [action]
  );
  assert.equal(valid.status, 'verified');
  assert.deepEqual(valid.fact.sourceActionIds, [action.actionId]);
  assert.deepEqual(valid.fact.exactActions, [exactAction]);
  assert.equal(
    validateConsolidationCandidate(
      candidate('user_fact', [], { sourceActionIds: [action.actionId], exactActions: [exactAction] }),
      [action]
    ).status,
    'rejected'
  );
  for (const mutation of [
    { exactActions: [{ ...exactAction, payload: { text: '被篡改' } }] },
    { sourceActionIds: [action.actionId, action.actionId], exactActions: [exactAction, exactAction] },
    { sourceActionIds: ['missing_action'], exactActions: [exactAction] },
    { exactActions: [{ ...exactAction, secret: 'nope' }] }
  ]) {
    const result = validateConsolidationCandidate(
      candidate('retrievable_event', [], { sourceActionIds: [action.actionId], exactActions: [exactAction], ...mutation }),
      [action]
    );
    assert.equal(result.status, 'rejected');
  }
});

test('retrieval returns action-only evidence and filters redacted authority groups', () => {
  const action = deliveredAction();
  const actionProjection = {
    actionId: action.actionId,
    kind: action.kind,
    targetKey: action.targetKey,
    targetRevision: action.targetRevision,
    payload: action.payload,
    actionChecksum: action.actionChecksum
  };
  const makeFact = (factId, groupId) => ({
    ...candidate('retrievable_event', [], {
      factId,
      sourceActionIds: [action.actionId],
      exactActions: [actionProjection],
      object: { event: 'weekend_plan' }
    }),
    status: 'verified',
    evidenceAuthority: { authorityGroupIds: [groupId], lineageKeys: ['lin_action_1'] }
  });
  const store = {
    listRetrievableFacts: () => [makeFact('fact_action_live', 'grp_action_live'), makeFact('fact_action_redacted', 'grp_action_redacted')],
    getMessage: () => null,
    isMessageSuppressed: () => false,
    assertVisibleGroupAuthorityInternal: groupId => groupId === 'grp_action_redacted'
      ? { status: 'redacted' }
      : { status: 'live' },
    getMessageContext: () => []
  };
  const pack = buildEvidencePack(store, { characterId: 'yuqi', query: 'weekend', now: 1784400002000 });
  assert.deepEqual(pack.facts.map(fact => fact.factId), ['fact_action_live']);
  assert.deepEqual(pack.facts[0].evidence, [{
    evidenceKind: 'action',
    ...actionProjection
  }]);
});

test('stable preference rejects retry siblings and accepts two independent authorities', () => {
  const first = deliveredMessage({ messageId: 'msg_pref_1', authorityGroupId: 'grp_pref_1', authorityLineageKey: 'lin_pref_1' });
  const retryOfSameLineage = deliveredMessage({ messageId: 'msg_pref_retry', authorityGroupId: 'grp_pref_retry', authorityLineageKey: 'lin_pref_1' });
  const second = deliveredMessage({ messageId: 'msg_pref_2', authorityGroupId: 'grp_pref_2', authorityLineageKey: 'lin_pref_2' });

  const duplicateLineage = validateConsolidationCandidate(
    candidate('stable_preference', [first, retryOfSameLineage]),
    [first, retryOfSameLineage]
  );
  assert.equal(duplicateLineage.status, 'rejected');
  assert.match(duplicateLineage.reasons.join(' '), /lineage|independent/i);

  const independent = validateConsolidationCandidate(
    candidate('stable_preference', [first, second]),
    [first, second]
  );
  assert.equal(independent.status, 'verified');
  assert.deepEqual(independent.fact.evidenceAuthority.authorityGroupIds, ['grp_pref_1', 'grp_pref_2']);
});

test('direct evidence writes route through the closed validator', () => {
  const writes = [];
  const store = { putFact(fact) { writes.push(fact); } };
  const valid = deliveredMessage();
  const result = commitVerifiedFacts(
    store,
    [
      candidate('delivered_yuqi_life_fact', [valid]),
      candidate('mood', [valid], { factId: 'fact_inferred', mood: 'soft' })
    ],
    [valid]
  );
  assert.equal(result.verified.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(writes.length, 1);
});

test('retrieval filters redacted, suppressed and expired evidence before ranking', () => {
  const validMessage = {
    messageId: 'msg_valid',
    speakerId: 'yuqi',
    speakerType: 'character',
    content: '周六下午一起吃饭',
    sentAt: 1784400001000
  };
  const facts = [
    {
      ...candidate('delivered_yuqi_life_fact', [deliveredMessage({ messageId: 'msg_valid' })]),
      factId: 'fact_valid',
      status: 'verified',
      sourceMessageIds: ['msg_valid'],
      evidenceAuthority: { authorityGroupIds: ['grp_valid'], lineageKeys: ['lin_valid'] }
    },
    {
      ...candidate('delivered_yuqi_life_fact', [deliveredMessage({ messageId: 'msg_redacted', content: '不该泄漏的红删文本' })]),
      factId: 'fact_redacted',
      status: 'verified',
      sourceMessageIds: ['msg_redacted'],
      redacted: true
    },
    {
      ...candidate('delivered_yuqi_life_fact', [deliveredMessage({ messageId: 'msg_expired' })]),
      factId: 'fact_expired',
      status: 'verified',
      sourceMessageIds: ['msg_expired'],
      expiresAt: 100
    }
  ];
  const store = {
    listRetrievableFacts: () => facts,
    getMessage: messageId => messageId === 'msg_valid' ? validMessage : {
      messageId,
      speakerId: 'yuqi',
      speakerType: 'character',
      content: '不该泄漏的红删文本',
      sentAt: 1
    },
    isMessageSuppressed: messageId => messageId === 'msg_redacted' || messageId === 'ctx_suppressed',
    getMessageContext: () => [
      { messageId: 'ctx_valid', speakerId: 'user', content: '可保留的上下文', sentAt: 1784400000000 },
      { messageId: 'ctx_suppressed', speakerId: 'user', content: '不该从context泄漏的抑制文本', suppressed: true, sentAt: 1784400000100 },
      { messageId: 'ctx_redacted', speakerId: 'yuqi', content: '不该从context泄漏的红删文本', redacted: true, sentAt: 1784400000200 },
      { messageId: 'ctx_empty', speakerId: 'yuqi', content: '   ', sentAt: 1784400000300 }
    ]
  };
  const pack = buildEvidencePack(store, { characterId: 'yuqi', query: '周六', now: 1784400002000 });
  assert.deepEqual(pack.facts.map(fact => fact.factId), ['fact_valid']);
  assert.equal(JSON.stringify(pack).includes('不该泄漏的红删文本'), false);
  const context = pack.facts[0].evidence[0].context;
  assert.deepEqual(context.map(item => item.messageId), ['ctx_valid']);
  assert.equal(JSON.stringify(context).includes('不该从context泄漏的抑制文本'), false);
  assert.equal(JSON.stringify(context).includes('不该从context泄漏的红删文本'), false);
});

test('exactQuotes are native three-key one-to-one projections of sourceMessageIds', () => {
  const first = deliveredMessage({ messageId: 'msg_quote_a', authorityGroupId: 'grp_quote_a', authorityLineageKey: 'lin_quote_a' });
  const second = deliveredMessage({ messageId: 'msg_quote_b', authorityGroupId: 'grp_quote_b', authorityLineageKey: 'lin_quote_b' });
  const valid = candidate('delivered_yuqi_life_fact', [first, second]);
  assert.equal(validateConsolidationCandidate(valid, [first, second]).status, 'verified');

  const duplicate = {
    ...valid,
    exactQuotes: [valid.exactQuotes[0], { ...valid.exactQuotes[0] }]
  };
  assert.equal(validateConsolidationCandidate(duplicate, [first, second]).status, 'rejected');

  const secret = {
    ...valid,
    exactQuotes: [valid.exactQuotes[0], { ...valid.exactQuotes[1], secret: 'nope' }]
  };
  assert.equal(validateConsolidationCandidate(secret, [first, second]).status, 'rejected');

  const missing = {
    ...valid,
    exactQuotes: [valid.exactQuotes[0]]
  };
  assert.equal(validateConsolidationCandidate(missing, [first, second]).status, 'rejected');
});

test('source IDs must remain native non-empty string arrays', () => {
  const message = deliveredMessage({ messageId: 'msg_native_ids' });
  assert.equal(validateConsolidationCandidate(
    candidate('delivered_yuqi_life_fact', [message], {
      sourceMessageIds: [123],
      exactQuotes: []
    }),
    [message]
  ).status, 'rejected');
  const action = deliveredAction({ actionId: 'action_native_ids' });
  const actionProjection = {
    actionId: action.actionId,
    kind: action.kind,
    targetKey: action.targetKey,
    targetRevision: action.targetRevision,
    payload: action.payload,
    actionChecksum: action.actionChecksum
  };
  assert.equal(validateConsolidationCandidate(
    candidate('retrievable_event', [], {
      sourceActionIds: [{}],
      exactActions: [actionProjection],
      evidenceSource: 'yuqi_delivered_action'
    }),
    [action]
  ).status, 'rejected');
});

test('action-only formal and life facts require directly matching closed proofs', () => {
  const moment = deliveredAction({ actionId: 'action_moment_proof' });
  const momentProjection = {
    actionId: moment.actionId,
    kind: moment.kind,
    targetKey: moment.targetKey,
    targetRevision: moment.targetRevision,
    payload: moment.payload,
    actionChecksum: moment.actionChecksum
  };
  const formalFromMoment = validateConsolidationCandidate(
    candidate('formal_commitment', [], {
      promisedBy: 'yuqi',
      promisedTo: 'user',
      sourceActionIds: [moment.actionId],
      exactActions: [momentProjection],
      evidenceSource: 'yuqi_delivered_action'
    }),
    [moment]
  );
  assert.equal(formalFromMoment.status, 'rejected');

  const promise = deliveredAction({
    actionId: 'action_promise_proof',
    kind: 'role_plan_create',
    payload: { promisedBy: 'yuqi', operation: 'remember' }
  });
  const promiseProjection = {
    actionId: promise.actionId,
    kind: promise.kind,
    targetKey: promise.targetKey,
    targetRevision: promise.targetRevision,
    payload: promise.payload,
    actionChecksum: promise.actionChecksum
  };
  assert.equal(validateConsolidationCandidate(
    candidate('formal_commitment', [], {
      promisedBy: 'yuqi',
      promisedTo: 'user',
      sourceActionIds: [promise.actionId],
      exactActions: [promiseProjection],
      evidenceSource: 'yuqi_delivered_action'
    }),
    [promise]
  ).status, 'verified');

  const arbitraryLifeAction = deliveredAction({ actionId: 'action_payment_not_life', kind: 'payment' });
  const arbitraryProjection = {
    actionId: arbitraryLifeAction.actionId,
    kind: arbitraryLifeAction.kind,
    targetKey: arbitraryLifeAction.targetKey,
    targetRevision: arbitraryLifeAction.targetRevision,
    payload: arbitraryLifeAction.payload,
    actionChecksum: arbitraryLifeAction.actionChecksum
  };
  assert.equal(validateConsolidationCandidate(
    candidate('delivered_yuqi_life_fact', [], {
      sourceActionIds: [arbitraryLifeAction.actionId],
      exactActions: [arbitraryProjection],
      evidenceSource: 'yuqi_delivered_action'
    }),
    [arbitraryLifeAction]
  ).status, 'rejected');
  const lifeAction = deliveredAction({
    actionId: 'action_life_event',
    kind: 'life_episode_create',
    payload: { episodeId: 'life_1', actorId: 'yuqi' }
  });
  const lifeProjection = {
    actionId: lifeAction.actionId,
    kind: lifeAction.kind,
    targetKey: lifeAction.targetKey,
    targetRevision: lifeAction.targetRevision,
    payload: lifeAction.payload,
    actionChecksum: lifeAction.actionChecksum
  };
  assert.equal(validateConsolidationCandidate(
    candidate('delivered_yuqi_life_fact', [], {
      sourceActionIds: [lifeAction.actionId],
      exactActions: [lifeProjection],
      evidenceSource: 'yuqi_delivered_action'
    }),
    [lifeAction]
  ).status, 'verified');

  const mixedFormalMessage = deliveredMessage({
    messageId: 'msg_mixed_formal',
    speakerId: 'yuqi',
    content: '我会记得'
  });
  const mixedFormal = candidate('formal_commitment', [mixedFormalMessage], {
    promisedBy: 'yuqi',
    promisedTo: 'user',
    sourceActionIds: [moment.actionId],
    exactActions: [momentProjection],
    evidenceSource: 'yuqi_delivered_action'
  });
  assert.equal(validateConsolidationCandidate(mixedFormal, [
    mixedFormalMessage,
    moment
  ]).status, 'rejected');

  const mixedLifeMessage = deliveredMessage({
    messageId: 'msg_mixed_life',
    speakerId: 'yuqi'
  });
  const mixedLife = candidate('delivered_yuqi_life_fact', [mixedLifeMessage], {
    sourceActionIds: [moment.actionId],
    exactActions: [momentProjection],
    evidenceSource: 'yuqi_delivered_action'
  });
  assert.equal(validateConsolidationCandidate(mixedLife, [
    mixedLifeMessage,
    moment
  ]).status, 'rejected');

  const wrongLifeSpeaker = deliveredMessage({
    messageId: 'msg_wrong_life_speaker',
    speakerId: 'other-character',
    speakerType: 'character'
  });
  assert.equal(validateConsolidationCandidate(
    candidate('delivered_yuqi_life_fact', [wrongLifeSpeaker]),
    [wrongLifeSpeaker]
  ).status, 'rejected');
});

test('typed v3 candidate identity, object, confidence, and promise fields are closed', () => {
  const message = deliveredMessage();
  for (const mutation of [
    { factId: 1 },
    { characterId: {} },
    { subjectId: 7 },
    { predicate: [] },
    { evidenceMode: 1 },
    { origin: {} },
    { evidenceSource: ['yuqi_delivered_message'] },
    { authorityContractVersion: 3 },
    { confidence: '0.9' },
    { confidence: 2 },
    { object: [] },
    { object: 'secret' },
    { promisedTo: 99 }
  ]) {
    assert.equal(validateConsolidationCandidate(
      candidate('formal_commitment', [message], {
        promisedBy: 'yuqi',
        promisedTo: 'user',
        ...mutation
      }),
      [message]
    ).status, 'rejected');
  }
});

test('authority provenance metadata is store-owned and cannot be model-spoofed', () => {
  const message = deliveredMessage();
  for (const mutation of [
    { origin: 'caller' },
    { authorityContractVersion: 'v2' },
    { evidenceSource: 'model_inference' }
  ]) {
    assert.equal(validateConsolidationCandidate(
      candidate('delivered_yuqi_life_fact', [message], mutation),
      [message]
    ).status, 'rejected');
  }
});

test('authority evidence rejects coercible IDs, versions, states, speakers, times, and roles', () => {
  const message = deliveredMessage();
  for (const mutation of [
    { messageId: 123 },
    { resultAuthorityVersion: '1' },
    { turnState: ['committed'] },
    { speakerId: ['yuqi'] },
    { speakerType: 'speaker' },
    { content: { text: '伪造' } },
    { sentAt: '1784400001000' },
    { authorityGroupId: ['grp_1'] }
  ]) {
    const mutated = { ...message, ...mutation };
    assert.equal(validateConsolidationCandidate(
      candidate('delivered_yuqi_life_fact', [mutated]),
      [mutated]
    ).status, 'rejected');
  }
  const numericMessageId = { ...message, messageId: 123 };
  const stringIdCandidate = candidate('delivered_yuqi_life_fact', [message], {
    sourceMessageIds: ['123'],
    exactQuotes: [{ messageId: '123', speakerId: message.speakerId, text: message.content }]
  });
  assert.equal(validateConsolidationCandidate(stringIdCandidate, [numericMessageId]).status, 'rejected');

  const action = deliveredAction();
  const projection = {
    actionId: action.actionId,
    kind: action.kind,
    targetKey: action.targetKey,
    targetRevision: action.targetRevision,
    payload: action.payload,
    actionChecksum: action.actionChecksum
  };
  for (const mutation of [
    { actionId: 1 },
    { resultAuthorityVersion: '1' },
    { turnState: ['committed'] },
    { authorityRoleId: ['yuqi'] },
    { authorityCommitChecksum: { value: 'c'.repeat(64) } }
  ]) {
    const mutated = { ...action, ...mutation };
    assert.equal(validateConsolidationCandidate(
      candidate('retrievable_event', [], {
        sourceActionIds: [action.actionId],
        exactActions: [projection],
        evidenceSource: 'yuqi_delivered_action'
      }),
      [mutated]
    ).status, 'rejected');
  }
});
