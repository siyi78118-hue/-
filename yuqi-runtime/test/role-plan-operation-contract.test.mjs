import assert from 'node:assert/strict';
import test from 'node:test';

test('the runtime exposes one role-plan operation contract', async () => {
  const contract = await import('../src/role-plan-operation-contract.mjs').catch(() => null);
  assert.equal(typeof contract?.normalizeRolePlanOperationList, 'function');
  assert.equal(typeof contract?.rolePlanOperationHasTimeChange, 'function');
  assert.equal(typeof contract?.rolePlanModelContractV1, 'function');
});

const {
  normalizeRolePlanOperationList,
  rolePlanOperationHasTimeChange,
  rolePlanModelContractV1
} = await import('../src/role-plan-operation-contract.mjs');

function createOperation(overrides = {}) {
  return {
    op: 'create',
    type: 'private_message',
    source: 'spoken',
    title: '早安',
    intent: '明早问候',
    sourceQuote: '但是明天的早安不要忘了',
    evidenceMessageIds: ['msg_1'],
    schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' },
    timeConfidence: 'inferred',
    ...overrides
  };
}

test('normalizes a valid closed role-plan list without sharing caller objects', () => {
  const source = [createOperation()];
  const normalized = normalizeRolePlanOperationList(JSON.stringify(source), {
    validMessageIds: ['msg_1']
  });
  assert.deepEqual(normalized, source);
  normalized[0].title = '篡改';
  assert.equal(source[0].title, '早安');
  assert.equal(rolePlanOperationHasTimeChange(source[0]), true);
  assert.equal(rolePlanOperationHasTimeChange({
    op: 'update', planId: 'plan_1', patch: { schedule: { kind: 'daily', time: '09:00' } }
  }), true);
  assert.equal(rolePlanOperationHasTimeChange({
    op: 'update', planId: 'plan_1', patch: { title: '新标题' }
  }), false);
});

test('publishes one immutable-by-copy model contract for explicit and inferred time', () => {
  const first = rolePlanModelContractV1();
  assert.deepEqual(first, {
    version: 1,
    container: 'JSON array string',
    timeConfidence: {
      requiredFor: ['create', 'update_with_schedule'],
      allowed: ['explicit', 'inferred'],
      explicit: 'the user supplied a concrete execution time',
      inferred: 'the user used a vague natural time and Yuqi selected the concrete execution time'
    },
    rejectMissingOrAliases: true
  });
  first.timeConfidence.allowed.push('legacy');
  assert.deepEqual(rolePlanModelContractV1().timeConfidence.allowed, ['explicit', 'inferred']);
});

test('accepts every canonical schedule kind and all target operations', () => {
  const schedules = [
    { kind: 'once', at: '2026-08-15T08:00:00+08:00' },
    { kind: 'interval', startsAt: '2026-08-15T08:00:00+08:00', intervalMs: 300_000 },
    { kind: 'daily', time: '08:00' },
    { kind: 'weekly', weekdays: [1, 3, 5], time: '08:00' },
    { kind: 'monthly', day: 15, time: '08:00' }
  ];
  for (const schedule of schedules) {
    assert.equal(normalizeRolePlanOperationList([
      createOperation({ schedule, timeConfidence: 'explicit' })
    ], { validMessageIds: ['msg_1'] }).length, 1);
  }
  const targets = ['cancel', 'pause', 'resume', 'complete'].map(op => ({
    op, planId: 'plan_1', reason: '用户要求'
  }));
  targets.push({
    op: 'update',
    planId: 'plan_1',
    patch: { schedule: { kind: 'daily', time: '09:00' }, timeConfidence: 'explicit' },
    reason: '改到九点'
  });
  assert.deepEqual(
    normalizeRolePlanOperationList(targets, { allowedPlanIds: ['plan_1'] }),
    targets
  );
});

test('requires native canonical time confidence for every time-bearing operation', () => {
  for (const value of [undefined, null, 1, ['inferred'], { value: 'inferred' },
    'implicit', 'approximate', 'INFERRED']) {
    const operation = createOperation();
    if (value === undefined) delete operation.timeConfidence;
    else operation.timeConfidence = value;
    assert.throws(
      () => normalizeRolePlanOperationList([operation], { validMessageIds: ['msg_1'] }),
      /role plan operation contract conflict: time confidence/
    );
  }
  assert.throws(() => normalizeRolePlanOperationList([{
    op: 'update', planId: 'plan_1',
    patch: { schedule: { kind: 'daily', time: '09:00' } }
  }], { allowedPlanIds: ['plan_1'] }), /time confidence/);
});

test('rejects unknown fields, coerced schedule values, and foreign authority references', () => {
  assert.throws(() => normalizeRolePlanOperationList([
    createOperation({ secret: 'leak' })
  ], { validMessageIds: ['msg_1'] }), /fields/);
  assert.throws(() => normalizeRolePlanOperationList([
    createOperation({ schedule: { kind: 'interval', startsAt: '2026-08-15T08:00:00+08:00', intervalMs: '300000' } })
  ], { validMessageIds: ['msg_1'] }), /schedule/);
  assert.throws(() => normalizeRolePlanOperationList([
    createOperation({ evidenceMessageIds: ['msg_foreign'] })
  ], { validMessageIds: ['msg_1'] }), /evidence/);
  assert.throws(() => normalizeRolePlanOperationList([
    { op: 'cancel', planId: 'plan_foreign' }
  ], { allowedPlanIds: ['plan_1'] }), /target/);
  assert.throws(() => normalizeRolePlanOperationList([
    { op: 'update', planId: 'plan_1', patch: { title: '改名', secret: true } }
  ], { allowedPlanIds: ['plan_1'] }), /patch fields/);
});

test('rejects malformed containers, operation counts, and duplicate evidence identities', () => {
  for (const value of ['{', '{}', null, 1, { operations: [] }]) {
    assert.throws(() => normalizeRolePlanOperationList(value), /role plan operation contract conflict/);
  }
  assert.throws(
    () => normalizeRolePlanOperationList(Array.from({ length: 13 }, () => createOperation())),
    /operation count/
  );
  assert.throws(() => normalizeRolePlanOperationList([
    createOperation({ evidenceMessageIds: ['msg_1', 'msg_1'] })
  ], { validMessageIds: ['msg_1'] }), /evidence/);
});
