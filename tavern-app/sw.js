const CACHE_NAME = 'rpchat-v2';
const APP_SHELL = ['./index.html', './manifest.json', './icon.svg', './sw.js'];
const MEMORY_DB_NAME = 'ALMemoryDB';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/chat/completions') || e.request.url.includes('/messages') || e.request.url.includes('/embeddings')) return;
  if (e.request.mode === 'navigate' || e.request.url.endsWith('/index.html')) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok) caches.open(CACHE_NAME).then(c => c.put('./index.html', resp.clone()));
        return resp;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok && e.request.method === 'GET') caches.open(CACHE_NAME).then(c => c.put(e.request, resp.clone()));
      return resp;
    })).catch(() => caches.match('./index.html'))
  );
});

function openMemoryDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MEMORY_DB_NAME, 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(storeName) {
  const db = await openMemoryDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function put(storeName, item) {
  const db = await openMemoryDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

async function getMeta(key, fallback = null) {
  const rows = await getAll('meta');
  return rows.find(r => r.key === key)?.value ?? fallback;
}

async function setMeta(key, value) {
  return put('meta', { key, value, updatedAt: Date.now() });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getTimeContext(date = new Date()) {
  const weekday = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][date.getDay()];
  return [
    `当前设备时间：${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
    `星期：${weekday}`,
    `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区'}`,
    `时间戳：${date.toISOString()}`
  ].join('\n');
}

function recentMessages(chat, count = 30) {
  return (chat?.messages || []).slice(-count);
}

function messageLine(m) {
  return `${m.role === 'user' ? '用户' : '角色'}：${m.content}`;
}

function buildMemoryPack(charId) {
  return Promise.all([
    getAll('summaries'),
    getAll('events'),
    getAll('profiles')
  ]).then(([summaries, events, profiles]) => {
    const latestSummaries = summaries.filter(r => r.charId === charId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 3).reverse();
    const importantEvents = events.filter(r => r.charId === charId).sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.createdAt - a.createdAt).slice(0, 8);
    const profileRows = profiles.filter(r => r.charId === charId).sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.createdAt - a.createdAt).slice(0, 8);
    const parts = [];
    if (latestSummaries.length) parts.push('近期增量摘要：\n' + latestSummaries.map(s => `- ${s.content}`).join('\n'));
    if (importantEvents.length) parts.push('重要事件和时间节点：\n' + importantEvents.map(e => `- ${e.happenedAt || '未注明'}｜${e.title || '事件'}：${e.detail}`).join('\n'));
    if (profileRows.length) parts.push('稳定资料和关系状态：\n' + profileRows.map(p => `- ${p.title || p.type || '资料'}：${p.detail}`).join('\n'));
    if (!parts.length) return '';
    return `以下是手机本地记忆库提供给你的参考。不要提到记忆库、系统、推送或后台，只把它自然转化成角色发来的微信消息。\n\n${parts.join('\n\n')}`;
  });
}

async function callModel(settings, system, messages) {
  const apiType = settings.chatApiType || settings.apiType || 'openai';
  const apiUrl = settings.chatApiUrl || settings.apiUrl || '';
  const apiKey = settings.chatApiKey || settings.apiKey || '';
  if (apiType === 'claude') {
    const resp = await fetch(apiUrl.replace(/\/+$/, '') + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: settings.chatModel || 'claude-sonnet-4-20250514', system, messages, max_tokens: Number(settings.maxTokens) || 1000, temperature: Number(settings.temperature) || 0.8, stream: false })
    });
    if (!resp.ok) throw new Error('API ' + resp.status);
    const json = await resp.json();
    return Array.isArray(json.content) ? json.content.map(p => p.text || '').join('') : (json.content || json.text || '');
  }
  const resp = await fetch(apiUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: settings.chatModel || 'gpt-4o', messages: [{ role: 'system', content: system }, ...messages], temperature: Number(settings.temperature) || 0.8, max_tokens: Number(settings.maxTokens) || 1000, stream: false })
  });
  if (!resp.ok) throw new Error('API ' + resp.status);
  const json = await resp.json();
  return json.choices?.[0]?.message?.content || json.output_text || '';
}

async function notifyClients(data) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(data));
}

async function handleProactivePush(payload) {
  const state = await getMeta('app_state', null);
  if (!state?.settings || !state?.allChats) throw new Error('missing local state');
  const { settings, characters, allChats } = state;
  const charId = payload.charId || findDueProactiveCharId(allChats);
  if (!charId) throw new Error('missing char id');
  const char = (characters || []).find(c => c.id === charId);
  const chat = allChats[charId];
  if (!char || !chat?.messages?.length) throw new Error('missing chat');
  if (!(settings.chatApiUrl || settings.apiUrl) || !(settings.chatApiKey || settings.apiKey) || !settings.chatModel) throw new Error('missing api config');

  const memoryPack = await buildMemoryPack(charId);
  let system = chat.charPrompt || `当前你要扮演的角色：${char.name}`;
  system += '\n\n当前设备时间（角色可以自然参考，但不要说自己看到了系统时间）：\n' + getTimeContext();
  if (memoryPack) system += '\n\n' + memoryPack;
  if (settings.systemPrompt) system += '\n\n' + settings.systemPrompt;
  if (chat.extraPrompt) system += '\n\n' + chat.extraPrompt;
  system += `\n\n主动消息任务：现在不是用户刚刚发消息后等你回答，而是经过了一段空闲时间后，你作为${char.name}主动给用户发来一条消息。
你应该根据时间流逝、你上一条说过的话、未解决话题、约定或关系状态主动开口。
可以延续上一话题、补充上一句、关心用户、提起约定、找一个符合角色的自然话题。
只能输出消息正文。禁止动作、神态、环境、旁白、心理描写、系统说明、推送说明、定时器说明，禁止替用户说话。默认 1-3 句。`;

  const messages = recentMessages(chat, 30).map(m => ({ role: m.role, content: m.content }));
  const reply = (await callModel(settings, system, messages)).trim() || '在吗？';
  chat.messages.push({ role: 'assistant', content: reply, time: Date.now(), proactive: true });
  chat.unread = (chat.unread || 0) + 1;
  chat.lastProactiveAt = Date.now();
  if (chat.pendingProactiveJob?.jobId === payload.jobId || payload.jobId) delete chat.pendingProactiveJob;
  state.allChats = allChats;
  state.updatedAt = Date.now();
  await setMeta('app_state', state);
  await notifyClients({ type: 'al-state-updated', charId, reply });
  await self.registration.showNotification(char.name || 'AL', {
    body: reply,
    tag: `al-${charId}`,
    data: { charId, url: './index.html' },
    icon: './icon.svg',
    badge: './icon.svg'
  });
}

function findDueProactiveCharId(allChats) {
  const now = Date.now();
  const rows = Object.entries(allChats || {}).map(([charId, chat]) => ({ charId, chat, job: chat?.pendingProactiveJob }));
  const due = rows
    .filter(r => r.job?.dueAt && Date.parse(r.job.dueAt) <= now)
    .sort((a, b) => Date.parse(a.job.dueAt) - Date.parse(b.job.dueAt))[0];
  if (due) return due.charId;
  return rows
    .filter(r => r.chat?.messages?.length)
    .sort((a, b) => (b.chat.messages[b.chat.messages.length - 1]?.time || 0) - (a.chat.messages[a.chat.messages.length - 1]?.time || 0))[0]?.charId || '';
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = { type: 'proactive' }; }
    if (payload.type && payload.type !== 'proactive') {
      await self.registration.showNotification('AL', { body: '有新的主动消息提醒', icon: './icon.svg' });
      return;
    }
    try {
      await handleProactivePush(payload);
    } catch (err) {
      await self.registration.showNotification('AL', {
        body: '主动消息生成失败，打开 AL 后会继续尝试。',
        tag: 'al-proactive-error',
        data: { url: './index.html' },
        icon: './icon.svg'
      });
      console.warn('[AL Push]', err);
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = event.notification.data?.url || './index.html';
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
