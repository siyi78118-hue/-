(function initRolePlanDomain(root) {
  'use strict';

  const EFFECTIVE_STATUSES = new Set(['active', 'paused', 'running', 'failed']);
  const PLAN_TYPES = new Set(['private_message', 'moment_post', 'role_schedule']);
  const PLAN_SOURCES = new Set(['spoken', 'accepted_request', 'private_decision', 'user_created']);
  const PLAN_OPERATIONS = new Set(['create', 'update', 'cancel', 'pause', 'resume', 'complete', 'delete']);
  const CANONICAL_PLAN_OPERATIONS = new Set(['create', 'update', 'cancel', 'pause', 'resume', 'complete']);
  const CANONICAL_REQUEST_KEYS = Object.freeze([
    'version', 'authoritativeTurnId', 'actionId', 'actionChecksum', 'kind', 'planId', 'operationJson'
  ]);
  const CANONICAL_PROOF_KEYS = Object.freeze([...CANONICAL_REQUEST_KEYS, 'appliedAt']);
  const CANONICAL_HISTORY_KEYS = Object.freeze(['historyId', 'planId', 'operation', 'detailJson', 'createdAt']);
  const CANONICAL_DESCRIPTOR_KEYS = Object.freeze([
    'authoritativeTurnId', 'actionId', 'actionChecksum', 'kind',
    'targetKey', 'targetRevision', 'operation'
  ]);
  const ACTIVE_LIMIT = 50;
  const MIN_SEND_GAP_MS = 5 * 60 * 1000;

  function copy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function compact(value, maxLength) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length <= maxLength ? text : text.slice(0, maxLength);
  }

  function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function exactKeys(value, keys) {
    return plainObject(value)
      && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (plainObject(value)) {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function nativeNonemptyString(value, maxLength = 256) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  }

  function safeId(value) {
    return compact(value, 128).replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function occurrenceId(planId, scheduledFor) {
    return `${String(planId)}:${Number(scheduledFor)}`;
  }

  function effectivePlans(plans, characterId) {
    return (Array.isArray(plans) ? plans : []).filter(plan => (
      plan?.characterId === characterId && EFFECTIVE_STATUSES.has(plan?.status)
    ));
  }

  function parseTime(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
  }

  function localCandidate(baseMs, time, dayOffset = 0) {
    const parsed = parseTime(time);
    if (!parsed) return null;
    const value = new Date(baseMs);
    value.setDate(value.getDate() + dayOffset);
    value.setHours(parsed.hour, parsed.minute, 0, 0);
    return value.getTime();
  }

  function beforeEnd(candidate, endsAt) {
    return Number.isFinite(candidate) && candidate <= endsAt ? candidate : null;
  }

  function nextOccurrence(schedule, afterMs) {
    const rule = schedule && typeof schedule === 'object' ? schedule : {};
    const after = Number(afterMs);
    if (!Number.isFinite(after)) return null;
    const parsedEnd = rule.endsAt ? Date.parse(rule.endsAt) : Number.POSITIVE_INFINITY;
    const endsAt = Number.isFinite(parsedEnd) ? parsedEnd : Number.POSITIVE_INFINITY;

    if (rule.kind === 'once') {
      const candidate = Date.parse(rule.at);
      return candidate > after ? beforeEnd(candidate, endsAt) : null;
    }

    if (rule.kind === 'interval') {
      const anchor = Date.parse(rule.startsAt);
      const intervalMs = Number(rule.intervalMs);
      if (!Number.isFinite(anchor) || !Number.isFinite(intervalMs) || intervalMs < MIN_SEND_GAP_MS) return null;
      const candidate = anchor > after
        ? anchor
        : anchor + (Math.floor((after - anchor) / intervalMs) + 1) * intervalMs;
      return beforeEnd(candidate, endsAt);
    }

    if (rule.kind === 'daily') {
      let candidate = localCandidate(after, rule.time);
      if (!Number.isFinite(candidate)) return null;
      if (candidate <= after) candidate = localCandidate(after, rule.time, 1);
      return beforeEnd(candidate, endsAt);
    }

    if (rule.kind === 'weekly') {
      const weekdays = new Set((Array.isArray(rule.weekdays) ? rule.weekdays : []).map(Number));
      if (!weekdays.size || [...weekdays].some(day => day < 0 || day > 6)) return null;
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = localCandidate(after, rule.time, offset);
        if (candidate > after && weekdays.has(new Date(candidate).getDay())) return beforeEnd(candidate, endsAt);
      }
      return null;
    }

    if (rule.kind === 'monthly') {
      const wantedDay = Number(rule.day);
      if (!Number.isInteger(wantedDay) || wantedDay < 1 || wantedDay > 31 || !parseTime(rule.time)) return null;
      for (let offset = 0; offset <= 12; offset += 1) {
        const base = new Date(after);
        const monthStart = new Date(base.getFullYear(), base.getMonth() + offset, 1, 0, 0, 0, 0);
        const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
        monthStart.setDate(Math.min(wantedDay, lastDay));
        const candidate = localCandidate(monthStart.getTime(), rule.time);
        if (candidate > after) return beforeEnd(candidate, endsAt);
      }
    }
    return null;
  }

  function normalizeOperation(operation, context = {}) {
    const source = operation && typeof operation === 'object' ? operation : {};
    if ((source.op === 'create' && Object.hasOwn(source, 'canonicalActionApplications'))
      || (source.op === 'update'
        && source.patch
        && typeof source.patch === 'object'
        && Object.hasOwn(source.patch, 'canonicalActionApplications'))) {
      return { ok: false, code: 'PLAN_LEDGER_RESERVED', detail: 'canonicalActionApplications is reserved' };
    }
    const value = copy(operation || {});
    if (!PLAN_OPERATIONS.has(value.op)) {
      return { ok: false, code: 'PLAN_OP_INVALID', detail: 'unknown operation' };
    }
    if (value.op !== 'create') {
      value.planId = compact(value.planId, 96);
      if (!value.planId) return { ok: false, code: 'PLAN_TARGET_REQUIRED', detail: 'planId is required' };
      if (value.patch && typeof value.patch !== 'object') return { ok: false, code: 'PLAN_PATCH_INVALID', detail: 'patch must be an object' };
      return { ok: true, value };
    }
    if (!PLAN_TYPES.has(value.type) || !PLAN_SOURCES.has(value.source)) {
      return { ok: false, code: 'PLAN_ENUM_INVALID', detail: 'invalid type or source' };
    }
    const durationMs = Number(value.durationMs);
    if (value.type === 'role_schedule' && (!Number.isFinite(durationMs) || durationMs < 60 * 1000)) {
      return { ok: false, code: 'PLAN_DURATION_REQUIRED', detail: 'role_schedule requires durationMs' };
    }
    const now = Number(context.now);
    const nextRunAt = nextOccurrence(value.schedule, now - 1);
    if (!Number.isFinite(nextRunAt) || nextRunAt <= now) {
      return { ok: false, code: 'PLAN_TIME_INVALID', detail: 'schedule has no future occurrence' };
    }
    const uid = typeof context.uid === 'function' ? context.uid : () => `plan_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const normalizedNext = value.type === 'role_schedule' ? nextRunAt : Math.max(nextRunAt, now + MIN_SEND_GAP_MS);
    return {
      ok: true,
      value: {
        ...value,
        planId: compact(value.planId || uid(), 96),
        characterId: compact(context.charId, 96),
        origin: value.origin === 'user' ? 'user' : 'ai',
        title: compact(value.title, 80),
        intent: compact(value.intent, 600),
        sourceQuote: compact(value.sourceQuote, 240),
        evidenceMessageIds: (Array.isArray(value.evidenceMessageIds) ? value.evidenceMessageIds : []).map(item => compact(item, 96)).filter(Boolean).slice(0, 12),
        schedule: copy(value.schedule),
        timeConfidence: value.timeConfidence === 'inferred' ? 'inferred' : 'explicit',
        nextRunAt: normalizedNext,
        status: 'active'
      }
    };
  }

  function sameIntent(left, right) {
    return compact(left, 600).replace(/\s+/g, '') === compact(right, 600).replace(/\s+/g, '');
  }

  function semanticDuplicatePlan(plans, operation, characterId) {
    return (Array.isArray(plans) ? plans : []).find(plan => (
      plan.characterId === characterId
      && plan.type === operation.type
      && plan.status === 'active'
      && sameIntent(plan.intent, operation.intent)
      && Math.abs(Number(plan.nextRunAt) - Number(operation.nextRunAt)) < MIN_SEND_GAP_MS
    )) || null;
  }

  function applyOperations(plans, history, operations, context = {}) {
    const nextPlans = copy(Array.isArray(plans) ? plans : []);
    let nextHistory = copy(Array.isArray(history) ? history : []);
    const rejected = [];
    const now = Number(context.now) || Date.now();
    const uid = typeof context.uid === 'function' ? context.uid : () => `plan_${now}_${Math.random().toString(36).slice(2, 8)}`;
    let changed = false;

    for (const raw of Array.isArray(operations) ? operations : []) {
      const checked = normalizeOperation(raw, { ...context, now, uid });
      if (!checked.ok) {
        rejected.push(checked);
        continue;
      }
      const operation = checked.value;
      if (operation.op === 'create') {
        const duplicate = semanticDuplicatePlan(nextPlans, operation, context.charId);
        if (duplicate) {
          duplicate.nextRunAt = operation.nextRunAt;
          duplicate.schedule = copy(operation.schedule);
          duplicate.updatedAt = now;
          changed = true;
          continue;
        }
        if (effectivePlans(nextPlans, context.charId).length >= ACTIVE_LIMIT) {
          rejected.push({ ok: false, code: 'PLAN_LIMIT', detail: '50 effective plans' });
          continue;
        }
        nextPlans.push({ ...operation, createdAt: now, updatedAt: now });
        nextHistory.push({
          historyId: compact(uid(), 96),
          planId: operation.planId,
          operation: 'create',
          detailJson: JSON.stringify({ title: operation.title }),
          createdAt: now
        });
        changed = true;
        continue;
      }

      const target = nextPlans.find(plan => plan.planId === operation.planId && plan.characterId === context.charId);
      if (!target) {
        rejected.push({ ok: false, code: 'PLAN_TARGET_MISSING', detail: operation.planId });
        continue;
      }
      if (operation.op === 'delete') {
        if (!['completed', 'cancelled'].includes(target.status)) {
          rejected.push({ ok: false, code: 'PLAN_DELETE_ACTIVE', detail: operation.planId });
          continue;
        }
        nextPlans.splice(nextPlans.indexOf(target), 1);
        nextHistory = nextHistory.filter(row => row.planId !== target.planId);
        changed = true;
        continue;
      }
      if (operation.op === 'update') {
        const patch = copy(operation.patch || {});
        delete patch.planId;
        delete patch.characterId;
        const nextType = patch.type || target.type;
        if (!PLAN_TYPES.has(nextType)) {
          rejected.push({ ok: false, code: 'PLAN_ENUM_INVALID', detail: 'invalid type' });
          continue;
        }
        const durationMs = Number(patch.durationMs ?? target.durationMs);
        if (nextType === 'role_schedule' && (!Number.isFinite(durationMs) || durationMs < 60 * 1000)) {
          rejected.push({ ok: false, code: 'PLAN_DURATION_REQUIRED', detail: 'role_schedule requires durationMs' });
          continue;
        }
        if (patch.schedule) {
          const recalculated = nextOccurrence(patch.schedule, now - 1);
          if (!Number.isFinite(recalculated) || recalculated <= now) {
            rejected.push({ ok: false, code: 'PLAN_TIME_INVALID', detail: 'schedule has no future occurrence' });
            continue;
          }
          patch.nextRunAt = nextType === 'role_schedule' ? recalculated : Math.max(recalculated, now + MIN_SEND_GAP_MS);
        }
        Object.assign(target, patch);
      }
      if (operation.op === 'cancel') Object.assign(target, { status: 'cancelled', cancelledAt: now });
      if (operation.op === 'pause') target.status = 'paused';
      if (operation.op === 'resume') {
        if (Number(target.nextRunAt) <= now) {
          const resumedAt = nextOccurrence(target.schedule, now - 1);
          if (Number.isFinite(resumedAt)) target.nextRunAt = resumedAt;
          else target.lastErrorCode = 'PLAN_TIME_EXPIRED';
        }
        target.status = Number(target.nextRunAt) > now ? 'active' : 'failed';
      }
      if (operation.op === 'complete') Object.assign(target, { status: 'completed', completedAt: now });
      target.updatedAt = now;
      nextHistory.push({
        historyId: compact(uid(), 96),
        planId: target.planId,
        operation: operation.op,
        detailJson: JSON.stringify({ reason: compact(operation.reason, 240) }),
        createdAt: now
      });
      changed = true;
    }

    return { plans: nextPlans, history: nextHistory, changed, rejected };
  }

  function validateCanonicalPair(pair) {
    if (!exactKeys(pair, ['operation', 'request'])
      || !plainObject(pair.operation)
      || !exactKeys(pair.request, CANONICAL_REQUEST_KEYS)) {
      throw new Error('canonical role plan authority conflict');
    }
    const request = pair.request;
    if (request.version !== 1
      || !nativeNonemptyString(request.authoritativeTurnId, 128)
      || !nativeNonemptyString(request.actionId, 128)
      || typeof request.actionChecksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(request.actionChecksum)
      || !nativeNonemptyString(request.planId, 96)
      || typeof request.operationJson !== 'string') {
      throw new Error('canonical role plan authority conflict');
    }
    let operation;
    try {
      operation = JSON.parse(request.operationJson);
    } catch {
      throw new Error('canonical role plan authority conflict');
    }
    if (!plainObject(operation)
      || canonicalJson(operation) !== request.operationJson
      || canonicalJson(pair.operation) !== request.operationJson
      || !CANONICAL_PLAN_OPERATIONS.has(operation.op)
      || request.kind !== `role_plan_${operation.op}`) {
      throw new Error('canonical role plan authority conflict');
    }
    if (operation.op !== 'create' && operation.planId !== request.planId) {
      throw new Error('canonical role plan authority conflict');
    }
    return { operation: copy(operation), request: copy(request) };
  }

  function requestMatchesProof(request, proof) {
    return exactKeys(proof, CANONICAL_PROOF_KEYS)
      && positiveSafeInteger(proof.appliedAt)
      && CANONICAL_REQUEST_KEYS.every(key => canonicalJson(proof[key]) === canonicalJson(request[key]));
  }

  function canonicalHistoryRow(proof) {
    const operation = JSON.parse(proof.operationJson);
    return {
      historyId: proof.actionId,
      planId: proof.planId,
      operation: operation.op,
      detailJson: proof.operationJson,
      createdAt: proof.appliedAt
    };
  }

  function sameCanonicalHistory(left, right) {
    return exactKeys(left, CANONICAL_HISTORY_KEYS)
      && CANONICAL_HISTORY_KEYS.every(key => canonicalJson(left[key]) === canonicalJson(right[key]));
  }

  function findCanonicalProofOwner(plans, actionId) {
    const owners = (Array.isArray(plans) ? plans : []).filter(plan => (
      plainObject(plan?.canonicalActionApplications)
      && Object.hasOwn(plan.canonicalActionApplications, actionId)
    ));
    if (owners.length > 1) throw new Error('canonical role plan authority conflict');
    return owners[0] || null;
  }

  function globalApplicationProof(request, proof) {
    return {
      turnId: request.authoritativeTurnId,
      actionId: request.actionId,
      actionChecksum: request.actionChecksum,
      type: request.kind,
      appliedAt: proof.appliedAt
    };
  }

  function inspectCanonicalApplications(plans, history, pairs) {
    const nextPlans = copy(Array.isArray(plans) ? plans : []);
    const nextHistory = copy(Array.isArray(history) ? history : []);
    const checkedPairs = (Array.isArray(pairs) ? pairs : []).map(validateCanonicalPair);
    const incomingIds = new Set();
    const proofs = {};
    const missingActionIds = [];
    for (const pair of checkedPairs) {
      const request = pair.request;
      if (incomingIds.has(request.actionId)) throw new Error('canonical role plan authority conflict');
      incomingIds.add(request.actionId);
      const owner = findCanonicalProofOwner(nextPlans, request.actionId);
      const proof = owner?.canonicalActionApplications?.[request.actionId] || null;
      const historyMatches = nextHistory.filter(row => row?.historyId === request.actionId);
      if (!proof) {
        if (historyMatches.length) throw new Error('canonical role plan history conflict');
        missingActionIds.push(request.actionId);
        continue;
      }
      if (owner.planId !== request.planId || !requestMatchesProof(request, proof)) {
        throw new Error('canonical role plan authority conflict');
      }
      const expectedHistory = canonicalHistoryRow(proof);
      if (historyMatches.length > 1
        || (historyMatches.length === 1 && !sameCanonicalHistory(historyMatches[0], expectedHistory))) {
        throw new Error('canonical role plan history conflict');
      }
      proofs[request.actionId] = globalApplicationProof(request, proof);
    }
    return { proofs, missingActionIds };
  }

  function applyCanonicalApplications(plans, history, pairs, context = {}) {
    const nextPlans = copy(Array.isArray(plans) ? plans : []);
    const nextHistory = copy(Array.isArray(history) ? history : []);
    const checkedPairs = (Array.isArray(pairs) ? pairs : []).map(validateCanonicalPair);
    const incomingIds = new Set();
    for (const pair of checkedPairs) {
      if (incomingIds.has(pair.request.actionId)) {
        throw new Error('canonical role plan authority conflict');
      }
      incomingIds.add(pair.request.actionId);
    }
    const appliedAt = Number(context.appliedAt);
    let plansChanged = false;
    let historyChanged = false;

    for (const pair of checkedPairs) {
      const { operation, request } = pair;
      let target = findCanonicalProofOwner(nextPlans, request.actionId);
      let proof = target?.canonicalActionApplications?.[request.actionId] || null;
      if (proof) {
        if (target.planId !== request.planId || !requestMatchesProof(request, proof)) {
          throw new Error('canonical role plan authority conflict');
        }
      } else {
        if (!positiveSafeInteger(appliedAt)) {
          throw new Error('canonical role plan authority conflict');
        }
        const result = applyOperations(nextPlans, [], [operation], {
          ...context,
          now: Number(context.now),
          uid: () => request.planId
        });
        if (!result.changed || result.rejected.length) {
          throw new Error('canonical role plan operation conflict');
        }
        nextPlans.splice(0, nextPlans.length, ...result.plans);
        target = nextPlans.find(plan => plan.planId === request.planId && plan.characterId === context.charId);
        if (!target) throw new Error('canonical role plan authority conflict');
        if (target.canonicalActionApplications != null
          && !plainObject(target.canonicalActionApplications)) {
          throw new Error('canonical role plan authority conflict');
        }
        proof = { ...copy(request), appliedAt };
        target.canonicalActionApplications = {
          ...(target.canonicalActionApplications || {}),
          [request.actionId]: proof
        };
        plansChanged = true;
      }

      const expectedHistory = canonicalHistoryRow(proof);
      const matches = nextHistory.filter(row => row?.historyId === request.actionId);
      if (matches.length > 1 || (matches.length === 1 && !sameCanonicalHistory(matches[0], expectedHistory))) {
        throw new Error('canonical role plan history conflict');
      }
      if (matches.length === 0) {
        nextHistory.push(expectedHistory);
        historyChanged = true;
      }
    }

    const inspected = inspectCanonicalApplications(nextPlans, nextHistory, checkedPairs);
    if (inspected.missingActionIds.length) throw new Error('canonical role plan authority conflict');
    return {
      plans: nextPlans,
      history: nextHistory,
      changed: plansChanged || historyChanged,
      plansChanged,
      historyChanged,
      proofs: inspected.proofs
    };
  }

  function validateCanonicalDescriptor(descriptor) {
    if (!exactKeys(descriptor, CANONICAL_DESCRIPTOR_KEYS)
      || !plainObject(descriptor.operation)
      || !nativeNonemptyString(descriptor.authoritativeTurnId, 128)
      || !nativeNonemptyString(descriptor.actionId, 128)
      || typeof descriptor.actionChecksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(descriptor.actionChecksum)
      || typeof descriptor.targetKey !== 'string'
      || !descriptor.targetKey
      || typeof descriptor.targetRevision !== 'string'
      || !descriptor.targetRevision) {
      throw new Error('canonical role plan authority conflict');
    }
    const operation = copy(descriptor.operation);
    if (!CANONICAL_PLAN_OPERATIONS.has(operation.op)
      || descriptor.kind !== `role_plan_${operation.op}`) {
      throw new Error('canonical role plan authority conflict');
    }
    if (operation.op === 'create') {
      if (!nativeNonemptyString(operation.planId, 96)
        || !/^lineage_create:[a-zA-Z0-9._:-]+:role_plan_create$/.test(descriptor.targetKey)) {
        throw new Error('canonical role plan authority conflict');
      }
    } else if (!nativeNonemptyString(operation.planId, 96)
      || descriptor.targetKey !== `role_plan:${operation.planId}`) {
      throw new Error('canonical role plan authority conflict');
    }
    return { ...copy(descriptor), operation };
  }

  function canonicalPairForDescriptor(descriptor, planId) {
    return {
      operation: copy(descriptor.operation),
      request: {
        version: 1,
        authoritativeTurnId: descriptor.authoritativeTurnId,
        actionId: descriptor.actionId,
        actionChecksum: descriptor.actionChecksum,
        kind: descriptor.kind,
        planId,
        operationJson: canonicalJson(descriptor.operation)
      }
    };
  }

  function prepareCanonicalApplications(plans, history, descriptors, context = {}) {
    const checked = (Array.isArray(descriptors) ? descriptors : []).map(validateCanonicalDescriptor);
    const incomingIds = new Set();
    let runningPlans = copy(Array.isArray(plans) ? plans : []);
    let runningHistory = copy(Array.isArray(history) ? history : []);
    const pairs = [];
    for (const descriptor of checked) {
      if (incomingIds.has(descriptor.actionId)) throw new Error('canonical role plan authority conflict');
      incomingIds.add(descriptor.actionId);
      const owner = findCanonicalProofOwner(runningPlans, descriptor.actionId);
      let planId = owner?.planId || descriptor.operation.planId;
      if (!owner && descriptor.operation.op === 'create') {
        const normalized = normalizeOperation(descriptor.operation, {
          ...context,
          now: Number(context.now),
          uid: () => descriptor.operation.planId
        });
        if (!normalized.ok) throw new Error('canonical role plan operation conflict');
        planId = semanticDuplicatePlan(runningPlans, normalized.value, context.charId)?.planId
          || normalized.value.planId;
      }
      const pair = canonicalPairForDescriptor(descriptor, planId);
      const preview = applyCanonicalApplications(runningPlans, runningHistory, [pair], context);
      runningPlans = preview.plans;
      runningHistory = preview.history;
      pairs.push(pair);
    }
    return {
      pairs: copy(pairs),
      preview: {
        plans: runningPlans,
        history: runningHistory,
        proofs: inspectCanonicalApplications(runningPlans, runningHistory, pairs).proofs
      }
    };
  }

  function scheduleContext(plans, characterId, nowMs) {
    const now = Number(nowMs);
    return (Array.isArray(plans) ? plans : []).filter(plan => {
      if (plan?.characterId !== characterId || plan?.type !== 'role_schedule' || plan?.status !== 'active') return false;
      return roleScheduleState(plan, now).active;
    });
  }

  function roleScheduleState(plan, nowMs) {
    const now = Number(nowMs);
    const durationMs = Number(plan?.durationMs);
    const recurringStart = durationMs > 0 ? occurrenceStartAt(plan?.schedule, now) : null;
    const startedAt = Number(recurringStart ?? plan?.startedAt ?? plan?.nextRunAt);
    const endsAt = recurringStart != null && durationMs > 0
      ? startedAt + durationMs
      : (plan?.endsAt == null ? Number.POSITIVE_INFINITY : Number(plan.endsAt));
    const active = Number.isFinite(startedAt) && startedAt <= now && endsAt > now;
    const nextRunAt = nextOccurrence(plan?.schedule, now);
    const explicitlyBounded = plan?.schedule?.kind === 'once' || Boolean(plan?.schedule?.endsAt);
    return {
      active,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      endsAt: Number.isFinite(endsAt) ? endsAt : null,
      nextRunAt,
      expired: !active && nextRunAt == null && explicitlyBounded
    };
  }

  function occurrenceStartAt(schedule, now) {
    const rule = schedule && typeof schedule === 'object' ? schedule : {};
    const startsAt = rule.startsAt ? Date.parse(rule.startsAt) : Number.NEGATIVE_INFINITY;
    const endsAt = rule.endsAt ? Date.parse(rule.endsAt) : Number.POSITIVE_INFINITY;
    let candidate = null;
    if (rule.kind === 'once') candidate = Date.parse(rule.at);
    if (rule.kind === 'interval') {
      const anchor = Date.parse(rule.startsAt);
      const intervalMs = Number(rule.intervalMs);
      if (Number.isFinite(anchor) && intervalMs >= MIN_SEND_GAP_MS && now >= anchor) {
        candidate = anchor + Math.floor((now - anchor) / intervalMs) * intervalMs;
      }
    }
    if (rule.kind === 'daily') candidate = localCandidate(now, rule.time);
    if (rule.kind === 'weekly') {
      const weekdays = new Set((Array.isArray(rule.weekdays) ? rule.weekdays : []).map(Number));
      const today = localCandidate(now, rule.time);
      if (weekdays.has(new Date(now).getDay())) candidate = today;
    }
    if (rule.kind === 'monthly') {
      const day = Number(rule.day);
      const base = new Date(now);
      if (Number.isInteger(day) && day >= 1 && day <= 31) {
        const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
        const monthDay = new Date(base.getFullYear(), base.getMonth(), Math.min(day, lastDay), 0, 0, 0, 0);
        candidate = localCandidate(monthDay.getTime(), rule.time);
      }
    }
    return Number.isFinite(candidate)
      && candidate <= now
      && candidate >= startsAt
      && candidate <= endsAt
      ? candidate
      : null;
  }

  function cloudJob(plan, deviceId) {
    const scheduledFor = Number(plan?.nextRunAt);
    const safeDeviceId = safeId(deviceId);
    const safePlanId = safeId(plan?.planId);
    return {
      deviceId: safeDeviceId,
      jobId: `rpl_${safeDeviceId}_${safePlanId}_${scheduledFor}`,
      planId: String(plan?.planId || ''),
      occurrenceId: occurrenceId(plan?.planId, scheduledFor),
      charId: String(plan?.characterId || ''),
      dueAt: new Date(scheduledFor).toISOString(),
      type: 'role-plan',
      kind: String(plan?.type || ''),
      source: String(plan?.source || '')
    };
  }

  root.ALRolePlans = {
    ACTIVE_LIMIT,
    MIN_SEND_GAP_MS,
    normalizeOperation,
    applyOperations,
    applyCanonicalApplications,
    prepareCanonicalApplications,
    inspectCanonicalApplications,
    nextOccurrence,
    occurrenceId,
    effectivePlans,
    scheduleContext,
    roleScheduleState,
    cloudJob
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
