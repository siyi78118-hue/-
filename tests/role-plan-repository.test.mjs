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
    async compareAndSwapRolePlanBundle(bundle) {
      const plans = structuredClone(rows.get('role_plans_v1') || []);
      const planIds = new Set(plans.filter(plan => plan.characterId === bundle.characterId).map(plan => plan.planId));
      const history = structuredClone(rows.get('role_plan_history_v1') || [])
        .filter(row => planIds.has(row.planId));
      if (canonicalScopeChecksum(plans.filter(plan => plan.characterId === bundle.characterId), history) !== bundle.expectedScopeChecksum) {
        return { status: 'stale' };
      }
      const incoming = new Set((bundle.incomingActionIds || []).filter(actionId => typeof actionId === 'string' && actionId));
      for (const plan of plans) {
        const ledger = plan?.canonicalActionApplications;
        if (plan.characterId !== bundle.characterId && ledger && typeof ledger === 'object'
          && Object.keys(ledger).some(actionId => incoming.has(actionId))) {
          throw new Error('canonical role plan authority conflict');
        }
      }
      for (const row of rows.get('role_plan_history_v1') || []) {
        if (incoming.has(row?.historyId) && !planIds.has(row?.planId)) {
          throw new Error('canonical role plan authority conflict');
        }
      }
      writes.push('canonical_role_plan_bundle');
      rows.set('role_plans_v1', [
        ...plans.filter(plan => plan.characterId !== bundle.characterId),
        ...structuredClone(bundle.plans)
      ]);
      const nextPlanIds = new Set(bundle.plans.map(plan => plan.planId));
      rows.set('role_plan_history_v1', [
        ...(rows.get('role_plan_history_v1') || []).filter(row => !planIds.has(row.planId) && !nextPlanIds.has(row.planId)),
        ...structuredClone(bundle.history)
      ]);
      return { status: 'applied' };
    },
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

function canonicalScopeChecksum(plans, history) {
  const order = rows => structuredClone(rows).sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : (leftJson > rightJson ? 1 : 0);
  });
  return canonicalJson({ plans: order(plans), history: order(history) });
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
  return {
    authoritativeTurnId: 'turn_authority_1',
    actionId,
    actionChecksum: 'a'.repeat(64),
    kind,
    targetKey: operation.op === 'create'
      ? 'lineage_create:lineage_1:role_plan_create'
      : `role_plan:${operation.planId}`,
    targetRevision: `sha256:${'b'.repeat(64)}`,
    operation: structuredClone(operation),
    ...overrides
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

test('ordinary native role-plan mutations retain the legacy bridge while canonical batches fail closed until native CAS exists', async () => {
  let plans = [{
    planId: 'native-plan', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }];
  let history = [];
  const calls = [];
  const nativePlugin = {
    async listRolePlans() { return { plans: structuredClone(plans) }; },
    async rolePlanHistory({ planId }) { return { history: structuredClone(history.filter(row => row.planId === planId)) }; },
    async replaceRolePlans(args) {
      calls.push('legacy-replace');
      plans = JSON.parse(args.plansJson);
      history = JSON.parse(args.historyJson);
    }
  };
  const repository = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, nativePlugin, metaStore: metaStore(), now: () => 5000, uid: () => 'unused'
  });
  await repository.mutate('char-a', 'native-plan', 'pause');
  assert.equal(plans[0].status, 'paused');
  assert.deepEqual(calls, ['legacy-replace']);
  await assert.rejects(repository.prepareCanonicalBatch('char-a', [canonicalDescriptor(
    'canonical-native', 'role_plan_pause', { op: 'pause', planId: 'native-plan' }
  )]), /canonical role plan CAS unavailable/);
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
  assert.deepEqual(meta.writes, ['canonical_role_plan_bundle']);
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

test('a canonical bundle failure leaves no plan ledger before replay commits it once', async () => {
  const base = metaStore();
  await base.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: '标题', intent: '联系用户', nextRunAt: 9000
  }]);
  base.writes.length = 0;
  let failBundle = true;
  const faultingMeta = {
    getMeta: base.getMeta,
    setMeta: base.setMeta,
    async compareAndSwapRolePlanBundle(bundle) {
      if (failBundle) {
        failBundle = false;
        throw new Error('forced:bundle_write');
      }
      return base.compareAndSwapRolePlanBundle(bundle);
    }
  };
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: faultingMeta, now: () => 7000, uid: () => 'unused'
  });
  const pause = { op: 'pause', planId: 'plan-a', reason: '稍后继续' };
  const pair = canonicalPair('action_pause', 'role_plan_pause', 'plan-a', pause);

  await assert.rejects(repo.applyCanonical('char-a', [pair]), /forced:bundle_write/);
  assert.equal(base.rows.get('role_plans_v1')[0].status, 'active');
  assert.equal(base.rows.get('role_plans_v1')[0].canonicalActionApplications, undefined);

  const repaired = await repo.applyCanonical('char-a', [pair]);
  assert.equal(repaired.plansChanged, true);
  assert.equal(repaired.historyChanged, true);
  assert.equal(base.rows.get('role_plans_v1')[0].canonicalActionApplications.action_pause.appliedAt, 7000);
  assert.equal(base.writes.filter(key => key === 'canonical_role_plan_bundle').length, 1);
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
    async readCanonicalRolePlanBundle() {
      return { plans: structuredClone(nativePlans), history: structuredClone(nativeHistory), allPlans: structuredClone(nativePlans), allHistory: structuredClone(nativeHistory) };
    },
    async replaceRolePlansIfUnchanged(args) {
      calls.push(structuredClone(args));
      nativePlans = JSON.parse(args.plansJson);
      nativeHistory = JSON.parse(args.historyJson);
      return { status: 'applied' };
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

test('prepared canonical batch inspects without writes and applies six actions with one plan write', async () => {
  const meta = metaStore();
  const now = Date.parse('2026-07-16T20:00:00+08:00');
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => now, uid: () => 'unused'
  });
  const create = {
    op: 'create', planId: 'plan-new', type: 'private_message', source: 'spoken', title: '早安',
    intent: '明天发早安', schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' },
    timeConfidence: 'explicit'
  };
  const descriptors = [
    canonicalDescriptor('action_create', 'role_plan_create', create),
    canonicalDescriptor('action_update', 'role_plan_update', { op: 'update', planId: 'plan-new', patch: { title: '新版' } }),
    canonicalDescriptor('action_pause', 'role_plan_pause', { op: 'pause', planId: 'plan-new' }),
    canonicalDescriptor('action_resume', 'role_plan_resume', { op: 'resume', planId: 'plan-new' }),
    canonicalDescriptor('action_complete', 'role_plan_complete', { op: 'complete', planId: 'plan-new' }),
    canonicalDescriptor('action_cancel', 'role_plan_cancel', { op: 'cancel', planId: 'plan-new' })
  ];

  assert.equal(typeof repo.prepareCanonicalBatch, 'function');
  assert.equal(typeof repo.inspectPreparedCanonicalBatch, 'function');
  assert.equal(typeof repo.applyPreparedCanonicalBatch, 'function');
  const prepared = await repo.prepareCanonicalBatch('char-a', descriptors);
  const inspected = await repo.inspectPreparedCanonicalBatch(prepared);
  assert.deepEqual(JSON.parse(JSON.stringify(inspected.proofs)), {});
  assert.equal(meta.writes.length, 0);

  const applied = await repo.applyPreparedCanonicalBatch(prepared);
  assert.deepEqual(Object.keys(applied.proofs), descriptors.map(row => row.actionId));
  assert.equal(meta.writes.filter(key => key === 'canonical_role_plan_bundle').length, 1);
  assert.equal(meta.rows.get('role_plans_v1')[0].status, 'cancelled');
  assert.deepEqual(meta.rows.get('role_plan_history_v1').map(row => row.historyId), descriptors.map(row => row.actionId));
});

test('prepared canonical batch fails closed when plan or history state changes before apply', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }]);
  meta.writes.length = 0;
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 5000, uid: () => 'unused'
  });
  const descriptor = canonicalDescriptor('action_pause', 'role_plan_pause', {
    op: 'pause', planId: 'plan-a'
  });
  const prepared = await repo.prepareCanonicalBatch('char-a', [descriptor]);
  const changed = structuredClone(meta.rows.get('role_plans_v1'));
  changed[0].title = 'concurrent';
  meta.rows.set('role_plans_v1', changed);

  await assert.rejects(repo.applyPreparedCanonicalBatch(prepared), /canonical role plan prepared state conflict/);
  assert.equal(meta.writes.length, 0);
  assert.equal(meta.rows.get('role_plans_v1')[0].status, 'active');
});

test('prepared batch rolls back an atomic bundle failure before a replay commits once', async () => {
  const base = metaStore();
  await base.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }]);
  base.writes.length = 0;
  let failBundle = true;
  const meta = {
    getMeta: base.getMeta,
    setMeta: base.setMeta,
    async compareAndSwapRolePlanBundle(bundle) {
      if (failBundle) {
        failBundle = false;
        throw new Error('forced:prepared_bundle');
      }
      return base.compareAndSwapRolePlanBundle(bundle);
    }
  };
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 6000, uid: () => 'unused'
  });
  const descriptor = canonicalDescriptor('action_pause', 'role_plan_pause', {
    op: 'pause', planId: 'plan-a'
  });

  const first = await repo.prepareCanonicalBatch('char-a', [descriptor]);
  await assert.rejects(repo.applyPreparedCanonicalBatch(first), /forced:prepared_bundle/);
  assert.equal(base.rows.get('role_plans_v1')[0].status, 'active');
  assert.equal(base.rows.get('role_plan_history_v1'), undefined);

  const replay = await repo.prepareCanonicalBatch('char-a', [descriptor]);
  const repaired = await repo.applyPreparedCanonicalBatch(replay);
  assert.equal(repaired.proofs.action_pause.appliedAt, 6000);
  assert.equal(base.writes.filter(key => key === 'canonical_role_plan_bundle').length, 1);
  assert.equal(base.rows.get('role_plan_history_v1')[0].historyId, 'action_pause');
});

test('native prepared batch replaces plans and history exactly once with every proof', async () => {
  let plans = [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }];
  let history = [];
  const replacements = [];
  const nativePlugin = {
    async readCanonicalRolePlanBundle() {
      return { plans: structuredClone(plans), history: structuredClone(history), allPlans: structuredClone(plans), allHistory: structuredClone(history) };
    },
    async replaceRolePlansIfUnchanged(args) {
      replacements.push(structuredClone(args));
      plans = JSON.parse(args.plansJson);
      history = JSON.parse(args.historyJson);
      return { status: 'applied' };
    }
  };
  const repo = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, nativePlugin, metaStore: metaStore(), now: () => 7000, uid: () => 'unused'
  });
  const descriptors = [
    canonicalDescriptor('action_update', 'role_plan_update', { op: 'update', planId: 'plan-a', patch: { title: 'B' } }),
    canonicalDescriptor('action_pause', 'role_plan_pause', { op: 'pause', planId: 'plan-a' })
  ];
  const prepared = await repo.prepareCanonicalBatch('char-a', descriptors);
  const applied = await repo.applyPreparedCanonicalBatch(prepared);

  assert.equal(replacements.length, 1);
  assert.deepEqual(replacements[0].incomingActionIds, ['action_update', 'action_pause']);
  assert.deepEqual(Object.keys(applied.proofs), ['action_update', 'action_pause']);
  assert.deepEqual(Object.keys(plans[0].canonicalActionApplications), ['action_update', 'action_pause']);
  assert.deepEqual(history.map(row => row.historyId), ['action_update', 'action_pause']);
});

test('overlapping canonical batches commit one bundle and leave the stale caller with zero writes', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'before', intent: 'A', nextRunAt: 9000
  }]);
  const repository = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 5000, uid: () => 'unused'
  });
  const first = await repository.prepareCanonicalBatch('char-a', [canonicalDescriptor(
    'action-first', 'role_plan_update', { op: 'update', planId: 'plan-a', patch: { title: 'first' } }
  )]);
  const second = await repository.prepareCanonicalBatch('char-a', [canonicalDescriptor(
    'action-second', 'role_plan_update', { op: 'update', planId: 'plan-a', patch: { title: 'second' } }
  )]);
  const [left, right] = await Promise.allSettled([
    repository.applyPreparedCanonicalBatch(first),
    repository.applyPreparedCanonicalBatch(second)
  ]);
  assert.equal([left, right].filter(row => row.status === 'fulfilled').length, 1);
  assert.equal([left, right].filter(row => row.status === 'rejected').length, 1);
  assert.match(String([left, right].find(row => row.status === 'rejected').reason), /canonical role plan prepared state conflict/);
  const plan = meta.rows.get('role_plans_v1')[0];
  const history = meta.rows.get('role_plan_history_v1');
  assert.equal(Object.keys(plan.canonicalActionApplications).length, 1);
  assert.equal(history.length, 1);
  const stale = left.status === 'rejected' ? first : second;
  const rebuilt = await repository.prepareCanonicalBatch('char-a', stale.pairs.map(pair => ({
    authoritativeTurnId: pair.request.authoritativeTurnId,
    actionId: pair.request.actionId,
    actionChecksum: pair.request.actionChecksum,
    kind: pair.request.kind,
    targetKey: `role_plan:${pair.request.planId}`,
    targetRevision: `sha256:${'b'.repeat(64)}`,
    operation: JSON.parse(pair.request.operationJson)
  })));
  await repository.applyPreparedCanonicalBatch(rebuilt);
  assert.equal(Object.keys(meta.rows.get('role_plans_v1')[0].canonicalActionApplications).length, 2);
  assert.equal(meta.rows.get('role_plan_history_v1').length, 2);
});

test('canonical batches reject a global action id already owned by another character', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }, {
    planId: 'plan-b', characterId: 'char-b', status: 'active', type: 'private_message',
    source: 'spoken', title: 'B', intent: 'B', nextRunAt: 9000,
    canonicalActionApplications: {
      reused_action: {
        version: 1, authoritativeTurnId: 'turn-old', actionId: 'reused_action',
        actionChecksum: 'a'.repeat(64), kind: 'role_plan_update', planId: 'plan-b',
        operationJson: '{"op":"update","patch":{"title":"B"},"planId":"plan-b"}', appliedAt: 4000
      }
    }
  }]);
  const repository = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 5000, uid: () => 'unused'
  });
  const before = structuredClone(meta.rows.get('role_plans_v1'));
  await assert.rejects(repository.prepareCanonicalBatch('char-a', [canonicalDescriptor(
    'reused_action', 'role_plan_update', { op: 'update', planId: 'plan-a', patch: { title: 'changed' } }
  )]), /canonical role plan authority conflict/);
  assert.deepEqual(meta.rows.get('role_plans_v1'), before);
});

test('concurrent foreign canonical action claims allow only one character to commit', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }, {
    planId: 'plan-b', characterId: 'char-b', status: 'active', type: 'private_message',
    source: 'spoken', title: 'B', intent: 'B', nextRunAt: 9000
  }]);
  const repository = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 5000, uid: () => 'unused'
  });
  const actionId = 'action_global_race';
  const [preparedA, preparedB] = await Promise.all([
    repository.prepareCanonicalBatch('char-a', [canonicalDescriptor(
      actionId, 'role_plan_update', { op: 'update', planId: 'plan-a', patch: { title: 'A won' } }
    )]),
    repository.prepareCanonicalBatch('char-b', [canonicalDescriptor(
      actionId, 'role_plan_update', { op: 'update', planId: 'plan-b', patch: { title: 'B won' } }
    )])
  ]);
  const beforeWrites = meta.writes.length;
  const outcomes = await Promise.allSettled([
    repository.applyPreparedCanonicalBatch(preparedA),
    repository.applyPreparedCanonicalBatch(preparedB)
  ]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(row => row.status === 'rejected').length, 1);
  assert.match(String(outcomes.find(row => row.status === 'rejected').reason), /canonical role plan authority conflict/);
  assert.equal(meta.writes.length, beforeWrites + 1);
  const ledgers = meta.rows.get('role_plans_v1')
    .flatMap(plan => Object.keys(plan.canonicalActionApplications || {}));
  assert.deepEqual(ledgers, [actionId]);
  assert.deepEqual(meta.rows.get('role_plan_history_v1').map(row => row.historyId), [actionId]);
});

test('concurrent canonical batches for different characters retain distinct global action ids', async () => {
  const meta = metaStore();
  await meta.setMeta('role_plans_v1', [{
    planId: 'plan-a', characterId: 'char-a', status: 'active', type: 'private_message',
    source: 'spoken', title: 'A', intent: 'A', nextRunAt: 9000
  }, {
    planId: 'plan-b', characterId: 'char-b', status: 'active', type: 'private_message',
    source: 'spoken', title: 'B', intent: 'B', nextRunAt: 9000
  }]);
  const repository = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, metaStore: meta, now: () => 5000, uid: () => 'unused'
  });
  const [preparedA, preparedB] = await Promise.all([
    repository.prepareCanonicalBatch('char-a', [canonicalDescriptor(
      'action_a', 'role_plan_update', { op: 'update', planId: 'plan-a', patch: { title: 'A won' } }
    )]),
    repository.prepareCanonicalBatch('char-b', [canonicalDescriptor(
      'action_b', 'role_plan_update', { op: 'update', planId: 'plan-b', patch: { title: 'B won' } }
    )])
  ]);
  await Promise.all([
    repository.applyPreparedCanonicalBatch(preparedA),
    repository.applyPreparedCanonicalBatch(preparedB)
  ]);
  const actionIds = meta.rows.get('role_plans_v1')
    .flatMap(plan => Object.keys(plan.canonicalActionApplications || {})).sort();
  assert.deepEqual(actionIds, ['action_a', 'action_b']);
  assert.deepEqual(meta.rows.get('role_plan_history_v1').map(row => row.historyId).sort(), ['action_a', 'action_b']);
});

test('canonical native batches fail closed unless the bundle exposes the full global authority set', async () => {
  const nativePlugin = {
    async readCanonicalRolePlanBundle() { return { plans: [], history: [] }; },
    async replaceRolePlansIfUnchanged() { throw new Error('must not write'); }
  };
  const repository = context.ALRolePlanRepository.create({
    domain: context.ALRolePlans, nativePlugin, metaStore: metaStore(), now: () => 5000, uid: () => 'unused'
  });
  await assert.rejects(repository.prepareCanonicalBatch('char-a', [canonicalDescriptor(
    'action_native_closed', 'role_plan_create', { op: 'create', title: 'A', intent: 'A', type: 'private_message', nextRunAt: 9000 }
  )]), /canonical role plan CAS unavailable/);
});
