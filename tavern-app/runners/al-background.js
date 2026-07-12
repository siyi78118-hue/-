const RUNNER_STATE_KEY = 'state_json';
const PENDING_PUSH_QUEUE_KEY = 'pending_push_queue';
const PENDING_USER_REPLY_QUEUE_KEY = 'pending_user_reply_queue';
const DICE_INTERVAL_MS = 10 * 60 * 1000;
const DICE_CHANCE = 0.05;
const MAX_DICE_ROLLS = 432;
const MAX_PUSHES_PER_WAKE = 8;

function kvGet(key) {
  const result = CapacitorKV.get(key);
  return result && typeof result === 'object' && 'value' in result ? result.value : result;
}

function readJson(key, fallback = null) {
  try {
    const raw = kvGet(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error('[AL Background] read failed', key, err);
    return fallback;
  }
}

function writeState(state) {
  state.updatedAt = Date.now();
  CapacitorKV.set(RUNNER_STATE_KEY, JSON.stringify(state));
}

function pendingPushQueue() {
  const queue = readJson(PENDING_PUSH_QUEUE_KEY, []);
  return Array.isArray(queue) ? queue : [];
}

function dequeuePendingPush() {
  const queue = pendingPushQueue();
  const payload = queue.shift() || null;
  CapacitorKV.set(PENDING_PUSH_QUEUE_KEY, JSON.stringify(queue));
  return payload;
}

function requeuePendingPush(payload) {
  if (!payload) return;
  const queue = pendingPushQueue();
  const jobId = String(payload.jobId || '');
  if (!jobId || !queue.some(item => String(item?.jobId || '') === jobId)) queue.unshift(payload);
  CapacitorKV.set(PENDING_PUSH_QUEUE_KEY, JSON.stringify(queue));
}

function asBool(value) {
  return value === true || value === 'true' || value === '1';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function elapsedText(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return '不到1分钟';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}`;
  return `${Math.floor(hours / 24)}天${hours % 24 ? `${hours % 24}小时` : ''}`;
}

function periodFor(date) {
  const hour = date.getHours();
  if (hour < 5) return ['凌晨', '早上、上午、中午、下午、傍晚'];
  if (hour < 8) return ['清晨', '半夜三更、深夜、下午、晚上'];
  if (hour < 11) return ['上午', '半夜三更、深夜、下午、晚上'];
  if (hour < 13) return ['中午', '半夜三更、深夜、清晨、晚上'];
  if (hour < 18) return ['下午', '半夜三更、深夜、凌晨、早上、上午、晚上'];
  if (hour < 22) return ['晚上', '半夜三更、凌晨、早上、上午、下午'];
  return ['深夜', '早上、上午、中午、下午、傍晚'];
}

function runtimeTimeContext(chat, now = new Date()) {
  const visible = (chat?.messages || []).filter(message => !message.hidden && !message.deleted && !message.retracted);
  const last = visible[visible.length - 1];
  const [period, banned] = periodFor(now);
  const elapsed = last?.time ? elapsedText(now.getTime() - Number(last.time)) : '未知';
  return [
    '【本次后台触发的最新现实时间，优先级高于前文旧时间】',
    `当前设备时间：${formatLocalTime(now)}`,
    `当前时段：${period}`,
    `距离最后一条可见消息：${elapsed}`,
    `禁止使用与当前时段矛盾的说法：${banned}。`,
    '这是一段时间后角色主动打开聊天，不是玩家刚发来问题后的即时回答。',
    '若已经跨天或间隔很久，应像重新发起微信消息；可以记得旧话题，但不能假装旧对话刚刚结束。',
    '只输出聊天语言，不输出动作、旁白、心理、系统说明或调度信息。'
  ].join('\n');
}

function visibleMessages(chat, count = 30, now = new Date()) {
  return (chat?.messages || [])
    .filter(message => !message.deleted && !message.retracted && ['user', 'assistant'].includes(message.role))
    .slice(-count)
    .map(message => {
      const at = message.time ? new Date(message.time) : null;
      const stamp = at ? `【发送时间 ${formatLocalTime(at)}，距现在 ${elapsedText(now.getTime() - at.getTime())}】` : '';
      const hidden = message.hidden ? '【已经发生的后台事件，不是玩家刚发来的消息】' : '';
      return { role: message.role, content: `${stamp}${hidden}${String(message.content || '')}` };
    });
}

function cleanKey(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF\r\n\t]/g, '').trim();
}

function apiEndpoint(value, route) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('API 地址为空');
  if (!/^https?:\/\//i.test(raw)) throw new Error('API address must be an absolute URL');
  let hostname = '';
  let pathname = '';
  let base = '';
  if (typeof URL === 'function') {
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error('API 地址格式不正确'); }
    hostname = parsed.hostname;
    pathname = parsed.pathname;
    parsed.search = '';
    parsed.hash = '';
    base = parsed.toString().replace(/\/+$/, '');
  } else {
    const match = raw.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i);
    if (!match) throw new Error('API 地址格式不正确');
    const authority = match[2];
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    hostname = hostPort.startsWith('[')
      ? hostPort.slice(1, hostPort.indexOf(']'))
      : hostPort.split(':')[0];
    pathname = match[3] || '';
    base = `${match[1].toLowerCase()}://${authority}${pathname}`.replace(/\/+$/, '');
  }
  if (/github\.io$/i.test(hostname) && /\/(?:[^/]+\/)*tavern-app(?:\/|$)/i.test(pathname)) {
    throw new Error('API 地址指向了 AL 页面，不是模型接口');
  }
  base = base.replace(/\/(?:chat\/completions|messages|models)$/i, '');
  return base.replace(/\/+$/, '') + '/' + String(route || '').replace(/^\/+/, '');
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => extractText(item?.text ?? item?.content ?? item)).join('');
  if (!value || typeof value !== 'object') return '';
  return extractText(value.text ?? value.content ?? value.output_text ?? value.result ?? '');
}

function responseText(json) {
  return (
    extractText(json?.choices?.[0]?.message?.content) ||
    extractText(json?.choices?.[0]?.text) ||
    extractText(json?.content) ||
    extractText(json?.output_text) ||
    extractText(json?.candidates?.[0]?.content?.parts) ||
    extractText(json?.result)
  ).trim();
}

async function callModel(config, system, messages, maxTokens) {
  const type = config.type || 'openai';
  const url = String(config.url || '').replace(/\/+$/, '');
  const key = cleanKey(config.key);
  if (!url || !key || !config.model) throw new Error('API config missing');
  const endpoint = apiEndpoint(url, type === 'claude' ? 'messages' : 'chat/completions');
  const headers = type === 'claude'
    ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  const body = type === 'claude'
    ? { model: config.model, system, messages, max_tokens: maxTokens || 1000, temperature: Number(config.temperature) || 0.8, stream: false }
    : { model: config.model, messages: [{ role: 'system', content: system }, ...messages], max_tokens: maxTokens || 1000, temperature: Number(config.temperature) || 0.8, stream: false };
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await response.text();
  if (/text\/html/i.test(String(response.headers?.get?.('content-type') || '')) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(raw)) {
    throw new Error(`API returned HTML page: ${endpoint}`);
  }
  if (!response.ok) throw new Error(`API ${response.status}: ${raw.slice(0, 160)}`);
  let json;
  try { json = JSON.parse(raw); } catch { return raw.trim(); }
  return responseText(json);
}

function apiConfig(settings, kind) {
  const memory = kind === 'memory';
  return {
    type: memory ? settings.memoryApiType : settings.chatApiType,
    url: memory ? settings.memoryApiUrl : settings.chatApiUrl,
    key: memory ? settings.memoryApiKey : settings.chatApiKey,
    model: memory ? settings.memoryModel : settings.chatModel,
    temperature: memory ? 0.2 : settings.temperature
  };
}

function memoryRows(state, charId) {
  const memory = state.memory || {};
  return [
    ...(memory.profiles || []).filter(row => row.charId === charId).map(row => ({ type: '资料', at: row.createdAt, importance: row.importance, text: `${row.title || ''}：${row.detail || row.content || ''}` })),
    ...(memory.events || []).filter(row => row.charId === charId).map(row => ({ type: '事件', at: row.happenedAt || row.createdAt, importance: row.importance, text: `${row.title || ''}：${row.detail || ''}` })),
    ...(memory.summaries || []).filter(row => row.charId === charId).map(row => ({ type: '摘要', at: row.createdAt, importance: 2, text: row.content || '' }))
  ].filter(row => row.text.trim());
}

function fallbackMemoryPack(rows) {
  return rows
    .slice()
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || (Date.parse(b.at) || Number(b.at) || 0) - (Date.parse(a.at) || Number(a.at) || 0))
    .slice(0, 14)
    .map(row => `[${row.type}｜${row.at || '时间未注明'}] ${row.text}`)
    .join('\n');
}

async function retrieveMemory(state, charId, query) {
  const rows = memoryRows(state, charId);
  if (!rows.length) return '';
  const candidates = rows.slice(0, 120).map((row, index) => `${index + 1}. [${row.type}｜${row.at || '时间未注明'}] ${row.text}`).join('\n').slice(0, 16000);
  const config = apiConfig(state.settings || {}, 'memory');
  if (!config.url || !config.key || !config.model) return fallbackMemoryPack(rows);
  const system = `你是 AL 的记忆检索 AI。根据当前任务，从候选记忆中挑选真正有助于角色本次行为的内容。\n必须保留事件发生时间，禁止把昨天改写成今天。\n不要把无关琐事塞入结果。不要使用“用户、角色”代称，保留双方昵称。\n只输出选中的记忆，每行一条；没有相关记忆可输出“无相关记忆”。`;
  try {
    const output = await callModel(config, system, [{ role: 'user', content: `当前任务：\n${query}\n\n候选记忆：\n${candidates}` }], 1400);
    if (!output || /无相关记忆/.test(output)) return '';
    return output.slice(0, 5000);
  } catch (err) {
    console.warn('[AL Background] memory API fallback:', err?.message || err);
    return fallbackMemoryPack(rows);
  }
}

function cleanReply(text) {
  return String(text || '')
    .replace(/<al_schedule>[\s\S]*?<\/al_schedule>/gi, '')
    .replace(/<al_payment>[\s\S]*?<\/al_payment>/gi, '')
    .replace(/<al_send_payment>[\s\S]*?<\/al_send_payment>/gi, '')
    .replace(/^```(?:json)?|```$/gim, '')
    .replace(/^【发送时间[^】]*】\s*/gm, '')
    .trim();
}

function extractAssistantPaymentDirective(text) {
  const match = String(text || '').match(/<al_send_payment>([\s\S]*?)<\/al_send_payment>/i);
  if (!match) return null;
  try {
    const json = JSON.parse(match[1].trim());
    const type = String(json.type || '').trim().toLowerCase();
    const amount = Math.round(Number(json.amount) * 100) / 100;
    if (!['redpacket', 'transfer'].includes(type) || !Number.isFinite(amount) || amount <= 0) return null;
    return { type, amount, note: String(json.note || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
  } catch {
    return null;
  }
}

function appendIncomingPayment(chat, directive, sourceId, extra = {}) {
  if (!chat || !directive || !sourceId) return null;
  const id = `incoming_${directive.type}_${sourceId}`;
  const existing = (chat.messages || []).find(message => message.id === id);
  if (existing) return existing;
  const time = Date.now();
  const message = {
    id,
    role: 'assistant',
    type: directive.type,
    payType: directive.type,
    payDirection: 'incoming',
    amount: directive.amount,
    note: directive.note || '',
    payStatus: 'pending',
    payExpiresAt: time + 24 * 60 * 60 * 1000,
    time,
    ...extra
  };
  chat.messages.push(message);
  return message;
}

function splitReply(text) {
  return cleanReply(text).split(/\n+/).map(part => part.trim()).filter(part => part && !/^\(?对方没有回复\)?[。！!]?$/i.test(part)).slice(0, 6);
}

function notificationId(seed) {
  let hash = 0;
  for (const char of String(seed || 'al')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash || 1);
}

function notify(title, body, payload, moment) {
  try {
    CapacitorNotifications.schedule([{ id: notificationId(payload.jobId || `${payload.charId}:${Date.now()}`), title, body, group: moment ? 'al-moments' : 'al-chat', autoCancel: true, extra: { charId: payload.charId || '', kind: payload.kind || 'chat' } }]);
    return true;
  } catch (err) {
    console.warn('[AL Background] notification skipped:', err?.message || err);
    return false;
  }
}

function appIsActive() {
  try {
    const state = CapacitorApp?.getState?.();
    const parsed = typeof state === 'string' ? JSON.parse(state) : state;
    return !!parsed?.isActive;
  } catch {
    return false;
  }
}

function geometricDicePlan(now = Date.now()) {
  const random = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, Math.random()));
  const rolls = Math.max(1, Math.min(MAX_DICE_ROLLS, Math.floor(Math.log(1 - random) / Math.log(1 - DICE_CHANCE)) + 1));
  return { dueAt: new Date(now + rolls * DICE_INTERVAL_MS), rolls };
}

async function scheduleNext(state, charId, kind) {
  const settings = state.settings || {};
  const chat = state.allChats?.[charId];
  if (!chat || !settings.timerEndpoint || !settings.deviceId || !settings.cloudTimerEnabled) return;
  const plan = geometricDicePlan();
  const prefix = kind === 'moment' ? 'mom' : 'pro';
  const jobId = `${prefix}_${settings.deviceId}_${charId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job = { jobId, dueAt: plan.dueAt.toISOString(), kind, mode: 'dice', rollChance: DICE_CHANCE, diceIntervalMs: DICE_INTERVAL_MS, diceRolls: plan.rolls, dicePrecomputed: true };
  chat[kind === 'moment' ? 'pendingMomentJob' : 'pendingProactiveJob'] = job;
  const response = await fetch(`${String(settings.timerEndpoint).replace(/\/+$/, '')}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: settings.deviceId, charId, type: 'proactive', ...job })
  });
  if (!response.ok) throw new Error(`schedule ${response.status}`);
}

async function acknowledgeCloudJob(state, payload, outcome = 'generated') {
  const settings = state?.settings || {};
  if (!settings.timerEndpoint || !settings.deviceId || !payload?.jobId) return false;
  try {
    const response = await fetch(`${String(settings.timerEndpoint).replace(/\/+$/, '')}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: settings.deviceId, jobId: payload.jobId, charId: payload.charId || '', kind: payload.kind || 'chat', outcome })
    });
    return response.ok;
  } catch (err) {
    console.warn('[AL Background] cloud ack failed:', err?.message || err);
    return false;
  }
}

function appendMemoryEvent(state, charId, title, detail, type) {
  state.memory = state.memory || {};
  state.memory.events = Array.isArray(state.memory.events) ? state.memory.events : [];
  const at = new Date().toISOString();
  const keywords = type === 'moment' ? ['朋友圈', '主动动态'] : type === 'payment' ? ['支付', '红包', '转账'] : ['主动消息', '私聊'];
  state.memory.events.push({ id: `evt_bg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, charId, happenedAt: at, type, title, detail, status: 'stable', importance: type === 'payment' ? 4 : 3, keywords, createdAt: Date.now() });
}

function appendIncomingPaymentMemory(state, charId, char, player, directive) {
  if (!directive) return;
  const label = directive.type === 'redpacket' ? '红包' : '转账';
  appendMemoryEvent(state, charId, `${char.name}发出${label}`, `${char.name}给${player}发来${label}，金额 ${directive.amount}${directive.note ? `，备注“${directive.note}”` : ''}，当前等待领取。`, 'payment');
}

async function runChat(state, payload, char, chat, prepared) {
  const now = new Date();
  const query = `${char.name}准备在${formatLocalTime(now)}主动给${prepared.playerName}发微信私聊。距离最后一条消息已经过去一段时间。筛选与双方关系、未完成约定、近期情绪、重要事件和当前时段有关的记忆。`;
  const memoryPack = await retrieveMemory(state, payload.charId, query);
  const system = `${prepared.chatSystem}\n\n${memoryPack ? `【记忆 AI 本次筛选结果】\n${memoryPack}\n` : ''}\n${runtimeTimeContext(chat, now)}`;
  const messages = visibleMessages(chat, 30, now);
  messages.push({ role: 'user', content: `【内部主动触发，不是${prepared.playerName}发来的消息】现在由${char.name}主动发一段微信私聊。${payload.mode === 'dice' ? `${prepared.playerName}仍未回复此前的主动消息，不要自问自答，也不要机械催促。` : ''}只输出${char.name}真正发送的文字。` });
  const raw = await callModel(apiConfig(state.settings || {}, 'chat'), system, messages, Number(state.settings?.maxTokens) || 1000);
  const assistantPayment = extractAssistantPaymentDirective(raw);
  const chunks = splitReply(raw);
  if (!chunks.length && !assistantPayment) throw new Error('chat model returned empty reply');
  const base = Date.now();
  chunks.forEach((content, index) => chat.messages.push({ id: `msg_bg_${base}_${index}`, role: 'assistant', content, time: base + index * 700, proactive: true, proactiveMode: payload.mode === 'dice' ? 'dice' : 'planned' }));
  appendIncomingPayment(chat, assistantPayment, payload.jobId || `proactive_${base}`, { proactive: true, proactiveMode: payload.mode === 'dice' ? 'dice' : 'planned' });
  appendIncomingPaymentMemory(state, payload.charId, char, prepared.playerName, assistantPayment);
  chat.unread = (Number(chat.unread) || 0) + chunks.length;
  chat.lastProactiveAt = base;
  chat.lastProactiveChatAt = base;
  chat.lastProactiveType = 'chat';
  delete chat.pendingProactiveJob;
  appendMemoryEvent(state, payload.charId, '主动私聊', `${char.name}在${new Date(base).toISOString()}主动发来：“${chunks.join(' / ')}”`, 'fact');
  await scheduleNext(state, payload.charId, 'chat');
  const notificationBody = chunks[0] || (assistantPayment?.type === 'redpacket' ? '发来一个红包' : '发来一笔转账');
  notify(char.name || 'AL', notificationBody + (chunks.length > 1 ? ' ...' : ''), payload, false);
}

function parseMomentText(raw) {
  const cleaned = cleanReply(raw);
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const json = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
    return String(json.text || json.timeline || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch {
    return cleaned.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
}

async function runMoment(state, payload, char, chat, prepared) {
  const now = new Date();
  const query = `${char.name}准备在${formatLocalTime(now)}主动发朋友圈。筛选与近期生活、双方关系、重要互动和当前时段相关，但适合公开发布的记忆。`;
  const memoryPack = await retrieveMemory(state, payload.charId, query);
  const system = `${prepared.momentSystem}\n\n${memoryPack ? `【记忆 AI 本次筛选结果】\n${memoryPack}\n` : ''}\n${runtimeTimeContext(chat, now)}\n朋友圈不是给${prepared.playerName}的私聊续答，应像${char.name}自己随手发布的动态。只输出 {"text":"正文"}。`;
  const raw = await callModel(apiConfig(state.settings || {}, 'chat'), system, prepared.momentMessages || [], Number(state.settings?.maxTokens) || 1000);
  const text = parseMomentText(raw);
  if (!text) throw new Error('moment model returned empty reply');
  const at = Date.now();
  state.allMoments = Array.isArray(state.allMoments) ? state.allMoments : [];
  state.allMoments.unshift({ id: `mom_bg_${at}_${Math.random().toString(36).slice(2, 7)}`, authorType: 'char', charId: payload.charId, text, time: at, likes: [], comments: [], proactive: true });
  chat.messages.push({ id: `evt_bg_${at}`, role: 'user', hidden: true, time: at, content: `【朋友圈事件】${char.name}在朋友圈发布动态：“${text}”` });
  chat.lastProactiveAt = at;
  chat.lastProactiveMomentAt = at;
  chat.lastProactiveType = 'moment';
  delete chat.pendingMomentJob;
  appendMemoryEvent(state, payload.charId, '主动朋友圈', `${char.name}在${new Date(at).toISOString()}发布朋友圈：“${text}”`, 'moment');
  await scheduleNext(state, payload.charId, 'moment');
  notify(char.name || 'AL', `发了一条朋友圈：${text}`, payload, true);
}

function userReplyTaskRows() {
  const rows = readJson(PENDING_USER_REPLY_QUEUE_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

function writeUserReplyTaskRows(rows) {
  CapacitorKV.set(PENDING_USER_REPLY_QUEUE_KEY, JSON.stringify(Array.isArray(rows) ? rows.slice(-30) : []));
}

function userMessageForTask(chat, task) {
  return (chat?.messages || []).find(message => message.id === task.userMessageId && message.role === 'user');
}

function taskAlreadyAnswered(chat, task) {
  return (chat?.messages || []).some(message => message.role === 'assistant' && message.replyToMessageId === task.userMessageId);
}

async function runUserReply(state, task) {
  const char = (state.characters || []).find(item => item.id === task.charId);
  const chat = state.allChats?.[task.charId];
  const prepared = state.prepared?.[task.charId];
  const userMessage = userMessageForTask(chat, task);
  if (!char || !chat || !prepared?.userReplySystem || !userMessage) throw new Error('user reply snapshot missing');
  if (userMessage.deleted || userMessage.retracted) {
    task.status = 'done';
    task.completedAt = Date.now();
    delete chat.pendingReply;
    return [];
  }
  if (taskAlreadyAnswered(chat, task)) {
    task.status = 'done';
    task.completedAt = Date.now();
    delete chat.pendingReply;
    delete userMessage.replyState;
    delete userMessage.replyError;
    return [];
  }

  const now = new Date();
  const taskUserText = String(task.userText || userMessage.content || '').trim();
  const query = `${prepared.playerName}刚在${formatLocalTime(now)}对${char.name}说：“${taskUserText.slice(0, 500)}”。筛选本轮真正相关的人物资料、承诺、关系变化、近期情绪和未完成事件。`;
  const memoryPack = await retrieveMemory(state, task.charId, query);
  const hiddenTaskContext = taskUserText && taskUserText !== String(userMessage.content || '').trim()
    ? `\n\n【本条消息的隐藏输入说明】\n${taskUserText}`
    : '';
  const system = `${prepared.userReplySystem}${memoryPack ? `\n\n【记忆 AI 本次筛选结果】\n${memoryPack}` : ''}${hiddenTaskContext}\n\n当前设备时间：${formatLocalTime(now)}。只输出${char.name}真正发出的微信消息。`;
  const messages = visibleMessages(chat, 30, now);
  const raw = await callModel(apiConfig(state.settings || {}, 'chat'), system, messages, Number(state.settings?.maxTokens) || 1000);
  const assistantPayment = extractAssistantPaymentDirective(raw);
  const chunks = splitReply(raw);
  if (!chunks.length && !assistantPayment) throw new Error('chat model returned empty reply');
  const base = Date.now();
  chunks.forEach((content, index) => chat.messages.push({
    id: `msg_reply_${task.userMessageId}_${index}`,
    role: 'assistant',
    content,
    time: base + index * 700,
    replyToMessageId: task.userMessageId
  }));
  appendIncomingPayment(chat, assistantPayment, task.userMessageId, { replyToMessageId: task.userMessageId });
  appendIncomingPaymentMemory(state, task.charId, char, prepared.playerName, assistantPayment);
  delete chat.pendingReply;
  delete userMessage.replyState;
  delete userMessage.replyError;
  task.status = 'done';
  task.completedAt = base;
  task.error = '';
  const notificationBody = chunks[0] || (assistantPayment?.type === 'redpacket' ? '发来一个红包' : '发来一笔转账');
  if (!appIsActive()) notify(char.name || 'AL', notificationBody + (chunks.length > 1 ? ' ...' : ''), { ...task, jobId: task.taskId, kind: 'reply' }, false);
  return chunks;
}

async function runPendingUserReplies() {
  const state = readJson(RUNNER_STATE_KEY, null);
  if (!state?.settings || !state?.allChats) throw new Error('local background snapshot missing');
  const tasks = userReplyTaskRows();
  const task = tasks.find(item => item?.status === 'pending' || item?.status === 'running');
  if (!task) return [];
  const chat = state.allChats?.[task.charId];
  const userMessage = userMessageForTask(chat, task);
  task.status = 'running';
  task.startedAt = Date.now();
  writeUserReplyTaskRows(tasks);
  writeState(state);
  try {
    const chunks = await runUserReply(state, task);
    writeUserReplyTaskRows(tasks);
    writeState(state);
    return chunks;
  } catch (err) {
    task.status = 'failed';
    task.error = String(err?.message || err).slice(0, 300);
    task.failedAt = Date.now();
    if (chat?.pendingReply) {
      chat.pendingReply.state = 'failed';
      chat.pendingReply.error = task.error;
      chat.pendingReply.updatedAt = Date.now();
    }
    if (userMessage) {
      userMessage.replyState = 'failed';
      userMessage.replyError = task.error;
    }
    notify('AL', '回复生成失败，点此重试', { ...task, jobId: task.taskId, kind: 'reply' }, false);
    writeUserReplyTaskRows(tasks);
    writeState(state);
    throw err;
  }
}

async function runRemoteNotification(payload) {
  const state = readJson(RUNNER_STATE_KEY, null);
  if (!state?.settings || !state?.allChats) throw new Error('local background snapshot missing');
  const char = (state.characters || []).find(item => item.id === payload.charId);
  const chat = state.allChats[payload.charId];
  const prepared = state.prepared?.[payload.charId];
  if (!char || !chat?.messages?.length || !prepared) throw new Error('character background snapshot missing');
  const jobKey = payload.kind === 'moment' ? 'pendingMomentJob' : 'pendingProactiveJob';
  const localJob = chat[jobKey];
  if (!asBool(payload.test) && payload.jobId && localJob?.jobId && payload.jobId !== localJob.jobId) {
    await acknowledgeCloudJob(state, payload, 'stale');
    return;
  }
  state.settings.cloudTimerLastStatus = `FCM 后台已收到${payload.kind === 'moment' ? '朋友圈' : '私聊'}任务，正在生成。`;
  state.settings.cloudTimerLastStatusAt = Date.now();
  try {
    if (payload.kind === 'moment') await runMoment(state, payload, char, chat, prepared);
    else await runChat(state, payload, char, chat, prepared);
    state.settings.cloudTimerLastStatus = `FCM 后台${payload.kind === 'moment' ? '朋友圈' : '私聊'}已生成。`;
    state.settings.cloudTimerLastStatusAt = Date.now();
  } catch (err) {
    state.settings.cloudTimerLastStatus = `FCM 后台生成失败：${String(err?.message || err).slice(0, 180)}`;
    state.settings.cloudTimerLastStatusAt = Date.now();
    notify('AL', '主动消息生成失败，已安排稍后重试。', payload, false);
    throw err;
  } finally {
    writeState(state);
  }
  await acknowledgeCloudJob(state, payload, 'generated');
}

async function drainPendingPushQueue() {
  const initialCount = Math.min(MAX_PUSHES_PER_WAKE, pendingPushQueue().length);
  const completed = [];
  for (let index = 0; index < initialCount; index++) {
    const payload = dequeuePendingPush();
    if (!payload) break;
    try {
      await runRemoteNotification(payload);
      completed.push(String(payload.jobId || ''));
    } catch (err) {
      requeuePendingPush(payload);
      throw err;
    }
  }
  return completed;
}

addEventListener('syncState', (resolve, reject, args) => {
  try {
    const incomingRaw = args?.state || args?.dataArgs?.state;
    const incoming = typeof incomingRaw === 'string' ? JSON.parse(incomingRaw) : incomingRaw;
    if (!incoming) throw new Error('state missing');
    const current = readJson(RUNNER_STATE_KEY, null);
    if (!current?.updatedAt || Number(incoming.updatedAt) >= Number(current.updatedAt)) CapacitorKV.set(RUNNER_STATE_KEY, JSON.stringify(incoming));
    resolve({ ok: true });
  } catch (err) { reject(err); }
});

addEventListener('readState', (resolve, reject) => {
  try { resolve({ state: kvGet(RUNNER_STATE_KEY) || '' }); }
  catch (err) { reject(err); }
});

addEventListener('remoteNotification', (resolve, reject) => {
  if (!pendingPushQueue().length) {
    resolve({ ok: true, skipped: true });
    return;
  }
  drainPendingPushQueue()
    .then(jobIds => resolve({ ok: true, jobIds }))
    .catch(err => { console.error('[AL Background]', err); reject(err); });
});

addEventListener('pendingUserReply', (resolve, reject) => {
  runPendingUserReplies()
    .then(chunks => resolve({ ok: true, count: chunks.length }))
    .catch(err => { console.error('[AL Background Reply]', err); reject(err); });
});

addEventListener('queueUserReply', (resolve, reject, args) => {
  try {
    const raw = args?.task || args?.dataArgs?.task;
    const task = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!task?.taskId || !task?.charId || !task?.userMessageId) throw new Error('reply task missing');
    const rows = userReplyTaskRows();
    const index = rows.findIndex(item => item?.taskId === task.taskId);
    const next = { ...task, status: 'pending', error: '', queuedAt: Date.now() };
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    writeUserReplyTaskRows(rows);
    resolve({ ok: true, taskId: next.taskId });
  } catch (err) {
    reject(err);
  }
});

addEventListener('backgroundTick', (resolve) => resolve({ ok: true }));
