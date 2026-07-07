// Cloudflare Worker: AL cloud timer.
//
// Bindings required:
// - KV namespace: AL_TIMER_KV
// - Secret VAPID_PRIVATE_JWK: P-256 private JWK JSON string with x/y/d
// - Variable VAPID_PUBLIC_KEY: base64url VAPID public key
// - Variable VAPID_SUBJECT: e.g. mailto:you@example.com
//
// Cron trigger: every 1 minute.
//
// This worker stores only timer metadata and push subscriptions:
// { deviceId, jobId, charId, dueAt, type }. It does not store chat, memory,
// role prompts, summaries, or API keys.
//
// Important quota note:
// Workers KV Free has a very small daily quota for list operations. Do not scan
// jobs with KV.list() every minute. Jobs are bucketed by due minute so the cron
// path only performs direct KV.get() calls.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response('', { headers: CORS });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'AL cloud timer' });
      }
      if (request.method === 'POST' && url.pathname === '/register') {
        const body = await request.json();
        if (!body.deviceId || !body.subscription?.endpoint) throw new Error('missing deviceId/subscription');
        await env.AL_TIMER_KV.put(`sub:${body.deviceId}`, JSON.stringify({
          deviceId: body.deviceId,
          subscription: body.subscription,
          updatedAt: Date.now()
        }));
        return json({ ok: true });
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
          updatedAt: Date.now()
        };
        await saveJob(job, env);
        return json({ ok: true, dueMinute: minuteKey(dueAtMs) });
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        const body = await request.json();
        if (body.jobId) await env.AL_TIMER_KV.delete(`job:${body.jobId}`);
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
        const delivered = await deliverJob(job, env);
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
  const nowMinute = Math.floor(Date.now() / 60000);
  const startMinute = nowMinute - 5;
  for (let minute = startMinute; minute <= nowMinute; minute++) {
    await runDueMinute(env, minute);
  }
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
  await env.AL_TIMER_KV.put(bucketKey, JSON.stringify(ids), { expirationTtl: 3 * 24 * 60 * 60 });
}

async function removeJobFromBucket(bucketKey, jobId, env) {
  const raw = await env.AL_TIMER_KV.get(bucketKey);
  if (!raw) return;
  const ids = JSON.parse(raw).filter(id => id !== jobId);
  if (ids.length) {
    await env.AL_TIMER_KV.put(bucketKey, JSON.stringify(ids), { expirationTtl: 3 * 24 * 60 * 60 });
  } else {
    await env.AL_TIMER_KV.delete(bucketKey);
  }
}

async function runDueMinute(env, minute) {
  const bucketKey = `due:${minute}`;
  const raw = await env.AL_TIMER_KV.get(bucketKey);
  if (!raw) return;
  const ids = JSON.parse(raw);
  const now = Date.now();
  const remaining = [];
  for (const jobId of ids) {
    const jobRaw = await env.AL_TIMER_KV.get(`job:${jobId}`);
    if (!jobRaw) continue;
    const job = JSON.parse(jobRaw);
    if (!job.dueAt) continue;
    const dueAtMs = Date.parse(job.dueAt);
    if (dueAtMs > now) {
      remaining.push(jobId);
      continue;
    }
    await deliverJob(job, env);
    await env.AL_TIMER_KV.delete(`job:${job.jobId}`);
  }
  if (remaining.length) {
    await env.AL_TIMER_KV.put(bucketKey, JSON.stringify(remaining), { expirationTtl: 3 * 24 * 60 * 60 });
  } else {
    await env.AL_TIMER_KV.delete(bucketKey);
  }
}

function minuteKey(ms) {
  return Math.ceil(ms / 60000);
}

async function deliverJob(job, env) {
  const subRaw = await env.AL_TIMER_KV.get(`sub:${job.deviceId}`);
  if (!subRaw) return { ok: false, reason: 'missing subscription', jobId: job.jobId };
  const { subscription } = JSON.parse(subRaw);
  await sendEmptyPush(subscription, env);
  return { ok: true, jobId: job.jobId, charId: job.charId || '', kind: job.kind || '' };
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
  if (!resp.ok && resp.status !== 404 && resp.status !== 410) {
    throw new Error(`push failed ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
  }
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

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
