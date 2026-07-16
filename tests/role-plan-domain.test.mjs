import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

process.env.TZ = 'Asia/Shanghai';

const domainPath = new URL('../tavern-app/lib/role-plan-domain.js', import.meta.url);
const context = vm.createContext({ structuredClone, Date, Math, JSON, Set, String, Number });
if (existsSync(domainPath)) vm.runInContext(readFileSync(domainPath, 'utf8'), context);
const domain = context.ALRolePlans;

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
