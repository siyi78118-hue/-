// Cloudflare Worker: AL cloud timer.
//
// Bindings required:
// - D1 database: AL_TIMER_DB
// - Secret VAPID_PRIVATE_JWK: P-256 private JWK JSON string with x/y/d
// - Variable VAPID_PUBLIC_KEY: base64url VAPID public key
// - Variable VAPID_SUBJECT: e.g. mailto:you@example.com
// - Secret FIREBASE_PRIVATE_KEY: Firebase service-account RSA private key PEM
// - Variable FIREBASE_PROJECT_ID: Firebase project id
// - Variable FIREBASE_CLIENT_EMAIL: Firebase service-account client email
//
// Cron trigger: every 1 minute.
//
// This worker stores only timer metadata and push subscriptions:
// { deviceId, jobId, charId, dueAt, type, planId, occurrenceId, source }. It does not store chat, memory,
// role prompts, summaries, or API keys.
//
// Timer rows live in D1. Cron queries the indexed due_at column directly; no
// KV due buckets or active-pointer keys are written.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Yuqi-Registration'
};
const CLOUD_TIMER_WORKER_VERSION = '2026-07-17.18';
const FCM_ACK_MAX_ATTEMPTS = 8;
let lastCronSummary = null;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response('', { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname.startsWith('/bridge/')) {
      if (!env.YUQI_RELAY_SERVICE) return json({ ok: false, error: 'Yuqi relay service is not bound' }, 503);
      return env.YUQI_RELAY_SERVICE.fetch(request);
    }
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'AL cloud timer', version: CLOUD_TIMER_WORKER_VERSION, cron: await getLastCron(env) });
      }
      if (request.method === 'GET' && url.pathname === '/logs') {
        return json({ ok: true, events: [], source: 'workers-logs' });
      }
      if (request.method === 'POST' && url.pathname === '/register') {
        const body = await request.json();
        const isFcm = body.transport === 'fcm' || !!body.fcmToken;
        if (!body.deviceId || (!isFcm && !body.subscription?.endpoint) || (isFcm && !body.fcmToken)) {
          throw new Error('missing deviceId/push target');
        }
        const target = {
          deviceId: body.deviceId,
          transport: isFcm ? 'fcm' : 'webpush',
          fcmToken: isFcm ? String(body.fcmToken) : '',
          subscription: isFcm ? null : body.subscription,
          backgroundAck: isFcm ? Math.max(0, Number(body.capabilities?.backgroundAck) || 0) : 0,
          updatedAt: Date.now()
        };
        const saved = await timerStore(env).saveSubscription(target);
        const idempotent = !!saved.idempotent;
        logWorkerEvent('register', { deviceId: shortId(body.deviceId), transport: isFcm ? 'fcm' : 'webpush', idempotent, ok: true });
        return json({ ok: true, transport: isFcm ? 'fcm' : 'webpush', idempotent });
      }
      if (request.method === 'POST' && url.pathname === '/schedule') {
        const body = await request.json();
        if (!body.deviceId || !body.jobId || !body.dueAt) throw new Error('missing deviceId/jobId/dueAt');
        if (body.type === 'role-plan') {
          const privateFields = ['intent', 'sourceQuote', 'messages', 'memory', 'prompt', 'apiKey', 'authorization'];
          if (privateFields.some(field => body[field] != null)) throw new Error('ROLE_PLAN_PAYLOAD_NOT_MINIMAL');
          if (!body.planId || !body.occurrenceId || !body.charId) throw new Error('missing role plan identifiers');
        }
        const dueAtMs = Date.parse(body.dueAt);
        if (!Number.isFinite(dueAtMs)) throw new Error('invalid dueAt');
        const job = {
          deviceId: body.deviceId,
          jobId: body.jobId,
          charId: body.charId || '',
          dueAt: body.dueAt,
          type: body.type || 'proactive',
          kind: body.kind || (String(body.jobId || '').startsWith('mom_') ? 'moment' : 'chat'),
          planId: body.type === 'role-plan' ? String(body.planId || '') : undefined,
          occurrenceId: body.type === 'role-plan' ? String(body.occurrenceId || '') : undefined,
          source: body.type === 'role-plan' ? String(body.source || '') : undefined,
          mode: body.mode === 'dice' ? 'dice' : 'planned',
          rollChance: Number.isFinite(Number(body.rollChance)) ? Number(body.rollChance) : undefined,
          diceIntervalMs: Number.isFinite(Number(body.diceIntervalMs)) ? Number(body.diceIntervalMs) : undefined,
          diceRolls: Number.isFinite(Number(body.diceRolls)) ? Number(body.diceRolls) : undefined,
          maxRolls: Number.isFinite(Number(body.maxRolls)) ? Number(body.maxRolls) : undefined,
          dicePrecomputed: !!body.dicePrecomputed,
          test: !!body.test,
          updatedAt: Date.now()
        };
        const saved = await saveJob(job, env);
        logWorkerEvent('schedule', { deviceId: shortId(job.deviceId), jobId: shortId(job.jobId), charId: shortId(job.charId), kind: job.kind, dueAt: job.dueAt, idempotent: !!saved.idempotent, replacedJobId: shortId(saved.replacedJobId), ok: true });
        return json({ ok: true, dueMinute: minuteKey(dueAtMs), idempotent: !!saved.idempotent, replacedJobId: saved.replacedJobId || '' });
      }
      if (request.method === 'POST' && url.pathname === '/job-status') {
        const body = await request.json();
        if (!body.jobId) throw new Error('missing jobId');
        return json(await jobStatus(body.jobId, body.deviceId || '', env));
      }
      if (request.method === 'POST' && url.pathname === '/cancel-device-tasks') {
        const body = await request.json();
        const deviceId = String(body.deviceId || '');
        const result = await cancelDeviceAutomaticTasks(deviceId, env);
        await appendEvent(env, {
          type: 'cancel-device-tasks',
          deviceId: shortId(deviceId),
          momentJobsDeleted: result.momentJobsDeleted,
          chatJobsDeleted: result.chatJobsDeleted,
          rolePlanJobsDeleted: result.rolePlanJobsDeleted,
          dueReferencesDeleted: result.dueReferencesDeleted,
          dueBucketsDeleted: result.dueBucketsDeleted,
          ok: true
        });
        return json(result);
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        const body = await request.json();
        if (body.jobId) await cancelJob(body.jobId, env);
        await appendEvent(env, { type: 'cancel', deviceId: shortId(body.deviceId || ''), jobId: body.jobId || '', ok: true });
        return json({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/ack') {
        const body = await request.json();
        if (!body.jobId || !body.deviceId) throw new Error('missing jobId/deviceId');
        const job = await timerStore(env).getJob(body.jobId);
        if (job && job.deviceId !== body.deviceId) throw new Error('device mismatch');
        await cancelJob(body.jobId, env);
        await appendEvent(env, { type: 'ack', deviceId: shortId(body.deviceId || job?.deviceId || ''), jobId: body.jobId, charId: body.charId || job?.charId || '', kind: body.kind || job?.kind || '', outcome: body.outcome || 'generated', ok: true });
        return json({ ok: true, acknowledged: !!job });
      }
      if (request.method === 'POST' && url.pathname === '/trigger') {
        const body = await request.json();
        if (!body.deviceId) throw new Error('missing deviceId');
        const storedJob = body.jobId ? await timerStore(env).getJob(body.jobId) : null;
        const job = storedJob || body;
        job.deviceId = job.deviceId || body.deviceId;
        job.jobId = job.jobId || body.jobId || `manual:${body.deviceId}:${Date.now()}`;
        job.charId = job.charId || body.charId || '';
        job.type = job.type || 'proactive';
        job.kind = job.kind || body.kind || (String(job.jobId || '').startsWith('mom_') ? 'moment' : 'chat');
        job.test = !!(job.test || body.test);
        const delivered = await deliverJob(job, env);
        if (job.jobId && !delivered.retry && !delivered.awaitingAck) await cancelJob(job.jobId, env);
        if (job.jobId && delivered.awaitingAck) await deferForFcmAck(job, env);
        if (job.jobId && delivered.retry) await deferForDeliveryRetry(job, env, delivered.reason || 'push failed');
        await appendEvent(env, { type: 'manual-trigger', deviceId: shortId(job.deviceId), jobId: job.jobId, charId: job.charId, kind: job.kind, ok: delivered.ok, reason: delivered.reason || delivered.fallbackReason || '', retry: !!delivered.retry, payload: delivered.payload !== false });
        return json({ ok: delivered.ok, delivered });
      }
      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      const failure = classifyWorkerError(err);
      logWorkerEvent('request-error', {
        path: url.pathname,
        status: failure.status,
        code: failure.code,
        error: failure.error
      }, 'error');
      return json({
        ok: false,
        error: failure.error,
        code: failure.code,
        ...(failure.retryAt ? { retryAt: failure.retryAt } : {})
      }, failure.status);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueJobs(env));
  }
};

async function runDueJobs(env) {
  const startedAt = Date.now();
  const nowMinute = Math.floor(startedAt / 60000);
  const startMinute = nowMinute;
  const summary = {
    ok: true,
    startedAt,
    finishedAt: 0,
    startMinute,
    endMinute: nowMinute,
    buckets: 0,
    jobsSeen: 0,
    delivered: 0,
    retry: 0,
    failed: 0,
    future: 0,
    missing: 0,
    error: ''
  };
  try {
    const store = timerStore(env);
    const jobs = await store.dueJobs(startedAt, 100);
    summary.buckets = 1;
    summary.jobsSeen = jobs.length;
    for (const job of jobs) {
      try {
        const delivered = await deliverJob(job, env);
        await appendEvent(env, { type: 'deliver', deviceId: shortId(job.deviceId), jobId: job.jobId, charId: job.charId || '', kind: job.kind || '', ok: delivered.ok, reason: delivered.reason || delivered.fallbackReason || '', retry: !!delivered.retry, awaitingAck: !!delivered.awaitingAck, payload: delivered.payload !== false });
        if (delivered.awaitingAck) {
          summary.delivered += 1;
          if (!await deferForFcmAck(job, env)) summary.failed += 1;
        } else if (delivered.retry) {
          summary.retry += 1;
          if (!await deferForDeliveryRetry(job, env, delivered.reason || 'push failed')) summary.failed += 1;
        } else {
          delivered.ok ? summary.delivered += 1 : summary.failed += 1;
          await clearJobRecord(job, env);
        }
      } catch (err) {
        await appendEvent(env, { type: 'deliver-error', jobId: job.jobId, ok: false, reason: String(err?.message || err).slice(0, 160), retry: true });
        if (await deferForDeliveryRetry(job, env, err?.message || String(err))) summary.retry += 1;
        else summary.failed += 1;
      }
    }
  } catch (err) {
    summary.ok = false;
    summary.error = String(err?.message || err).slice(0, 180);
    throw err;
  } finally {
    summary.finishedAt = Date.now();
    lastCronSummary = summary;
    try {
      const store = timerStore(env);
      if (store.saveCronSummary) await store.saveCronSummary(summary);
    } catch (metaError) {
      console.warn('failed to persist cron summary:', metaError?.message || metaError);
    }
    const hasActivity = !summary.ok || summary.jobsSeen > 0 || summary.delivered > 0 || summary.retry > 0 || summary.failed > 0 || summary.missing > 0;
    if (hasActivity) logWorkerEvent('cron', { ok: summary.ok, buckets: summary.buckets, jobsSeen: summary.jobsSeen, delivered: summary.delivered, retry: summary.retry, failed: summary.failed, missing: summary.missing, error: summary.error });
  }
}

async function getLastCron(env) {
  if (lastCronSummary) return lastCronSummary;
  const store = timerStore(env);
  return store.getCronSummary ? await store.getCronSummary() : null;
}

function timerStore(env) {
  if (env?.AL_TIMER_STORE) return env.AL_TIMER_STORE;
  if (!env?.AL_TIMER_DB) throw new Error('AL_TIMER_DB binding is missing');
  return createD1TimerStore(env.AL_TIMER_DB);
}

function createD1TimerStore(db) {
  const parseJob = row => row?.payload_json ? JSON.parse(row.payload_json) : null;
  return {
    async getSubscription(deviceId) {
      const row = await db.prepare('SELECT target_json FROM timer_devices WHERE device_id = ?1').bind(deviceId).first();
      return row?.target_json ? JSON.parse(row.target_json) : null;
    },
    async saveSubscription(target) {
      const previous = await this.getSubscription(target.deviceId);
      const idempotent = samePushTarget(previous, target);
      if (!idempotent) {
        await db.prepare(`INSERT INTO timer_devices (device_id, transport, target_json, background_ack, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(device_id) DO UPDATE SET transport=excluded.transport, target_json=excluded.target_json,
          background_ack=excluded.background_ack, updated_at=excluded.updated_at`)
          .bind(target.deviceId, target.transport, JSON.stringify(target), Number(target.backgroundAck || 0), target.updatedAt).run();
      }
      return { idempotent };
    },
    async deleteSubscription(deviceId) {
      const result = await db.prepare('DELETE FROM timer_devices WHERE device_id = ?1').bind(deviceId).run();
      return Number(result?.meta?.changes || 0) > 0;
    },
    async getJob(jobId) {
      return parseJob(await db.prepare('SELECT payload_json FROM timer_jobs WHERE job_id = ?1').bind(jobId).first());
    },
    async saveJob(job, logicalKey) {
      const activeRow = await db.prepare('SELECT job_id, payload_json FROM timer_jobs WHERE logical_key = ?1').bind(logicalKey).first();
      const active = parseJob(activeRow);
      const previous = await this.getJob(job.jobId);
      if (active?.jobId === job.jobId && sameScheduledJob(previous, job)) return { idempotent: true, replacedJobId: '' };
      await db.prepare(`INSERT OR REPLACE INTO timer_jobs
        (job_id, logical_key, device_id, char_id, type, kind, plan_id, occurrence_id, source,
         due_at, payload_json, delivery_attempts, awaiting_ack, test, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`)
        .bind(job.jobId, logicalKey, job.deviceId, job.charId || '', job.type || 'proactive', job.kind || 'chat',
          job.planId || null, job.occurrenceId || null, job.source || null, Date.parse(job.dueAt), JSON.stringify(job),
          Number(job.deliveryAttempts || 0), job.awaitingAck ? 1 : 0, job.test ? 1 : 0, Number(job.updatedAt || Date.now())).run();
      return { idempotent: false, replacedJobId: active?.jobId && active.jobId !== job.jobId ? active.jobId : '' };
    },
    async deleteJob(jobId) {
      const result = await db.prepare('DELETE FROM timer_jobs WHERE job_id = ?1').bind(jobId).run();
      return Number(result?.meta?.changes || 0) > 0;
    },
    async dueJobs(now, limit = 100) {
      const result = await db.prepare('SELECT payload_json FROM timer_jobs WHERE due_at <= ?1 ORDER BY due_at ASC LIMIT ?2').bind(now, limit).all();
      return (result?.results || []).map(parseJob).filter(Boolean);
    },
    async deviceJobs(deviceId) {
      const result = await db.prepare('SELECT payload_json FROM timer_jobs WHERE device_id = ?1 ORDER BY due_at ASC').bind(deviceId).all();
      return (result?.results || []).map(parseJob).filter(Boolean);
    },
    async getCronSummary() {
      const row = await db.prepare("SELECT value_json FROM timer_meta WHERE meta_key = 'last_cron'").first();
      return row?.value_json ? JSON.parse(row.value_json) : null;
    },
    async saveCronSummary(summary) {
      await db.prepare(`INSERT INTO timer_meta (meta_key, value_json, updated_at) VALUES ('last_cron', ?1, ?2)
        ON CONFLICT(meta_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
        .bind(JSON.stringify(summary), Date.now()).run();
    }
  };
}

function logicalTaskKey(job) {
  if (job?.test) return `active:test:${encodeURIComponent(String(job.deviceId || ''))}:${encodeURIComponent(String(job.jobId || ''))}`;
  if (job?.type === 'role-plan') return `active:role-plan:${encodeURIComponent(String(job.deviceId || ''))}:${encodeURIComponent(String(job.jobId || ''))}`;
  return `active:${encodeURIComponent(String(job.deviceId || ''))}:${encodeURIComponent(String(job.charId || ''))}:${encodeURIComponent(String(job.kind || 'chat'))}`;
}

function sameScheduledJob(left, right) {
  if (!left || !right) return false;
  const fields = ['deviceId', 'jobId', 'charId', 'dueAt', 'type', 'kind', 'planId', 'occurrenceId', 'source', 'mode', 'rollChance', 'diceIntervalMs', 'diceRolls', 'maxRolls', 'dicePrecomputed', 'test'];
  return fields.every(field => (left[field] ?? null) === (right[field] ?? null));
}

function samePushTarget(left, right) {
  if (!left || !right) return false;
  return left.deviceId === right.deviceId
    && left.transport === right.transport
    && String(left.fcmToken || '') === String(right.fcmToken || '')
    && Number(left.backgroundAck || 0) === Number(right.backgroundAck || 0)
    && JSON.stringify(left.subscription || null) === JSON.stringify(right.subscription || null);
}

async function saveJob(job, env) {
  return timerStore(env).saveJob(job, logicalTaskKey(job));
}

async function cancelJob(jobId, env) {
  await timerStore(env).deleteJob(jobId);
}

function validDeviceId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

function isDeviceAutomaticJobId(jobId, deviceId) {
  const value = String(jobId || '');
  return value.startsWith(`mom_${deviceId}_`) || value.startsWith(`pro_${deviceId}_`) || value.startsWith(`rpl_${deviceId}_`);
}

async function cancelDeviceAutomaticTasks(deviceId, env) {
  if (!validDeviceId(deviceId)) throw new Error('invalid deviceId');
  const store = timerStore(env);
  let momentJobsDeleted = 0;
  let chatJobsDeleted = 0;
  let rolePlanJobsDeleted = 0;
  for (const job of await store.deviceJobs(deviceId)) {
    if (job.test || !isDeviceAutomaticJobId(job.jobId, deviceId)) continue;
    await store.deleteJob(job.jobId);
    if (job.type === 'role-plan') rolePlanJobsDeleted += 1;
    else if (job.kind === 'moment') momentJobsDeleted += 1;
    else chatJobsDeleted += 1;
  }

  return {
    ok: true,
    deviceId,
    momentJobsDeleted,
    chatJobsDeleted,
    rolePlanJobsDeleted,
    dueReferencesDeleted: momentJobsDeleted + chatJobsDeleted + rolePlanJobsDeleted,
    dueBucketsDeleted: 0,
    subscriptionPreserved: !!(await store.getSubscription(deviceId))
  };
}

async function jobStatus(jobId, deviceId, env) {
  const store = timerStore(env);
  const job = await store.getJob(jobId);
  const dueAtMs = Date.parse(job?.dueAt || '');
  const dueMinute = Number.isFinite(dueAtMs) ? minuteKey(dueAtMs) : null;
  const bucketHasJob = !!job;
  const subDeviceId = deviceId || job?.deviceId || '';
  const subscription = subDeviceId ? await store.getSubscription(subDeviceId) : null;
  return {
    ok: true,
    jobId,
    exists: !!job,
    bucketHasJob,
    subscriptionExists: !!subscription,
    dueMinute,
    nowMinute: Math.floor(Date.now() / 60000),
    job: job ? {
      charId: job.charId || '',
      dueAt: job.dueAt || '',
      kind: job.kind || '',
      mode: job.mode || '',
      rollChance: job.rollChance,
      diceIntervalMs: job.diceIntervalMs,
      diceRolls: job.diceRolls,
      dicePrecomputed: !!job.dicePrecomputed,
      test: !!job.test,
      updatedAt: job.updatedAt || 0
    } : null
  };
}

async function clearJobRecord(job, env) {
  await timerStore(env).deleteJob(job.jobId);
}

function minuteKey(ms) {
  return Math.ceil(ms / 60000);
}

async function deferForFcmAck(job, env) {
  const attempts = Math.max(0, Number(job.deliveryAttempts) || 0) + 1;
  if (attempts > FCM_ACK_MAX_ATTEMPTS) {
    await cancelJob(job.jobId, env);
    await appendEvent(env, { type: 'ack-timeout', deviceId: shortId(job.deviceId), jobId: job.jobId, charId: job.charId || '', kind: job.kind || '', attempts, ok: false, reason: 'phone did not acknowledge background generation' });
    return false;
  }
  const delayMinutes = Math.min(60, 5 * Math.pow(2, Math.min(4, attempts - 1)));
  await saveJob({
    ...job,
    dueAt: new Date(Date.now() + delayMinutes * 60000).toISOString(),
    deliveryAttempts: attempts,
    awaitingAck: true,
    lastPushedAt: Date.now(),
    updatedAt: Date.now()
  }, env);
  return true;
}

async function deferForDeliveryRetry(job, env, reason = '') {
  const attempts = Math.max(0, Number(job.deliveryAttempts) || 0) + 1;
  if (attempts > FCM_ACK_MAX_ATTEMPTS) {
    await cancelJob(job.jobId, env);
    await appendEvent(env, {
      type: 'delivery-timeout',
      deviceId: shortId(job.deviceId),
      jobId: job.jobId,
      charId: job.charId || '',
      kind: job.kind || '',
      attempts,
      ok: false,
      reason: String(reason || 'push retry limit reached').slice(0, 160)
    });
    return false;
  }
  const delayMinutes = Math.min(30, 2 * Math.pow(2, Math.min(4, attempts - 1)));
  await saveJob({
    ...job,
    dueAt: new Date(Date.now() + delayMinutes * 60000).toISOString(),
    deliveryAttempts: attempts,
    awaitingAck: false,
    lastDeliveryError: String(reason || '').slice(0, 160),
    updatedAt: Date.now()
  }, env);
  return true;
}

async function deliverJob(job, env) {
  const store = timerStore(env);
  const target = await store.getSubscription(job.deviceId);
  if (!target) return { ok: false, reason: 'missing subscription', jobId: job.jobId, retry: false };
  const result = await sendPush(target, env, {
    type: job.type === 'role-plan' ? 'role-plan' : 'proactive',
    deviceId: job.deviceId || '',
    jobId: job.jobId || '',
    charId: job.charId || '',
    kind: job.kind || 'chat',
    planId: job.planId || '',
    occurrenceId: job.occurrenceId || '',
    source: job.source || '',
    mode: job.mode || 'planned',
    rollChance: job.rollChance,
    diceIntervalMs: job.diceIntervalMs,
    diceRolls: job.diceRolls,
    maxRolls: job.maxRolls,
    dicePrecomputed: !!job.dicePrecomputed,
    dueAt: job.dueAt || '',
    test: !!job.test
  });
  if (result.expired) {
    await store.deleteSubscription(job.deviceId);
    return { ok: false, reason: 'subscription expired', jobId: job.jobId, retry: false };
  }
  if (!result.ok) return { ok: false, reason: result.reason || 'push failed', jobId: job.jobId, retry: true };
  return { ok: true, jobId: job.jobId, charId: job.charId || '', kind: job.kind || '', test: !!job.test, retry: false, awaitingAck: result.transport === 'fcm' && Number(target.backgroundAck) >= 1, transport: result.transport || '' };
}

async function getRecentEvents(env) {
  return [];
}

async function appendEvent(env, event) {
  logWorkerEvent(event?.type || 'event', { at: Date.now(), ...event }, event?.ok === false ? 'error' : 'log');
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 14) return text;
  return text.slice(0, 6) + '...' + text.slice(-5);
}

function classifyWorkerError(err, now = Date.now()) {
  const message = String(err?.message || err || 'unknown error').slice(0, 240);
  if (/KV put\(\) limit exceeded for the day/i.test(message)) {
    const current = new Date(now);
    const retryAt = new Date(Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate() + 1
    )).toISOString();
    return {
      status: 429,
      code: 'KV_DAILY_WRITE_LIMIT',
      error: 'Cloudflare KV daily write limit exceeded.',
      retryAt
    };
  }
  if (/D1.*(?:limit|quota)|(?:limit|quota).*D1/i.test(message)) {
    const current = new Date(now);
    const retryAt = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1)).toISOString();
    return { status: 429, code: 'D1_DAILY_LIMIT', error: 'Cloudflare D1 daily limit exceeded.', retryAt };
  }
  return { status: 400, code: 'REQUEST_FAILED', error: message, retryAt: '' };
}

function logWorkerEvent(type, fields = {}, level = 'log') {
  const entry = JSON.stringify({
    service: 'al-cloud-timer',
    version: CLOUD_TIMER_WORKER_VERSION,
    type,
    ...fields
  });
  const logger = level === 'error' ? console.error : console.log;
  logger(entry);
}

async function sendPush(target, env, payload = {}) {
  if (target?.transport === 'fcm' || target?.fcmToken) {
    return sendFcmPush(target.fcmToken, env, payload);
  }
  const subscription = target?.subscription || target;
  if (subscription?.keys?.p256dh && subscription?.keys?.auth) {
    try {
      const encrypted = await sendEncryptedPush(subscription, env, payload);
      if (encrypted.ok || encrypted.expired) return encrypted;
      console.warn('encrypted push failed, falling back to empty push:', encrypted.reason || encrypted.status);
      const fallback = await sendEmptyPush(subscription, env);
      return fallback.ok ? { ...fallback, payload: false, fallbackReason: encrypted.reason || String(encrypted.status || '') } : encrypted;
    } catch (err) {
      console.warn('encrypted push error, falling back to empty push:', err?.message || err);
      const fallback = await sendEmptyPush(subscription, env);
      return fallback.ok ? { ...fallback, payload: false, fallbackReason: String(err?.message || err).slice(0, 120) } : fallback;
    }
  }
  return sendEmptyPush(subscription, env);
}

let cachedFirebaseAccessToken = null;

async function sendFcmPush(fcmToken, env, payload = {}) {
  if (!fcmToken) return { ok: false, expired: true, reason: 'missing fcm token' };
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return { ok: false, reason: 'firebase service account is not configured' };
  }
  const accessToken = await getFirebaseAccessToken(env);
  const stringData = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (value !== undefined && value !== null) stringData[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        data: stringData,
        android: {
          priority: 'high',
          ttl: '86400s'
        }
      }
    })
  });
  const raw = await resp.text();
  if (resp.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(raw)) {
    return { ok: false, expired: true, status: resp.status, reason: 'fcm token expired' };
  }
  if (!resp.ok) return { ok: false, status: resp.status, reason: `fcm failed ${resp.status}: ${raw.slice(0, 180)}` };
  return { ok: true, status: resp.status, payload: true, transport: 'fcm' };
}

async function getFirebaseAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirebaseAccessToken?.token && cachedFirebaseAccessToken.expiresAt > now + 60) {
    return cachedFirebaseAccessToken.token;
  }
  const assertion = await createFirebaseServiceAccountJWT(env, now);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const json = await resp.json();
  if (!resp.ok || !json.access_token) throw new Error(`firebase oauth failed ${resp.status}: ${JSON.stringify(json).slice(0, 180)}`);
  cachedFirebaseAccessToken = {
    token: json.access_token,
    expiresAt: now + Math.max(60, Number(json.expires_in) || 3600)
  };
  return json.access_token;
}

async function createFirebaseServiceAccountJWT(env, now = Math.floor(Date.now() / 1000)) {
  const header = base64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64urlJson({
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    iat: now,
    exp: now + 3600
  });
  const unsigned = `${header}.${claims}`;
  const keyBytes = pemToBytes(env.FIREBASE_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}

function pemToBytes(value) {
  const base64 = String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, '');
  const binary = atob(base64);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

async function sendEncryptedPush(subscription, env, payload = {}) {
  const endpoint = subscription.endpoint;
  const aud = new URL(endpoint).origin;
  const jwt = await createVapidJWT(env, aud);
  const encrypted = await encryptPushPayload(subscription, JSON.stringify(payload));
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '60',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(encrypted.byteLength),
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    },
    body: encrypted
  });
  if (resp.status === 404 || resp.status === 410) return { ok: false, expired: true, status: resp.status };
  if (!resp.ok) return { ok: false, status: resp.status, reason: `push failed ${resp.status}: ${(await resp.text()).slice(0, 120)}` };
  return { ok: true, status: resp.status, payload: true };
}

async function sendEmptyPush(subscription, env) {
  const endpoint = subscription.endpoint;
  const aud = new URL(endpoint).origin;
  const jwt = await createVapidJWT(env, aud);
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '60',
      Urgency: 'high',
      'Content-Length': '0',
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    }
  });
  if (resp.status === 404 || resp.status === 410) return { ok: false, expired: true, status: resp.status };
  if (!resp.ok) return { ok: false, status: resp.status, reason: `push failed ${resp.status}: ${(await resp.text()).slice(0, 120)}` };
  return { ok: true, status: resp.status };
}

async function encryptPushPayload(subscription, payloadText) {
  const userPublicKeyBytes = base64urlToBytes(subscription.keys.p256dh);
  const authSecret = base64urlToBytes(subscription.keys.auth);
  const appServerKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const appServerPublicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', appServerKeys.publicKey));
  const userPublicKey = await crypto.subtle.importKey('raw', userPublicKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: userPublicKey }, appServerKeys.privateKey, 256));
  const authPrk = await hkdfExtract(authSecret, sharedSecret);
  const context = concatBytes(utf8('WebPush: info\0'), userPublicKeyBytes, appServerPublicKeyBytes);
  const ikm = await hkdfExpand(authPrk, context, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = concatBytes(utf8(payloadText), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plaintext));
  const recordSize = new Uint8Array([0, 0, 16, 0]);
  const keyLength = new Uint8Array([appServerPublicKeyBytes.byteLength]);
  return concatBytes(salt, recordSize, keyLength, appServerPublicKeyBytes, ciphertext);
}

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let previous = new Uint8Array(0);
  const chunks = [];
  let outputLength = 0;
  for (let counter = 1; outputLength < length; counter++) {
    const input = concatBytes(previous, info, new Uint8Array([counter]));
    previous = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
    chunks.push(previous);
    outputLength += previous.byteLength;
  }
  return concatBytes(...chunks).slice(0, length);
}

async function createVapidJWT(env, aud) {
  const header = base64urlJson({ typ: 'JWT', alg: 'ES256' });
  const payload = base64urlJson({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com'
  });
  const data = `${header}.${payload}`;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const der = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(data)));
  return `${data}.${base64url(der)}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function base64urlJson(value) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function base64urlToBytes(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '='.repeat((4 - text.length % 4) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
