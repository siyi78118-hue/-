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
  return {
    async getMeta(key, fallback) { return rows.has(key) ? structuredClone(rows.get(key)) : fallback; },
    async setMeta(key, value) { rows.set(key, structuredClone(value)); },
    rows
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
