import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

process.env.TZ = 'Asia/Shanghai';
const context = vm.createContext({ Date, Math, JSON, Set, String, Number, structuredClone });
vm.runInContext(readFileSync(new URL('../tavern-app/lib/role-plan-domain.js', import.meta.url), 'utf8'), context);
const repositoryPath = new URL('../tavern-app/lib/role-plan-repository.js', import.meta.url);
try { vm.runInContext(readFileSync(repositoryPath, 'utf8'), context); } catch {}

function metaStore() {
  const rows = new Map();
  const writes = [];
  return {
    async getMeta(key, fallback) { return rows.has(key) ? structuredClone(rows.get(key)) : fallback; },
    async setMeta(key, value) { writes.push(key); rows.set(key, structuredClone(value)); },
    rows,
    writes
  };
}

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

test('persists plans and history in IndexedDB meta fallback', async () => {
  assert.ok(context.ALRolePlanRepository, 'ALRolePlanRepository should be exported');
  const meta = metaStore();
  const repo = context.ALRolePlanRepository.create({ domain: context.ALRolePlans, metaStore: meta, now: () => Date.parse('2026-07-16T20:00:00+08:00'), uid: () => 'plan-a' });

  await repo.apply('char-a', [{
    op: 'create', type: 'role_schedule', source: 'user_created', origin: 'user',
    title: '上班', intent: '正在工作', schedule: { kind: 'once', at: '2026-07-17T10:00:00+08:00' },
    durationMs: 8 * 60 * 60 * 1000, timeConfidence: 'explicit'
  }]);

  assert.equal((await repo.list('char-a')).length, 1);
  assert.equal((await repo.history('plan-a')).length, 1);
  assert.equal(meta.rows.has('role_plans_v1'), true);
  assert.equal(JSON.stringify(meta.rows).includes('apiKey'), false);
});

test('mutates an existing plan without touching neighboring plans', async () => {
  const meta = metaStore();
  let id = 0;
  const repo = context.ALRolePlanRepository.create({ domain: context.ALRolePlans, metaStore: meta, now: () => 1000, uid: () => `id-${++id}` });
  await meta.setMeta('role_plans_v1', [
    { planId: 'a', characterId: 'char-a', status: 'active', type: 'private_message', title: 'A', intent: 'A', nextRunAt: 2000 },
    { planId: 'b', characterId: 'char-a', status: 'active', type: 'private_message', title: 'B', intent: 'B', nextRunAt: 3000 }
  ]);

  await repo.mutate('char-a', 'a', 'cancel', { reason: '明确取消' });

  const plans = await repo.list('char-a');
  assert.equal(plans.find(plan => plan.planId === 'a').status, 'cancelled');
  assert.equal(plans.find(plan => plan.planId === 'b').status, 'active');
});

test('uses the native bridge as authoritative when available', async () => {
  const calls = [];
  const nativePlugin = {
    async listRolePlans(args) { calls.push(['list', args]); return { plans: [{ planId: 'native', characterId: args.characterId, status: 'active' }] }; },
    async replaceRolePlans(args) { calls.push(['replace', args]); return { saved: true }; },
    async rolePlanHistory() { return { history: [] }; }
  };
  const repo = context.ALRolePlanRepository.create({ domain: context.ALRolePlans, nativePlugin, metaStore: metaStore(), now: () => 1000, uid: () => 'id' });

  const plans = await repo.list('char-a');

  assert.equal(plans[0].planId, 'native');
  assert.equal(calls[0][0], 'list');
});

test('formats current role schedules for the prompt', async () => {
  const meta = metaStore();
  const now = Date.parse('2026-07-17T10:30:00+08:00');
  await meta.setMeta('role_plans_v1', [{
    planId: 'work', characterId: 'char-a', status: 'active', type: 'role_schedule',
    title: '上班', intent: '正在公司工作', startedAt: now - 1000, endsAt: now + 1000
  }]);
  const repo = context.ALRolePlanRepository.create({ domain: context.ALRolePlans, metaStore: meta, now: () => now, uid: () => 'id' });

  assert.match(await repo.scheduleContext('char-a', now), /上班：正在公司工作/);
});

test('canonical batches write plan state and all action proofs once before repairing history', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: '旧标题', intent: '联系用户', nextRunAt: 9000
  }]);
  meta.writes.length = 0;
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 5000, uid: () => 'unused'
  });
  assert.equal(typeof repo.applyCanonical, 'function');
  const update = { op: 'update', planId: 'plan-a', patch: { title: '新标题' } };
  const pause = { op: 'pause', planId: 'plan-a', reason: '稍后继续' };
  const pairs = [
    canonicalPair('action_update', 'role_plan_update', 'plan-a', update),
    canonicalPair('action_pause', 'role_plan_pause', 'plan-a', pause)
  ];

  const applied = await repo.applyCanonical('char-a', pairs);
  assert.equal(applied.plansChanged, true);
  assert.deepEqual(meta.writes, ['role_plans_v1', 'role_plan_history_v1']);
  const stored = meta.rows.get('role_plans_v1')[0];
  assert.equal(stored.title, '新标题');
  assert.equal(stored.status, 'paused');
  assert.deepEqual(Object.keys(stored.canonicalActionApplications), ['action_update', 'action_pause']);
  assert.deepEqual(meta.rows.get('role_plan_history_v1').map(row => row.historyId), ['action_update', 'action_pause']);

  const writeCount = meta.writes.length;
  const replay = await repo.applyCanonical('char-a', pairs);
  assert.equal(replay.plansChanged, false);
  assert.equal(replay.historyChanged, false);
  assert.equal(meta.writes.length, writeCount);

  const changed = canonicalPair('action_update', 'role_plan_update', 'plan-a', update, {
    actionChecksum: 'b'.repeat(64)
  });
  await assert.rejects(repo.applyCanonical('char-a', [changed]), /canonical role plan authority conflict/);
  assert.equal(meta.writes.length, writeCount);
});

test('a history-write crash is repaired from the plan ledger without reapplying the operation', async () => {
  const base = metaStore();
  await base.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: '标题', intent: '联系用户', nextRunAt: 9000
  }]);
  base.writes.length = 0;
  let failHistory = true;
  const faultingMeta = {
    getMeta: base.getMeta,
    async setMeta(key, value) {
      if (key === 'role_plan_history_v1' && failHistory) {
        failHistory = false;
        throw new Error('forced:history_write');
      }
      return base.setMeta(key, value);
    }
  };
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: faultingMeta, now: () => 7000, uid: () => 'unused'
  });
  const pause = { op: 'pause', planId: 'plan-a', reason: '稍后继续' };
  const pair = canonicalPair('action_pause', 'role_plan_pause', 'plan-a', pause);

  await assert.rejects(repo.applyCanonical('char-a', [pair]), /forced:history_write/);
  const afterCrash = structuredClone(base.rows.get('role_plans_v1')[0]);
  assert.equal(afterCrash.status, 'paused');
  assert.equal(afterCrash.canonicalActionApplications.action_pause.appliedAt, 7000);
  assert.equal(base.writes.filter(key => key === 'role_plans_v1').length, 1);

  const repaired = await repo.applyCanonical('char-a', [pair]);
  assert.equal(repaired.plansChanged, false);
  assert.equal(repaired.historyChanged, true);
  assert.deepEqual(base.rows.get('role_plans_v1')[0], afterCrash);
  assert.equal(base.writes.filter(key => key === 'role_plans_v1').length, 1);
  assert.equal(base.rows.get('role_plan_history_v1')[0].historyId, 'action_pause');
});

test('canonical create dedup records proof on the reused plan and native replacement keeps proof with history', async () => {
  let nativePlans = [{
    planId: 'existing', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: '早安', intent: '明天发早安',
    nextRunAt: Date.parse('2026-07-17T09:00:00+08:00')
  }];
  let nativeHistory = [];
  const calls = [];
  const nativePlugin = {
    async listRolePlans() { return { plans: structuredClone(nativePlans) }; },
    async rolePlanHistory({ planId }) {
      return { history: structuredClone(nativeHistory.filter(row => row.planId === planId)) };
    },
    async replaceRolePlans(args) {
      calls.push(structuredClone(args));
      nativePlans = JSON.parse(args.plansJson);
      nativeHistory = JSON.parse(args.historyJson);
      return { saved: true };
    }
  };
  const now = Date.parse('2026-07-16T20:00:00+08:00');
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, nativePlugin, metaStore: metaStore(), now: () => now, uid: () => 'new-plan'
  });
  const create = {
    op: 'create', planId: 'new-plan', type: 'private_message', source: 'spoken', title: '发早安',
    intent: '明天发早安', schedule: { kind: 'once', at: '2026-07-17T09:02:00+08:00' },
    timeConfidence: 'explicit'
  };
  const pair = canonicalPair('action_create', 'role_plan_create', 'existing', create);

  await repo.applyCanonical('char-a', [pair]);
  assert.equal(calls.length, 1);
  assert.equal(nativePlans.length, 1);
  assert.equal(nativePlans[0].planId, 'existing');
  assert.equal(nativePlans[0].canonicalActionApplications.action_create.planId, 'existing');
  assert.equal(nativeHistory[0].historyId, 'action_create');
  assert.equal(JSON.parse(calls[0].plansJson)[0].canonicalActionApplications.action_create.actionId, 'action_create');
  assert.equal(JSON.parse(calls[0].historyJson)[0].historyId, 'action_create');
});

test('legacy repository calls reject reserved ledger injection without a meta write', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', intent: '联系用户', nextRunAt: 9000,
    canonicalActionApplications: { action_existing: { appliedAt: 1000 } }
  }]);
  meta.writes.length = 0;
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 2000, uid: () => 'unused'
  });

  const result = await repo.apply('char-a', [{
    op: 'update', planId: 'plan-a', patch: { canonicalActionApplications: null }
  }]);
  assert.equal(result.changed, false);
  assert.equal(result.rejected[0].code, 'PLAN_LEDGER_RESERVED');
  assert.equal(meta.writes.length, 0);
});

test('canonical create preflights an orphan history row for its requested plan before any write', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plan_history_v1', [{
    historyId: 'action_create_orphan',
    planId: 'new-plan',
    operation: 'create',
    detailJson: '{"forged":true}',
    createdAt: 1
  }]);
  meta.writes.length = 0;
  const now = Date.parse('2026-07-16T20:00:00+08:00');
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => now, uid: () => 'new-plan'
  });
  const operation = {
    op: 'create',
    planId: 'new-plan',
    type: 'private_message',
    source: 'spoken',
    title: '早安',
    intent: '明天发早安',
    schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' },
    timeConfidence: 'explicit'
  };

  await assert.rejects(repo.applyCanonical('char-a', [
    canonicalPair('action_create_orphan', 'role_plan_create', 'new-plan', operation)
  ]), /canonical role plan history conflict/);
  assert.equal(meta.writes.length, 0);
  assert.equal(meta.rows.has('role_plans_v1'), false);
  assert.equal(meta.rows.get('role_plan_history_v1')[0].detailJson, '{"forged":true}');
});
