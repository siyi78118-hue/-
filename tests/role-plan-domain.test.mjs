import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

process.env.TZ = 'Asia/Shanghai';

const domainPath = new URL('../tavern-app/lib/role-plan-domain.js', import.meta.url);
const context = vm.createContext({ structuredClone, Date, Math, JSON, Set, String, Number });
if (existsSync(domainPath)) vm.runInContext(readFileSync(domainPath, 'utf8'), context);
const domain = context.ALRolePlans;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalPair(actionId, kind, planId, operation, overrides = {}) {
  return {
    operation: structuredClone(operation),
    request: {
      version: 1,
      authoritativeTurnId: 'turn_authority_1',
      actionId,
      actionChecksum: 'a'.repeat(64),
      kind,
      planId,
      operationJson: canonicalJson(operation),
      ...overrides
    }
  };
}

function canonicalDescriptor(actionId, kind, operation, overrides = {}) {
  const targetKey = operation.op === 'create'
    ? 'lineage_create:lineage_1:role_plan_create'
    : `role_plan:${operation.planId}`;
  return {
    authoritativeTurnId: 'turn_authority_1',
    actionId,
    actionChecksum: 'a'.repeat(64),
    kind,
    targetKey,
    targetRevision: `sha256:${'b'.repeat(64)}`,
    operation: structuredClone(operation),
    ...overrides
  };
}

test('exports the role plan domain', () => {
  assert.ok(domain, 'ALRolePlans should be exported');
});

test('creates an explicit one-time commitment', () => {
  const now = Date.parse('2026-07-16T20:00:00+08:00');
  const result = domain.applyOperations([], [], [{
    op: 'create',
    type: 'private_message',
    source: 'spoken',
    title: '起床后发早安',
    intent: '明天起床后主动向用户问早安',
    schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' },
    timeConfidence: 'explicit'
  }], { charId: 'char-a', now, uid: () => 'plan-a' });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.plans[0].planId, 'plan-a');
  assert.equal(result.plans[0].status, 'active');
  assert.equal(result.plans[0].nextRunAt, Date.parse('2026-07-17T09:00:00+08:00'));
});

test('keeps local wall-clock time for daily and weekly schedules', () => {
  const after = Date.parse('2026-07-16T10:00:00+08:00');
  assert.equal(
    domain.nextOccurrence({ kind: 'daily', time: '09:00' }, after),
    Date.parse('2026-07-17T09:00:00+08:00')
  );
  assert.equal(
    domain.nextOccurrence({ kind: 'weekly', weekdays: [5], time: '08:30' }, after),
    Date.parse('2026-07-17T08:30:00+08:00')
  );
});

test('clamps monthly dates and advances fixed intervals', () => {
  assert.equal(
    domain.nextOccurrence({ kind: 'monthly', day: 31, time: '09:00' }, Date.parse('2026-04-01T00:00:00+08:00')),
    Date.parse('2026-04-30T09:00:00+08:00')
  );
  assert.equal(
    domain.nextOccurrence({ kind: 'interval', startsAt: '2026-07-16T08:00:00+08:00', intervalMs: 3600000 }, Date.parse('2026-07-16T09:10:00+08:00')),
    Date.parse('2026-07-16T10:00:00+08:00')
  );
});

test('cancels only the explicitly referenced plan', () => {
  const plans = [
    { planId: 'work', characterId: 'char-a', type: 'role_schedule', status: 'active', title: '上班', intent: '工作', nextRunAt: 10 },
    { planId: 'morning', characterId: 'char-a', type: 'private_message', status: 'active', title: '早安', intent: '发早安', nextRunAt: 20 }
  ];
  const result = domain.applyOperations(plans, [], [{ op: 'cancel', planId: 'work', reason: '角色明确表示已经辞职' }], {
    charId: 'char-a', now: 30, uid: () => 'history-a'
  });

  assert.equal(result.plans.find(plan => plan.planId === 'work').status, 'cancelled');
  assert.equal(result.plans.find(plan => plan.planId === 'morning').status, 'active');
  assert.equal(result.history[0].operation, 'cancel');
});

test('merges a semantic duplicate instead of creating a second plan', () => {
  const now = Date.parse('2026-07-16T20:00:00+08:00');
  const existing = [{
    planId: 'existing', characterId: 'char-a', type: 'private_message', source: 'spoken', status: 'active',
    title: '早安', intent: '明天起床后发早安', nextRunAt: Date.parse('2026-07-17T09:00:00+08:00'), createdAt: now, updatedAt: now
  }];
  const result = domain.applyOperations(existing, [], [{
    op: 'create', type: 'private_message', source: 'spoken', title: '发早安', intent: '明天起床后发早安',
    schedule: { kind: 'once', at: '2026-07-17T09:02:00+08:00' }, timeConfidence: 'explicit'
  }], { charId: 'char-a', now, uid: () => 'new-plan' });

  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].planId, 'existing');
  assert.equal(result.plans[0].nextRunAt, Date.parse('2026-07-17T09:02:00+08:00'));
});

test('enforces fifty effective plans per character', () => {
  const plans = Array.from({ length: 50 }, (_, index) => ({
    planId: `plan-${index}`, characterId: 'char-a', type: 'private_message', status: 'active', intent: `事项${index}`, nextRunAt: 1000 + index
  }));
  const result = domain.applyOperations(plans, [], [{
    op: 'create', type: 'private_message', source: 'private_decision', title: '额外计划', intent: '额外事项',
    schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' }, timeConfidence: 'explicit'
  }], { charId: 'char-a', now: Date.parse('2026-07-16T20:00:00+08:00'), uid: () => 'overflow' });

  assert.equal(result.plans.length, 50);
  assert.equal(result.rejected[0].code, 'PLAN_LIMIT');
});

test('builds a minimal independent cloud job', () => {
  const plan = {
    planId: 'plan-a', characterId: 'char-a', type: 'private_message', source: 'spoken',
    nextRunAt: Date.parse('2026-07-17T09:00:00+08:00'), intent: 'private intent must stay local'
  };
  const job = domain.cloudJob(plan, 'device-a');
  assert.equal(job.type, 'role-plan');
  assert.equal(job.occurrenceId, `plan-a:${plan.nextRunAt}`);
  assert.equal('intent' in job, false);
  assert.equal(JSON.stringify(job).includes('private intent'), false);
});

test('returns only current role schedules as prompt context', () => {
  const now = Date.parse('2026-07-17T10:30:00+08:00');
  const rows = domain.scheduleContext([
    { planId: 'work', characterId: 'char-a', type: 'role_schedule', status: 'active', title: '上班', intent: '正在工作', startedAt: now - 1800000, endsAt: now + 1800000 },
    { planId: 'cancelled', characterId: 'char-a', type: 'role_schedule', status: 'cancelled', title: '旧工作', intent: '旧工作', startedAt: now - 1000, endsAt: now + 1000 },
    { planId: 'other', characterId: 'char-b', type: 'role_schedule', status: 'active', title: '别人的日程', intent: '无关', startedAt: now - 1000, endsAt: now + 1000 }
  ], 'char-a', now);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].planId, 'work');
});

test('recurring role schedules are active only inside their current duration window', () => {
  const plans = [{
    planId: 'daily-work',
    characterId: 'char-a',
    type: 'role_schedule',
    status: 'active',
    title: '编辑部工作',
    intent: '正在编辑部处理稿件',
    schedule: { kind: 'daily', time: '09:00' },
    durationMs: 8 * 60 * 60 * 1000
  }];
  assert.equal(
    domain.scheduleContext(plans, 'char-a', Date.parse('2026-07-17T10:30:00+08:00')).length,
    1
  );
  assert.equal(
    domain.scheduleContext(plans, 'char-a', Date.parse('2026-07-17T18:30:00+08:00')).length,
    0
  );
});

test('role schedules require an explicit positive duration', () => {
  const result = domain.applyOperations([], [], [{
    op: 'create',
    type: 'role_schedule',
    source: 'private_decision',
    title: '去编辑部',
    intent: '在编辑部工作',
    schedule: { kind: 'daily', time: '09:00' },
    timeConfidence: 'explicit'
  }], {
    charId: 'char-a',
    now: Date.parse('2026-07-17T08:00:00+08:00'),
    uid: () => 'work'
  });
  assert.equal(result.rejected[0].code, 'PLAN_DURATION_REQUIRED');
});

test('role schedule state exposes its active window, next recurrence, and terminal expiry', () => {
  const daily = {
    planId: 'daily-work', type: 'role_schedule', status: 'active',
    schedule: { kind: 'daily', time: '09:00' }, durationMs: 8 * 60 * 60 * 1000
  };
  const state = domain.roleScheduleState(daily, Date.parse('2026-07-17T10:30:00+08:00'));
  assert.equal(state.active, true);
  assert.equal(state.nextRunAt, Date.parse('2026-07-18T09:00:00+08:00'));

  const once = {
    planId: 'once-work', type: 'role_schedule', status: 'active',
    schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' }, durationMs: 60 * 60 * 1000
  };
  assert.equal(
    domain.roleScheduleState(once, Date.parse('2026-07-17T11:00:00+08:00')).expired,
    true
  );
});

test('resuming a missed recurring plan advances it to a future occurrence', () => {
  const now = Date.parse('2026-07-18T10:00:00+08:00');
  const plans = [{
    planId: 'daily', characterId: 'char-a', type: 'private_message', source: 'spoken', status: 'paused',
    title: '早安', intent: '每天早安', schedule: { kind: 'daily', time: '09:00' },
    nextRunAt: Date.parse('2026-07-17T09:00:00+08:00')
  }];
  const result = domain.applyOperations(plans, [], [{ op: 'resume', planId: 'daily' }], {
    charId: 'char-a', now, uid: () => 'history-resume'
  });
  assert.equal(result.plans[0].status, 'active');
  assert.equal(result.plans[0].nextRunAt, Date.parse('2026-07-19T09:00:00+08:00'));
});

test('deletes only a terminal plan together with its history', () => {
  const plans = [
    { planId: 'done', characterId: 'char-a', type: 'private_message', status: 'completed' },
    { planId: 'active', characterId: 'char-a', type: 'private_message', status: 'active' }
  ];
  const history = [
    { historyId: 'h-done', planId: 'done', operation: 'complete' },
    { historyId: 'h-active', planId: 'active', operation: 'create' }
  ];
  const rejected = domain.applyOperations(plans, history, [{ op: 'delete', planId: 'active' }], {
    charId: 'char-a', now: 1000, uid: () => 'history-delete'
  });
  assert.equal(rejected.rejected[0].code, 'PLAN_DELETE_ACTIVE');

  const result = domain.applyOperations(plans, history, [{ op: 'delete', planId: 'done' }], {
    charId: 'char-a', now: 1000, uid: () => 'history-delete'
  });
  assert.deepEqual(result.plans.map(plan => plan.planId), ['active']);
  assert.deepEqual(result.history.map(row => row.historyId), ['h-active']);
});

test('canonical role-plan batches preflight every request and persist ordered untrimmed proofs', () => {
  assert.equal(typeof domain.applyCanonicalApplications, 'function');
  const original = [{
    planId: 'plan-a', characterId: 'char-a', type: 'private_message', source: 'spoken',
    status: 'active', title: '旧标题', intent: '晚点联系', nextRunAt: 9000, updatedAt: 1000
  }];
  const update = { op: 'update', planId: 'plan-a', patch: { title: '新标题' } };
  const pause = { op: 'pause', planId: 'plan-a', reason: '临时有事' };
  const pairs = [
    canonicalPair('action_update', 'role_plan_update', 'plan-a', update),
    canonicalPair('action_pause', 'role_plan_pause', 'plan-a', pause)
  ];
  const applied = domain.applyCanonicalApplications(original, [], pairs, {
    charId: 'char-a', now: 5000, appliedAt: 5000, uid: () => 'unused'
  });

  assert.equal(applied.plansChanged, true);
  assert.equal(applied.historyChanged, true);
  assert.equal(applied.plans[0].title, '新标题');
  assert.equal(applied.plans[0].status, 'paused');
  assert.deepEqual(Object.keys(applied.plans[0].canonicalActionApplications), ['action_update', 'action_pause']);
  assert.equal(applied.plans[0].canonicalActionApplications.action_update.appliedAt, 5000);
  assert.deepEqual(applied.history.map(row => row.historyId), ['action_update', 'action_pause']);

  const replay = domain.applyCanonicalApplications(applied.plans, applied.history, pairs, {
    charId: 'char-a', now: 9000, appliedAt: 9000, uid: () => 'unused'
  });
  assert.equal(replay.plansChanged, false);
  assert.equal(replay.historyChanged, false);
  assert.equal(replay.plans[0].canonicalActionApplications.action_update.appliedAt, 5000);

  const changed = canonicalPair('action_update', 'role_plan_update', 'plan-a', update, {
    actionChecksum: 'b'.repeat(64)
  });
  assert.throws(() => domain.applyCanonicalApplications(applied.plans, applied.history, [changed], {
    charId: 'char-a', now: 10000, appliedAt: 10000
  }), /canonical role plan authority conflict/);
  assert.throws(() => domain.applyCanonicalApplications(original, [], [pairs[0], pairs[0]], {
    charId: 'char-a', now: 5000, appliedAt: 5000
  }), /canonical role plan authority conflict/);
  assert.equal('canonicalActionApplications' in original[0], false, 'failed preflight must not mutate input plans');
});

test('canonical history is repairable but never authorizes replay without a plan ledger', () => {
  const operation = { op: 'pause', planId: 'plan-a', reason: '稍后继续' };
  const pair = canonicalPair('action_pause', 'role_plan_pause', 'plan-a', operation);
  const proof = { ...pair.request, appliedAt: 7000 };
  const provenPlan = {
    planId: 'plan-a', characterId: 'char-a', type: 'private_message', status: 'paused',
    canonicalActionApplications: { action_pause: proof }
  };
  const repaired = domain.applyCanonicalApplications([provenPlan], [], [pair], {
    charId: 'char-a', now: 9000, appliedAt: 9000
  });
  assert.equal(repaired.plansChanged, false);
  assert.equal(repaired.historyChanged, true);
  assert.equal(repaired.history[0].historyId, 'action_pause');
  assert.equal(repaired.history[0].createdAt, 7000);

  const historyOnly = structuredClone(repaired.history);
  const unprovenPlan = {
    planId: 'plan-a', characterId: 'char-a', type: 'private_message', status: 'active'
  };
  assert.throws(() => domain.applyCanonicalApplications([unprovenPlan], historyOnly, [pair], {
    charId: 'char-a', now: 10000, appliedAt: 10000
  }), /canonical role plan history conflict/, 'history alone must neither authorize nor be overwritten');
  assert.equal(unprovenPlan.status, 'active');
  assert.equal('canonicalActionApplications' in unprovenPlan, false);

  const changedHistory = [{ ...repaired.history[0], operation: 'resume' }];
  assert.throws(() => domain.applyCanonicalApplications([provenPlan], changedHistory, [pair], {
    charId: 'char-a', now: 10000, appliedAt: 10000
  }), /canonical role plan history conflict/);
});

test('legacy operations cannot inject, overwrite, or delete the canonical role-plan ledger', () => {
  const plan = {
    planId: 'plan-a', characterId: 'char-a', type: 'private_message', source: 'spoken',
    status: 'active', intent: '联系用户', nextRunAt: 9000,
    canonicalActionApplications: { action_existing: { appliedAt: 1000 } }
  };
  const create = domain.applyOperations([], [], [{
    op: 'create', planId: 'bad-create', type: 'private_message', source: 'spoken',
    intent: '不能注入', schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' },
    canonicalActionApplications: {}
  }], { charId: 'char-a', now: 1000, uid: () => 'bad-create' });
  assert.equal(create.changed, false);
  assert.equal(create.rejected[0].code, 'PLAN_LEDGER_RESERVED');

  for (const patch of [
    { canonicalActionApplications: {} },
    { canonicalActionApplications: null },
    { canonicalActionApplications: undefined }
  ]) {
    const result = domain.applyOperations([plan], [], [{ op: 'update', planId: 'plan-a', patch }], {
      charId: 'char-a', now: 2000, uid: () => 'legacy-history'
    });
    assert.equal(result.changed, false);
    assert.equal(result.rejected[0].code, 'PLAN_LEDGER_RESERVED');
    assert.deepEqual(result.plans, [plan]);
  }
});

test('canonical preparation resolves a six-operation create chain before any caller mutation', () => {
  assert.equal(typeof domain.prepareCanonicalApplications, 'function');
  const now = Date.parse('2026-07-16T20:00:00+08:00');
  const create = {
    op: 'create', planId: 'plan-new', type: 'private_message', source: 'spoken',
    title: '早安', intent: '明天发早安',
    schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' },
    timeConfidence: 'explicit'
  };
  const descriptors = [
    canonicalDescriptor('action_create', 'role_plan_create', create),
    canonicalDescriptor('action_update', 'role_plan_update', { op: 'update', planId: 'plan-new', patch: { title: '新早安' } }),
    canonicalDescriptor('action_pause', 'role_plan_pause', { op: 'pause', planId: 'plan-new', reason: '先等等' }),
    canonicalDescriptor('action_resume', 'role_plan_resume', { op: 'resume', planId: 'plan-new' }),
    canonicalDescriptor('action_complete', 'role_plan_complete', { op: 'complete', planId: 'plan-new' }),
    canonicalDescriptor('action_cancel', 'role_plan_cancel', { op: 'cancel', planId: 'plan-new', reason: '最终取消' })
  ];
  const sourcePlans = [];
  const sourceHistory = [];

  const prepared = domain.prepareCanonicalApplications(sourcePlans, sourceHistory, descriptors, {
    charId: 'char-a', now, appliedAt: now, uid: () => 'unused'
  });

  assert.deepEqual(sourcePlans, []);
  assert.deepEqual(sourceHistory, []);
  assert.deepEqual(prepared.pairs.map(pair => pair.request.planId), Array(6).fill('plan-new'));
  assert.equal(prepared.preview.plans[0].title, '新早安');
  assert.equal(prepared.preview.plans[0].status, 'cancelled');
  assert.deepEqual(Object.keys(prepared.preview.plans[0].canonicalActionApplications), descriptors.map(row => row.actionId));
  assert.deepEqual(prepared.preview.history.map(row => row.historyId), descriptors.map(row => row.actionId));
});

test('canonical preparation owns semantic create dedup and keeps the original operation JSON', () => {
  const now = Date.parse('2026-07-16T20:00:00+08:00');
  const plans = [{
    planId: 'existing', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: '早安', intent: '明天发早安',
    nextRunAt: Date.parse('2026-07-17T09:00:00+08:00')
  }];
  const operation = {
    op: 'create', planId: 'proposed', type: 'private_message', source: 'spoken', title: '发早安',
    intent: '明天发早安', schedule: { kind: 'once', at: '2026-07-17T09:02:00+08:00' },
    timeConfidence: 'explicit'
  };
  const prepared = domain.prepareCanonicalApplications(plans, [], [
    canonicalDescriptor('action_dedup', 'role_plan_create', operation)
  ], { charId: 'char-a', now, appliedAt: now });

  assert.equal(prepared.pairs[0].request.planId, 'existing');
  assert.equal(prepared.pairs[0].request.operationJson, canonicalJson(operation));
  assert.equal(prepared.preview.plans.length, 1);
  assert.equal(prepared.preview.plans[0].canonicalActionApplications.action_dedup.planId, 'existing');
});

test('canonical preparation rejects late invalid operations, foreign targets, and history-only authority without mutation', () => {
  const plans = [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }];
  const before = structuredClone(plans);
  const valid = canonicalDescriptor('action_pause', 'role_plan_pause', {
    op: 'pause', planId: 'plan-a'
  });
  const invalid = canonicalDescriptor('action_resume', 'role_plan_resume', {
    op: 'resume', planId: 'foreign'
  });
  assert.throws(() => domain.prepareCanonicalApplications(plans, [], [valid, invalid], {
    charId: 'char-a', now: 5000, appliedAt: 5000
  }), /canonical role plan operation conflict/);
  assert.deepEqual(plans, before);

  const history = [{
    historyId: 'action_pause', planId: 'plan-a', operation: 'pause',
    detailJson: canonicalJson({ op: 'pause', planId: 'plan-a' }), createdAt: 1
  }];
  assert.throws(() => domain.prepareCanonicalApplications(plans, history, [valid], {
    charId: 'char-a', now: 5000, appliedAt: 5000
  }), /canonical role plan history conflict/);
  assert.deepEqual(plans, before);
});
