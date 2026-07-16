(function initRolePlanRepository(root) {
  'use strict';

  const PLANS_KEY = 'role_plans_v1';
  const HISTORY_KEY = 'role_plan_history_v1';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function create(options = {}) {
    const domain = options.domain;
    const nativePlugin = options.nativePlugin || null;
    const metaStore = options.metaStore;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const uid = typeof options.uid === 'function'
      ? options.uid
      : () => `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!domain) throw new Error('role plan domain is required');
    if (!metaStore?.getMeta || !metaStore?.setMeta) throw new Error('role plan meta store is required');

    async function allPlans() {
      return clone(await metaStore.getMeta(PLANS_KEY, [])) || [];
    }

    async function allHistory() {
      return clone(await metaStore.getMeta(HISTORY_KEY, [])) || [];
    }

    async function list(characterId, listOptions = {}) {
      if (nativePlugin?.listRolePlans) {
        const page = await nativePlugin.listRolePlans({ characterId, includeTerminal: listOptions.includeTerminal !== false });
        return Array.isArray(page?.plans) ? page.plans : [];
      }
      const rows = await allPlans();
      return rows
        .filter(plan => plan.characterId === characterId)
        .filter(plan => listOptions.includeTerminal !== false || !['completed', 'cancelled'].includes(plan.status))
        .sort((left, right) => Number(left.nextRunAt || Number.MAX_SAFE_INTEGER) - Number(right.nextRunAt || Number.MAX_SAFE_INTEGER));
    }

    async function replace(characterId, plans, history) {
      if (nativePlugin?.replaceRolePlans) {
        await nativePlugin.replaceRolePlans({
          characterId,
          plansJson: JSON.stringify(plans),
          historyJson: JSON.stringify(history)
        });
        return;
      }
      const existingPlans = await allPlans();
      const existingHistory = await allHistory();
      await metaStore.setMeta(PLANS_KEY, [
        ...existingPlans.filter(plan => plan.characterId !== characterId),
        ...plans
      ]);
      const changedPlanIds = new Set(plans.map(plan => plan.planId));
      await metaStore.setMeta(HISTORY_KEY, [
        ...existingHistory.filter(row => !changedPlanIds.has(row.planId)),
        ...history
      ]);
    }

    async function history(planId, limit = 100) {
      if (nativePlugin?.rolePlanHistory) {
        const page = await nativePlugin.rolePlanHistory({ planId, limit });
        return Array.isArray(page?.history) ? page.history : [];
      }
      return (await allHistory())
        .filter(row => row.planId === planId)
        .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
        .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)));
    }

    async function apply(characterId, operations) {
      const plans = await list(characterId, { includeTerminal: true });
      const planIds = new Set(plans.map(plan => plan.planId));
      const historyRows = nativePlugin?.rolePlanHistory
        ? (await Promise.all([...planIds].map(planId => history(planId, 200)))).flat()
        : (await allHistory()).filter(row => planIds.has(row.planId));
      const result = domain.applyOperations(plans, historyRows, operations, {
        charId: characterId,
        now: now(),
        uid
      });
      if (result.changed) await replace(characterId, result.plans, result.history);
      return result;
    }

    async function mutate(characterId, planId, action, patch = {}) {
      return apply(characterId, [{ op: action, planId, ...clone(patch) }]);
    }

    async function scheduleContext(characterId, at = now()) {
      const rows = domain.scheduleContext(await list(characterId, { includeTerminal: false }), characterId, at);
      if (!rows.length) return '';
      return `当前角色日程：\n${rows.map(row => `${row.title || '日程'}：${row.intent || ''}`).join('\n')}`;
    }

    async function reconcile(characterId) {
      return list(characterId, { includeTerminal: true });
    }

    return { list, apply, mutate, replace, history, scheduleContext, reconcile };
  }

  root.ALRolePlanRepository = { create, PLANS_KEY, HISTORY_KEY };
})(typeof globalThis !== 'undefined' ? globalThis : self);
