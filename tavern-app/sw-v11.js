const CACHE_NAME = 'rpchat-v95';
const APP_SHELL = ['./index.html', './manifest.json', './icon.svg', './warm-modern.css', './lib/api-endpoint.js', './lib/role-plan-domain.js', './lib/role-plan-repository.js', './sw-v11.js'];
const MEMORY_DB_NAME = 'ALMemoryDB';
const MEMORY_DB_VERSION = 2;
const PROACTIVE_JOB_KINDS = ['chat', 'moment'];
const API_TIMEOUT_MS = 120000;
const MEMORY_MAX_TOKENS = 4096;
const CALL_LOG_LIMIT = 30;
const VECTOR_DIM = 384;
const MEMORY_PACK_CHAR_BUDGET = 3600;
const MEMORY_LINE_CHAR_LIMIT = 360;
const NORMAL_RAW_CONTEXT_LIMIT = 200;
const REDPACKET_EXPIRE_MS = 24 * 60 * 60 * 1000;
const PROACTIVE_DICE_INTERVAL_MS = 10 * 60 * 1000;
const PROACTIVE_DICE_CHANCE = 0.05;
const PROACTIVE_DICE_MAX_ROLLS = 432;
const MOMENT_DICE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MOMENT_DICE_CHANCE = 0.10;
const MOMENT_DICE_MAX_ROLLS = 56;
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

function automaticTasksEnabled(currentSettings = {}) {
  return currentSettings.proactiveEnabled === true && currentSettings.cloudTimerEnabled === true;
}

async function automaticTasksStillEnabled() {
  const current = await getMeta('app_state', null).catch(() => null);
  return automaticTasksEnabled(current?.settings || {});
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

function apiEndpoint(value, route) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error('invalid API base URL');
  const parsed = new URL(raw);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|messages|models)$/i, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '') + '/' + String(route || '').replace(/^\/+/, '');
}

function rejectHtmlApiResponse(raw, response, endpoint = '') {
  const contentType = String(response?.headers?.get?.('content-type') || '');
  if (/text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(String(raw || ''))) {
    throw new Error(`API returned HTML page${endpoint ? `: ${endpoint}` : ''}`);
  }
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
      messageChars: messages.reduce((sum, message) => sum + String(message?.content || '').length, 0),
      historyOmitted: Math.max(0, Number(entry.historyOmitted) || 0),
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
  const now = Date.now();
  const appendLine = existing => {
    const line = [traceId, message].filter(Boolean).join('｜');
    if (!line) return '';
    const rows = String(existing || '').split('\n').map(row => row.trim()).filter(Boolean);
    const sameTrace = traceId && rows.length && rows[rows.length - 1].startsWith(`${traceId}｜`);
    const next = sameTrace ? rows.concat(line) : [line];
    return next.slice(-8).join('\n');
  };
  if (kind === 'moment') {
    state.settings.cloudTimerLastMomentTrace = appendLine(state.settings.cloudTimerLastMomentTrace);
    state.settings.cloudTimerLastMomentTraceAt = now;
  } else {
    state.settings.cloudTimerLastChatTrace = appendLine(state.settings.cloudTimerLastChatTrace);
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

function visibleConversationMessages(chat) {
  return (chat?.messages || []).filter(m => !m.hidden && !m.deleted && !m.retracted && m.role !== 'system');
}

function normalizeProactiveTriggerMode(value = 'planned') {
  return value === 'dice' ? 'dice' : 'planned';
}

function proactiveConversationState(chat, now = new Date()) {
  const messages = visibleConversationMessages(chat);
  const last = messages[messages.length - 1] || null;
  const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
  const afterLastUser = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : messages;
  const assistantSinceLastUser = afterLastUser.filter(m => m.role === 'assistant');
  const proactiveSinceLastUser = assistantSinceLastUser.filter(m => m.proactive && m.proactiveMode !== 'manual');
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : null;
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant') || null;
  const elapsedFrom = msg => msg?.time ? Math.max(0, now.getTime() - Number(msg.time)) : null;
  return {
    messages,
    last,
    lastUser,
    lastAssistant,
    assistantSinceLastUser,
    proactiveSinceLastUser,
    lastElapsedMs: elapsedFrom(last),
    crossedDay: !!(last?.time && new Date(last.time).toDateString() !== now.toDateString())
  };
}

function chatHasUnansweredProactive(chat) {
  return proactiveConversationState(chat).proactiveSinceLastUser.length > 0;
}

function expectedProactiveChatMode(chat) {
  return chatHasUnansweredProactive(chat) ? 'dice' : 'planned';
}

function proactiveJobMatchesConversationStage(chat, job = null) {
  return proactiveJobMode(job) === expectedProactiveChatMode(chat);
}

function proactiveHistoryMode(chat, now = new Date()) {
  const state = proactiveConversationState(chat, now);
  const elapsed = state.lastElapsedMs == null ? 0 : state.lastElapsedMs;
  if (elapsed >= 24 * 60 * 60 * 1000) return 'fresh-start';
  if (elapsed >= 6 * 60 * 60 * 1000 || (state.crossedDay && elapsed >= 2 * 60 * 60 * 1000)) return 'archive';
  return 'recent';
}

function latestMessageByRole(chat, role) {
  return visibleConversationMessages(chat).slice().reverse().find(m => m.role === role) || null;
}

function messageTimeLine(label, msg, now = new Date(), includeContent = true) {
  if (!msg?.time) return `${label}：无`;
  const at = new Date(msg.time);
  const elapsed = formatElapsed(now.getTime() - at.getTime());
  const content = String(msg.content || '').replace(/\s+/g, ' ').slice(0, 120);
  return `${label}：${formatFullTime(at)}（距现在 ${elapsed}）｜${msg.role === 'user' ? '用户' : '角色'}${includeContent && content ? `：${content}` : ''}`;
}

function buildProactiveTimeContext(chat, now = new Date(), triggerMode = 'planned') {
  const state = proactiveConversationState(chat, now);
  const historyMode = proactiveHistoryMode(chat, now);
  const includeContent = historyMode === 'recent';
  const lastElapsedMinutes = state.lastElapsedMs == null ? 0 : Math.round(state.lastElapsedMs / 60000);
  const mode = state.crossedDay || lastElapsedMinutes >= 360
    ? '跨天/超长间隔重新开口'
    : lastElapsedMinutes >= 60
      ? '长间隔重新开口'
      : lastElapsedMinutes >= 15
        ? '中等间隔自然续聊'
        : '短间隔可轻续聊';
  const normalizedTriggerMode = normalizeProactiveTriggerMode(triggerMode);
  const stage = normalizedTriggerMode === 'dice'
    ? '随机再联系阶段：角色已经主动追发过，但玩家仍未回复；这不是第一轮计划追发。'
    : '计划追发阶段：这是玩家最后一次发言后，角色正常回复之外唯一的一轮计划追发；本轮发出后应进入随机再联系阶段。';
  const unanswered = state.proactiveSinceLastUser.length
    ? `玩家最后一次发言后，已有 ${state.proactiveSinceLastUser.length} 条主动消息气泡仍未得到玩家回复。`
    : `玩家最后一次发言后，角色已发送 ${state.assistantSinceLastUser.length} 条回复气泡，尚未出现主动追发气泡。`;
  return [
    '主动消息时间流逝上下文：',
    `当前时间：${formatFullTime(now)}`,
    messageTimeLine('最后一条真实聊天消息', state.last, now, includeContent),
    messageTimeLine('上一条玩家消息', state.lastUser, now, includeContent),
    messageTimeLine('上一条角色消息', state.lastAssistant, now, includeContent),
    `主动阶段：${stage}`,
    `未回复状态：${unanswered}`,
    `智能策略：${mode}`,
    `历史上下文策略：${historyMode === 'fresh-start' ? '最近200条仍完整保留，但上一轮已自然结束；除非当前话题明确关联，否则以当前时段重新开口' : historyMode === 'archive' ? '最近200条仍完整保留，旧聊天作为过往事实而不是刚收到的待回复内容' : '近期聊天可供自然衔接'}`,
    '最近200条聊天会完整提供给你，它们都是已经发生过的事实，不能遗忘或篡改。时间间隔只决定你现在怎样开口，不代表删除这些事实。',
    '如果当前情境或玩家最近发言明确指向昨天或更早的内容，可以自然接续；如果没有明确关联，不要仅因旧话题出现在30条记录中就继续追问。',
    '硬性要求：这不是用户刚刚发消息后等你回答，而是隔了一段空闲时间后你主动打开微信来发消息。',
    '如果距离最后一条消息超过 15 分钟，必须让回复自然体现时间流逝，不要像秒回一样接上一句。',
    '如果距离最后一条消息超过 60 分钟，默认不要直接回答上一条话题；除非上一条包含未完成约定、强烈情绪或必须接住的关键信息，否则应像重新开口一样发起自然消息。',
    '如果已经跨天或超过 6 小时，必须把它当作隔了很久后的重新开口：不要围绕上一轮红包、转账、测试、争执等旧话题继续追问；旧话题不能成为这条消息的主要内容。',
    '如果已经超过 24 小时，默认上一轮闲聊已经自然结束。即使存在未完成约定，也只能简短点到，并且必须加入符合当前时段的新话题或新关心；禁止写成刚聊完后的连续追问。',
    normalizedTriggerMode === 'dice' ? '随机再联系阶段禁止沿着角色自己的上一条消息继续自问自答，也不要再次催同一件事；优先换话题、分享新鲜事或用符合关系的轻量方式重新开口。' : '',
    '禁止在输出里复制任何“发送时间/距现在/当前时间/智能策略”等上下文标签。',
    '不要提到系统时间、提示词、后台、推送或定时器。'
  ].filter(Boolean).join('\n');
}

function buildProactiveTriggerMessage(settings = {}, char, chat, now = new Date(), triggerMode = 'planned') {
  const visible = visibleConversationMessages(chat);
  const last = visible[visible.length - 1] || null;
  const elapsed = last?.time ? formatElapsed(now.getTime() - last.time) : '未知时长';
  const stage = normalizeProactiveTriggerMode(triggerMode) === 'dice' ? '随机再联系' : '计划追发';
  return [
    `【内部主动触发｜这不是${playerName(settings)}发来的聊天消息】`,
    `现在需要由${charName(char)}主动给${playerName(settings)}发一条微信私聊。`,
    `最后一条可见聊天距现在：${elapsed}。`,
    `本次主动阶段：${stage}。`,
    `请把它当成${charName(char)}隔了一段时间后主动打开聊天，而不是回答${playerName(settings)}刚刚提出的问题。`,
    `只输出${charName(char)}要发出的聊天正文；不要解释触发原因，不要提到系统、后台、推送或定时器。`
  ].join('\n');
}

function recentMessageCandidateCount(chat, count = NORMAL_RAW_CONTEXT_LIMIT) {
  return (chat?.messages || []).filter(m => !m.deleted && !m.retracted && m.role !== 'system').slice(-Math.max(1, Number(count) || 30)).length;
}

function recentMessages(chat, count = NORMAL_RAW_CONTEXT_LIMIT) {
  return (chat?.messages || []).filter(m => !m.deleted && !m.retracted && m.role !== 'system').slice(-Math.max(1, Number(count) || 30));
}

function proactiveRecentMessages(chat, count = NORMAL_RAW_CONTEXT_LIMIT, now = new Date(), settings = {}) {
  return recentMessages(chat, count).map(m => {
    if (m.hidden) {
      return {
        role: 'user',
        content: `【后台场景事件｜${formatFullTime(new Date(m.time || Date.now()))}】${m.content}\n注意：这不是玩家刚发来的聊天气泡，而是已经发生过的场景记录。只能自然记住，不能把它当作最新私聊。`
      };
    }
    const at = m.time ? new Date(m.time) : null;
    const meta = at ? `历史消息元数据：${formatFullTime(at)}，距现在 ${formatElapsed(now.getTime() - at.getTime())}。元数据只供判断时间流逝，禁止复制进回复。` : '历史消息元数据：发送时间未知，禁止复制进回复。';
    return { role: m.role, content: `${meta}\n历史聊天正文：${m.content}` };
  });
}

function buildProactiveMemoryQuery(chat, settings = {}, now = new Date(), triggerMode = 'planned') {
  const state = proactiveConversationState(chat, now);
  const historyMode = proactiveHistoryMode(chat, now);
  const elapsed = state.lastElapsedMs == null ? '未知时长' : formatElapsed(state.lastElapsedMs);
  const latestPlayerText = String(state.lastUser?.content || '').replace(/\s+/g, ' ').slice(0, 300) || '无';
  const latestCharacterText = String(state.lastAssistant?.content || '').replace(/\s+/g, ' ').slice(0, 300) || '无';
  return [
    '主动消息记忆检索。',
    getTimeContext(now),
    `当前阶段：${normalizeProactiveTriggerMode(triggerMode) === 'dice' ? '玩家尚未回复先前主动消息后的随机再联系' : '玩家最后一次回复后的计划追发'}`,
    `距离最后一条真实聊天：${elapsed}。`,
    `最近一条玩家消息：${latestPlayerText}`,
    `最近一条角色消息：${latestCharacterText}`,
    historyMode === 'fresh-start'
      ? '时间已经过去较久。根据最近一条玩家消息判断是否需要召回昨天或更早的内容：有明确关联就召回，没有关联就不要强行延续旧话题。'
      : historyMode === 'archive'
        ? '聊天已有明显时间间隔。根据玩家最近发言筛选相关记忆；有关联可以继续旧事，没有关联则优先关系、约定和当前时段。'
        : '可以检索与近期话题直接相关的记忆。'
  ].join('\n');
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

function stripProactiveScheduleDirective(text) {
  return String(text || '')
    .replace(/<al_schedule>[\s\S]*?<\/al_schedule>/gi, '')
    .replace(/<al_schedule>[\s\S]*$/gi, '')
    .replace(/\{[\s\S]*?\}/g, block => {
      try {
        const json = JSON.parse(block);
        if (json && typeof json === 'object' && !Array.isArray(json)
          && ('nextProactiveAt' in json || 'nextProactiveIn' in json || 'nextMessageAt' in json || 'next_message_at' in json || 'nextMessageIn' in json || 'next_message_in' in json)) {
          return '';
        }
      } catch {}
      return block;
    });
}
function normalizePaymentDirectiveStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['received', 'receive', 'accepted', 'accept', 'claimed', 'claim', 'collected', 'done'].includes(status)) return 'received';
  if (['refused', 'refuse', 'declined', 'decline', 'rejected', 'reject', 'returned', 'return'].includes(status)) return 'refused';
  if (['pending', 'wait', 'waiting', 'later', 'undecided', 'open'].includes(status)) return 'pending';
  return '';
}
function extractPaymentStatusDirective(text) {
  const raw = String(text || '');
  const tagged = raw.match(/<al_payment>([\s\S]*?)<\/al_payment>/i);
  const candidates = tagged ? [{ block: tagged[1], tagged: true }] : [];
  (raw.match(/\{[\s\S]*?\}/g) || []).forEach(block => {
    if (/paymentStatus|payment_status/i.test(block)) candidates.push({ block, tagged: false });
  });
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(String(candidate.block).trim());
      const value = candidate.tagged ? (json.status || json.paymentStatus || json.payment_status) : (json.paymentStatus || json.payment_status);
      const status = normalizePaymentDirectiveStatus(value);
      if (status) return { status, raw: candidate.block };
    } catch {}
  }
  return null;
}
function stripPaymentStatusDirective(text) {
  return String(text || '')
    .replace(/<al_payment>[\s\S]*?<\/al_payment>/gi, '')
    .replace(/<al_payment>[\s\S]*$/gi, '')
    .replace(/\{[\s\S]*?\}/g, block => {
      try {
        const json = JSON.parse(block);
        if (json && typeof json === 'object' && !Array.isArray(json) && ('paymentStatus' in json || 'payment_status' in json)) return '';
      } catch {}
      return block;
    });
}
function stripLeakedPromptMetadata(text) {
  return String(text || '')
    .replace(/[【[]\s*(?:发送时间|历史消息元数据)[^】\]]*[】\]]\s*/g, '')
    .replace(/[【[]\s*(?:发送时间|历史消息元数据)[^\n]*$/g, '')
    .replace(/历史消息元数据[:：][^\n]*(?:\n|$)/g, '')
    .replace(/历史聊天正文[:：]/g, '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && !/(免打扰模式|骰子|摇骰|调度|定时器|后台|系统提示|发送时间|距现在|智能策略|主动消息时间流逝上下文|主动阶段|未回复状态|历史上下文策略)/.test(line))
    .join('\n');
}
function cleanAssistantChatReply(text) {
  const raw = stripLeakedPromptMetadata(stripPaymentStatusDirective(stripProactiveScheduleDirective(text))).trim();
  if (!raw) return '';
  const jsonLike = raw.replace(/```json|```/g, '').trim();
  try {
    const json = JSON.parse(jsonLike);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const value = String(json.chat || json.reply || json.message || json.comment || '').replace(/\s+/g, ' ').trim();
      if (value) return value;
      if ('like' in json || 'timeline' in json || 'moment' in json || 'post' in json || 'text' in json) return '';
    }
  } catch {}
  return raw.replace(/\{[\s\S]*?\}/g, block => {
    try {
      const json = JSON.parse(block);
      if (json && typeof json === 'object' && !Array.isArray(json) && ('like' in json || 'timeline' in json || 'moment' in json || 'post' in json)) return '';
    } catch {}
    return block;
  }).replace(/\n{3,}/g, '\n\n').trim();
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
  );
}
function mergeStreamText(current = '', incoming = '') {
  const before = String(current || '');
  const next = String(incoming || '');
  if (!next) return before;
  if (next === before || (next.length > before.length && next.startsWith(before))) return next;
  return before + next;
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
        if (delta) result = mergeStreamText(result, delta);
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

function stripStagePersonaBlock(prompt = '') {
  return String(prompt || '').replace(/\s*<al_current_stage_persona>[\s\S]*?<\/al_current_stage_persona>\s*/g, '\n\n').trim();
}

function backgroundStagePersonaBlock(char, settings = {}) {
  const config = char?.stagePersona;
  if (!config || config.enabled === false || !Array.isArray(config.stages)) return '';
  const stage = config.stages.find(item => item?.id === config.currentStage) || config.stages[0];
  if (!stage?.content) return '';
  const content = String(stage.content)
    .replaceAll('{{char}}', charName(char))
    .replaceAll('{{player}}', playerName(settings));
  return `<al_current_stage_persona>\n当前关系阶段：${stage.label || stage.id}\n以下仅为当前阶段生效的人设补充，优先于初始关系描述中已经过时的亲疏程度，但不得改变角色的核心身份、经历、雷点和稳定性格。\n${content}\n</al_current_stage_persona>`;
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
    const threadComments = (moment.comments || []).filter(c => c.charId === charId || (c.charId === 'player' && (moment.charId === charId || c.replyToCharId === charId)));
    threadComments.forEach(c => {
      const speaker = c.charId === 'player' ? playerName(settings) : charName((characters || []).find(ch => ch.id === charId));
      const repliedTo = c.replyToName ? `回复${c.replyToName}` : '评论';
      parts.push(`${speaker}${repliedTo}：“${momentSnippet(c.text, 60)}”`);
    });
    return `- ${parts.join('；')}`;
  });
  return `以下是最近朋友圈上下文，角色可以自然记得自己看过、点赞过、评论过或发过的动态；不要提到“系统记录/上下文”。\n${lines.join('\n')}`;
}

function memoryTextHasSignal(text) {
  const value = String(text || '');
  return /(承诺|约定|答应|计划|以后|下次|明天|今晚|周|红包|转账|收款|领取|拒收|退款|金额|欠|补偿|道歉|和好|吵|争执|生气|雷点|不喜欢|介意|边界|称呼|关系|喜欢|讨厌|职业|年龄|生日|住址|住在|城市|学校|公司|重要|不能忘|必须记|未解决|提醒|朋友圈|动态|评论|点赞|留言)/.test(value);
}

function memoryTextHasStrongSignal(text) {
  const value = String(text || '');
  if (/(承诺|约定|答应|计划|以后|下次|明天|今晚|周末|红包|转账|收款|领取|拒收|退款|金额|欠|补偿|道歉|和好|吵架|争执|生气|雷点|不喜欢|介意|边界|称呼|关系|喜欢|讨厌|职业|年龄|生日|住址|住在|城市|学校|公司|重要|不能忘|必须记|未解决|提醒|拒绝|答复)/.test(value)) return true;
  return /(朋友圈|动态|评论|点赞|留言)/.test(value)
    && /(承诺|约定|答应|计划|以后|下次|明天|今晚|周末|红包|转账|收款|领取|拒收|退款|金额|补偿|道歉|和好|吵架|争执|生气|雷点|边界|称呼|关系|喜欢|讨厌|重要|不能忘|必须记|未解决|提醒|拒绝|答复)/.test(value);
}

function memoryTextIsNoise(text) {
  const value = String(text || '');
  if (/\[语音消息\s*\d+秒，未转文字\]|未提供转文字内容|只能回应“收到语音”这个事实/.test(value)) return true;
  const lowValueMoment = /(朋友圈|动态|评论|点赞|留言)/.test(value)
    && /(哈哈|笑|乐|炫耀|普通|随手|测试|无后续|没必要|短评|只点|只评论)/.test(value);
  const lowValueChat = /(测试|校对|表快|表慢|几点|现在时间|AI身份|身份争论|是不是AI|名字.*合理|戏太多|科幻片|装神弄鬼|普通寒暄|你好|在吗|又来)/.test(value);
  return (lowValueMoment || lowValueChat) && !memoryTextHasStrongSignal(value);
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
  if (['moment', 'fact', 'event'].includes(type)) return importance >= 4 && memoryTextHasStrongSignal(text);
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
  return text.length >= 20 && !memoryTextIsNoise(text) && memoryTextHasStrongSignal(text);
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
  const timestamp = Number(m?.time);
  const timeText = Number.isFinite(timestamp) && timestamp > 0 ? formatFullTime(new Date(timestamp)) : '时间未知';
  if (m?.hidden) return `【消息时间｜${timeText}】【隐藏事件】${m.content}`;
  return `【消息时间｜${timeText}】${m.role === 'user' ? playerName(settings) : charName(char)}：${m.content}`;
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

async function recordBackgroundScenarioMemory(state, charId, title, detail, options = {}) {
  if (!state?.settings || !charId || !detail) return false;
  const char = (state.characters || []).find(c => c.id === charId);
  const now = Date.now();
  const cleanDetail = memoryAliasText(detail, char, state.settings).replace(/\s+/g, ' ').trim();
  const type = options.type || 'fact';
  const keywords = options.keywords || memorySignalTerms(cleanDetail).slice(0, 8);
  const item = {
    id: `evt_bg_${now}_${Math.random().toString(36).slice(2, 7)}`,
    charId,
    happenedAt: formatFullTime(new Date(now)),
    type,
    title: memoryAliasText(title || '后台事件', char, state.settings),
    detail: cleanDetail,
    status: options.status || 'stable',
    importance: Number(options.importance) || 4,
    keywords,
    createdAt: now
  };
  if (!shouldKeepEvent(item)) return false;
  await put('events', item);
  await put('vectors', {
    id: `vec_event_${item.id}`,
    charId,
    sourceType: 'event',
    sourceId: item.id,
    text: [item.happenedAt, item.title, item.detail, ...(item.keywords || [])].join('\n'),
    keywords: item.keywords,
    importance: item.importance,
    embedding: localEmbedding([item.title, item.detail, ...(item.keywords || [])].join(' ')),
    createdAt: now
  });
  return true;
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

function latestPendingPayment(chat) {
  if (!chat?.messages?.length) return null;
  const now = Date.now();
  return chat.messages.slice().reverse().find(message => {
    const type = message.payType || message.type;
    if (!['transfer', 'redpacket'].includes(type)) return false;
    if ((message.payStatus || 'pending') !== 'pending') return false;
    if (type !== 'redpacket') return true;
    const expiresAt = Number(message.payExpiresAt) || ((Number(message.time) || now) + REDPACKET_EXPIRE_MS);
    return now < expiresAt;
  }) || null;
}

function inferPaymentStatusFromReply(reply) {
  const text = String(reply || '').replace(/\s+/g, '');
  if (!text) return 'pending';
  if (/(不是不收|并非不收|没说不收|先放着|先别催|等会儿|等会|晚点|过会儿|回头再|想清楚|考虑一下|先问清楚|为什么发|怎么突然)/.test(text)) return 'pending';
  if (/(不收|不要|别发|别给|退回|退还|还给你|拒收|不领|不拿|拿回去|收不起|用不着|算了吧)/.test(text)) return 'refused';
  if (/(收下|收了|我收|领了|领取|拿了|收到|收款|谢谢|谢了|多谢|恭敬不如从命|不客气了|那我就收|拆了|点开了)/.test(text)) return 'received';
  return 'pending';
}

async function updateBackgroundPaymentStatusFromReply(state, charId, reply, explicitStatus = '') {
  const chat = state?.allChats?.[charId];
  const message = latestPendingPayment(chat);
  if (!message) return false;
  const status = normalizePaymentDirectiveStatus(explicitStatus) || inferPaymentStatusFromReply(reply);
  if (status === 'pending') return false;
  const char = (state.characters || []).find(row => row.id === charId);
  const type = message.payType || message.type;
  const label = type === 'redpacket' ? '红包' : '转账';
  const note = message.note ? `，备注“${message.note}”` : '';
  const now = Date.now();
  if (type === 'redpacket' && status === 'refused') {
    message.payDeclinedAt = now;
  } else {
    message.payStatus = status;
    message.payStatusTime = now;
    if (status === 'refused' && !message.refunded) {
      state.settings.walletBalance = Math.max(0, Math.round(((Number(state.settings.walletBalance) || 0) + (Number(message.amount) || 0)) * 100) / 100);
      message.refunded = true;
    }
  }
  if (message.payMemoryRecordedStatus !== status) {
    const result = status === 'received'
      ? `${charName(char)}收下了${playerName(state.settings)}发来的${label}`
      : `${charName(char)}没有收下${playerName(state.settings)}发来的${label}`;
    const pendingRule = type === 'redpacket' && status === 'refused' ? '；红包仍处于待领取状态，24小时未领取才会自动退回' : '';
    await recordBackgroundScenarioMemory(state, charId, '支付事件', `${result}，金额 ${formatMoney(message.amount)}${note}${pendingRule}。`, { type: 'payment', keywords: [label, status === 'received' ? '领取' : '拒收'] });
    message.payMemoryRecordedStatus = status;
  }
  return true;
}

function buildBackgroundMemoryQueryPayload(char, triggerText, messages, settings = {}) {
  const system = `你是 AL 的后台本地记忆检索 AI。
你不参与角色扮演，不回复${playerName(settings)}，不替${charName(char)}说话。
任务：只根据当前触发原因、固定最近200条聊天和后台场景事件，生成向量数据库召回用的检索查询。
当前触发原因或玩家最近一条发言优先级最高。最近200条只用于消除“昨天那件事”等指代歧义，不代表其中每个旧话题都要召回。
正例：当前触发原因明确提到“昨天的红包”，检索红包金额、是否领取和备注。
反例：当前是新话题，却仅因30条里出现过红包就继续召回并催问红包。
有关联时可以召回昨天或更早的记忆；没有关联时不要强行带入旧内容。
query 要围绕当前需要回忆的事实、关系、承诺、红包、朋友圈或雷点。
keywords 要短而具体，方便本地记忆库召回。
只输出 JSON，不要输出解释：{"query":"一句检索查询","keywords":["关键词"],"focus":"profile|event|relationship|payment|moment|current"}`;
  const user = `双方昵称：${playerName(settings)} / ${charName(char)}
固定最近200条聊天与场景事件（仅用于判断当前触发是否指向旧内容）：
${messages.slice(-NORMAL_RAW_CONTEXT_LIMIT).map(m => messageLine(m, char, settings)).join('\n') || '暂无'}

当前触发原因：
${triggerText}

输出 JSON：{"query":"一句检索查询，包含最需要回忆的人物、事件、承诺、朋友圈/红包等关键词","keywords":["关键词"],"focus":"profile|event|relationship|payment|moment|current"}`;
  return { system, user };
}

function hasBackgroundMemoryApi(settings = {}) {
  return !!(settings.memoryApiUrl && settings.memoryApiKey && settings.memoryModel);
}

async function callBackgroundMemoryJSON(settings = {}, system, user, options = {}) {
  const apiType = settings.memoryApiType || 'openai';
  const apiUrl = settings.memoryApiUrl || '';
  const apiKey = cleanApiKey(settings.memoryApiKey || '');
  const model = settings.memoryModel || '';
  if (!apiUrl || !apiKey || !model) throw new Error('memory api not configured');
  const startedAt = Date.now();
  const messages = [{ role: 'user', content: user }];
  let text = '';
  let diagnostic = '';
  if (apiType === 'claude') {
    try {
      const endpoint = apiEndpoint(apiUrl, 'messages');
      const resp = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, system, messages, max_tokens: MEMORY_MAX_TOKENS, temperature: 0.2 })
      }, API_TIMEOUT_MS);
      const raw = await resp.text();
      rejectHtmlApiResponse(raw, resp, endpoint);
      if (!resp.ok) throw new Error(`记忆 API ${resp.status}: ${raw.slice(0, 120)}`);
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
      const endpoint = apiEndpoint(apiUrl, 'chat/completions');
      const resp = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.2, max_tokens: MEMORY_MAX_TOKENS })
      }, API_TIMEOUT_MS);
      const raw = await resp.text();
      rejectHtmlApiResponse(raw, resp, endpoint);
      if (!resp.ok) throw new Error(`记忆 API ${resp.status}: ${raw.slice(0, 120)}`);
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

function memoryQuerySceneName(scene = 'background-memory-query') {
  const value = String(scene || '').trim();
  if (!value || value === 'background-memory-query') return 'background-memory-query';
  return value.startsWith('background-memory-query-') ? value : `background-memory-query-${value}`;
}

async function generateBackgroundMemoryQuery(charId, char, settings = {}, triggerText = '', messages = [], scene = 'background-memory-query') {
  const fallback = { query: `${charName(char)} ${triggerText}`, keywords: memorySignalTerms(triggerText).slice(0, 8), focus: 'current', _memoryAiStatus: 'skipped' };
  const queryScene = memoryQuerySceneName(scene);
  if (!hasBackgroundMemoryApi(settings)) {
    setMemoryQueryStatus(settings, '后台记忆AI筛选跳过：记忆接口未完整配置，已改用本地关键词检索。');
    return fallback;
  }
  const payload = buildBackgroundMemoryQueryPayload(char, triggerText, messages, settings);
  try {
    const json = await callBackgroundMemoryJSON(settings, payload.system, payload.user, { scene: queryScene, charId });
    return { ...fallback, ...json, _memoryAiStatus: 'ok' };
  } catch (err) {
    console.warn('[AL SW Memory] query fallback:', err.message);
    setMemoryQueryStatus(settings, `后台记忆AI筛选失败：${err.message}；已改用本地关键词检索。`);
    return { ...fallback, _memoryAiStatus: 'failed' };
  }
}

async function buildMemoryPack(charId, char, settings = {}, queryText = '', scene = 'background-memory-query') {
  const state = await getMeta('app_state', null).catch(() => null);
  const recent = Array.isArray(state?.allChats?.[charId]?.messages) ? state.allChats[charId].messages.slice(-NORMAL_RAW_CONTEXT_LIMIT) : [];
  const query = await generateBackgroundMemoryQuery(charId, char, settings, queryText, recent, scene);
  const recallText = [query.query, queryText, ...(query.keywords || [])].filter(Boolean).join(' ');
  return Promise.all([
    searchMemoryVectors(charId, recallText),
    getAll('summaries'),
    getAll('events'),
    getAll('profiles')
  ]).then(([hits, summaries, events, profiles]) => {
    const vectorKeys = new Set(hits.map(hit => `${hit.sourceType}:${hit.sourceId}`));
    if (query._memoryAiStatus === 'ok') {
      const keywordText = (query.keywords || []).slice(0, 5).join('、') || query.query || '已生成检索词';
      setMemoryQueryStatus(settings, `后台记忆AI已调用；关键词：${keywordText}；向量库召回 ${hits.length} 条。`);
    }
    const keywordRows = searchKeywordMemoryRows({ summaries, events, profiles }, recallText, query.keywords || [], char, settings, 5)
      .filter(hit => !vectorKeys.has(`${hit.sourceType}:${hit.sourceId}`));
    return composeMemoryPackSections(
      '以下是记忆AI根据本次触发原因筛选出的手机本地记忆补充。不要提到记忆库、系统、推送或后台，只把它自然转化成角色发来的微信消息。',
      [
        { title: '本轮相关记忆', priority: 10, lines: hits.map(h => memoryAliasText(h.text, char, settings)) },
        { title: '关键词补充记忆', priority: 20, lines: keywordRows.map(row => `${row.text}${row.reason ? `（触发：${row.reason}）` : ''}`) }
      ]
    );
  });
}

function buildBackgroundProactiveChatSystem(settings, char, chat, memoryPack, proactiveNow, proactiveTimeContext, triggerMode = 'planned') {
  const composer = createPromptComposer('proactive-chat');
  const normalizedTriggerMode = normalizeProactiveTriggerMode(triggerMode);
  composer.add('char-prompt', stripStagePersonaBlock(chat.charPrompt || `当前你要扮演的角色：${charName(char)}`), { priority: 0 });
  composer.add('stage-persona', backgroundStagePersonaBlock(char, settings), { priority: 5 });
  composer.add('time-context', '当前设备时间（角色可以自然参考，但不要说自己看到了系统时间）：\n' + getTimeContext(proactiveNow), { priority: 10 });
  composer.add('memory-pack', memoryPack, { priority: 20 });
  const pendingPayment = latestPendingPayment(chat);
  if (pendingPayment) {
    const label = (pendingPayment.payType || pendingPayment.type) === 'redpacket' ? '红包' : '转账';
    composer.add('pending-payment-context', `当前会话仍有一笔${playerName(settings)}发给${charName(char)}的${label}等待处理，金额 ${formatMoney(pendingPayment.amount)}${pendingPayment.note ? `，备注“${pendingPayment.note}”` : ''}。
如果本条消息明确已经领取/收下，正文后输出 <al_payment>{"status":"received"}</al_payment>；明确拒收/退还则输出 refused；犹豫、晚点处理或没有决定则输出 pending。这个标签只供后端更新支付 UI，禁止解释。红包拒绝后仍待领取，24 小时未领取才退回；转账拒收会立即退回。`, { priority: 30 });
  }
  composer.add('global-extra-preset', settings.systemPrompt ? '全局补充预设：\n' + settings.systemPrompt : '', { priority: 80 });
  composer.add('chat-extra-prompt', chat.extraPrompt ? '当前会话补充：\n' + chat.extraPrompt : '', { priority: 90 });
  composer.add('proactive-time-context', proactiveTimeContext, { priority: 100 });
  composer.add('proactive-task', `主动消息任务：现在不是${playerName(settings)}刚刚发消息后等你回答，而是经过了一段空闲时间后，你作为${charName(char)}主动给${playerName(settings)}发来一条微信式消息。
当前主动阶段：${normalizedTriggerMode === 'dice' ? '随机再联系。你已经主动追发过，但玩家仍未回复；禁止沿着你自己的上一句话继续自问自答，也不要再次催同一件事。' : '计划追发。这是正常回复后唯一的一轮计划主动消息；不要输出下一次发送时间，发出后系统会切换到随机再联系。'}
关系语境：${playerName(settings)}已经有一段时间没有继续回复${charName(char)}了。${charName(char)}可以对此有轻微反应，比如试探、嘴硬、换话题、追问、补一句刚才没说完的话，或装作不在意；具体语气必须符合角色性格和双方关系。
你应该根据时间流逝、你上一条说过的话、未解决话题、约定或关系状态主动开口。
可以延续上一话题、关心${playerName(settings)}、提起约定、找一个符合角色的自然话题；长间隔时更像重新打开聊天。
如果已经隔了很久、跨天或接近一天，不能像刚刚结束上一轮聊天一样继续追红包/转账/测试等旧话题；应该换成更自然的重新开口，旧事不能成为主要内容。超过 24 小时时，必须加入符合当前时段的新话题或新关心。
禁止说“免打扰模式、骰子、摇骰、调度、时间戳、系统、后台、推送、定时器”等调度相关词。
只能输出消息正文。禁止动作、神态、环境、旁白、心理描写、系统说明、推送说明、定时器说明，禁止替${playerName(settings)}说话。
如果想连续发几条消息，用换行分隔每一条；系统会把每一行拆成独立聊天气泡。不要在同一个消息里用换行排版。
默认 1-3 句。`, { priority: 110, scenes: ['proactive-chat'] });
  return { system: composer.compile(), promptBlocks: promptBlockDiagnostics(composer.blocks()) };
}

function buildBackgroundMomentPostSystem(settings, char, chat, memoryPack, proactiveNow, momentContext = '') {
  const composer = createPromptComposer('moment-post');
  composer.add('char-prompt', stripStagePersonaBlock(chat.charPrompt || `当前你要扮演的角色：${charName(char)}`), { priority: 0 });
  composer.add('stage-persona', backgroundStagePersonaBlock(char, settings), { priority: 5 });
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
    historyOmitted: options.historyOmitted,
    promptBlocks: options.promptBlocks,
    system,
    messages,
    startedAt
  };
  if (apiType === 'claude') {
    let resp;
    try {
      const endpoint = apiEndpoint(apiUrl, 'messages');
      resp = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', system, messages, max_tokens: Number(settings.maxTokens) || 1000, temperature: Number(settings.temperature) || 0.8, stream: useStream })
      }, API_TIMEOUT_MS);
      rejectHtmlApiResponse('', resp, endpoint);
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
    rejectHtmlApiResponse(raw, resp);
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
    const endpoint = apiEndpoint(apiUrl, 'chat/completions');
    resp = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o', messages: [{ role: 'system', content: system }, ...messages], temperature: Number(settings.temperature) || 0.8, max_tokens: Number(settings.maxTokens) || 1000, stream: useStream })
    }, API_TIMEOUT_MS);
    rejectHtmlApiResponse('', resp, endpoint);
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
  rejectHtmlApiResponse(raw, resp);
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
function proactiveJobMode(job) {
  return job?.mode === 'dice' ? 'dice' : 'planned';
}
function proactiveDiceOptions(kind = 'chat') {
  return kind === 'moment'
    ? { mode: 'dice', intervalMs: MOMENT_DICE_INTERVAL_MS, rollChance: MOMENT_DICE_CHANCE, maxRolls: MOMENT_DICE_MAX_ROLLS }
    : { mode: 'dice', intervalMs: PROACTIVE_DICE_INTERVAL_MS, rollChance: PROACTIVE_DICE_CHANCE, maxRolls: PROACTIVE_DICE_MAX_ROLLS };
}
function proactiveDicePlan(options = {}, now = Date.now(), randomValue = Math.random()) {
  const intervalMs = Math.max(60000, Number(options.intervalMs) || PROACTIVE_DICE_INTERVAL_MS);
  const rawChance = Number(options.rollChance ?? PROACTIVE_DICE_CHANCE);
  const chance = Number.isFinite(rawChance) ? Math.max(0, Math.min(1, rawChance)) : PROACTIVE_DICE_CHANCE;
  const maxRolls = Math.max(1, Math.floor(Number(options.maxRolls) || PROACTIVE_DICE_MAX_ROLLS));
  const rawRandom = Number(randomValue);
  const random = Number.isFinite(rawRandom) ? Math.max(0, Math.min(1 - Number.EPSILON, rawRandom)) : Math.random();
  let rolls = 1;
  if (chance <= 0) rolls = maxRolls;
  else if (chance < 1) rolls = Math.floor(Math.log(1 - random) / Math.log(1 - chance)) + 1;
  rolls = Math.max(1, Math.min(maxRolls, rolls));
  const parsedNow = now instanceof Date ? now.getTime() : Number(now);
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  return { dueAt: new Date(nowMs + rolls * intervalMs), rolls, intervalMs, rollChance: chance, maxRolls };
}
function rollProactiveDice(kind = 'chat', job = null) {
  if (job?.dicePrecomputed) return true;
  const chance = Math.max(0, Math.min(1, Number(job?.rollChance ?? proactiveDiceOptions(kind).rollChance) || 0));
  return Math.random() < chance;
}
function proactiveJobId(settings, charId, kind = 'chat') {
  return `${proactiveJobPrefix(kind)}_${settings.deviceId}_${charId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function proactivePayloadMatchesJob(payload = {}, job = null) {
  if (!payload.charId) return true;
  if (!job) return false;
  if (payload.jobId && job.jobId && payload.jobId !== job.jobId) return false;
  if (payload.dueAt && job.dueAt) {
    const payloadDueAt = Date.parse(payload.dueAt);
    const localDueAt = Date.parse(job.dueAt);
    if (Number.isFinite(payloadDueAt) && Number.isFinite(localDueAt) && Math.abs(payloadDueAt - localDueAt) > 1000) return false;
  }
  return true;
}
function cloudTimerDefaultQuotaRetryAt(now = Date.now()) {
  const current = new Date(now);
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1)).toISOString();
}
function cloudTimerQuotaPauseActive(settings, now = Date.now()) {
  const retryAt = Date.parse(settings?.cloudTimerQuotaRetryAt || '');
  return Number.isFinite(retryAt) && retryAt > now;
}
function isCloudTimerQuotaError(err) {
  return ['KV_DAILY_WRITE_LIMIT', 'D1_DAILY_LIMIT'].includes(err?.code)
    || /KV put\(\) limit exceeded for the day|KV daily write limit exceeded|D1 daily limit exceeded/i.test(String(err?.message || err || ''));
}
async function cloudTimerResponseError(resp) {
  let payload = null;
  try { payload = await resp.json(); } catch (_) {}
  const err = new Error(String(payload?.error || `schedule failed ${resp.status}`));
  err.code = String(payload?.code || '');
  err.retryAt = String(payload?.retryAt || '');
  err.httpStatus = resp.status;
  return err;
}
async function scheduleNextCloudProactive(state, charId, kind = 'chat', options = {}) {
  const settings = state?.settings || {};
  const chat = state?.allChats?.[charId];
  if (!automaticTasksEnabled(settings) || !settings.timerEndpoint || !settings.pushSubscription || !settings.deviceId || !chat) return false;
  if (cloudTimerQuotaPauseActive(settings)) return false;
  if (!(await automaticTasksStillEnabled())) return false;
  const jobKey = proactiveJobKey(kind);
  const previousJob = chat[jobKey] ? { ...chat[jobKey] } : null;
  const mode = options.mode === 'dice' ? 'dice' : 'planned';
  const dicePlan = mode === 'dice' ? proactiveDicePlan(options) : null;
  const dueAtMs = dicePlan?.dueAt.getTime() || (Date.now() + proactiveDelayMs(settings, kind));
  const jobId = proactiveJobId(settings, charId, kind);
  chat[jobKey] = { jobId, dueAt: new Date(dueAtMs).toISOString(), kind, mode };
  if (mode === 'dice') {
    chat[jobKey].rollChance = dicePlan.rollChance;
    chat[jobKey].diceIntervalMs = dicePlan.intervalMs;
    chat[jobKey].diceRolls = dicePlan.rolls;
    chat[jobKey].dicePrecomputed = true;
    chat[jobKey].maxRolls = dicePlan.maxRolls;
  }
  try {
    const resp = await fetchWithTimeout(timerUrl(settings, '/schedule'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: settings.deviceId, jobId, charId, dueAt: chat[jobKey].dueAt, type: 'proactive', kind, mode: proactiveJobMode(chat[jobKey]), rollChance: chat[jobKey].rollChance, diceIntervalMs: chat[jobKey].diceIntervalMs, diceRolls: chat[jobKey].diceRolls, dicePrecomputed: !!chat[jobKey].dicePrecomputed })
    }, API_TIMEOUT_MS);
    if (!resp.ok) throw await cloudTimerResponseError(resp);
    delete settings.cloudTimerQuotaRetryAt;
    if (!(await automaticTasksStillEnabled())) {
      await fetchWithTimeout(timerUrl(settings, '/cancel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: settings.deviceId, jobId })
      }, 8000).catch(err => console.warn('[AL Push] disabled job cleanup skipped:', err));
      if (previousJob) chat[jobKey] = previousJob;
      else delete chat[jobKey];
      return false;
    }
    if (previousJob?.jobId && previousJob.jobId !== chat[jobKey].jobId) {
      await fetchWithTimeout(timerUrl(settings, '/cancel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: settings.deviceId, jobId: previousJob.jobId })
      }, 8000).catch(err => console.warn('[AL Push] stale job cleanup skipped:', err));
    }
  } catch (err) {
    if (isCloudTimerQuotaError(err)) {
      settings.cloudTimerQuotaRetryAt = err.retryAt || cloudTimerDefaultQuotaRetryAt();
      setStateCloudTimerStatus(state, `Cloudflare KV 今日写入额度已用完；本地${kind === 'moment' ? '朋友圈' : '私聊'}任务已保留，额度重置后自动同步。`, kind);
      state.updatedAt = Date.now();
      await setMeta('app_state', state);
      return true;
    }
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
  if (!automaticTasksEnabled(state.settings)) return false;
  const allChats = state.allChats;
  const dueJob = payload.charId
    ? { charId: payload.charId, kind: payload.kind === 'moment' ? 'moment' : 'chat' }
    : findDueProactiveJob(allChats);
  const charId = dueJob?.charId || '';
  const kind = dueJob?.kind || 'chat';
  const chat = allChats[charId];
  if (!charId || !chat) return false;
  try {
    if (!(await automaticTasksStillEnabled())) return false;
    await scheduleNextCloudProactive(state, charId, kind, proactiveDiceOptions(kind));
    if (!(await automaticTasksStillEnabled())) return false;
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
  if (!automaticTasksEnabled(state.settings)) return false;
  const { settings, characters, allChats } = state;
  const traceId = `${payload.kind === 'moment' ? 'mom' : 'chat'}-${Date.now().toString(36).slice(-6)}`;
  scrubEmptyReplyMessages(allChats);
  const exactDueJobs = payload.charId
    ? (() => {
        const kind = payload.kind === 'moment' ? 'moment' : 'chat';
        const job = allChats[payload.charId]?.[proactiveJobKey(kind)] || null;
        return [{ charId: payload.charId, kind, job }];
      })()
    : getDueProactiveJobs(allChats);
  const fallbackJob = !payload.charId && !exactDueJobs.length ? getFallbackProactiveJob(allChats) : null;
  const dueJobs = exactDueJobs.length ? exactDueJobs : (fallbackJob ? [fallbackJob] : []);
  const dueJob = dueJobs[0] || null;
  const charId = dueJob?.charId || '';
  const kind = dueJob?.kind || 'chat';
  const triggerMode = kind === 'chat' && allChats[charId]
    ? expectedProactiveChatMode(allChats[charId])
    : proactiveJobMode(dueJob?.job || payload);
  if (!charId) {
    setStateCloudTimerTrace(state, 'chat', traceId, '收到云端 push，但本地没有可触发会话或任务');
    setStateCloudTimerStatus(state, '后台收到云闹钟，但本地没有可触发会话；请打开 AL 后重新绑定或重新安排。', 'chat');
    state.updatedAt = Date.now();
    if (!(await automaticTasksStillEnabled())) return false;
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', skipped: true });
    return;
  }
  if (!payload.test && !proactivePayloadMatchesJob(payload, dueJob.job)) {
    setStateCloudTimerTrace(state, kind, traceId, '忽略已被新任务替换的旧推送，避免沿用过期话题。');
    state.allChats = allChats;
    state.updatedAt = Date.now();
    if (!(await automaticTasksStillEnabled())) return false;
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, stalePushSkipped: true });
    return;
  }
  if (kind === 'chat' && !payload.test && !proactiveJobMatchesConversationStage(allChats[charId], dueJob.job)) {
    const expectedMode = expectedProactiveChatMode(allChats[charId]);
    setStateCloudTimerTrace(state, kind, traceId, `忽略阶段不匹配的${proactiveJobMode(dueJob.job) === 'dice' ? '随机抽取' : '计划追发'}任务，已按当前会话改排为${expectedMode === 'dice' ? '随机抽取' : '计划追发'}。`);
    await scheduleNextCloudProactive(state, charId, kind, expectedMode === 'dice'
      ? proactiveDiceOptions(kind)
      : { mode: 'planned' });
    if (!(await automaticTasksStillEnabled())) return false;
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, stageMismatchSkipped: true });
    return;
  }
  if (await hasVisibleClient()) {
    setStateCloudTimerTrace(state, kind, traceId, `后台收到 push，mode=${triggerMode}，页面可见，转交前台处理；目标：${charId}${dueJob.job?.dueAt ? `，本地 due=${formatFullTime(new Date(dueJob.job.dueAt))}` : '，无本地 due'}`);
    setStateCloudTimerTriggerAck(state, `${payload.test ? '测试' : '真实'}${kind === 'moment' ? '朋友圈' : '私聊'}闹钟已被后台收到并转交前台。`);
    state.updatedAt = Date.now();
    if (!(await automaticTasksStillEnabled())) return false;
    await setMeta('app_state', state);
    if (!payload.charId && exactDueJobs.length > 1) {
      await notifyClients({ type: 'al-run-proactive-due', jobCount: dueJobs.length, test: dueJobs.some(row => row.job?.test) });
      return;
    }
    await notifyClients({
      type: 'al-run-proactive',
      charId,
      kind,
      mode: triggerMode,
      jobId: payload.jobId || dueJob.job?.jobId || '',
      test: !!(payload.test || dueJob.job?.test),
      fallback: !!fallbackJob
    });
    return;
  }
  if (proactiveJobMode(dueJob.job || payload) === 'dice' && !rollProactiveDice(kind, dueJob.job || payload)) {
    setStateCloudTimerTrace(state, kind, traceId, `后台骰子未抽中，本轮不生成${kind === 'moment' ? '朋友圈，6 小时后再抽' : '私聊，10 分钟后再抽'}。`);
    await scheduleNextCloudProactive(state, charId, kind, proactiveDiceOptions(kind));
    if (!(await automaticTasksStillEnabled())) return false;
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, skipped: true });
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
  setStateCloudTimerTrace(state, kind, traceId, `后台收到触发，mode=${triggerMode}，目标：${charId}${fallbackJob ? '，本地未命中到期任务，已用最近任务兜底' : ''}`);
  setStateCloudTimerTriggerAck(state, `真实${kind === 'moment' ? '朋友圈' : '私聊'}闹钟已被后台收到。`);
  state.updatedAt = Date.now();
  if (!(await automaticTasksStillEnabled())) return false;
  await setMeta('app_state', state);
  if (kind === 'moment') return handleProactiveMomentPush(state, charId, payload);
  const char = (characters || []).find(c => c.id === charId);
  const chat = allChats[charId];
  if (!char || !chat?.messages?.length) throw new Error('missing chat');
  if (!(settings.chatApiUrl || settings.apiUrl) || !(settings.chatApiKey || settings.apiKey) || !(settings.chatModel || settings.model)) throw new Error('missing api config');
  if (await refreshBackgroundPaymentExpirations(state, charId)) {
    state.allChats = allChats;
    state.updatedAt = Date.now();
    if (!(await automaticTasksStillEnabled())) return false;
    await setMeta('app_state', state);
  }
  const proactiveNow = new Date();
  const proactiveTimeContext = buildProactiveTimeContext(chat, proactiveNow, triggerMode);
  const memoryQuery = buildProactiveMemoryQuery(chat, settings, proactiveNow, triggerMode);
  const memoryPack = await buildMemoryPack(charId, char, settings, memoryQuery, 'proactive-chat');
  if (!(await automaticTasksStillEnabled())) return false;
  setStateCloudTimerTrace(state, 'chat', traceId, `记忆完成 ${String(memoryPack || '').length} 字，正在请求聊天模型`);
  const prompt = buildBackgroundProactiveChatSystem(settings, char, chat, memoryPack, proactiveNow, proactiveTimeContext, triggerMode);

  const messages = proactiveRecentMessages(chat, 30, proactiveNow, settings);
  const historyOmitted = Math.max(0, recentMessageCandidateCount(chat, 30) - messages.length);
  messages.push({ role: 'user', content: buildProactiveTriggerMessage(settings, char, chat, proactiveNow, triggerMode) });
  const reply = (await callModel(settings, prompt.system, messages, {
    stream: true,
    kind: 'chat',
    scene: 'background-proactive-chat',
    charId,
    memoryChars: memoryPack.length,
    historyOmitted,
    memoryStatus: memoryStatusWithBudget(memoryPack, memoryQuerySnapshot(settings)),
    promptBlocks: prompt.promptBlocks
  })).trim();
  if (!(await automaticTasksStillEnabled())) return false;
  setStateCloudTimerTrace(state, 'chat', traceId, `模型返回 ${reply.length} 字`);
  const paymentDirective = extractPaymentStatusDirective(reply);
  const replyText = cleanAssistantChatReply(reply);
  chat.lastProactiveAt = Date.now();
  chat.lastProactiveChatAt = Date.now();
  if (chat.pendingProactiveJob?.jobId === payload.jobId || payload.jobId) delete chat.pendingProactiveJob;
  if (isEmptyReplyText(replyText)) {
    const emptyReason = lastModelResponseDiagnostic || '空回复';
    try {
      await scheduleNextCloudProactive(state, charId, 'chat', proactiveDiceOptions('chat'));
    } catch (err) {
      console.warn('[AL Push] next schedule skipped:', err);
    }
    if (!(await automaticTasksStillEnabled())) return false;
    setStateCloudTimerTrace(state, 'chat', traceId, `空回复：${emptyReason}`);
    setStateCloudTimerStatus(state, `后台私聊生成了空回复：${emptyReason}，已跳过并安排下次重试。`, 'chat');
    state.allChats = allChats;
    state.updatedAt = Date.now();
    await setMeta('app_state', state);
    await notifyClients({ type: 'al-state-updated', charId, skipped: true });
    return;
  }
  const chunks = appendAssistantMessages(chat, replyText, { proactive: true, proactiveMode: triggerMode });
  if (!chunks.length) {
    try {
      await scheduleNextCloudProactive(state, charId, 'chat', proactiveDiceOptions('chat'));
    } catch (err) {
      console.warn('[AL Push] next schedule skipped:', err);
    }
    if (!(await automaticTasksStillEnabled())) return false;
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
  await updateBackgroundPaymentStatusFromReply(state, charId, replyText, paymentDirective?.status);
  if (!(await automaticTasksStillEnabled())) return false;
  try {
    await scheduleNextCloudProactive(state, charId, 'chat', proactiveDiceOptions('chat'));
  } catch (err) {
    console.warn('[AL Push] next schedule skipped:', err);
  }
  if (!(await automaticTasksStillEnabled())) return false;
  setStateCloudTimerTrace(state, 'chat', traceId, `写入完成 ${chunks.length} 条`);
  setStateCloudTimerStatus(state, `后台私聊已生成 ${chunks.length} 条消息。`, 'chat');
  await recordBackgroundScenarioMemory(
    state,
    charId,
    '后台主动私聊',
    `${charName(char)}后台主动给${playerName(settings)}发来私聊：“${chunks.join(' / ')}”`,
    { type: 'fact', keywords: ['主动消息', '私聊', ...memorySignalTerms(chunks.join(' ')).slice(0, 6)] }
  );
  if (!(await automaticTasksStillEnabled())) return false;
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
  if (!automaticTasksEnabled(settings)) return false;
  const allMoments = Array.isArray(state.allMoments) ? state.allMoments : [];
  const char = (characters || []).find(c => c.id === charId);
  const chat = allChats[charId];
  if (!char || !chat?.messages?.length) return false;
  if (await refreshBackgroundPaymentExpirations(state, charId)) {
    state.allChats = allChats;
    state.updatedAt = Date.now();
    if (!(await automaticTasksStillEnabled())) return false;
    await setMeta('app_state', state);
  }
  const proactiveNow = new Date();
  const momentContext = buildBackgroundMomentContext(allMoments, characters, charId, settings, 6);
  const memoryQuery = `角色朋友圈动态触发。\n${getTimeContext(proactiveNow)}\n${charName(char)}准备主动发朋友圈。\n${momentContext}`;
  const memoryPack = await buildMemoryPack(charId, char, settings, memoryQuery, 'moment-post');
  if (!(await automaticTasksStillEnabled())) return false;
  const prompt = buildBackgroundMomentPostSystem(settings, char, chat, memoryPack, proactiveNow, momentContext);
  const messages = proactiveRecentMessages(chat, 20, proactiveNow, settings);
  const historyOmitted = Math.max(0, recentMessageCandidateCount(chat, 20) - messages.length);
  const raw = (await callModel(settings, prompt.system, messages, {
    kind: 'moment',
    scene: 'background-moment-post',
    charId,
    memoryChars: memoryPack.length,
    historyOmitted,
    memoryStatus: memoryStatusWithBudget(memoryPack, memoryQuerySnapshot(settings)),
    promptBlocks: prompt.promptBlocks
  })).trim();
  if (!(await automaticTasksStillEnabled())) return false;
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
      await scheduleNextCloudProactive(state, charId, 'moment', proactiveDiceOptions('moment'));
    } catch (err) {
      console.warn('[AL Push] next schedule skipped:', err);
    }
    if (!(await automaticTasksStillEnabled())) return false;
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
    await scheduleNextCloudProactive(state, charId, 'moment', proactiveDiceOptions('moment'));
  } catch (err) {
    console.warn('[AL Push] next schedule skipped:', err);
  }
  if (!(await automaticTasksStillEnabled())) return false;
  await recordBackgroundScenarioMemory(
    state,
    charId,
    '后台朋友圈动态',
    `${charName(char)}后台主动发布朋友圈：“${text}”`,
    { type: 'moment', keywords: ['朋友圈', '动态', ...memorySignalTerms(text).slice(0, 6)] }
  );
  if (!(await automaticTasksStillEnabled())) return false;
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
  const rows = Object.entries(allChats || {}).flatMap(([charId, chat]) =>
    PROACTIVE_JOB_KINDS.map(kind => ({ charId, kind, chat, job: chat?.[proactiveJobKey(kind)] }))
  );
  return rows
    .filter(r => r.job?.dueAt && Date.parse(r.job.dueAt) <= now)
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
    if (!(await automaticTasksStillEnabled())) return;
    let wakeShown = false;
    try {
      wakeShown = await showProactiveWakeNotification(payload);
      await handleProactivePush(payload);
      if (wakeShown) await closeProactiveWakeNotification();
    } catch (err) {
      if (wakeShown) await closeProactiveWakeNotification();
      if (!(await automaticTasksStillEnabled())) return;
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
