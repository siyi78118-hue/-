import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const modulePath = new URL('../tavern-app/lib/canonical-action-application.js', import.meta.url);

function loadModule() {
  const context = vm.createContext({
    structuredClone,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String
  });
  if (existsSync(modulePath)) vm.runInContext(readFileSync(modulePath, 'utf8'), context);
  return context.ALCanonicalActionApplication;
}

test('exports the canonical action application boundary', () => {
  const api = loadModule();
  assert.ok(api, 'ALCanonicalActionApplication should be exported');
  assert.equal(typeof api.createCanonicalActionApplier, 'function');
});

function canonicalAction(kind, ordinal, overrides = {}) {
  const actionId = overrides.actionId || `action_${kind}_${ordinal}`;
  return {
    actionId,
    ordinal,
    kind,
    targetKey: overrides.targetKey || `${kind}:${ordinal}`,
    targetRevision: overrides.targetRevision || `sha256:${'b'.repeat(64)}`,
    payload: overrides.payload || {},
    actionChecksum: overrides.actionChecksum || 'a'.repeat(64)
  };
}

function groupResult(overrides = {}) {
  return {
    authoritativeTurnId: 'turn_remote_1',
    visibleGroupId: 'group_1',
    roleId: 'yuqi',
    terminalDisposition: 'action_only',
    ...overrides
  };
}

function proofStore(initial = {}) {
  let value = structuredClone(initial);
  let writes = 0;
  return {
    async load() { return structuredClone(value); },
    async save(next) { value = structuredClone(next); writes += 1; },
    snapshot() { return structuredClone(value); },
    writes() { return writes; }
  };
}

test('whole-set preflight rejects reserved actions before any mutation or UI acknowledgement', async () => {
  const api = loadModule();
  const globalProofStore = proofStore();
  const events = [];
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      payment: {
        async preflight() { events.push('preflight:payment'); },
        async apply() { events.push('apply:payment'); }
      }
    },
    acknowledgeUiApplied: async () => events.push('ui-ack'),
    now: () => 1000
  });
  assert.equal(typeof applier.applyGroup, 'function');

  const result = await applier.applyGroup({
    localTurnId: 'local_1',
    result: groupResult(),
    actions: [
      canonicalAction('payment_accept', 0),
      canonicalAction('moment_create', 1)
    ]
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: 'unsupported', actionId: 'action_moment_create_1', kind: 'moment_create'
  });
  assert.deepEqual(events, []);
  assert.equal(globalProofStore.writes(), 0);
});

test('applies supported actions in ordinal order, persists exact proofs, and only then acknowledges UI', async () => {
  const api = loadModule();
  const globalProofStore = proofStore();
  const events = [];
  const nativeUi = new Set();
  let nativeTransitions = 0;
  const actions = [
    canonicalAction('payment_accept', 0, { actionId: 'pay_action' }),
    canonicalAction('moment_like', 1, { actionId: 'moment_action' })
  ];
  const proofFor = (action, appliedAt) => ({
    turnId: 'turn_remote_1',
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    type: action.kind,
    appliedAt
  });
  const adapters = Object.fromEntries(['payment', 'moment'].map((family, index) => [family, {
    async preflight({ action }) { events.push(`preflight:${action.actionId}`); },
    async verifyApplied({ action }) {
      events.push(`verify:${action.actionId}`);
      return { outcome: 'already_applied', proof: proofFor(action, 2000 + index) };
    },
    async apply({ action }) {
      events.push(`apply:${action.actionId}`);
      return { outcome: 'applied', proof: proofFor(action, 2000 + index) };
    }
  }]));
  const makeApplier = () => api.createCanonicalActionApplier({
    globalProofStore,
    adapters,
    acknowledgeUiApplied: async ({ localTurnId }) => {
      events.push(`ui-ack:${localTurnId}`);
      if (!nativeUi.has(localTurnId)) {
        nativeUi.add(localTurnId);
        nativeTransitions += 1;
      }
    },
    fault: async name => events.push(`fault:${name}`),
    now: () => 9000
  });

  const first = await makeApplier().applyGroup({
    localTurnId: 'local_1',
    result: groupResult(),
    actions
  });
  assert.equal(first.status, 'ready_for_ui_ack');
  assert.deepEqual(events.slice(0, 2), ['preflight:pay_action', 'preflight:moment_action']);
  assert.ok(events.indexOf('apply:pay_action') < events.indexOf('apply:moment_action'));
  assert.ok(events.lastIndexOf('ui-ack:local_1') > events.lastIndexOf('apply:moment_action'));
  assert.deepEqual(globalProofStore.snapshot(), {
    pay_action: proofFor(actions[0], 2000),
    moment_action: proofFor(actions[1], 2001)
  });
  assert.equal(nativeTransitions, 1);

  events.length = 0;
  const replay = await makeApplier().applyGroup({
    localTurnId: 'local_1',
    result: groupResult(),
    actions
  });
  assert.equal(replay.status, 'already_proven');
  assert.equal(events.some(event => event.startsWith('apply:')), false);
  assert.equal(nativeTransitions, 1, 'native UI state is monotonic across ambiguous acknowledgement replay');
});

test('zero canonical actions never acknowledge UI application', async () => {
  const api = loadModule();
  const globalProofStore = proofStore();
  let uiAcks = 0;
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {},
    acknowledgeUiApplied: async () => { uiAcks += 1; }
  });

  await assert.rejects(applier.applyGroup({
    localTurnId: 'local_zero',
    result: groupResult(),
    actions: []
  }), /canonical action set conflict/);
  assert.equal(globalProofStore.writes(), 0);
  assert.equal(uiAcks, 0);
});

test('canonical action groups require a live visible identity and never apply actions to skip', async () => {
  const api = loadModule();
  const globalProofStore = proofStore();
  let adapterReads = 0;
  let adapterWrites = 0;
  let uiAcks = 0;
  const adapter = {
    async preflight() { adapterReads += 1; },
    async verifyApplied() { throw new Error('unexpected verify'); },
    async apply() { adapterWrites += 1; throw new Error('unexpected apply'); }
  };
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: { moment: adapter },
    acknowledgeUiApplied: async () => { uiAcks += 1; }
  });
  const action = canonicalAction('moment_like', 0);
  for (const result of [
    groupResult({ visibleGroupId: '' }),
    groupResult({ roleId: '' }),
    groupResult({ terminalDisposition: 'skip' }),
    groupResult({ terminalDisposition: 'mystery' })
  ]) {
    await assert.rejects(applier.applyGroup({
      localTurnId: 'local_identity_guard', result, actions: [action]
    }), /canonical action group identity conflict/);
  }
  assert.equal(adapterReads, 0);
  assert.equal(adapterWrites, 0);
  assert.equal(globalProofStore.writes(), 0);
  assert.equal(uiAcks, 0);
});

test('whole-set preflight and domain verification finish before any pending mutation', async () => {
  const api = loadModule();
  const existing = canonicalAction('payment_accept', 0, { actionId: 'existing_action' });
  const pending = canonicalAction('moment_like', 1, { actionId: 'pending_action' });
  const existingProof = {
    turnId: 'turn_remote_1',
    actionId: existing.actionId,
    actionChecksum: existing.actionChecksum,
    type: existing.kind,
    appliedAt: 2100
  };
  const globalProofStore = proofStore({ [existing.actionId]: existingProof });
  const events = [];
  let uiAcks = 0;
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      payment: {
        async preflight() { events.push('preflight:existing'); },
        async verifyApplied() {
          events.push('verify:existing');
          return { outcome: 'already_applied', proof: existingProof };
        },
        async apply() { events.push('apply:existing'); throw new Error('unexpected apply'); }
      },
      moment: {
        async preflight() { events.push('preflight:pending'); throw new Error('later preflight conflict'); },
        async verifyApplied() { events.push('verify:pending'); throw new Error('unexpected verify'); },
        async apply() { events.push('apply:pending'); throw new Error('unexpected apply'); }
      }
    },
    acknowledgeUiApplied: async () => { uiAcks += 1; }
  });

  await assert.rejects(applier.applyGroup({
    localTurnId: 'local_preflight',
    result: groupResult(),
    actions: [existing, pending]
  }), /later preflight conflict/);
  assert.deepEqual(events, ['preflight:existing', 'preflight:pending']);
  assert.equal(globalProofStore.writes(), 0);
  assert.equal(uiAcks, 0);
});

test('an exact-looking global proof cannot replace domain-native evidence or hide a changed target', async () => {
  const api = loadModule();
  const state = paymentState();
  state.chats.yuqi.messages.push({
    id: 'payment_2', role: 'user', payType: 'transfer', amount: 10,
    payStatus: 'pending', note: '宵夜'
  });
  const action = paymentDeclineAction();
  const forgedProof = {
    turnId: 'turn_remote_1',
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    type: action.kind,
    appliedAt: 5000
  };

  for (const candidate of [
    action,
    paymentDeclineAction({
      payload: { messageId: 'payment_2' },
      targetKey: 'payment:payment_2',
      targetRevision: `sha256:${'d'.repeat(64)}`
    })
  ]) {
    const globalProofStore = proofStore({ [action.actionId]: forgedProof });
    let uiAcks = 0;
    const applier = api.createCanonicalActionApplier({
      globalProofStore,
      adapters: {
        payment: api.createPaymentActionAdapter({
          store: paymentStore(state),
          now: () => 7000
        })
      },
      acknowledgeUiApplied: async () => { uiAcks += 1; }
    });
    const before = structuredClone(state);
    await assert.rejects(applier.applyGroup({
      localTurnId: 'local_forged',
      result: groupResult(),
      actions: [candidate]
    }), /payment action application proof conflict/);
    assert.deepEqual(state, before);
    assert.equal(globalProofStore.writes(), 0);
    assert.equal(uiAcks, 0);
  }
});

test('a trimmed historical domain proof is valid session evidence without changing appliedAt', async () => {
  const api = loadModule();
  const action = canonicalAction('role_plan_update', 0, { actionId: 'old_action' });
  const historicalProof = {
    turnId: 'turn_remote_1',
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    type: action.kind,
    appliedAt: 5000
  };
  const newer = {};
  for (let index = 0; index < 1000; index += 1) {
    newer[`newer_${index}`] = {
      turnId: 'other_turn',
      actionId: `newer_${index}`,
      actionChecksum: 'd'.repeat(64),
      type: 'role_plan_update',
      appliedAt: 10000 + index
    };
  }
  const globalProofStore = proofStore(newer);
  let uiAcks = 0;
  let applies = 0;
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      role_plan: {
        async preflight() {},
        async verifyApplied() { throw new Error('unexpected global verification'); },
        async apply() {
          applies += 1;
          return { outcome: 'already_applied', proof: structuredClone(historicalProof) };
        }
      }
    },
    acknowledgeUiApplied: async () => { uiAcks += 1; }
  });

  const applied = await applier.applyGroup({
    localTurnId: 'local_old',
    result: groupResult(),
    actions: [action]
  });
  assert.equal(applied.status, 'ready_for_ui_ack');
  assert.equal(applies, 1);
  assert.equal(uiAcks, 1);
  assert.equal(globalProofStore.snapshot()[action.actionId], undefined);
  assert.equal(Object.keys(globalProofStore.snapshot()).length, 1000);
  assert.equal(historicalProof.appliedAt, 5000);
});

test('a changed checksum conflicts before verification, mutation, or UI acknowledgement', async () => {
  const api = loadModule();
  const action = canonicalAction('moment_like', 0, { actionId: 'checksum_action' });
  const globalProofStore = proofStore({
    [action.actionId]: {
      turnId: 'turn_remote_1',
      actionId: action.actionId,
      actionChecksum: action.actionChecksum,
      type: action.kind,
      appliedAt: 2200
    }
  });
  const events = [];
  let uiAcks = 0;
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      moment: {
        async preflight() { events.push('preflight'); },
        async verifyApplied() { events.push('verify'); throw new Error('unexpected verify'); },
        async apply() { events.push('apply'); throw new Error('unexpected apply'); }
      }
    },
    acknowledgeUiApplied: async () => { uiAcks += 1; }
  });
  const changed = { ...action, actionChecksum: 'f'.repeat(64) };

  const outcome = await applier.applyGroup({
    localTurnId: 'local_checksum',
    result: groupResult(),
    actions: [changed]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
    status: 'conflict', actionId: action.actionId, kind: action.kind
  });
  assert.deepEqual(events, ['preflight']);
  assert.equal(globalProofStore.writes(), 0);
  assert.equal(uiAcks, 0);
});

test('a crash after global proof persistence reloads through domain verification before UI acknowledgement', async () => {
  const api = loadModule();
  const action = canonicalAction('relationship_transition', 0, { actionId: 'reload_action' });
  const proof = {
    turnId: 'turn_remote_1',
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    type: action.kind,
    appliedAt: 2300
  };
  const globalProofStore = proofStore();
  let domainApplied = false;
  let applyCalls = 0;
  let verifyCalls = 0;
  let uiAcks = 0;
  let crash = true;
  const adapters = {
    relationship: {
      async preflight() {},
      async verifyApplied() {
        verifyCalls += 1;
        if (!domainApplied) throw new Error('missing domain proof');
        return { outcome: 'already_applied', proof: structuredClone(proof) };
      },
      async apply() {
        applyCalls += 1;
        domainApplied = true;
        return { outcome: 'applied', proof: structuredClone(proof) };
      }
    }
  };
  const makeApplier = () => api.createCanonicalActionApplier({
    globalProofStore,
    adapters,
    acknowledgeUiApplied: async () => { uiAcks += 1; },
    fault: async name => {
      if (name === `after_global_proof:${action.actionId}` && crash) {
        crash = false;
        throw new Error('forced:after_global_proof');
      }
    }
  });
  const input = { localTurnId: 'local_reload', result: groupResult(), actions: [action] };

  await assert.rejects(makeApplier().applyGroup(input), /forced:after_global_proof/);
  assert.deepEqual(globalProofStore.snapshot()[action.actionId], proof);
  assert.equal(applyCalls, 1);
  assert.equal(uiAcks, 0);

  const replay = await makeApplier().applyGroup(input);
  assert.equal(replay.status, 'already_proven');
  assert.equal(applyCalls, 1);
  assert.equal(verifyCalls, 1);
  assert.equal(uiAcks, 1);
});

test('a concurrently corrupted persisted proof cannot pass on session fields alone', async () => {
  const api = loadModule();
  const action = canonicalAction('role_plan_update', 0, { actionId: 'corrupt_save_action' });
  const proof = {
    turnId: 'turn_remote_1',
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    type: action.kind,
    appliedAt: 2400
  };
  let stored = {};
  const globalProofStore = {
    async load() { return structuredClone(stored); },
    async save(next) {
      stored = structuredClone(next);
      stored[action.actionId].extra = 'leak';
    }
  };
  let uiAcks = 0;
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      role_plan: {
        async preflight() {},
        async verifyApplied() { throw new Error('unexpected verify'); },
        async apply() { return { outcome: 'applied', proof: structuredClone(proof) }; }
      }
    },
    acknowledgeUiApplied: async () => { uiAcks += 1; }
  });

  await assert.rejects(applier.applyGroup({
    localTurnId: 'local_corrupt_save',
    result: groupResult(),
    actions: [action]
  }), /canonical action application proof conflict/);
  assert.equal(uiAcks, 0);
});

function paymentState() {
  return {
    settings: { walletBalance: 74.5 },
    chats: {
      yuqi: {
        messages: [{
          id: 'payment_1', role: 'user', payType: 'transfer', amount: 25.5,
          payStatus: 'pending', note: '晚饭'
        }]
      }
    }
  };
}

function paymentStore(state) {
  return {
    async readSettings() { return structuredClone(state.settings); },
    async writeSettings(next) { state.settings = structuredClone(next); },
    async readChat(characterId) { return structuredClone(state.chats[characterId]); },
    async writeChat(characterId, next) { state.chats[characterId] = structuredClone(next); },
    createMemoryEvent({ request, appliedAt }) {
      return {
        id: `memory_${request.actionId}`,
        role: 'user',
        hidden: true,
        sourceActionId: request.actionId,
        time: appliedAt,
        content: '【支付事件】虞栖拒绝了转账。'
      };
    }
  };
}

function paymentDeclineAction(overrides = {}) {
  return canonicalAction('payment_decline', 0, {
    actionId: 'payment_decline_1',
    targetKey: 'payment:payment_1',
    targetRevision: `sha256:${'c'.repeat(64)}`,
    payload: { messageId: 'payment_1' },
    ...overrides
  });
}

function paymentAcceptAction(overrides = {}) {
  return canonicalAction('payment_accept', 0, {
    actionId: 'payment_accept_1',
    targetKey: 'payment:payment_1',
    targetRevision: `sha256:${'e'.repeat(64)}`,
    payload: { messageId: 'payment_1' },
    ...overrides
  });
}

function storedPaymentRequest(action, overrides = {}) {
  const decline = action.kind === 'payment_decline';
  return {
    version: 1,
    authoritativeTurnId: 'turn_remote_1',
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    kind: action.kind,
    targetKey: action.targetKey,
    targetRevision: action.targetRevision,
    characterId: 'yuqi',
    targetMessageId: action.payload.messageId,
    payType: 'transfer',
    amountCents: 2550,
    decision: decline ? 'decline' : 'accept',
    balanceDeltaCents: decline ? 2550 : 0,
    balanceAfterCents: decline ? 10000 : 7450,
    appliedAt: 5000,
    ...overrides
  };
}

test('payment journal and exact chat marker must retain the same appliedAt for both decisions', async () => {
  const api = loadModule();
  for (const action of [paymentAcceptAction(), paymentDeclineAction()]) {
    const state = paymentState();
    const target = state.chats.yuqi.messages[0];
    const decline = action.kind === 'payment_decline';
    state.settings.walletBalance = decline ? 100 : 74.5;
    state.settings.nativePaymentActionApplications = {
      [action.actionId]: storedPaymentRequest(action)
    };
    target.payStatus = decline ? 'refused' : 'received';
    target.payStatusTime = 5001;
    target.payMemoryRecordedStatus = decline ? 'refused' : 'received';
    if (decline) target.refunded = true;
    target.nativePaymentActionApplication = {
      actionId: action.actionId,
      actionChecksum: action.actionChecksum,
      appliedAt: 5001
    };
    const globalProofStore = proofStore();
    let uiAcks = 0;
    const applier = api.createCanonicalActionApplier({
      globalProofStore,
      adapters: {
        payment: api.createPaymentActionAdapter({
          store: paymentStore(state),
          now: () => 8000
        })
      },
      acknowledgeUiApplied: async () => { uiAcks += 1; }
    });
    const before = structuredClone(state);
    await assert.rejects(applier.applyGroup({
      localTurnId: `local_${action.kind}`,
      result: groupResult(),
      actions: [action]
    }), /payment action authority conflict/);
    assert.deepEqual(state, before);
    assert.equal(globalProofStore.writes(), 0);
    assert.equal(uiAcks, 0);
  }
});

test('a global payment proof requires a fully landed exact chat marker, not a journal alone', async () => {
  const api = loadModule();
  const action = paymentDeclineAction();
  const state = paymentState();
  state.settings.walletBalance = 100;
  state.settings.nativePaymentActionApplications = {
    [action.actionId]: storedPaymentRequest(action)
  };
  const globalProofStore = proofStore({
    [action.actionId]: {
      turnId: 'turn_remote_1',
      actionId: action.actionId,
      actionChecksum: action.actionChecksum,
      type: action.kind,
      appliedAt: 5000
    }
  });
  let uiAcks = 0;
  const applier = api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      payment: api.createPaymentActionAdapter({ store: paymentStore(state), now: () => 8000 })
    },
    acknowledgeUiApplied: async () => { uiAcks += 1; }
  });
  const before = structuredClone(state);

  await assert.rejects(applier.applyGroup({
    localTurnId: 'local_journal_only',
    result: groupResult(),
    actions: [action]
  }), /payment action application proof conflict/);
  assert.deepEqual(state, before);
  assert.equal(globalProofStore.writes(), 0);
  assert.equal(uiAcks, 0);
});

test('an exact marker-only payment landing verifies the global proof and rejects incomplete landing fields', async () => {
  const api = loadModule();
  const action = paymentDeclineAction();
  const exactProof = {
    turnId: 'turn_remote_1',
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    type: action.kind,
    appliedAt: 5000
  };
  const state = paymentState();
  const target = state.chats.yuqi.messages[0];
  target.payStatus = 'refused';
  target.payStatusTime = 5000;
  target.refunded = true;
  target.payMemoryRecordedStatus = 'refused';
  target.nativePaymentActionApplication = {
    actionId: action.actionId,
    actionChecksum: action.actionChecksum,
    appliedAt: 5000
  };
  const makeApplier = (globalProofStore, onAck) => api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      payment: api.createPaymentActionAdapter({ store: paymentStore(state), now: () => 8000 })
    },
    acknowledgeUiApplied: onAck
  });
  const firstProofStore = proofStore({ [action.actionId]: exactProof });
  let uiAcks = 0;
  const verified = await makeApplier(firstProofStore, async () => { uiAcks += 1; }).applyGroup({
    localTurnId: 'local_marker_only',
    result: groupResult(),
    actions: [action]
  });
  assert.equal(verified.status, 'already_proven');
  assert.equal(firstProofStore.writes(), 0);
  assert.equal(uiAcks, 1);

  target.payMemoryRecordedStatus = '';
  const invalidProofStore = proofStore({ [action.actionId]: exactProof });
  const before = structuredClone(state);
  await assert.rejects(makeApplier(invalidProofStore, async () => {
    throw new Error('unexpected UI acknowledgement');
  }).applyGroup({
    localTurnId: 'local_incomplete_marker',
    result: groupResult(),
    actions: [action]
  }), /payment action target conflict/);
  assert.deepEqual(state, before);
  assert.equal(invalidProofStore.writes(), 0);
});

test('payment accept and decline both require the exact messageId payload shape', async () => {
  const api = loadModule();
  const state = paymentState();
  const adapter = api.createPaymentActionAdapter({ store: paymentStore(state), now: () => 8000 });
  for (const base of [paymentAcceptAction(), paymentDeclineAction()]) {
    for (const payload of [
      { paymentId: 'payment_1' },
      { messageId: 'payment_1', decision: base.kind === 'payment_accept' ? 'accept' : 'decline' },
      { messageId: ['payment_1'] }
    ]) {
      const action = { ...base, payload };
      await assert.rejects(adapter.preflight({ action, result: groupResult() }),
        /payment action authority conflict/);
    }
  }
});

test('payment journal prevents a second refund after settings-to-chat and chat-to-proof crashes', async () => {
  const api = loadModule();
  assert.equal(typeof api.createPaymentActionAdapter, 'function');
  const state = paymentState();
  const globalProofStore = proofStore();
  const nativeUi = new Set();
  let clock = 5000;
  let failAt = 'payment_after_settings';
  const fault = async name => {
    if (name === failAt) {
      failAt = '';
      throw new Error(`forced:${name}`);
    }
  };
  const makeApplier = () => api.createCanonicalActionApplier({
    globalProofStore,
    adapters: {
      payment: api.createPaymentActionAdapter({
        store: paymentStore(state),
        now: () => clock++,
        fault
      })
    },
    acknowledgeUiApplied: async ({ localTurnId }) => nativeUi.add(localTurnId),
    now: () => clock++,
    fault
  });
  const input = {
    localTurnId: 'local_payment',
    result: groupResult(),
    actions: [paymentDeclineAction()]
  };

  await assert.rejects(makeApplier().applyGroup(input), /forced:payment_after_settings/);
  assert.equal(state.settings.walletBalance, 100);
  assert.equal(Object.keys(state.settings.nativePaymentActionApplications).length, 1);
  assert.equal(state.chats.yuqi.messages[0].payStatus, 'pending');
  assert.equal(globalProofStore.writes(), 0);
  assert.equal(nativeUi.size, 0);

  failAt = 'after_domain:payment_decline_1';
  await assert.rejects(makeApplier().applyGroup(input), /forced:after_domain:payment_decline_1/);
  const target = state.chats.yuqi.messages.find(row => row.id === 'payment_1');
  assert.equal(target.payStatus, 'refused');
  assert.equal(target.refunded, true);
  assert.equal(state.settings.walletBalance, 100);
  assert.equal(state.chats.yuqi.messages.filter(row => row.sourceActionId === 'payment_decline_1').length, 1);
  assert.equal(globalProofStore.writes(), 0);

  const completed = await makeApplier().applyGroup(input);
  assert.equal(completed.status, 'ready_for_ui_ack');
  assert.equal(state.settings.walletBalance, 100);
  assert.equal(state.chats.yuqi.messages.filter(row => row.sourceActionId === 'payment_decline_1').length, 1);
  assert.equal(nativeUi.size, 1);

  state.settings.walletBalance = 150;
  await globalProofStore.save({});
  const afterRecharge = await makeApplier().applyGroup(input);
  assert.equal(afterRecharge.status, 'ready_for_ui_ack');
  assert.equal(state.settings.walletBalance, 150, 'historical balanceAfter must not be compared with current balance');
  assert.equal(state.chats.yuqi.messages.filter(row => row.sourceActionId === 'payment_decline_1').length, 1);

  await globalProofStore.save({});
  const changed = paymentDeclineAction({ actionChecksum: 'd'.repeat(64) });
  await assert.rejects(makeApplier().applyGroup({ ...input, actions: [changed] }), /payment action authority conflict/);
  assert.equal(state.settings.walletBalance, 150);

  const invalidState = paymentState();
  const invalidProofStore = proofStore();
  let invalidUiAcks = 0;
  const invalidApplier = api.createCanonicalActionApplier({
    globalProofStore: invalidProofStore,
    adapters: {
      payment: api.createPaymentActionAdapter({
        store: paymentStore(invalidState),
        now: () => clock++
      })
    },
    acknowledgeUiApplied: async () => { invalidUiAcks += 1; },
    now: () => clock++
  });
  const invalidBefore = structuredClone(invalidState);
  await assert.rejects(invalidApplier.applyGroup({
    ...input,
    actions: [paymentDeclineAction({ payload: { messageId: 'payment_1', decision: 'decline' } })]
  }), /payment action authority conflict/);
  await assert.rejects(invalidApplier.applyGroup({
    ...input,
    actions: [paymentDeclineAction({ payload: { paymentId: 'payment_1' } })]
  }), /payment action authority conflict/);
  assert.deepEqual(invalidState, invalidBefore);
  assert.equal(invalidProofStore.writes(), 0);
  assert.equal(invalidUiAcks, 0);
});
