const CACHE_NAME = 'rpchat-v22';
const APP_SHELL = ['./index.html', './manifest.json', './icon.svg', './sw-v11.js'];
const MEMORY_DB_NAME = 'ALMemoryDB';
const MEMORY_DB_VERSION = 2;
const PROACTIVE_JOB_KINDS = ['chat', 'moment'];
const API_TIMEOUT_MS = 120000;
const CALL_LOG_LIMIT = 30;
const VECTOR_DIM = 384;
const MEMORY_PACK_CHAR_BUDGET = 3600;
const MEMORY_LINE_CHAR_LIMIT = 360;
const REDPACKET_EXPIRE_MS = 24 * 60 * 60 * 1000;
let lastModelResponseDiagnostic = '';

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
  if (/\/sw-v\d+\.js(?:$|\?)/.test(new URL(e.request.url).pathname)) {
    e.respondWith(fetch(e.request));
    return;
  }
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
    const req = indexedDB.open(MEMORY_DB_NAME, MEMORY_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const ensure = (name, indexes = []) => {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
        } else {
          store = req.transaction.objectStore(name);
        }
        indexes.forEach(([idx, key]) => {
          if (!store.indexNames.contains(idx)) store.createIndex(idx, key, { unique: false });
        });
      };
      ensure('summaries', [['charId', 'charId'], ['createdAt', 'createdAt']]);
      ensure('events', [['charId', 'charId'], ['status', 'status'], ['createdAt', 'createdAt']]);
      ensure('profiles', [['charId', 'charId'], ['type', 'type'], ['createdAt', 'createdAt']]);
      ensure('vectors', [['charId', 'charId'], ['sourceId', 'sourceId'], ['sourceType', 'sourceType']]);
      if (db.objectStoreNames.contains('meta') && req.transaction.objectStore('meta').keyPath !== 'key') {
        db.deleteObjectStore('meta');
      }
      ensure('meta', [['updatedAt', 'updatedAt']]);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll(storeName) {
  const db = await openMemoryDB();
  if (!db.objectStoreNames.contains(storeName)) return [];
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

function redactSensitiveText(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ***')
    .replace(/x-api-key["':\s]+[A-Za-z0-9._\-]{8,}/gi, 'x-api-key ***');
}

function compactLogText(text, max = 1200) {
  const value = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function cleanApiKey(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\r\n\t]/g, '')
    .trim();
}

async function recordModelCall(entry = {}) {
  try {
    const startedAt = Number(entry.startedAt) || Date.now();
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    const promptBlocks = Array.isArray(entry.promptBlocks) ? entry.promptBlocks : [];
    const logs = await getMeta('call_logs', []);
    logs.unshift({
      id: `call_${startedAt}_${Math.random().toString(36).slice(2, 7)}`,
      at: startedAt,
      time: formatFullTime(new Date(startedAt)),
      durationMs: Math.max(0, Date.now() - startedAt),
      kind: entry.kind || 'chat',
      scene: entry.scene || '',
      provider: entry.provider || '',
      model: entry.model || '',
      charId: entry.charId || '',
      ok: entry.ok !== false,
      empty: !!entry.empty,
      diagnostic: compactLogText(entry.diagnostic || '', 600),
      error: compactLogText(entry.error || '', 600),
      systemChars: String(entry.system || '').length,
      messageCount: messages.length,
      memoryChars: Number(entry.memoryChars) || 0,
      memoryStatus: compactLogText(entry.memoryStatus || '', 240),
      promptBlocks: promptBlocks.slice(0, 20).map(block => ({
        id: compactLogText(block.id || '', 80),
        priority: Number(block.priority) || 0,
        chars: Number(block.chars) || 0,
        preview: compactLogText(block.preview || '', 180)
      })),
      systemPreview: compactLogText(entry.system, 1800),
      messagesPreview: messages.slice(-4).map(m => ({ role: m.role || '', content: compactLogText(m.content, 360) })),
      outputPreview: compactLogText(entry.output, 600)
    });
    await setMeta('call_logs', logs.slice(0, CALL_LOG_LIMIT));
  } catch (err) {
    console.warn('[AL SW CallLog] skipped:', err.message);
  }
}

function setStateCloudTimerStatus(state, message, kind = 'general') {
  if (!state?.settings) return;
  const now = Date.now();
  if (kind === 'chat') {
    state.settings.cloudTimerLastChatStatus = message;
    state.settings.cloudTimerLastChatStatusAt = now;
  } else if (kind === 'moment') {
    state.settings.cloudTimerLastMomentStatus = message;
    state.settings.cloudTimerLastMomentStatusAt = now;
  } else {
    state.settings.cloudTimerLastStatus = message;
    state.settings.cloudTimerLastStatusAt = now;
  }
}

function setStateCloudTimerTriggerAck(state, message) {
  if (!state?.settings) return;
  state.settings.cloudTimerLastTriggerAckStatus = message;
  state.settings.cloudTimerLastTriggerAckAt = Date.now();
}

function setStateCloudTimerTrace(state, kind = 'chat', traceId = '', message = '') {
  if (!state?.settings) return;
  const line = [traceId, message].filter(Boolean).join('｜');
  const now = Date.now();
  if (kind === 'moment') {
    state.settings.cloudTimerLastMomentTrace = line;
    state.settings.cloudTimerLastMomentTraceAt = now;
  } else {
    state.settings.cloudTimerLastChatTrace = line;
    state.settings.cloudTimerLastChatTraceAt = now;
  }
}

function setMemoryQueryStatus(settings = {}, message) {
  settings.lastMemoryQueryStatus = message;
  settings.lastMemoryQueryAt = Date.now();
}
function memoryQuerySnapshot(settings = {}) {
  return settings.lastMemoryQueryStatus
    ? `${settings.lastMemoryQueryAt ? formatFullTime(new Date(settings.lastMemoryQueryAt)) + '｜' : ''}${settings.lastMemoryQueryStatus}`
    : '';
}
function memoryPackBudgetStatus(memoryPack = '') {
  const match = String(memoryPack || '').match(/预算提示：已省略\s*(\d+)\s*条低优先级记忆/);
  return match ? `记忆预算：已省略 ${match[1]} 条低优先级记忆。` : '';
}
function memoryStatusWithBudget(memoryPack = '', baseStatus = '') {
  const base = String(baseStatus || '').trim();
  const budget = memoryPackBudgetStatus(memoryPack);
  if (!budget || /记忆预算：已省略/.test(base)) return base;
  return [base, budget].filter(Boolean).join('\n');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getDayPeriod(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return { label: '凌晨', range: '00:00-04:59', banned: '早上、上午、中午、下午、傍晚' };
  if (h < 8) return { label: '清晨', range: '05:00-07:59', banned: '半夜三更、深夜、下午、晚上' };
  if (h < 11) return { label: '上午', range: '08:00-10:59', banned: '半夜三更、深夜、下午、晚上' };
  if (h < 13) return { label: '中午', range: '11:00-12:59', banned: '半夜三更、深夜、清晨、晚上' };
  if (h < 18) return { label: '下午', range: '13:00-17:59', banned: '半夜三更、深夜、凌晨、早上、上午、晚上' };
  if (h < 22) return { label: '晚上', range: '18:00-21:59', banned: '半夜三更、凌晨、早上、上午、下午' };
  return { label: '深夜', range: '22:00-23:59', banned: '早上、上午、中午、下午、傍晚' };
}

function getTimeContext(date = new Date()) {
  const weekday = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][date.getDay()];
  const period = getDayPeriod(date);
  return [
    `当前设备时间：${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
    `当前时段：${period.label}（${period.range}）`,
    `星期：${weekday}`,
    `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区'}`,
    `时间戳：${date.toISOString()}`,
    `时间表达规则：角色不需要刻意报出具体时间；只要涉及时间、时段、作息或类似“半夜三更”的说法，就必须符合当前时段。禁止使用与当前时段矛盾的说法：${period.banned}。`
  ].join('\n');
}

function formatFullTime(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatElapsed(ms) {
  const minutes = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const hourRest = hours % 24;
  return hourRest ? `${days} 天 ${hourRest} 小时` : `${days} 天`;
}

function latestMessageByRole(chat, role) {
  return (chat?.messages || []).slice().reverse().find(m => m.role === role) || null;
}

function messageTimeLine(label, msg, now = new Date()) {
  if (!msg?.time) return `${label}：无`;
  const at = new Date(msg.time);
  const elapsed = formatElapsed(now.getTime() - at.getTime());
  const content = String(msg.content || '').replace(/\s+/g, ' ').slice(0, 120);
  return `${label}：${formatFullTime(at)}（距现在 ${elapsed}）｜${msg.role === 'user' ? '用户' : '角色'}：${content}`;
}

function buildProactiveTimeContext(chat, now = new Date()) {
  const messages = chat?.messages || [];
  const last = messages[messages.length - 1] || null;
  const lastUser = latestMessageByRole(chat, 'user');
  const lastAssistant = latestMessageByRole(chat, 'assistant');
  const lastElapsedMinutes = last?.time ? Math.round((now.getTime() - last.time) / 60000) : 0;
  const mode = lastElapsedMinutes >= 60
    ? '长间隔重新开口'
    : lastElapsedMinutes >= 15
      ? '中等间隔自然续聊'
      : '短间隔可轻续聊';
  return [
    '主动消息时间流逝上下文：',
    `当前时间：${formatFullTime(now)}`,
    messageTimeLine('最后一条消息', last, now),
    messageTimeLine('上一条用户消息', lastUser, now),
    messageTimeLine('上一条角色消息', lastAssistant, now),
    `智能策略：${mode}`,
    '硬性要求：这不是用户刚刚发消息后等你回答，而是隔了一段空闲时间后你主动打开微信来发消息。',
    '如果距离最后一条消息超过 15 分钟，必须让回复自然体现时间流逝，不要像秒回一样接上一句。',
    '如果距离最后一条消息超过 60 分钟，默认不要直接回答上一条话题；除非上一条包含未完成约定、强烈情绪或必须接住的关键信息，否则应像重新开口一样发起自然消息。',
    '不要提到系统时间、提示词、后台、推送或定时器。'
  ].join('\n');
}

function buildProactiveTriggerMessage(settings = {}, char, chat, now = new Date()) {
  const visible = (chat?.messages || []).filter(m => !m.hidden);
  const last = visible[visible.length - 1] || null;
  const elapsed = last?.time ? formatElapsed(now.getTime() - last.time) : '未知时长';
  return [
    `【内部主动触发｜这不是${playerName(settings)}发来的聊天消息】`,
    `现在需要由${charName(char)}主动给${playerName(settings)}发一条微信私聊。`,
    `最后一条可见聊天距现在：${elapsed}。`,
    `请把它当成${charName(char)}隔了一段时间后主动打开聊天，而不是回答${playerName(settings)}刚刚提出的问题。`,
    `只输出${charName(char)}要发出的聊天正文；不要解释触发原因，不要提到系统、后台、推送或定时器。`
  ].join('\n');
}

function recentMessages(chat, count = 30) {
  return (chat?.messages || []).slice(-count);
}

function proactiveRecentMessages(chat, count = 30, now = new Date()) {
  return recentMessages(chat, count).map(m => {
    const at = m.time ? new Date(m.time) : null;
    const stamp = at ? `发送时间 ${formatFullTime(at)}，距现在 ${formatElapsed(now.getTime() - at.getTime())}` : '发送时间未知';
    return { role: m.role, content: `【${stamp}】${m.content}` };
  });
}

function createPromptComposer(scene) {
  const blocks = [];
  return {
    add(id, content, options = {}) {
      const value = String(content || '').trim();
      if (!value) return;
      const scenes = Array.isArray(options.scenes) ? options.scenes : null;
      if (scenes && !scenes.includes(scene)) return;
      blocks.push({
        id,
        content: value,
        priority: Number.isFinite(options.priority) ? options.priority : 100
      });
    },
    compile() {
      return blocks
        .sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))
        .map(block => block.content)
        .filter(Boolean)
        .join('\n\n');
    },
    blocks() {
      return blocks.slice().sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
    }
  };
}

function promptBlockDiagnostics(blocks = []) {
  return blocks.map(block => ({
    id: block.id,
    priority: block.priority,
    chars: String(block.content || '').length,
    preview: compactLogText(block.content, 180)
  }));
}

function splitAssistantOutput(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/\n+/)
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [normalized];
}

function isEmptyReplyText(text) {
  const value = String(text || '').trim();
  return !value || value === '（对方没有回复）' || value === '(对方没有回复)' || value === '对方没有回复';
}

function scrubEmptyReplyMessages(allChats) {
  let changed = false;
  Object.values(allChats || {}).forEach(chat => {
    if (!Array.isArray(chat?.messages)) return;
    const next = chat.messages.filter(m => !(m.role === 'assistant' && isEmptyReplyText(m.content)));
    if (next.length !== chat.messages.length) {
      chat.messages = next;
      changed = true;
    }
  });
  return changed;
}

function textFromContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join('');
  if (typeof value === 'object') {
    return textFromContent(value.text)
      || textFromContent(value.content)
      || textFromContent(value.output_text)
      || textFromContent(value.parts)
      || textFromContent(value.value)
      || textFromContent(value.data)
      || textFromContent(value.response)
      || textFromContent(value.result)
      || textFromContent(value.message?.content);
  }
  return String(value || '');
}

function extractResponseText(json) {
  const choice = json?.choices?.[0] || {};
  return (
    textFromContent(choice?.message?.content)
    || textFromContent(choice?.message?.text)
    || textFromContent(choice?.delta?.content)
    || textFromContent(choice?.text)
    || textFromContent(json?.candidates?.[0]?.content?.parts)
    || textFromContent(json?.candidates?.[0]?.content)
    || textFromContent(json?.output_text)
    || textFromContent(json?.output)
    || textFromContent(json?.content)
    || textFromContent(json?.text)
  ).trim();
}
function streamDeltaText(json) {
  const choice = json?.choices?.[0] || {};
  return (
    textFromContent(choice?.delta?.content)
    || textFromContent(choice?.message?.content)
    || textFromContent(choice?.text)
    || textFromContent(json?.delta?.text)
    || textFromContent(json?.content_block?.text)
    || textFromContent(json?.candidates?.[0]?.content?.parts)
    || textFromContent(json?.candidates?.[0]?.content)
    || textFromContent(json?.output_text)
    || textFromContent(json?.content)
    || textFromContent(json?.text)
  ).trim();
}

function extractJson(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('记忆模型没有返回 JSON');
}

function compactRawResponse(raw) {
  return String(raw || '').replace(/\s+/g, ' ').slice(0, 220);
}
function responseDiagnostic(json, raw = '') {
  const choice = json?.choices?.[0] || {};
  const message = choice?.message || {};
  const parts = [];
  if (choice.finish_reason || choice.finishReason) parts.push(`finish=${choice.finish_reason || choice.finishReason}`);
  if (json?.candidates?.[0]?.finishReason) parts.push(`finish=${json.candidates[0].finishReason}`);
  if (json?.promptFeedback?.blockReason) parts.push(`blocked=${json.promptFeedback.blockReason}`);
  if (message && Object.keys(message).length) parts.push(`message字段=${Object.keys(message).join(',')}`);
  if (textFromContent(message.reasoning_content || message.reasoning || message.reasoning_text)) parts.push('只发现 reasoning 内容，没有最终正文');
  const textKeys = ['content', 'text', 'output_text', 'output'].filter(k => json?.[k] != null);
  if (textKeys.length) parts.push(`顶层字段=${textKeys.join(',')}`);
  const rawTip = compactRawResponse(raw);
  if (rawTip) parts.push(`响应片段=${rawTip}`);
  return parts.join('；') || '接口返回 200，但没有可解析的正文';
}

function parseJsonFallbackText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const dataLines = lines
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => line.slice(6).trim())
    .filter(Boolean);
  const candidates = dataLines.length ? dataLines : [text];
  for (const item of candidates.reverse()) {
    try {
      const parsed = JSON.parse(item);
      const value = streamDeltaText(parsed) || extractResponseText(parsed);
      if (value) return value;
    } catch {}
  }
  return '';
}

async function readStreamText(resp) {
  if (!resp.body?.getReader) {
    return parseJsonFallbackText(await resp.text());
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';
  let raw = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
      try {
        const parsed = JSON.parse(t.slice(6));
        const delta = streamDeltaText(parsed);
        if (delta) result += delta;
      } catch {}
    }
  }
  if (!result.trim()) result = parseJsonFallbackText(raw + buffer);
  return result.trim();
}

async function fetchWithTimeout(url, options, timeoutMs = API_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('连接超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function appendAssistantMessages(chat, text, extra = {}) {
  const parts = splitAssistantOutput(text);
  const chunks = parts.filter(part => !isEmptyReplyText(part));
  if (!chunks.length) return [];
  const baseTime = Date.now();
  chunks.forEach((content, index) => {
    chat.messages.push({ role: 'assistant', content, time: baseTime + index * 1000, ...extra });
  });
  return chunks;
}

function playerName(settings = {}) {
  return (settings.playerName || '玩家').trim() || '玩家';
}

function charName(char) {
  return char?.name || '对方';
}

function formatMoney(value) {
  return '¥' + (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}

function memoryAliasText(text, char, settings = {}) {
  return String(text || '')
    .replace(/用户/g, playerName(settings))
    .replace(/角色/g, charName(char));
}

function momentSnippet(text, max = 90) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function buildBackgroundMomentContext(allMoments, characters, charId, settings = {}, limit = 6) {
  if (!Array.isArray(allMoments) || !allMoments.length) return '';
  const rows = allMoments
    .filter(moment => {
      if (moment.authorType === 'player') return true;
      if (moment.charId === charId) return true;
      if ((moment.likes || []).includes(charId)) return true;
      return (moment.comments || []).some(c => c.charId === charId);
    })
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .slice(0, limit);
  if (!rows.length) return '';
  const lines = rows.map(moment => {
    const author = moment.authorType === 'player'
      ? playerName(settings)
      : charName((characters || []).find(c => c.id === moment.charId));
    const parts = [`${formatFullTime(new Date(moment.time || Date.now()))}｜${author}发了朋友圈：“${momentSnippet(moment.text, 80)}”`];
    if ((moment.likes || []).includes(charId)) parts.push(`${charName((characters || []).find(c => c.id === charId))}点过赞`);
    const ownComments = (moment.comments || []).filter(c => c.charId === charId);
    ownComments.forEach(c => parts.push(`${charName((characters || []).find(ch => ch.id === charId))}评论过：“${momentSnippet(c.text, 60)}”`));
    return `- ${parts.join('；')}`;
  });
  return `以下是最近朋友圈上下文，角色可以自然记得自己看过、点赞过、评论过或发过的动态；不要提到“系统记录/上下文”。\n${lines.join('\n')}`;
}

function memoryTextHasSignal(text) {
  const value = String(text || '');
  return /(承诺|约定|答应|计划|以后|下次|明天|今晚|周|红包|金额|欠|补偿|道歉|和好|吵|争执|生气|雷点|不喜欢|介意|边界|称呼|关系|喜欢|讨厌|职业|年龄|生日|住|城市|家|学校|公司|重要|不能忘|必须记)/.test(value);
}

function memoryTextIsNoise(text) {
  const value = String(text || '');
  return /(测试|校对|表快|表慢|几点|现在时间|AI身份|身份争论|是不是AI|名字.*合理|戏太多|科幻片|装神弄鬼|普通寒暄|你好|在吗|又来)/.test(value)
    && !memoryTextHasSignal(value.replace(/测试|校对|几点|AI身份|身份争论/g, ''));
}
function normalizeVector(vec) {
  const norm = Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0)) || 1;
  return vec.map(n => n / norm);
}
function hashText(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function localEmbedding(text, dim = VECTOR_DIM) {
  const vec = new Array(dim).fill(0);
  const raw = String(text || '').toLowerCase();
  const tokens = raw.match(/[a-z0-9_]+|[\u4e00-\u9fa5]/g) || [];
  const grams = [];
  for (let i = 0; i < tokens.length; i += 1) {
    grams.push(tokens[i]);
    if (i < tokens.length - 1) grams.push(tokens[i] + tokens[i + 1]);
    if (i < tokens.length - 2) grams.push(tokens[i] + tokens[i + 1] + tokens[i + 2]);
  }
  (grams.length ? grams : [raw]).forEach((token, i) => {
    const h = hashText(token);
    const idx = h % dim;
    const sign = h & 1 ? 1 : -1;
    vec[idx] += sign * (i < tokens.length ? 1 : 0.55);
  });
  return normalizeVector(vec);
}
function cosine(a, b) {
  const len = Math.min(a?.length || 0, b?.length || 0);
  if (!len) return 0;
  let dot = 0;
  for (let i = 0; i < len; i += 1) dot += a[i] * b[i];
  return dot;
}
function memorySignalTerms(text = '', extraKeywords = []) {
  const value = String(text || '');
  const terms = new Set();
  const signalWords = ['红包', '转账', '收款', '退款', '余额', '约定', '承诺', '答应', '计划', '明天', '今晚', '周末', '下次', '道歉', '和好', '吵架', '生气', '雷点', '边界', '称呼', '关系', '喜欢', '讨厌', '生日', '职业', '城市', '住址', '学校', '公司', '朋友圈', '评论', '点赞'];
  signalWords.forEach(word => { if (value.includes(word)) terms.add(word); });
  String(value).split(/[^\p{L}\p{N}]+/gu).forEach(token => {
    const t = token.trim();
    if (/^[a-z0-9_-]{2,}$/i.test(t)) terms.add(t.toLowerCase());
  });
  (extraKeywords || []).forEach(keyword => {
    const word = String(keyword || '').trim();
    if (word && word.length <= 24) terms.add(word);
  });
  return [...terms];
}
function scoreKeywordMemoryText(text, terms = [], importance = 0) {
  return keywordMemoryActivation({ text, terms, importance }).score;
}
function keywordMemoryActivation({ text = '', terms = [], importance = 0, keywords = [], type = '', status = '', createdAt = 0 } = {}) {
  const value = String(text || '').toLowerCase();
  if (!value || memoryTextIsNoise(value)) return { score: 0, reasons: [] };
  const reasons = [];
  let score = Math.min(4, Number(importance) || 0) * 0.12;
  const matched = new Set();
  for (const term of terms) {
    const t = String(term || '').toLowerCase();
    if (t && value.includes(t)) {
      matched.add(term);
      score += t.length >= 3 ? 1 : 0.7;
    }
  }
  const keywordMatches = (keywords || []).filter(keyword => {
    const raw = String(keyword || '').trim();
    return raw && terms.some(term => String(term || '').toLowerCase() === raw.toLowerCase());
  });
  if (keywordMatches.length) {
    keywordMatches.slice(0, 3).forEach(keyword => matched.add(keyword));
    score += Math.min(2.4, keywordMatches.length * 1.2);
    reasons.push(`关键词:${keywordMatches.slice(0, 3).join('/')}`);
  }
  const importantTypes = ['promise', 'payment', 'moment', 'conflict', 'reconcile', 'preference', 'relationship', 'plan'];
  if (importantTypes.includes(String(type || ''))) {
    score += 0.25;
    reasons.push(`类型:${type}`);
  }
  if (String(status || '') === 'open') {
    score += 0.35;
    reasons.push('未完成');
  }
  const ageMs = Date.now() - Number(createdAt || 0);
  if (Number.isFinite(ageMs) && ageMs > 0 && ageMs < 7 * 24 * 60 * 60 * 1000) {
    score += 0.2;
    reasons.push('近期');
  }
  if (matched.size && !reasons.some(reason => reason.startsWith('关键词:'))) {
    reasons.push(`命中:${[...matched].slice(0, 3).join('/')}`);
  }
  return { score, reasons: reasons.slice(0, 4) };
}
function searchKeywordMemoryRows(rows = {}, queryText = '', queryKeywords = [], char = null, settings = {}, limit = 5) {
  const terms = memorySignalTerms(queryText, queryKeywords);
  if (!terms.length) return [];
  const candidates = [];
  for (const e of rows.events || []) {
    const text = memoryAliasText([e.happenedAt, e.title, e.detail, ...(e.keywords || [])].filter(Boolean).join('｜'), char, settings);
    if (!shouldKeepEvent(e)) continue;
    const activation = keywordMemoryActivation({ text, terms, importance: e.importance || 3, keywords: e.keywords || [], type: e.type || 'event', status: e.status || '', createdAt: e.createdAt || 0 });
    candidates.push({ sourceType: 'event', sourceId: e.id, text, importance: e.importance || 3, score: activation.score, reason: activation.reasons.join('，') });
  }
  for (const p of rows.profiles || []) {
    const text = memoryAliasText([p.title, p.detail, ...(p.keywords || [])].filter(Boolean).join('｜'), char, settings);
    if (!shouldKeepProfile(p)) continue;
    const activation = keywordMemoryActivation({ text, terms, importance: p.importance || 3, keywords: p.keywords || [], type: p.type || 'profile', createdAt: p.createdAt || 0 });
    candidates.push({ sourceType: 'profile', sourceId: p.id, text, importance: p.importance || 3, score: activation.score, reason: activation.reasons.join('，') });
  }
  for (const s of rows.summaries || []) {
    const text = memoryAliasText(s.content, char, settings);
    if (!shouldKeepSummary(text)) continue;
    const activation = keywordMemoryActivation({ text, terms, importance: 2, keywords: s.keywords || [], type: 'summary', createdAt: s.createdAt || 0 });
    candidates.push({ sourceType: 'summary', sourceId: s.id, text, importance: 2, score: activation.score, reason: activation.reasons.join('，') });
  }
  return candidates
    .filter(item => item.score >= 1)
    .sort((a, b) => b.score - a.score || (b.importance || 0) - (a.importance || 0))
    .slice(0, limit);
}

function shouldKeepEvent(e) {
  const type = String(e?.type || '');
  const importance = Number(e?.importance) || 0;
  const text = [e?.title, e?.detail, e?.happenedAt, ...(e?.keywords || [])].join(' ');
  if (!e?.detail || memoryTextIsNoise(text)) return false;
  if (['promise', 'conflict', 'reconcile', 'preference', 'relationship', 'plan'].includes(type)) return importance >= 3 || memoryTextHasSignal(text);
  return importance >= 4 && memoryTextHasSignal(text);
}

function shouldKeepProfile(p) {
  const importance = Number(p?.importance) || 0;
  const text = [p?.title, p?.detail, ...(p?.keywords || [])].join(' ');
  if (!p?.detail || memoryTextIsNoise(text)) return false;
  return importance >= 4 || memoryTextHasSignal(text);
}

function shouldKeepSummary(summary) {
  const text = String(summary || '');
  return text.length >= 20 && !memoryTextIsNoise(text) && memoryTextHasSignal(text);
}

function trimMemoryLine(text, max = MEMORY_LINE_CHAR_LIMIT) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, Math.max(20, max - 1)) + '…';
}

function composeMemoryPackSections(prefix, sections = [], budget = MEMORY_PACK_CHAR_BUDGET) {
  const ordered = sections
    .map(section => ({
      title: String(section.title || '').trim(),
      priority: Number(section.priority) || 100,
      lines: (section.lines || []).map(line => trimMemoryLine(line)).filter(Boolean)
    }))
    .filter(section => section.title && section.lines.length)
    .sort((a, b) => a.priority - b.priority);
  if (!ordered.length) return '';
  const keptSections = [];
  let used = String(prefix || '').length + 2;
  let omitted = 0;
  for (const section of ordered) {
    const headerCost = section.title.length + 2;
    if (used + headerCost > budget) {
      omitted += section.lines.length;
      continue;
    }
    const keptLines = [];
    used += headerCost;
    for (const line of section.lines) {
      const rendered = `- ${line}`;
      const cost = rendered.length + 1;
      if (used + cost > budget) {
        omitted++;
        continue;
      }
      keptLines.push(rendered);
      used += cost;
    }
    if (keptLines.length) keptSections.push(`${section.title}：\n${keptLines.join('\n')}`);
  }
  if (!keptSections.length) return '';
  if (omitted) keptSections.push(`预算提示：已省略 ${omitted} 条低优先级记忆，优先保留近期摘要、向量命中、未完成承诺和关键词强命中。`);
  return `${prefix}\n\n${keptSections.join('\n\n')}`;
}

function messageLine(m, char, settings = {}) {
  return `${m.role === 'user' ? playerName(settings) : charName(char)}：${m.content}`;
}

async function searchMemoryVectors(charId, queryText, limit = 8) {
  const queryVector = localEmbedding(queryText);
  const rows = (await getAll('vectors')).filter(row => row.charId === charId);
  return rows
    .map(row => ({ ...row, score: cosine(queryVector, row.embedding) }))
    .filter(row => row.score > 0.18 && !memoryTextIsNoise(row.text))
    .sort((a, b) => (b.score + (b.importance || 0) * 0.015) - (a.score + (a.importance || 0) * 0.015))
    .slice(0, limit);
}

async function recordBackgroundRedpacketExpirationMemory(state, charId, msg, now = Date.now()) {
  if (!state?.settings || !msg || msg.expireMemoryRecorded) return;
  const char = (state.characters || []).find(c => c.id === charId);
  const amount = formatMoney(msg.amount);
  const note = msg.note ? `，备注“${msg.note}”` : '';
  const detail = `${playerName(state.settings)}发给${charName(char)}的红包 24 小时未领取，已自动退回零钱，金额 ${amount}${note}。`;
  const id = `evt_redpacket_expired_${msg.id || msg.time || now}`;
  const item = {
    id,
    charId,
    happenedAt: formatFullTime(new Date(now)),
    type: 'payment',
    title: '红包自动退回',
    detail,
    status: 'done',
    importance: 4,
    keywords: ['红包', '退款', '24小时', '零钱'],
    createdAt: now
  };
  await put('events', item);
  await put('vectors', {
    id: `vec_event_${id}`,
    charId,
    sourceType: 'event',
    sourceId: id,
    text: [item.happenedAt, item.title, item.detail, ...(item.keywords || [])].join('\n'),
    keywords: item.keywords,
    importance: item.importance,
    embedding: localEmbedding([item.title, item.detail, ...(item.keywords || [])].join(' ')),
    createdAt: now
  });
  msg.expireMemoryRecorded = true;
}

async function refreshBackgroundPaymentExpirations(state, charId) {
  const chat = state?.allChats?.[charId];
  if (!state?.settings || !chat?.messages?.length) return false;
  let changed = false;
  const now = Date.now();
  for (const msg of chat.messages) {
    if ((msg.payType || msg.type) !== 'redpacket') continue;
    if ((msg.payStatus || 'pending') !== 'pending') continue;
    const expiresAt = Number(msg.payExpiresAt) || ((Number(msg.time) || now) + REDPACKET_EXPIRE_MS);
    if (!msg.payExpiresAt) {
      msg.payExpiresAt = expiresAt;
      changed = true;
    }
    if (now < expiresAt) continue;
    msg.payStatus = 'expired';
    msg.payStatusTime = now;
    if (!msg.refunded) {
      state.settings.walletBalance = Math.max(0, Math.round(((Number(state.settings.walletBalance) || 0) + (Number(msg.amount) || 0)) * 100) / 100);
      msg.refunded = true;
    }
    await recordBackgroundRedpacketExpirationMemory(state, charId, msg, now);
    changed = true;
  }
  return changed;
}

function buildBackgroundMemoryQueryPayload(char, triggerText, messages, settings = {}) {
  const system = `你是 AL 的后台本地记忆检索 AI。
你不参与角色扮演，不回复${playerName(settings)}，不替${charName(char)}说话。
任务：只根据当前触发原因、最近聊天和后台场景事件，生成向量数据库召回用的检索查询。
query 要围绕当前需要回忆的事实、关系、承诺、红包、朋友圈或雷点。
keywords 要短而具体，方便本地记忆库召回。
只输出 JSON，不要输出解释：{"query":"一句检索查询","keywords":["关键词"],"focus":"profile|event|relationship|payment|moment|current"}`;
  const user = `双方昵称：${playerName(settings)} / ${charName(char)}
最近聊天与场景事件：
${messages.slice(-10).map(m => messageLine(m, char, settings)).join('\n') || '暂无'}

当前触发原因：
${triggerText}

输出 JSON：{"query":"一句检索查询，包含最需要回忆的人物、事件、承诺、朋友圈/红包等关键词","keywords":["关键词"],"focus":"profile|event|relationship|payment|moment|current"}`;
  return { system, user };
}

function hasBackgroundMemoryApi(settings = {}) {
  return !!((settings.memoryApiUrl || settings.apiUrl) && (settings.memoryApiKey || settings.apiKey) && settings.memoryModel);
}

async function callBackgroundMemoryJSON(settings = {}, system, user, options = {}) {
  const apiType = settings.memoryApiType || settings.apiType || 'openai';
  const apiUrl = settings.memoryApiUrl || settings.apiUrl || '';
  const apiKey = cleanApiKey(settings.memoryApiKey || settings.apiKey || '');
  const model = settings.memoryModel || '';
  if (!apiUrl || !apiKey || !model) throw new Error('memory api not configured');
  const startedAt = Date.now();
  const messages = [{ role: 'user', content: user }];
  let text = '';
  let diagnostic = '';
  if (apiType === 'claude') {
    try {
      const resp = await fetchWithTimeout(apiUrl.replace(/\/+$/, '') + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, system, messages, max_tokens: 900, temperature: 0.2 })
      }, API_TIMEOUT_MS);
      if (!resp.ok) throw new Error(`记忆 API ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
      const raw = await resp.text();
      try {
        const json = JSON.parse(raw);
        text = extractResponseText(json) || parseJsonFallbackText(raw);
        if (!String(text || '').trim()) diagnostic = responseDiagnostic(json, raw);
      } catch {
        text = parseJsonFallbackText(raw);
        if (!String(text || '').trim()) diagnostic = '接口返回不是标准 JSON：' + compactRawResponse(raw);
      }
    } catch (err) {
      await recordModelCall({ kind: 'memory', scene: options.scene || 'background-memory-query', provider: 'claude', model, charId: options.charId || '', system, messages, startedAt, ok: false, error: err.message });
      throw err;
    }
  } else {
    try {
      const resp = await fetchWithTimeout(apiUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.2, max_tokens: 900 })
      }, API_TIMEOUT_MS);
      if (!resp.ok) throw new Error(`记忆 API ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
      const raw = await resp.text();
      try {
        const json = JSON.parse(raw);
        text = extractResponseText(json) || parseJsonFallbackText(raw);
        if (!String(text || '').trim()) diagnostic = responseDiagnostic(json, raw);
      } catch {
        text = parseJsonFallbackText(raw);
        if (!String(text || '').trim()) diagnostic = '接口返回不是标准 JSON：' + compactRawResponse(raw);
      }
    } catch (err) {
      await recordModelCall({ kind: 'memory', scene: options.scene || 'background-memory-query', provider: 'openai', model, charId: options.charId || '', system, messages, startedAt, ok: false, error: err.message });
      throw err;
    }
  }
  if (!String(text || '').trim()) {
    const err = new Error(diagnostic || '记忆 API 返回了空内容');
    await recordModelCall({ kind: 'memory', scene: options.scene || 'background-memory-query', provider: apiType, model, charId: options.charId || '', system, messages, startedAt, ok: false, empty: true, diagnostic: err.message });
    throw err;
  }
  try {
    const json = extractJson(text);
    await recordModelCall({ kind: 'memory', scene: options.scene || 'background-memory-query', provider: apiType, model, charId: options.charId || '', system, messages, startedAt, ok: true, output: text });
    return json;
  } catch (err) {
    await recordModelCall({ kind: 'memory', scene: options.scene || 'background-memory-query', provider: apiType, model, charId: options.charId || '', system, messages, startedAt, ok: false, diagnostic: '记忆 API 有正文但不是可解析 JSON：' + compactRawResponse(text), output: text });
    throw err;
  }
}

async function generateBackgroundMemoryQuery(charId, char, settings = {}, triggerText = '', messages = []) {
  const fallback = { query: `${charName(char)} ${triggerText}`, keywords: memorySignalTerms(triggerText).slice(0, 8), focus: 'current', _memoryAiStatus: 'skipped' };
  if (!hasBackgroundMemoryApi(settings)) {
    setMemoryQueryStatus(settings, '后台记忆AI筛选跳过：记忆接口未完整配置，已改用本地关键词检索。');
    return fallback;
  }
  const payload = buildBackgroundMemoryQueryPayload(char, triggerText, messages, settings);
  try {
    const json = await callBackgroundMemoryJSON(settings, payload.system, payload.user, { scene: 'background-memory-query', charId });
    return { ...fallback, ...json, _memoryAiStatus: 'ok' };
  } catch (err) {
    console.warn('[AL SW Memory] query fallback:', err.message);
    setMemoryQueryStatus(settings, `后台记忆AI筛选失败：${err.message}；已改用本地关键词检索。`);
    return { ...fallback, _memoryAiStatus: 'failed' };
  }
}

async function buildMemoryPack(charId, char, settings = {}, queryText = '') {
  const state = await getMeta('app_state', null).catch(() => null);
  const recent = Array.isArray(state?.allChats?.[charId]?.messages) ? state.allChats[charId].messages.slice(-30) : [];
  const query = await generateBackgroundMemoryQuery(charId, char, settings, queryText, recent);
  const recallText = [query.query, queryText, ...(query.keywords || [])].filter(Boolean).join(' ');
  return Promise.all([
    searchMemoryVectors(charId, recallText),
    getAll('summaries'),
    getAll('events'),
    getAll('profiles')
  ]).then(([hits, summaries, events, profiles]) => {
    const latestSummaries = summaries.filter(r => r.charId === charId && shouldKeepSummary(memoryAliasText(r.content, char, settings))).sort((a, b) => b.createdAt - a.createdAt).slice(0, 3).reverse();
    const vectorKeys = new Set(hits.map(hit => `${hit.sourceType}:${hit.sourceId}`));
    if (query._memoryAiStatus === 'ok') {
      const keywordText = (query.keywords || []).slice(0, 5).join('、') || query.query || '已生成检索词';
      setMemoryQueryStatus(settings, `后台记忆AI已调用；关键词：${keywordText}；向量库召回 ${hits.length} 条。`);
    }
    const keywordRows = searchKeywordMemoryRows({ summaries, events, profiles }, recallText, query.keywords || [], char, settings, 5)
      .filter(hit => !vectorKeys.has(`${hit.sourceType}:${hit.sourceId}`));
    return composeMemoryPackSections(
      '以下是手机本地记忆库提供给你的参考。不要提到记忆库、系统、推送或后台，只把它自然转化成角色发来的微信消息。',
      [
        { title: '近期增量摘要', priority: 10, lines: latestSummaries.map(s => memoryAliasText(s.content, char, settings)) },
        { title: '本轮向量召回记忆', priority: 20, lines: hits.map(h => memoryAliasText(h.text, char, settings)) },
        { title: '当前触发原因命中的本地记忆', priority: 30, lines: keywordRows.map(row => `${row.text}${row.reason ? `（触发：${row.reason}）` : ''}`) }
      ]
    );
  });
}

function buildBackgroundProactiveChatSystem(settings, char, chat, memoryPack, proactiveNow, proactiveTimeContext) {
  const composer = createPromptComposer('proactive-chat');
  composer.add('char-prompt', chat.charPrompt || `当前你要扮演的角色：${charName(char)}`, { priority: 0 });
  composer.add('time-context', '当前设备时间（角色可以自然参考，但不要说自己看到了系统时间）：\n' + getTimeContext(proactiveNow), { priority: 10 });
  composer.add('memory-pack', memoryPack, { priority: 20 });
  composer.add('global-extra-preset', settings.systemPrompt ? '全局补充预设：\n' + settings.systemPrompt : '', { priority: 80 });
  composer.add('chat-extra-prompt', chat.extraPrompt ? '当前会话补充：\n' + chat.extraPrompt : '', { priority: 90 });
  composer.add('proactive-time-context', proactiveTimeContext, { priority: 100 });
  composer.add('proactive-task', `主动消息任务：现在不是${playerName(settings)}刚刚发消息后等你回答，而是经过了一段空闲时间后，你作为${charName(char)}主动给${playerName(settings)}发来一条微信式消息。
你应该根据时间流逝、你上一条说过的话、未解决话题、约定或关系状态主动开口。
可以延续上一话题、关心${playerName(settings)}、提起约定、找一个符合角色的自然话题；长间隔时更像重新打开聊天。
只能输出消息正文。禁止动作、神态、环境、旁白、心理描写、系统说明、推送说明、定时器说明，禁止替${playerName(settings)}说话。
如果想连续发几条消息，用换行分隔每一条；系统会把每一行拆成独立聊天气泡。不要在同一个消息里用换行排版。
默认 1-3 句。`, { priority: 110, scenes: ['proactive-chat'] });
  return { system: composer.compile(), promptBlocks: promptBlockDiagnostics(composer.blocks()) };
}

function buildBackgroundMomentPostSystem(settings, char, chat, memoryPack, proactiveNow, momentContext = '') {
  const composer = createPromptComposer('moment-post');
  composer.add('char-prompt', chat.charPrompt || `当前你要扮演的角色：${charName(char)}`, { priority: 0 });
  composer.add('time-context', '当前设备时间（角色可以自然参考，但不要说自己看到了系统时间）：\n' + getTimeContext(proactiveNow), { priority: 10 });
  composer.add('memory-pack', memoryPack, { priority: 20 });
  composer.add('moment-context', momentContext, { priority: 30 });
  composer.add('global-extra-preset', settings.systemPrompt ? '全局补充预设：\n' + settings.systemPrompt : '', { priority: 80 });
  composer.add('chat-extra-prompt', chat.extraPrompt ? '当前会话补充：\n' + chat.extraPrompt : '', { priority: 90 });
  composer.add('moment-task', `朋友圈发布动态任务：
现在不是在私聊回复${playerName(settings)}，而是${charName(char)}自己发一条朋友圈动态。
只能输出 JSON，不要输出解释：{"text":"朋友圈正文"}
text 只能是动态正文，禁止动作、神态、心理、旁白、系统说明。
不要出现“用户/角色/API/系统/提示词/模型”等说法。
可以自然参考当前时间、最近聊天、朋友圈上下文、关系和未完成约定，但不要机械复述。
默认 1-2 句，像真人朋友圈动态；不要使用换行排版。`, { priority: 100, scenes: ['moment-post'] });
  return { system: composer.compile(), promptBlocks: promptBlockDiagnostics(composer.blocks()) };
}

async function callModel(settings, system, messages, options = {}) {
  lastModelResponseDiagnostic = '';
  const apiType = settings.chatApiType || settings.apiType || 'openai';
  const apiUrl = settings.chatApiUrl || settings.apiUrl || '';
  const apiKey = settings.chatApiKey || settings.apiKey || '';
  const model = settings.chatModel || settings.model || '';
  const useStream = options.stream === true || (apiType !== 'claude' && options.stream !== false);
  const startedAt = Date.now();
  const callBase = {
    kind: options.kind || 'chat',
    scene: options.scene || '',
    provider: apiType,
    model: model || (apiType === 'claude' ? 'claude-sonnet-4-20250514' : 'gpt-4o'),
    charId: options.charId || '',
    memoryChars: options.memoryChars,
    memoryStatus: options.memoryStatus || memoryQuerySnapshot(settings),
    promptBlocks: options.promptBlocks,
    system,
    messages,
    startedAt
  };
  if (apiType === 'claude') {
    let resp;
    try {
      resp = await fetchWithTimeout(apiUrl.replace(/\/+$/, '') + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', system, messages, max_tokens: Number(settings.maxTokens) || 1000, temperature: Number(settings.temperature) || 0.8, stream: useStream })
      }, API_TIMEOUT_MS);
      if (!resp.ok) throw new Error('API ' + resp.status);
      if (useStream) {
        const text = await readStreamText(resp);
        if (!text.trim()) lastModelResponseDiagnostic = lastModelResponseDiagnostic || '流式接口返回为空';
        await recordModelCall({ ...callBase, ok: true, empty: !text.trim(), diagnostic: lastModelResponseDiagnostic, output: text });
        return text;
      }
    } catch (err) {
      await recordModelCall({ ...callBase, ok: false, error: err.message });
      throw err;
    }
    const raw = await resp.text();
    try {
      const json = JSON.parse(raw);
      const text = extractResponseText(json) || parseJsonFallbackText(raw);
      if (!text.trim()) lastModelResponseDiagnostic = responseDiagnostic(json, raw);
      await recordModelCall({ ...callBase, ok: true, empty: !text.trim(), diagnostic: lastModelResponseDiagnostic, output: text });
      return text;
    } catch {
      const text = parseJsonFallbackText(raw);
      if (!text.trim()) lastModelResponseDiagnostic = '接口返回不是标准 JSON：' + compactRawResponse(raw);
      await recordModelCall({ ...callBase, ok: true, empty: !text.trim(), diagnostic: lastModelResponseDiagnostic, output: text });
      return text;
    }
  }
  let resp;
  try {
    resp = await fetchWithTimeout(apiUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o', messages: [{ role: 'system', content: system }, ...messages], temperature: Number(settings.temperature) || 0.8, max_tokens: Number(settings.maxTokens) || 1000, stream: useStream })
    }, API_TIMEOUT_MS);
    if (!resp.ok) throw new Error('API ' + resp.status);
    if (useStream) {
      const text = await readStreamText(resp);
      if (!text.trim()) lastModelResponseDiagnostic = lastModelResponseDiagnostic || '流式接口返回为空';
      await recordModelCall({ ...callBase, ok: true, empty: !text.trim(), diagnostic: lastModelResponseDiagnostic, output: text });
      return text;
    }
  } catch (err) {
    await recordModelCall({ ...callBase, ok: false, error: err.message });
    throw err;
  }
  const raw = await resp.text();
  try {
    const json = JSON.parse(raw);
    const text = extractResponseText(json) || parseJsonFallbackText(raw);
    if (!text.trim()) lastModelResponseDiagnostic = responseDiagnostic(json, raw);
    await recordModelCall({ ...callBase, ok: true, empty: !text.trim(), diagnostic: lastModelResponseDiagnostic, output: text });
    return text;
  } catch {
    const text = parseJsonFallbackText(raw);
    if (!text.trim()) lastModelResponseDiagnostic = '接口返回不是标准 JSON：' + compactRawResponse(raw);
    await recordModelCall({ ...callBase, ok: true, empty: !text.trim(), diagnostic: lastModelResponseDiagnostic, output: text });
    return text;
  }
}

async function notifyClients(data) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(data));
}

async function hasVisibleClient() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some(client => client.visibilityState === 'visible' || client.focused);
}

async function showProactiveWakeNotification(payload = {}) {
  if (await hasVisibleClient()) return false;
  await self.registration.showNotification('AL', {
    body: payload.test ? '正在测试主动消息...' : '有新的主动消息，正在生成...',
    tag: 'al-proactive-wakeup',
    renotify: false,
    data: { charId: payload.charId || '', url: './index.html' },
    icon: './icon.svg',
    badge: './icon.svg'
  });
  return true;
}

async function closeProactiveWakeNotification() {
  if (!self.registration.getNotifications) return;
  const notes = await self.registration.getNotifications({ tag: 'al-proactive-wakeup' });
  notes.forEach(note => note.close());
}

function timerUrl(settings, path) {
  return String(settings.timerEndpoint || '').replace(/\/+$/, '') + path;
}

function proactiveJobKey(kind = 'chat') {
  return kind === 'moment' ? 'pendingMomentJob' : 'pendingProactiveJob';
}
function proactiveJobPrefix(kind = 'chat') {
  return kind === 'moment' ? 'mom' : 'pro';
}
function proactiveDelayMs(settings, kind = 'chat') {
  const idleMs = Math.max(1, Number(settings.proactiveIdleMinutes) || 30) * 60000;
  return kind === 'moment' ? Math.max(2 * 60000, idleMs * 2) : idleMs;
}
function proactiveJobId(settings, charId, kind = 'chat') {
  return `${proactiveJobPrefix(kind)}_${settings.deviceId}_${charId}`;
}
async function scheduleNextCloudProactive(state, charId, kind = 'chat') {
  const settings = state?.settings || {};
  const chat = state?.allChats?.[charId];
  if (!settings.proactiveEnabled || !settings.cloudTimerEnabled || !settings.timerEndpoint || !settings.pushSubscription || !settings.deviceId || !chat) return false;
  const jobKey = proactiveJobKey(kind);
  const previousJob = chat[jobKey] ? { ...chat[jobKey] } : null;
  const dueAtMs = Date.now() + proactiveDelayMs(settings, kind);
  const jobId = proactiveJobId(settings, charId, kind);
  chat[jobKey] = { jobId, dueAt: new Date(dueAtMs).toISOString(), kind };
  try {
    const resp = await fetchWithTimeout(timerUrl(settings, '/schedule'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: settings.deviceId, jobId, charId, dueAt: chat[jobKey].dueAt, type: 'proactive', kind })
    }, API_TIMEOUT_MS);
    if (!resp.ok) throw new Error('schedule failed ' + resp.status);
  } catch (err) {
    if (previousJob) chat[jobKey] = previousJob;
    else delete chat[jobKey];
    throw err;
  }
  return true;
}

function shortErrorMessage(err) {
  const raw = String(err?.message || err || '未知错误');
  if (/timeout|timed out|超时|连接超时/i.test(raw)) return '接口响应超时';
  if (/401|403|Unauthorized|Forbidden/i.test(raw)) return '接口鉴权失败';
  if (/429|rate limit/i.test(raw)) return '请求过于频繁';
  if (/Failed to fetch|NetworkError|Load failed|ERR_FAILED/i.test(raw)) return '接口连接失败';
  return raw.slice(0, 80);
}

async function recoverProactivePushFailure(payload = {}, reason = null) {
  const state = await getMeta('app_state', null);
  if (!state?.settings || !state?.allChats) return false;
  const allChats = state.allChats;
  const dueJob = payload.charId
    ? { charId: payload.charId, kind: payload.kind === 'moment' ? 'moment' : 'chat' }
    : findDueProactiveJob(allChats);
  const charId = dueJob?.charId || '';
  const kind = dueJob?.kind || 'chat';
  const chat = allChats[charId];
  if (!charId || !chat) return false;
  try {
    await scheduleNextCloudProactive(state, charId, kind);
    setStateCloudTimerStatus(state, `后台${kind === 'moment' ? '朋友圈' : '私聊'}生成失败：${shortErrorMessage(reason)}，已安排下次重试。`, kind);
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, proactiveRetryScheduled: true });
    return true;
  } catch (err) {
    console.warn('[AL Push] retry schedule failed:', err);
    return false;
  }
}

async function handleProactivePush(payload) {
  const state = await getMeta('app_state', null);
  if (!state?.settings || !state?.allChats) throw new Error('missing local state');
  const { settings, characters, allChats } = state;
  const traceId = `${payload.kind === 'moment' ? 'mom' : 'chat'}-${Date.now().toString(36).slice(-6)}`;
  scrubEmptyReplyMessages(allChats);
  const exactDueJobs = payload.charId
    ? [{ charId: payload.charId, kind: payload.kind === 'moment' ? 'moment' : 'chat', job: null }]
    : getDueProactiveJobs(allChats);
  const fallbackJob = !payload.charId && !exactDueJobs.length ? getFallbackProactiveJob(allChats) : null;
  const dueJobs = exactDueJobs.length ? exactDueJobs : (fallbackJob ? [fallbackJob] : []);
  const dueJob = dueJobs[0] || null;
  const charId = dueJob?.charId || '';
  const kind = dueJob?.kind || 'chat';
  if (!charId) {
    setStateCloudTimerTrace(state, 'chat', traceId, '收到云端 push，但本地没有可触发会话或任务');
    setStateCloudTimerStatus(state, '后台收到云闹钟，但本地没有可触发会话；请打开 AL 后重新绑定或重新安排。', 'chat');
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', skipped: true });
    return;
  }
  if (await hasVisibleClient()) {
    if (!payload.charId && exactDueJobs.length > 1) {
      await notifyClients({ type: 'al-run-proactive-due', jobCount: dueJobs.length, test: dueJobs.some(row => row.job?.test) });
      return;
    }
    await notifyClients({
      type: 'al-run-proactive',
      charId,
      kind,
      jobId: payload.jobId || dueJob.job?.jobId || '',
      test: !!(payload.test || dueJob.job?.test),
      fallback: !!fallbackJob
    });
    return;
  }
  if (!payload.charId && dueJobs.length > 1) {
    for (const row of dueJobs) {
      await handleProactivePush({
        type: 'proactive',
        charId: row.charId,
        kind: row.kind,
        jobId: row.job?.jobId || '',
        test: !!row.job?.test
      });
    }
    return;
  }
  setStateCloudTimerTrace(state, kind, traceId, `后台收到触发，目标：${charId}${fallbackJob ? '，本地未命中到期任务，已用最近任务兜底' : ''}`);
  setStateCloudTimerTriggerAck(state, `真实${kind === 'moment' ? '朋友圈' : '私聊'}闹钟已被后台收到。`);
  state.updatedAt = Date.now();
  await setMeta('app_state', state);
  if (kind === 'moment') return handleProactiveMomentPush(state, charId, payload);
  const char = (characters || []).find(c => c.id === charId);
  const chat = allChats[charId];
  if (!char || !chat?.messages?.length) throw new Error('missing chat');
  if (!(settings.chatApiUrl || settings.apiUrl) || !(settings.chatApiKey || settings.apiKey) || !(settings.chatModel || settings.model)) throw new Error('missing api config');
  if (await refreshBackgroundPaymentExpirations(state, charId)) {
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
  }
  const proactiveNow = new Date();
  const proactiveTimeContext = buildProactiveTimeContext(chat, proactiveNow);
  const memoryQuery = `主动消息触发。\n${getTimeContext(proactiveNow)}\n${proactiveTimeContext}`;
  const memoryPack = await buildMemoryPack(charId, char, settings, memoryQuery);
  setStateCloudTimerTrace(state, 'chat', traceId, `记忆完成 ${String(memoryPack || '').length} 字，正在请求聊天模型`);
  const prompt = buildBackgroundProactiveChatSystem(settings, char, chat, memoryPack, proactiveNow, proactiveTimeContext);

  const messages = proactiveRecentMessages(chat, 30, proactiveNow);
  messages.push({ role: 'user', content: buildProactiveTriggerMessage(settings, char, chat, proactiveNow) });
  const reply = (await callModel(settings, prompt.system, messages, {
    stream: true,
    kind: 'chat',
    scene: 'background-proactive-chat',
    charId,
    memoryChars: memoryPack.length,
    memoryStatus: memoryStatusWithBudget(memoryPack, memoryQuerySnapshot(settings)),
    promptBlocks: prompt.promptBlocks
  })).trim();
  setStateCloudTimerTrace(state, 'chat', traceId, `模型返回 ${reply.length} 字`);
  chat.lastProactiveAt = Date.now();
  chat.lastProactiveChatAt = Date.now();
  if (chat.pendingProactiveJob?.jobId === payload.jobId || payload.jobId) delete chat.pendingProactiveJob;
  if (isEmptyReplyText(reply)) {
    const emptyReason = lastModelResponseDiagnostic || '空回复';
    try {
      await scheduleNextCloudProactive(state, charId, 'chat');
    } catch (err) {
      console.warn('[AL Push] next schedule skipped:', err);
    }
    setStateCloudTimerTrace(state, 'chat', traceId, `空回复：${emptyReason}`);
    setStateCloudTimerStatus(state, `后台私聊生成了空回复：${emptyReason}，已跳过并安排下次重试。`, 'chat');
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, skipped: true });
    return;
  }
  const chunks = appendAssistantMessages(chat, reply, { proactive: true });
  if (!chunks.length) {
    try {
      await scheduleNextCloudProactive(state, charId, 'chat');
    } catch (err) {
      console.warn('[AL Push] next schedule skipped:', err);
    }
    setStateCloudTimerTrace(state, 'chat', traceId, '输出无法拆成有效气泡');
    setStateCloudTimerStatus(state, '后台私聊输出无法拆成有效消息，已安排下次重试。', 'chat');
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, skipped: true });
    return;
  }
  chat.unread = (chat.unread || 0) + 1;
  chat.lastProactiveType = 'chat';
  try {
    await scheduleNextCloudProactive(state, charId, 'chat');
  } catch (err) {
    console.warn('[AL Push] next schedule skipped:', err);
  }
  setStateCloudTimerTrace(state, 'chat', traceId, `写入完成 ${chunks.length} 条`);
  setStateCloudTimerStatus(state, `后台私聊已生成 ${chunks.length} 条消息。`, 'chat');
  state.allChats = allChats;
  state.updatedAt = Date.now();
  await setMeta('app_state', state);
  await notifyClients({ type: 'al-state-updated', charId, reply });
  await self.registration.showNotification(char.name || 'AL', {
    body: chunks[0] + (chunks.length > 1 ? ' ...' : ''),
    tag: `al-${charId}`,
    data: { charId, url: './index.html' },
    icon: './icon.svg',
    badge: './icon.svg'
  });
}

async function handleProactiveMomentPush(state, charId, payload) {
  const { settings, characters, allChats } = state;
  const allMoments = Array.isArray(state.allMoments) ? state.allMoments : [];
  const char = (characters || []).find(c => c.id === charId);
  const chat = allChats[charId];
  if (!char || !chat?.messages?.length) return false;
  if (await refreshBackgroundPaymentExpirations(state, charId)) {
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
  }
  const proactiveNow = new Date();
  const momentContext = buildBackgroundMomentContext(allMoments, characters, charId, settings, 6);
  const memoryQuery = `角色朋友圈动态触发。\n${getTimeContext(proactiveNow)}\n${charName(char)}准备主动发朋友圈。\n${momentContext}`;
  const memoryPack = await buildMemoryPack(charId, char, settings, memoryQuery);
  const prompt = buildBackgroundMomentPostSystem(settings, char, chat, memoryPack, proactiveNow, momentContext);
  const messages = proactiveRecentMessages(chat, 20, proactiveNow);
  const raw = (await callModel(settings, prompt.system, messages, {
    kind: 'moment',
    scene: 'background-moment-post',
    charId,
    memoryChars: memoryPack.length,
    memoryStatus: memoryStatusWithBudget(memoryPack, memoryQuerySnapshot(settings)),
    promptBlocks: prompt.promptBlocks
  })).trim();
  let text = '';
  try {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    const json = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    text = String(json.text || json.timeline || '').replace(/\s+/g, ' ').trim();
  } catch {
    text = raw.replace(/\s+/g, ' ').trim();
  }
  text = momentSnippet(text, 160);
  chat.lastProactiveAt = Date.now();
  chat.lastProactiveMomentAt = Date.now();
  chat.lastProactiveType = 'moment';
  if (chat.pendingMomentJob?.jobId === payload.jobId || payload.jobId || !payload.kind) delete chat.pendingMomentJob;
  if (!text || isEmptyReplyText(text)) {
    const emptyReason = lastModelResponseDiagnostic || '空动态';
    try {
      await scheduleNextCloudProactive(state, charId, 'moment');
    } catch (err) {
      console.warn('[AL Push] next schedule skipped:', err);
    }
    setStateCloudTimerStatus(state, `后台朋友圈生成了空动态：${emptyReason}，已跳过并安排下次重试。`, 'moment');
    state.allChats = allChats;
    state.allMoments = allMoments;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, momentSkipped: true });
    return false;
  }
  const now = Date.now();
  allMoments.unshift({
    id: `mom_${now}_${Math.random().toString(36).slice(2, 8)}`,
    authorType: 'char',
    charId,
    text,
    time: now,
    likes: [],
    comments: [],
    proactive: true
  });
  chat.messages.push({
    role: 'user',
    hidden: true,
    time: now,
    content: `【朋友圈事件】${char.name}在朋友圈发布动态：“${momentSnippet(text)}”`
  });
  try {
    await scheduleNextCloudProactive(state, charId, 'moment');
  } catch (err) {
    console.warn('[AL Push] next schedule skipped:', err);
  }
  setStateCloudTimerStatus(state, '后台朋友圈已发布 1 条动态。', 'moment');
  state.allChats = allChats;
  state.allMoments = allMoments;
  state.updatedAt = Date.now();
  await setMeta('app_state', state);
  await notifyClients({ type: 'al-state-updated', charId, moment: true });
  await self.registration.showNotification(char.name || 'AL', {
    body: `发了一条朋友圈：${text}`,
    tag: `al-moment-${charId}`,
    data: { charId, url: './index.html' },
    icon: './icon.svg',
    badge: './icon.svg'
  });
  return true;
}

function findDueProactiveJob(allChats) {
  return getDueProactiveJobs(allChats)[0] || null;
}

function latestCloudTargetCharId(allChats) {
  return Object.entries(allChats || {})
    .map(([charId, chat]) => {
      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      const last = [...messages].reverse().find(m => !m.hidden) || messages[messages.length - 1];
      return { charId, time: Number(last?.time || 0), hasMessages: messages.length > 0 };
    })
    .filter(row => row.hasMessages)
    .sort((a, b) => b.time - a.time)[0]?.charId || '';
}

function getDueProactiveJobs(allChats) {
  const now = Date.now();
  const targetCharId = latestCloudTargetCharId(allChats);
  const rows = Object.entries(allChats || {}).flatMap(([charId, chat]) =>
    PROACTIVE_JOB_KINDS.map(kind => ({ charId, kind, chat, job: chat?.[proactiveJobKey(kind)] }))
  );
  return rows
    .filter(r => (!targetCharId || r.charId === targetCharId) && r.job?.dueAt && Date.parse(r.job.dueAt) <= now)
    .sort((a, b) => Date.parse(a.job.dueAt) - Date.parse(b.job.dueAt))
    .map(row => ({ charId: row.charId, kind: row.kind, job: row.job }));
}

function getFallbackProactiveJob(allChats) {
  const targetCharId = latestCloudTargetCharId(allChats);
  const targetChat = targetCharId ? allChats?.[targetCharId] : null;
  if (!targetCharId || !Array.isArray(targetChat?.messages) || !targetChat.messages.length) return null;
  const rows = PROACTIVE_JOB_KINDS
    .map(kind => ({ charId: targetCharId, kind, job: targetChat?.[proactiveJobKey(kind)] }))
    .filter(row => row.job?.dueAt || row.job?.jobId)
    .sort((a, b) => {
      const aTime = Date.parse(a.job?.dueAt || '') || Number.MAX_SAFE_INTEGER;
      const bTime = Date.parse(b.job?.dueAt || '') || Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  return rows[0] || { charId: targetCharId, kind: 'chat', job: null, fallback: true };
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = { type: 'proactive' }; }
    if (payload.type && payload.type !== 'proactive') {
      await self.registration.showNotification('AL', { body: '有新的主动消息提醒', icon: './icon.svg' });
      return;
    }
    let wakeShown = false;
    try {
      wakeShown = await showProactiveWakeNotification(payload);
      await handleProactivePush(payload);
      if (wakeShown) await closeProactiveWakeNotification();
    } catch (err) {
      if (wakeShown) await closeProactiveWakeNotification();
      const retryScheduled = await recoverProactivePushFailure(payload, err).catch(() => false);
      await self.registration.showNotification('AL', {
        body: retryScheduled ? '主动消息生成失败，已安排下次重试。' : '主动消息生成失败，打开 AL 后会继续尝试。',
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
