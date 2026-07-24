(function initRolePlanDomain(root) {
  'use strict';

  const EFFECTIVE_STATUSES = new Set(['active', 'paused', 'running', 'failed']);
  const PLAN_TYPES = new Set(['private_message', 'moment_post', 'role_schedule']);
  const PLAN_SOURCES = new Set(['spoken', 'accepted_request', 'private_decision', 'user_created']);
  const PLAN_OPERATIONS = new Set(['create', 'update', 'cancel', 'pause', 'resume', 'complete', 'delete']);
  const ACTIVE_LIMIT = 50;
  const MIN_SEND_GAP_MS = 5 * 60 * 1000;

  function copy(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function compact(value, maxLength) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length <= maxLength ? text : text.slice(0, maxLength);
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
        const duplicate = nextPlans.find(plan => (
          plan.characterId === context.charId
          && plan.type === operation.type
          && plan.status === 'active'
          && sameIntent(plan.intent, operation.intent)
          && Math.abs(Number(plan.nextRunAt) - Number(operation.nextRunAt)) < MIN_SEND_GAP_MS
        ));
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
    nextOccurrence,
    occurrenceId,
    effectivePlans,
    scheduleContext,
    roleScheduleState,
    cloudJob
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
