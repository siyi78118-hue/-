(function initRolePlanRepository(root) {
  'use strict';

  const PLANS_KEY = 'role_plans_v1';
  const HISTORY_KEY = 'role_plan_history_v1';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function snapshot(value) {
    return JSON.stringify(value);
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function canonicalRows(rows) {
    return clone(Array.isArray(rows) ? rows : [])
      .sort((left, right) => {
        const leftJson = canonicalJson(left);
        const rightJson = canonicalJson(right);
        return leftJson < rightJson ? -1 : (leftJson > rightJson ? 1 : 0);
      });
  }

  function scopeChecksum(plans, history) {
    return canonicalJson({ plans: canonicalRows(plans), history: canonicalRows(history) });
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
      if (nativePlugin && typeof nativePlugin.readCanonicalRolePlanBundle !== 'function') {
        if (typeof nativePlugin.replaceRolePlans !== 'function') {
          throw new Error('role plan native repository conflict');
        }
        await nativePlugin.replaceRolePlans({
          characterId,
          plansJson: JSON.stringify(plans),
          historyJson: JSON.stringify(history)
        });
        return;
      }
      const requestedIds = new Set((Array.isArray(plans) ? plans : [])
        .map(plan => plan?.planId).filter(Boolean));
      const scope = await readCanonicalScope(characterId, requestedIds);
      await compareAndSwapCanonicalScope(scope, plans, history, []);
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
      if (nativePlugin && typeof nativePlugin.readCanonicalRolePlanBundle !== 'function') {
        const plans = await list(characterId, { includeTerminal: true });
        const planIds = new Set(plans.map(plan => plan.planId));
        const historyRows = (await Promise.all([...planIds].map(planId => history(planId, 200)))).flat();
        const result = domain.applyOperations(plans, historyRows, operations, {
          charId: characterId,
          now: now(),
          uid
        });
        if (result.changed) await replace(characterId, result.plans, result.history);
        return result;
      }
      const scope = await readCanonicalScope(characterId);
      const result = domain.applyOperations(scope.plans, scope.historyRows, operations, {
        charId: characterId,
        now: now(),
        uid
      });
      if (result.changed) await compareAndSwapCanonicalScope(scope, result.plans, result.history, []);
      return result;
    }

    async function applyCanonical(characterId, orderedPairs) {
      const scope = await readCanonicalScope(characterId, pairPlanIds(orderedPairs));
      assertNoForeignCanonicalActionOwners(scope, (Array.isArray(orderedPairs) ? orderedPairs : [])
        .map(pair => pair?.request?.actionId));
      const appliedAt = Number(now());
      const result = domain.applyCanonicalApplications(scope.plans, scope.historyRows, orderedPairs, {
        charId: characterId,
        now: appliedAt,
        appliedAt,
        uid
      });
      if (!result.plansChanged && !result.historyChanged) return result;
      await compareAndSwapCanonicalScope(scope, result.plans, result.history, (Array.isArray(orderedPairs) ? orderedPairs : [])
        .map(pair => pair?.request?.actionId));
      return result;
    }

    function pairPlanIds(pairs) {
      const ids = new Set();
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        if (typeof pair?.request?.planId === 'string' && pair.request.planId) ids.add(pair.request.planId);
        try {
          const operation = JSON.parse(pair?.request?.operationJson || 'null');
          if (typeof operation?.planId === 'string' && operation.planId) ids.add(operation.planId);
        } catch {}
      }
      return ids;
    }

    function descriptorPlanIds(descriptors) {
      return new Set((Array.isArray(descriptors) ? descriptors : [])
        .map(row => row?.operation?.planId)
        .filter(planId => typeof planId === 'string' && planId));
    }

    function assertNoForeignCanonicalActionOwners(scope, actionIds) {
      const incoming = new Set(actionIds || []);
      const localPlanIds = new Set([
        ...scope.plans.map(plan => plan.planId),
        ...(scope.requestedPlanIds || [])
      ]);
      for (const plan of scope.allPlanRows) {
        const ledger = plan?.canonicalActionApplications;
        if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) continue;
        for (const actionId of Object.keys(ledger)) {
          if (incoming.has(actionId) && plan.characterId !== scope.characterId) {
            throw new Error('canonical role plan authority conflict');
          }
        }
      }
      for (const row of scope.allHistoryRows) {
        if (incoming.has(row?.historyId) && !localPlanIds.has(row.planId)) {
          throw new Error('canonical role plan authority conflict');
        }
      }
    }

    async function readCanonicalScope(characterId, requestedIds = new Set()) {
      if (nativePlugin) {
        if (typeof nativePlugin.readCanonicalRolePlanBundle !== 'function') {
          throw new Error('canonical role plan CAS unavailable');
        }
        const bundle = await nativePlugin.readCanonicalRolePlanBundle({
          characterId,
          requestedPlanIds: [...requestedIds]
        });
        if (!Array.isArray(bundle?.plans) || !Array.isArray(bundle?.history)
          || !Array.isArray(bundle?.allPlans) || !Array.isArray(bundle?.allHistory)) {
          throw new Error('canonical role plan CAS unavailable');
        }
        const scope = {
          characterId,
          requestedPlanIds: [...requestedIds],
          plans: clone(bundle.plans),
          historyRows: clone(bundle.history),
          allPlanRows: clone(bundle.allPlans),
          allHistoryRows: clone(bundle.allHistory)
        };
        scope.scopeChecksum = scopeChecksum(scope.plans, scope.historyRows);
        return scope;
      }
      const allPlanRows = await allPlans();
      const plans = allPlanRows.filter(plan => plan.characterId === characterId);
      const planIds = new Set([...plans.map(plan => plan.planId), ...requestedIds]);
      const allHistoryRows = await allHistory();
      const historyRows = allHistoryRows.filter(row => planIds.has(row.planId));
      return {
        characterId,
        requestedPlanIds: [...requestedIds],
        allPlanRows,
        plans,
        allHistoryRows,
        historyRows,
        scopeChecksum: scopeChecksum(plans, historyRows)
      };
    }

    async function compareAndSwapCanonicalScope(scope, plans, historyRows, incomingActionIds = []) {
      if (nativePlugin) {
        if (typeof nativePlugin.replaceRolePlansIfUnchanged !== 'function') {
          throw new Error('canonical role plan CAS unavailable');
        }
        const result = await nativePlugin.replaceRolePlansIfUnchanged({
          characterId: scope.characterId,
          requestedPlanIds: clone(scope.requestedPlanIds || []),
          expectedScopeChecksum: scope.scopeChecksum,
          incomingActionIds: clone(incomingActionIds),
          plansJson: JSON.stringify(plans),
          historyJson: JSON.stringify(historyRows)
        });
        if (result?.status === 'stale') throw new Error('canonical role plan prepared state conflict');
        if (result?.status !== 'applied') throw new Error('canonical role plan CAS unavailable');
        return;
      }
      if (typeof metaStore.compareAndSwapRolePlanBundle !== 'function') {
        throw new Error('canonical role plan CAS unavailable');
      }
      const result = await metaStore.compareAndSwapRolePlanBundle({
        characterId: scope.characterId,
        requestedPlanIds: clone(scope.requestedPlanIds || []),
        expectedScopeChecksum: scope.scopeChecksum,
        incomingActionIds: clone(incomingActionIds),
        plans: clone(plans),
        history: clone(historyRows)
      });
      if (result?.status === 'stale') throw new Error('canonical role plan prepared state conflict');
      if (result?.status !== 'applied') throw new Error('canonical role plan CAS unavailable');
    }

    async function prepareCanonicalBatch(characterId, descriptors) {
      const appliedAt = Number(now());
      if (!Number.isSafeInteger(appliedAt) || appliedAt <= 0) {
        throw new Error('canonical role plan prepared state conflict');
      }
      const scope = await readCanonicalScope(characterId, descriptorPlanIds(descriptors));
      assertNoForeignCanonicalActionOwners(scope, (Array.isArray(descriptors) ? descriptors : []).map(row => row?.actionId));
      const prepared = domain.prepareCanonicalApplications(scope.plans, scope.historyRows, descriptors, {
        charId: characterId,
        now: appliedAt,
        appliedAt,
        uid
      });
      return {
        characterId,
        appliedAt,
        pairs: clone(prepared.pairs),
        scopeChecksum: scope.scopeChecksum
      };
    }

    function validatePrepared(prepared) {
      if (!prepared || typeof prepared !== 'object'
        || Array.isArray(prepared)
        || typeof prepared.characterId !== 'string'
        || !prepared.characterId
        || !Number.isSafeInteger(prepared.appliedAt)
        || prepared.appliedAt <= 0
        || !Array.isArray(prepared.pairs)
        || typeof prepared.scopeChecksum !== 'string'
        || !prepared.scopeChecksum) {
        throw new Error('canonical role plan prepared state conflict');
      }
    }

    async function currentPreparedScope(prepared) {
      validatePrepared(prepared);
      const scope = await readCanonicalScope(prepared.characterId, pairPlanIds(prepared.pairs));
      assertNoForeignCanonicalActionOwners(scope, prepared.pairs.map(pair => pair?.request?.actionId));
      if (scope.scopeChecksum !== prepared.scopeChecksum) {
        throw new Error('canonical role plan prepared state conflict');
      }
      return scope;
    }

    async function inspectPreparedCanonicalBatch(prepared) {
      const scope = await currentPreparedScope(prepared);
      return domain.inspectCanonicalApplications(scope.plans, scope.historyRows, prepared.pairs);
    }

    async function applyPreparedCanonicalBatch(prepared) {
      const scope = await currentPreparedScope(prepared);
      const result = domain.applyCanonicalApplications(scope.plans, scope.historyRows, prepared.pairs, {
        charId: prepared.characterId,
        now: prepared.appliedAt,
        appliedAt: prepared.appliedAt,
        uid
      });
      if (!result.plansChanged && !result.historyChanged) return result;
      await compareAndSwapCanonicalScope(scope, result.plans, result.history,
        prepared.pairs.map(pair => pair?.request?.actionId));
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

    return {
      list,
      apply,
      applyCanonical,
      prepareCanonicalBatch,
      inspectPreparedCanonicalBatch,
      applyPreparedCanonicalBatch,
      mutate,
      replace,
      history,
      scheduleContext,
      reconcile
    };
  }

  root.ALRolePlanRepository = { create, PLANS_KEY, HISTORY_KEY };
})(typeof globalThis !== 'undefined' ? globalThis : self);
