// Cloudflare Worker: AL cloud timer.
//
// Bindings required:
// - KV namespace: AL_TIMER_KV
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
// { deviceId, jobId, charId, dueAt, type }. It does not store chat, memory,
// role prompts, summaries, or API keys.
//
// Important quota note:
// Workers KV Free has a very small daily quota. Do not scan jobs with KV.list()
// every minute. Dice jobs arrive with their successful roll already precomputed,
// so empty 10-minute rolls do not create KV writes or wake the phone.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const CLOUD_TIMER_WORKER_VERSION = '2026-07-11.10';
const RECENT_EVENT_LIMIT = 40;
const IDLE_CRON_HEARTBEAT_MINUTES = 10;
const JOB_BUCKET_TTL_SECONDS = 7 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response('', { headers: CORS });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'AL cloud timer', version: CLOUD_TIMER_WORKER_VERSION, cron: await getLastCron(env) });
      }
      if (request.method === 'GET' && url.pathname === '/logs') {
        return json({ ok: true, events: await getRecentEvents(env) });
      }
      if (request.method === 'POST' && url.pathname === '/register') {
        const body = await request.json();
        const isFcm = body.transport === 'fcm' || !!body.fcmToken;
        if (!body.deviceId || (!isFcm && !body.subscription?.endpoint) || (isFcm && !body.fcmToken)) {
          throw new Error('missing deviceId/push target');
        }
        await env.AL_TIMER_KV.put(`sub:${body.deviceId}`, JSON.stringify({
          deviceId: body.deviceId,
          transport: isFcm ? 'fcm' : 'webpush',
          fcmToken: isFcm ? String(body.fcmToken) : '',
          subscription: isFcm ? null : body.subscription,
          updatedAt: Date.now()
        }));
        await appendEvent(env, { type: 'register', deviceId: shortId(body.deviceId), transport: isFcm ? 'fcm' : 'webpush', ok: true });
        return json({ ok: true, transport: isFcm ? 'fcm' : 'webpush' });
      }
      if (request.method === 'POST' && url.pathname === '/schedule') {
        const body = await request.json();
        if (!body.deviceId || !body.jobId || !body.dueAt) throw new Error('missing deviceId/jobId/dueAt');
        const dueAtMs = Date.parse(body.dueAt);
        if (!Number.isFinite(dueAtMs)) throw new Error('invalid dueAt');
        const job = {
          deviceId: body.deviceId,
          jobId: body.jobId,
          charId: body.charId || '',
          dueAt: body.dueAt,
          type: body.type || 'proactive',
          kind: body.kind || (String(body.jobId || '').startsWith('mom_') ? 'moment' : 'chat'),
          mode: body.mode === 'dice' ? 'dice' : 'planned',
          rollChance: Number.isFinite(Number(body.rollChance)) ? Number(body.rollChance) : undefined,
          diceIntervalMs: Number.isFinite(Number(body.diceIntervalMs)) ? Number(body.diceIntervalMs) : undefined,
          diceRolls: Number.isFinite(Number(body.diceRolls)) ? Number(body.diceRolls) : undefined,
          dicePrecomputed: !!body.dicePrecomputed,
          test: !!body.test,
          updatedAt: Date.now()
        };
        await saveJob(job, env);
        await appendEvent(env, { type: 'schedule', deviceId: shortId(job.deviceId), jobId: job.jobId, charId: job.charId, kind: job.kind, dueAt: job.dueAt, ok: true });
        return json({ ok: true, dueMinute: minuteKey(dueAtMs) });
      }
      if (request.method === 'POST' && url.pathname === '/job-status') {
        const body = await request.json();
        if (!body.jobId) throw new Error('missing jobId');
        return json(await jobStatus(body.jobId, body.deviceId || '', env));
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        const body = await request.json();
        if (body.jobId) await cancelJob(body.jobId, env);
        await appendEvent(env, { type: 'cancel', deviceId: shortId(body.deviceId || ''), jobId: body.jobId || '', ok: true });
        return json({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/trigger') {
        const body = await request.json();
        if (!body.deviceId) throw new Error('missing deviceId');
        const job = body.jobId
          ? JSON.parse(await env.AL_TIMER_KV.get(`job:${body.jobId}`) || JSON.stringify(body))
          : body;
        job.deviceId = job.deviceId || body.deviceId;
        job.jobId = job.jobId || body.jobId || `manual:${body.deviceId}:${Date.now()}`;
        job.charId = job.charId || body.charId || '';
        job.type = job.type || 'proactive';
        job.kind = job.kind || body.kind || (String(job.jobId || '').startsWith('mom_') ? 'moment' : 'chat');
        job.test = !!(job.test || body.test);
        const delivered = await deliverJob(job, env);
        if (job.jobId && !delivered.retry) await cancelJob(job.jobId, env);
        await appendEvent(env, { type: 'manual-trigger', deviceId: shortId(job.deviceId), jobId: job.jobId, charId: job.charId, kind: job.kind, ok: delivered.ok, reason: delivered.reason || delivered.fallbackReason || '', retry: !!delivered.retry, payload: delivered.payload !== false });
        return json({ ok: delivered.ok, delivered });
      }
      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: err.message }, 400);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueJobs(env));
  }
};

async function runDueJobs(env) {
  const startedAt = Date.now();
  const nowMinute = Math.floor(startedAt / 60000);
  const startMinute = nowMinute - 5;
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
    for (let minute = startMinute; minute <= nowMinute; minute++) {
      const row = await runDueMinute(env, minute);
      summary.buckets += 1;
      summary.jobsSeen += row.jobsSeen;
      summary.delivered += row.delivered;
      summary.retry += row.retry;
      summary.failed += row.failed;
      summary.future += row.future;
      summary.missing += row.missing;
    }
  } catch (err) {
    summary.ok = false;
    summary.error = String(err?.message || err).slice(0, 180);
    throw err;
  } finally {
    summary.finishedAt = Date.now();
    const hasActivity = !summary.ok || summary.jobsSeen > 0 || summary.delivered > 0 || summary.retry > 0 || summary.failed > 0 || summary.missing > 0;
    const heartbeatDue = nowMinute % IDLE_CRON_HEARTBEAT_MINUTES === 0;
    if (hasActivity || heartbeatDue) {
      await env.AL_TIMER_KV.put('meta:lastCron', JSON.stringify(summary), { expirationTtl: 3 * 24 * 60 * 60 });
    }
    if (hasActivity) {
      await appendEvent(env, { type: 'cron', ok: summary.ok, buckets: summary.buckets, jobsSeen: summary.jobsSeen, delivered: summary.delivered, retry: summary.retry, failed: summary.failed, missing: summary.missing, error: summary.error });
    }
  }
}

async function getLastCron(env) {
  const raw = await env.AL_TIMER_KV.get('meta:lastCron');
  return raw ? JSON.parse(raw) : null;
}

async function saveJob(job, env) {
  const previousRaw = await env.AL_TIMER_KV.get(`job:${job.jobId}`);
  const previous = previousRaw ? JSON.parse(previousRaw) : null;
  const bucketKey = `due:${minuteKey(Date.parse(job.dueAt))}`;
  if (previous?.dueAt) {
    const previousBucketKey = `due:${minuteKey(Date.parse(previous.dueAt))}`;
    if (previousBucketKey !== bucketKey) await removeJobFromBucket(previousBucketKey, job.jobId, env);
  }
  await env.AL_TIMER_KV.put(`job:${job.jobId}`, JSON.stringify(job));
  const raw = await env.AL_TIMER_KV.get(bucketKey);
  const ids = raw ? JSON.parse(raw) : [];
  if (!ids.includes(job.jobId)) ids.push(job.jobId);
  await env.AL_TIMER_KV.put(bucketKey, JSON.stringify(ids), { expirationTtl: JOB_BUCKET_TTL_SECONDS });
}

async function removeJobFromBucket(bucketKey, jobId, env) {
  const raw = await env.AL_TIMER_KV.get(bucketKey);
  if (!raw) return;
  const ids = JSON.parse(raw).filter(id => id !== jobId);
  if (ids.length) {
    await env.AL_TIMER_KV.put(bucketKey, JSON.stringify(ids), { expirationTtl: JOB_BUCKET_TTL_SECONDS });
  } else {
    await env.AL_TIMER_KV.delete(bucketKey);
  }
}

async function cancelJob(jobId, env) {
  const raw = await env.AL_TIMER_KV.get(`job:${jobId}`);
  if (raw) {
    const job = JSON.parse(raw);
    const dueAtMs = Date.parse(job.dueAt || '');
    if (Number.isFinite(dueAtMs)) {
      await removeJobFromBucket(`due:${minuteKey(dueAtMs)}`, jobId, env);
    }
  }
  await env.AL_TIMER_KV.delete(`job:${jobId}`);
}

async function jobStatus(jobId, deviceId, env) {
  const raw = await env.AL_TIMER_KV.get(`job:${jobId}`);
  const job = raw ? JSON.parse(raw) : null;
  const dueAtMs = Date.parse(job?.dueAt || '');
  const dueMinute = Number.isFinite(dueAtMs) ? minuteKey(dueAtMs) : null;
  let bucketHasJob = false;
  if (dueMinute != null) {
    const bucketRaw = await env.AL_TIMER_KV.get(`due:${dueMinute}`);
    const ids = bucketRaw ? JSON.parse(bucketRaw) : [];
    bucketHasJob = ids.includes(jobId);
  }
  const subDeviceId = deviceId || job?.deviceId || '';
  const subRaw = subDeviceId ? await env.AL_TIMER_KV.get(`sub:${subDeviceId}`) : null;
  return {
    ok: true,
    jobId,
    exists: !!job,
    bucketHasJob,
    subscriptionExists: !!subRaw,
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

async function runDueMinute(env, minute) {
  const bucketKey = `due:${minute}`;
  const raw = await env.AL_TIMER_KV.get(bucketKey);
  const stats = { jobsSeen: 0, delivered: 0, retry: 0, failed: 0, future: 0, missing: 0 };
  if (!raw) return stats;
  const ids = JSON.parse(raw);
  stats.jobsSeen = ids.length;
  const now = Date.now();
  const remaining = [];
  for (const jobId of ids) {
    const jobRaw = await env.AL_TIMER_KV.get(`job:${jobId}`);
    if (!jobRaw) {
      stats.missing += 1;
      continue;
    }
    const job = JSON.parse(jobRaw);
    if (!job.dueAt) {
      stats.missing += 1;
      continue;
    }
    const dueAtMs = Date.parse(job.dueAt);
    if (dueAtMs > now) {
      stats.future += 1;
      remaining.push(jobId);
      continue;
    }
    try {
      const delivered = await deliverJob(job, env);
      await appendEvent(env, { type: 'deliver', deviceId: shortId(job.deviceId), jobId: job.jobId, charId: job.charId || '', kind: job.kind || '', ok: delivered.ok, reason: delivered.reason || delivered.fallbackReason || '', retry: !!delivered.retry, payload: delivered.payload !== false });
      if (delivered.retry) {
        stats.retry += 1;
        remaining.push(jobId);
      } else {
        if (delivered.ok) stats.delivered += 1;
        else stats.failed += 1;
        await env.AL_TIMER_KV.delete(`job:${job.jobId}`);
      }
    } catch (err) {
      console.warn(`deliver failed for ${jobId}:`, err.message);
      await appendEvent(env, { type: 'deliver-error', jobId, ok: false, reason: String(err?.message || err).slice(0, 160), retry: true });
      stats.failed += 1;
      remaining.push(jobId);
    }
  }
  if (remaining.length) {
    await env.AL_TIMER_KV.put(bucketKey, JSON.stringify(remaining), { expirationTtl: JOB_BUCKET_TTL_SECONDS });
  } else {
    await env.AL_TIMER_KV.delete(bucketKey);
  }
  return stats;
}

function minuteKey(ms) {
  return Math.ceil(ms / 60000);
}

async function deliverJob(job, env) {
  const subRaw = await env.AL_TIMER_KV.get(`sub:${job.deviceId}`);
  if (!subRaw) return { ok: false, reason: 'missing subscription', jobId: job.jobId, retry: false };
  const target = JSON.parse(subRaw);
  const result = await sendPush(target, env, {
    type: 'proactive',
    deviceId: job.deviceId || '',
    jobId: job.jobId || '',
    charId: job.charId || '',
    kind: job.kind || 'chat',
    mode: job.mode || 'planned',
    rollChance: job.rollChance,
    diceIntervalMs: job.diceIntervalMs,
    diceRolls: job.diceRolls,
    dicePrecomputed: !!job.dicePrecomputed,
    dueAt: job.dueAt || '',
    test: !!job.test
  });
  if (result.expired) {
    await env.AL_TIMER_KV.delete(`sub:${job.deviceId}`);
    return { ok: false, reason: 'subscription expired', jobId: job.jobId, retry: false };
  }
  if (!result.ok) return { ok: false, reason: result.reason || 'push failed', jobId: job.jobId, retry: true };
  return { ok: true, jobId: job.jobId, charId: job.charId || '', kind: job.kind || '', test: !!job.test, retry: false };
}

async function getRecentEvents(env) {
  const raw = await env.AL_TIMER_KV.get('meta:recentEvents');
  return raw ? JSON.parse(raw) : [];
}

async function appendEvent(env, event) {
  try {
    const events = await getRecentEvents(env);
    events.unshift({
      at: Date.now(),
      version: CLOUD_TIMER_WORKER_VERSION,
      ...event
    });
    await env.AL_TIMER_KV.put('meta:recentEvents', JSON.stringify(events.slice(0, RECENT_EVENT_LIMIT)), { expirationTtl: 3 * 24 * 60 * 60 });
  } catch (err) {
    console.warn('append event failed:', err?.message || err);
  }
}

function shortId(value) {
  const text = String(value || '');
  if (text.length <= 14) return text;
  return text.slice(0, 6) + '...' + text.slice(-5);
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
          ttl: '120s'
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
