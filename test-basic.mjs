import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = readFileSync('tavern-app/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(script, 'index.html should contain an inline app script');
const swScript = readFileSync('tavern-app/sw-v11.js', 'utf8');
assert.match(swScript, /function cleanApiKey\(value\)/);
assert.match(swScript, /后台记忆AI已调用/);
assert.match(swScript, /function localEmbedding\(text, dim = VECTOR_DIM\)/);
assert.match(swScript, /async function searchMemoryVectors\(charId, queryText/);
assert.match(swScript, /本轮向量召回记忆/);

const storage = new Map();
const elements = new Map();
const fetchCalls = [];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function element(id = '') {
  if (!elements.has(id)) {
    let text = '';
    elements.set(id, {
      id,
      value: '',
      style: {},
      className: '',
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      remove() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      set textContent(value) { text = value; },
      get textContent() { return text; },
      get innerHTML() { return escapeHtml(text); },
      set innerHTML(value) { text = value; },
    });
  }
  return elements.get(id);
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  TextDecoder,
  Uint8Array,
  Date,
  Math,
  JSON,
  URL,
  AbortController,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  fetch: async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-alpha' }, { id: 'gpt-beta' }] }),
    };
  },
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  },
  navigator: {},
  document: {
    body: element('body'),
    createElement: () => element(`created-${elements.size}`),
    getElementById: id => element(id),
    querySelector: () => null,
    querySelectorAll: () => [],
  },
};

vm.createContext(context);
vm.runInContext(`${script}
globalThis.__appTest = {
  parseCharacterCard,
  buildCharPrompt,
  formatMsg,
  normalizeChar,
  normalizePresetKey,
  fetchModels,
  selectFetchedModel,
  recentMessages,
  localEmbedding,
  cosine,
  cleanApiKey,
  getTimeContext,
  getDayPeriod,
  formatElapsed,
  buildProactiveTimeContext,
  proactiveRecentMessages,
  splitAssistantOutput,
  createPromptComposer,
  chatSceneFromOptions,
  buildChatSceneSystem,
  buildMomentInteractionPayload,
  buildMomentPostPayload,
  buildMomentReplyPayload,
  buildMemoryQueryPayload,
  buildMemoryExtractPayload,
  generateMemoryQuery,
  memoryAliasText,
  memorySignalTerms,
  scoreKeywordMemoryText,
  searchKeywordMemoryRows,
  recordModelCall,
  getModelCallLogs,
  getAllModelCallLogs,
  formatModelCallStatus,
  formatModelCallDiagnostic,
  clearModelCallLogs,
  shouldKeepEvent,
  RP_PRESETS,
};`, context);

const { parseCharacterCard, buildCharPrompt, formatMsg, normalizeChar, normalizePresetKey, fetchModels, selectFetchedModel, recentMessages, localEmbedding, cosine, cleanApiKey, getTimeContext, getDayPeriod, formatElapsed, buildProactiveTimeContext, proactiveRecentMessages, splitAssistantOutput, createPromptComposer, chatSceneFromOptions, buildChatSceneSystem, buildMomentInteractionPayload, buildMomentPostPayload, buildMomentReplyPayload, buildMemoryQueryPayload, buildMemoryExtractPayload, generateMemoryQuery, memoryAliasText, memorySignalTerms, scoreKeywordMemoryText, searchKeywordMemoryRows, recordModelCall, getModelCallLogs, getAllModelCallLogs, formatModelCallStatus, formatModelCallDiagnostic, clearModelCallLogs, shouldKeepEvent, RP_PRESETS } = context.__appTest;

const v2 = parseCharacterCard({
  spec: 'chara_card_v2',
  data: {
    name: '林晚',
    description: '雨夜酒馆的老板',
    personality: '温柔但敏锐',
    scenario: '窗外落雨',
    first_mes: '欢迎回来。',
    tags: ['测试', 'V2'],
  },
});
assert.equal(v2.name, '林晚');
assert.equal(v2.firstMessage, '欢迎回来。');
assert.deepEqual(v2.tags, ['测试', 'V2']);

const v1 = parseCharacterCard({
  name: '旧卡角色',
  description: 'V1 描述',
  personality: '冷静',
  greeting: '你好。',
});
assert.equal(v1.name, '旧卡角色');
assert.equal(v1.firstMessage, '你好。');

assert.throws(() => parseCharacterCard({ nope: true }), /Unrecognized format/);

const prompt = buildCharPrompt(v2);
assert.match(prompt, /手机私聊式角色扮演/);
assert.match(prompt, /只输出聊天消息本身/);
assert.match(prompt, /禁止任何非语言描写/);
assert.match(prompt, /禁止使用 \*动作\*/);
assert.match(prompt, /不替用户说话/);
assert.match(prompt, /当前你要扮演的角色：林晚/);
assert.match(prompt, /角色设定：雨夜酒馆的老板/);
assert.match(prompt, /场景：窗外落雨/);
assert.ok(RP_PRESETS.combined.prompt.includes('不写动作、神态、表情、环境'));
assert.ok(RP_PRESETS.combined.prompt.includes('拆成独立聊天气泡'));
assert.equal(normalizePresetKey('story'), 'combined');
assert.equal(normalizePresetKey('custom'), 'custom');

assert.equal(formatMsg('<b>*动作*</b>\n台词'), '&lt;b&gt;*动作*&lt;/b&gt;<br>台词');
assert.equal(JSON.stringify(splitAssistantOutput('第一句\n\n第二句\r\n第三句')), JSON.stringify(['第一句', '第二句', '第三句']));
assert.equal(memoryAliasText('用户和角色约好下次继续聊', { name: '林晚' }), '玩家和林晚约好下次继续聊');
assert.equal(shouldKeepEvent({ type: 'fact', title: '时间校对分歧', detail: '用户说自己这里是48分，角色解释表快了几分钟。', importance: 3, keywords: ['时间校对'] }), false);
assert.equal(shouldKeepEvent({ type: 'promise', title: '红包约定', detail: '玩家答应林晚回复“哟哟”后给180元红包。', importance: 4, keywords: ['红包', '约定'] }), true);
const promptComposer = createPromptComposer('chat');
promptComposer.add('late', '后写', { priority: 20 });
promptComposer.add('early', '先写', { priority: 10 });
promptComposer.add('other-scene', '不应出现', { priority: 1, scenes: ['proactive-chat'] });
assert.equal(promptComposer.compile(), '先写\n\n后写');
assert.equal(chatSceneFromOptions({}), 'chat');
assert.equal(chatSceneFromOptions({ proactive: true }), 'proactive-chat');
assert.equal(chatSceneFromOptions({ payment: { kind: 'redpacket' } }), 'payment');
const chatSystem = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。' });
assert.match(chatSystem, /微信私聊/);
assert.match(chatSystem, /记忆：林晚和玩家约好周末见。/);
assert.match(chatSystem, /当前触发情况：玩家刚在私聊里发来消息/);
const playerMoment = { text: '今天有点想喝热茶。', likes: [], comments: [], time: Date.now(), authorType: 'player' };
const interactionPayload = buildMomentInteractionPayload(v2, playerMoment, '记忆：林晚刚收过玩家的红包。');
assert.match(interactionPayload.system, /朋友圈动态互动/);
assert.match(interactionPayload.system, /只允许输出 JSON，不要输出解释：\{"like":true\/false,"comment":"留言正文或空字符串"\}/);
assert.match(interactionPayload.system, /记忆：林晚刚收过玩家的红包。/);
assert.match(interactionPayload.messages[0].content, /朋友圈正文：今天有点想喝热茶。/);
const postPayload = buildMomentPostPayload(v2, { messages: [] }, '记忆：林晚和玩家约好周末见。');
assert.match(postPayload.system, /朋友圈发布动态/);
assert.match(postPayload.system, /只允许输出 JSON，不要输出解释：\{"text":"朋友圈正文"\}/);
assert.match(postPayload.messages[0].content, /最近私聊/);
const ownMoment = { text: '雨停了。', comments: [{ name: '玩家', text: '终于能出门了' }], time: Date.now(), authorType: 'character' };
const replyPayload = buildMomentReplyPayload(v2, ownMoment, '终于能出门了', '记忆：玩家怕冷。');
assert.match(replyPayload.system, /朋友圈评论回复/);
assert.match(replyPayload.system, /只允许输出 JSON，不要输出解释：\{"comment":"回复评论正文或空字符串"\}/);
assert.match(replyPayload.system, /记忆：玩家怕冷。/);
assert.match(replyPayload.messages[0].content, /玩家刚评论：终于能出门了/);
const memoryQueryPayload = buildMemoryQueryPayload(v2, '你还记得红包吗？', [{ role: 'user', content: '我给你发过红包', time: Date.now() }]);
assert.match(memoryQueryPayload.system, /本地记忆检索 AI/);
assert.match(memoryQueryPayload.system, /生成向量数据库召回用的检索查询/);
assert.match(memoryQueryPayload.system, /只输出 JSON，不要输出解释/);
assert.match(memoryQueryPayload.user, /当前输入或触发原因：\n你还记得红包吗？/);
const memoryExtractPayload = buildMemoryExtractPayload(v2, [{ role: 'user', content: '我以后不收你大额红包', time: Date.now() }], '旧摘要');
assert.match(memoryExtractPayload.system, /本地记忆整理 AI/);
assert.match(memoryExtractPayload.system, /禁止用“用户”“角色”代称/);
assert.match(memoryExtractPayload.system, /红包仍待领取/);
assert.match(memoryExtractPayload.user, /旧增量摘要：\n旧摘要/);
assert.ok(memorySignalTerms('你还记得红包和周末约定吗？').includes('红包'));
assert.ok(scoreKeywordMemoryText('玩家承诺给林晚发红包。', ['红包'], 4) > 1);
const keywordRows = searchKeywordMemoryRows({
  events: [{ id: 'evt1', type: 'promise', title: '红包约定', detail: '玩家答应林晚回复暗号后发180元红包。', importance: 4, keywords: ['红包', '约定'] }],
  profiles: [],
  summaries: [],
}, '你还记得红包吗？', ['红包'], v2);
assert.equal(keywordRows[0].sourceId, 'evt1');
recordModelCall({
  kind: 'chat',
  scene: 'proactive-chat',
  provider: 'openai',
  model: 'gpt-test',
  charId: 'char-1',
  system: '系统提示：不要保存 sk-secret123456',
  messages: [{ role: 'user', content: '你好' }],
  memoryChars: 12,
  promptBlocks: [{ id: 'memory-pack', priority: 30, chars: 42, preview: '红包约定' }],
  output: '在。'
});
const callLogs = getModelCallLogs();
assert.equal(callLogs[0].scene, 'proactive-chat');
assert.equal(callLogs[0].model, 'gpt-test');
assert.equal(callLogs[0].messageCount, 1);
assert.equal(callLogs[0].memoryChars, 12);
assert.equal(callLogs[0].promptBlocks[0].id, 'memory-pack');
assert.match(callLogs[0].systemPreview, /系统提示/);
assert.doesNotMatch(callLogs[0].systemPreview, /sk-secret123456/);
assert.match(callLogs[0].systemPreview, /sk-\*\*\*/);
assert.equal(typeof context.ALDebug.getModelCallLogs, 'function');
assert.equal(typeof context.ALDebug.getAllModelCallLogs, 'function');
assert.equal(typeof context.ALDebug.formatModelCallDiagnostic, 'function');
assert.equal((await getAllModelCallLogs())[0].scene, 'proactive-chat');
assert.match(formatModelCallStatus({ time: '2026-07-08 12:00', scene: 'memory-query', model: 'mem-test', empty: true, diagnostic: '空内容' }), /最近调用：2026-07-08 12:00｜memory-query｜mem-test｜空回复｜空内容/);
const diagnosticText = formatModelCallDiagnostic(callLogs[0]);
assert.match(diagnosticText, /scene=proactive-chat/);
assert.match(diagnosticText, /promptBlocks=memory-pack@30:42/);
assert.match(diagnosticText, /promptBlockDetails=[\s\S]*红包约定/);
assert.doesNotMatch(diagnosticText, /sk-secret123456/);
clearModelCallLogs();
assert.equal(getModelCallLogs().length, 0);
vm.runInContext("settings.memoryApiUrl='https://memory.example/v1'; settings.memoryApiKey='sk-memory'; settings.memoryModel=''; settings.memoryApiType='openai';", context);
const skippedMemoryQuery = await generateMemoryQuery(v2, '你还记得红包吗？', []);
assert.equal(skippedMemoryQuery._memoryAiStatus, 'skipped');
assert.match(getModelCallLogs()[0].diagnostic, /缺少模型/);
clearModelCallLogs();
assert.equal(cleanApiKey(' sk-test\u200b\n　'), 'sk-test');
assert.match(getTimeContext(new Date('2026-07-04T09:05:03Z')), /当前设备时间/);
assert.equal(getDayPeriod(new Date('2026-07-04T14:15:00')).label, '下午');
const afternoonContext = getTimeContext(new Date('2026-07-04T14:15:00'));
assert.match(afternoonContext, /当前时段：下午/);
assert.match(afternoonContext, /禁止使用与当前时段矛盾的说法：.*半夜三更/);
assert.match(afternoonContext, /不需要刻意报出具体时间/);
assert.equal(formatElapsed(5 * 60000), '5 分钟');
assert.equal(formatElapsed(2 * 60 * 60000), '2 小时');
assert.equal(recentMessages({ messages: Array.from({ length: 35 }, (_, i) => ({ content: String(i) })) }, 30)[0].content, '5');
const proactiveNow = new Date('2026-07-04T12:00:00');
const proactiveChat = {
  messages: [
    { role: 'user', content: '你知道现在几点了吗？', time: new Date('2026-07-04T10:00:00').getTime() },
    { role: 'assistant', content: '我看一下。', time: new Date('2026-07-04T10:00:10').getTime() },
  ],
};
assert.match(buildProactiveTimeContext({ messages: [{ role: 'user', content: '刚说完', time: new Date('2026-07-04T11:55:00').getTime() }] }, proactiveNow), /短间隔可轻续聊/);
assert.match(buildProactiveTimeContext({ messages: [{ role: 'user', content: '半小时前', time: new Date('2026-07-04T11:30:00').getTime() }] }, proactiveNow), /中等间隔自然续聊/);
const longGapContext = buildProactiveTimeContext(proactiveChat, proactiveNow);
assert.match(longGapContext, /长间隔重新开口/);
assert.match(longGapContext, /默认不要直接回答上一条话题/);
assert.match(proactiveRecentMessages(proactiveChat, 30, proactiveNow)[0].content, /距现在 2 小时/);
const promiseVector = localEmbedding('周六晚上语音 承诺 不会消失');
const similarVector = localEmbedding('你是不是忘了周六语音的约定');
const differentVector = localEmbedding('今天午饭吃什么');
assert.equal(promiseVector.length, 384);
assert.ok(cosine(promiseVector, similarVector) > cosine(promiseVector, differentVector));

const normalized = normalizeChar({ name: '沈确' }, 1);
assert.ok(normalized.id);
assert.equal(normalized.avatar, '沈');

element('set-chat-api-type').value = 'openai';
element('set-chat-api-url').value = 'https://chat.example/v1';
element('set-chat-api-key').value = 'sk-chat';
element('set-memory-api-type').value = 'openai';
element('set-memory-api-url').value = 'https://memory.example/v1';
element('set-memory-api-key').value = 'sk-memory';
element('set-chat-model').value = '';
element('set-memory-model').value = '';
element('set-temp').value = '0.8';
element('set-max-tokens').value = '1000';
element('set-memory-interval').value = '30';
element('set-proactive-enabled').value = 'on';
element('set-proactive-minutes').value = '5';
element('set-cloud-timer-enabled').value = 'on';
element('set-timer-endpoint').value = 'https://timer.example';
element('set-push-public-key').value = 'BTestPublicKey';
element('set-system-prompt').value = '';
await fetchModels('chat');
assert.equal(fetchCalls.at(-1).url, 'https://chat.example/v1/models');
assert.match(element('set-chat-model-list').innerHTML, /gpt-alpha/);
assert.equal(element('set-chat-model').value, 'gpt-alpha');
selectFetchedModel('gpt-beta');
assert.equal(element('set-chat-model').value, 'gpt-beta');
await fetchModels('memory');
assert.equal(fetchCalls.at(-1).url, 'https://memory.example/v1/models');
assert.match(element('set-memory-model-list').innerHTML, /gpt-alpha/);
assert.equal(element('set-memory-model').value, 'gpt-alpha');
selectFetchedModel('gpt-beta', 'memory');
assert.equal(element('set-memory-model').value, 'gpt-beta');
assert.equal(JSON.parse(storage.get('rpchat_settings')).proactiveEnabled, true);
assert.equal(JSON.parse(storage.get('rpchat_settings')).proactiveIdleMinutes, 5);
assert.equal(JSON.parse(storage.get('rpchat_settings')).cloudTimerEnabled, true);
assert.equal(JSON.parse(storage.get('rpchat_settings')).timerEndpoint, 'https://timer.example');
assert.equal(JSON.parse(storage.get('rpchat_settings')).chatApiUrl, 'https://chat.example/v1');
assert.equal(JSON.parse(storage.get('rpchat_settings')).memoryApiUrl, 'https://memory.example/v1');
assert.equal(JSON.parse(storage.get('rpchat_settings')).chatApiKey, 'sk-chat');
assert.equal(JSON.parse(storage.get('rpchat_settings')).memoryApiKey, 'sk-memory');

console.log('basic app checks passed');
