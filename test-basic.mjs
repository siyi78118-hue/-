import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = readFileSync('tavern-app/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(script, 'index.html should contain an inline app script');
const swScript = readFileSync('tavern-app/sw-v11.js', 'utf8');
const cloudTimerWorker = readFileSync('cloud-timer-worker.js', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const cloudTimerDeployDoc = readFileSync('CLOUD_TIMER_DEPLOY.md', 'utf8');
const cloudTimerHealthScript = readFileSync('scripts/check-cloud-timer.mjs', 'utf8');
const cloudTimerDeployScript = readFileSync('scripts/deploy-cloud-timer.mjs', 'utf8');
const wranglerRunScript = readFileSync('scripts/run-wrangler.mjs', 'utf8');
assert.match(swScript, /const CACHE_NAME = 'rpchat-v69';/);
assert.match(script, /const MEMORY_DB_VERSION = 2;/);
assert.match(swScript, /const MEMORY_DB_VERSION = 2;/);
assert.match(script, /const APP_BUILD_VERSION = '2026-07-10\.55';/);
assert.match(script, /const CHAT_HISTORY_CHAR_BUDGET = 12000;/);
assert.match(script, /const PROACTIVE_HISTORY_CHAR_BUDGET = 9000;/);
assert.match(swScript, /const CHAT_HISTORY_CHAR_BUDGET = 12000;/);
assert.match(swScript, /const PROACTIVE_HISTORY_CHAR_BUDGET = 9000;/);
assert.match(script, /function messageContextCost\(message\)/);
assert.match(swScript, /function messageContextCost\(message\)/);
assert.match(script, /recentMessages\(chat, count, PROACTIVE_HISTORY_CHAR_BUDGET\)/);
assert.match(swScript, /recentMessages\(chat, count, PROACTIVE_HISTORY_CHAR_BUDGET\)/);
assert.match(html, /\.primary\{width:calc\(100% - 28px\);/);
assert.doesNotMatch(html, />发起聊天<\/button>/);
assert.doesNotMatch(html, /class="wallet-tools"/);
assert.doesNotMatch(html, /onclick="saveSettings\(\)">保存<\/button>/);
assert.equal((html.match(/>新增记忆<\/div>/g) || []).length, 1);
assert.match(html, /showScreen\(contactProfileReturnScreen \|\| 'contacts'\)/);
assert.match(html, /showScreen\(selfProfileReturnScreen \|\| 'me'\)/);
assert.match(html, /openSelfProfile\('chat-info'\)/);
assert.match(script, /function openSelfProfile\(returnScreen = activeScreen\)/);
assert.match(script, /contactProfileReturnScreen = activeScreen && activeScreen !== 'contact-profile'/);
assert.match(script, /const MEMORY_MAX_TOKENS = 4096;/);
assert.match(swScript, /const MEMORY_MAX_TOKENS = 4096;/);
assert.doesNotMatch(script, /\/embeddings/);
assert.match(script, /async function createEmbedding\(text\) \{[\s\S]*return localEmbedding\(text\);/);
assert.match(script, /async function compactCharacterMemory\(charId\)/);
assert.match(script, /const memoryExtractionStates = new Map\(\);/);
assert.match(script, /async function processMemoryBatch\(charId, force = false\)/);
assert.match(script, /const batchEnd = chat\.messages\.length;/);
assert.match(script, /MemoryDB\.setMeta\(memoryMetaKey\(charId\), batchEnd\)/);
assert.doesNotMatch(script, /MemoryDB\.setMeta\(memoryMetaKey\(charId\), chat\.messages\.length\)/);
assert.match(script, /游标未前移，下次会重试同一批/);
assert.match(script, /invalidateMemoryExtraction\(currentCharId\)/);
assert.match(script, /item\.manual = true;/);
assert.match(script, /await upsertMemoryItem\('profiles', item, profileRows\)/);
assert.match(script, /await upsertMemoryItem\('events', item, eventRows\)/);
assert.match(script, /this\.remove\('meta', memoryExtractStatusKey\(charId\)\)/);
assert.match(swScript, /return !!\(settings\.memoryApiUrl && settings\.memoryApiKey && settings\.memoryModel\);/);
assert.doesNotMatch(swScript, /settings\.memoryApiUrl \|\| settings\.apiUrl/);
assert.doesNotMatch(swScript, /settings\.memoryApiKey \|\| settings\.apiKey/);
assert.match(swScript, /function mergeStreamText\(current = '', incoming = ''\)/);
assert.match(swScript, /result = mergeStreamText\(result, delta\)/);
assert.match(script, /const EXPECTED_CLOUD_TIMER_VERSION = '2026-07-10\.9';/);
assert.match(script, /const PROACTIVE_DICE_INTERVAL_MS = 10 \* 60 \* 1000;/);
assert.match(script, /const PROACTIVE_DICE_CHANCE = 0\.05;/);
assert.match(script, /const PROACTIVE_DICE_MAX_ROLLS = 432;/);
assert.match(script, /function proactiveDicePlan\(options = \{\}, now = Date\.now\(\), randomValue = Math\.random\(\)\)/);
assert.match(swScript, /function proactiveDicePlan\(options = \{\}, now = Date\.now\(\), randomValue = Math\.random\(\)\)/);
assert.match(script, /if \(job\?\.dicePrecomputed\) return true;/);
assert.match(swScript, /if \(job\?\.dicePrecomputed\) return true;/);
assert.match(script, /dicePrecomputed: !!job\.dicePrecomputed/);
assert.match(swScript, /dicePrecomputed: !!chat\[jobKey\]\.dicePrecomputed/);
assert.match(script, /sw-v11\.js\?alarm-stream=1&v=\$\{APP_BUILD_VERSION\}/);
assert.match(script, /\.then\(reg => reg\.update\?\.\(\)\)/);
assert.match(script, /const API_TIMEOUT_MS = 120000;/);
assert.match(script, /const PROACTIVE_MEMORY_TIMEOUT_MS = API_TIMEOUT_MS;/);
assert.doesNotMatch(swScript, /Math\.min\(API_TIMEOUT_MS,\s*45000\)/);
assert.doesNotMatch(script, /rows\.find\(\(\{ chat \}\) => !hasFutureCloudJob\(chat, kind\)\)/);
assert.match(script, /function cancelOtherCloudJobs\(targetCharId, kind = 'chat'/);
assert.match(script, /function ensureOpenedChatProactive\(charId\)/);
assert.match(script, /ensureOpenedChatProactive\(charId\)/);
assert.match(script, /open-chat \$\{kind\} due skipped/);
assert.match(script, /function parseProactiveScheduleTime\(value, now = new Date\(\)\)/);
assert.match(script, /function extractProactiveScheduleDirective\(text, now = new Date\(\)\)/);
assert.match(script, /function stripProactiveScheduleDirective\(text\)/);
assert.match(script, /function stripLeakedPromptMetadata\(text\)/);
assert.match(script, /历史消息元数据/);
assert.match(script, /跨天\/超长间隔重新开口/);
assert.match(script, /免打扰模式\|骰子\|摇骰\|调度\|定时器/);
assert.match(swScript, /function stripLeakedPromptMetadata\(text\)/);
assert.match(swScript, /跨天\/超长间隔重新开口/);
assert.match(script, /<al_schedule>\{"nextProactiveAt":"YYYY-MM-DDTHH:mm:ss\+08:00"\}<\/al_schedule>/);
assert.match(script, /async function schedulePlannedChatFromReply\(charId, directive = null\)/);
assert.match(script, /async function scheduleDiceProactive\(charId, kind = 'chat'\)/);
assert.match(script, /async function enterProactiveDiceMode\(charId, kind = 'chat'\)/);
assert.match(script, /return scheduleDiceProactive\(charId, kind\);/);
assert.match(script, /async function ensureDiceProactiveScheduled\(charId, kind = 'chat'\)/);
assert.match(script, /if \(existingJob\?\.jobId \|\| existingJob\?\.dueAt\) return false;/);
assert.match(script, /if \(!manual\) try \{ await enterProactiveDiceMode\(charId, 'chat'\);/);
assert.match(script, /if \(!manual\) try \{ await enterProactiveDiceMode\(charId, 'moment'\);/);
assert.match(script, /proactiveDefaultScheduleOptions\(kind, chat\)/);
assert.match(script, /chatHasUnansweredProactive\(chat\)/);
assert.match(script, /triggerProactiveMessage\(target\.char\.id, false, proactiveJobMode\(job\)\)/);
assert.match(script, /triggerProactiveMessage\(data\.charId, false, proactiveJobMode\(localJob \|\| data\)\)/);
assert.match(script, /function proactiveModeLabel\(job\)/);
assert.match(script, /私聊下次（\$\{proactiveModeLabel\(chatJob\)\}）/);
assert.doesNotMatch(script, /cancelCloudProactive\(requestCharId, 'all'\)/);
assert.doesNotMatch(script, /cancelCloudProactive\(currentCharId, 'all'\)/);
assert.match(swScript, /function visibleConversationMessages\(chat\)/);
assert.match(swScript, /const triggerMode = proactiveJobMode\(dueJob\?\.job \|\| payload\);/);
assert.match(swScript, /mode: triggerMode,/);
assert.match(swScript, /buildProactiveTimeContext\(chat, proactiveNow, triggerMode\)/);
assert.match(swScript, /proactiveMode: triggerMode/);
assert.match(swScript, /function proactivePayloadMatchesJob\(payload = \{\}, job = null\)/);
assert.match(swScript, /忽略已被新任务替换的旧推送/);
assert.match(script, /Date\.now\(\)\.toString\(36\).*Math\.random\(\)\.toString\(36\)/);
assert.match(swScript, /Date\.now\(\)\.toString\(36\).*Math\.random\(\)\.toString\(36\)/);
assert.match(script, /cancelCloudJobId\(previousJob\.jobId\)/);
assert.match(swScript, /jobId: previousJob\.jobId/);
assert.match(script, /async function ensureLocalProactiveScheduled\(\)/);
assert.match(script, /await ensureLocalProactiveScheduled\(\);\s*await catchUpDueCloudProactive\(\);/);
const visibleHandoffIndex = swScript.indexOf("if (await hasVisibleClient())");
const backgroundDiceIndex = swScript.indexOf("if (proactiveJobMode(dueJob.job || payload) === 'dice' && !rollProactiveDice(dueJob.job || payload))");
assert.ok(visibleHandoffIndex >= 0 && backgroundDiceIndex > visibleHandoffIndex, '页面可见时应只由前台抽一次骰子');
assert.match(script, /function rollProactiveDice\(kind = 'chat', job = null\)/);
assert.match(script, /骰子未抽中/);
assert.match(script, /已经有一段时间没有继续回复/);
assert.match(script, /async function checkCloudTimerWorkerVersion/);
assert.match(script, /function cloudTimerErrorMessage\(err\)/);
assert.match(script, /云闹钟连接失败：请检查闹钟地址是否为 Worker 地址/);
assert.match(script, /manualCheckCloudTimerVersion\(\)/);
assert.match(html, /检测云端 Worker 版本/);
assert.match(html, /查看云闹钟最近流水/);
assert.match(script, /async function fetchCloudTimerLogs\(\)/);
assert.match(script, /timerUrl\('\/logs'\)/);
assert.match(script, /云闹钟版本/);
assert.match(script, /function buildProactiveTriggerMessage/);
assert.match(script, /私聊链路/);
assert.match(script, /function appendCloudTraceLine/);
assert.match(script, /前台收到 push：kind=/);
assert.match(script, /前台发现 \$\{tasks\.length\} 个本地到期任务/);
assert.match(script, /checkProactiveMessages\(\)\.catch\(err => console\.warn\('\[AL Timer\] immediate proactive check skipped:'/);
assert.match(swScript, /function buildProactiveTriggerMessage/);
assert.match(cloudTimerHealthScript, /DEFAULT_TIMEOUT_MS = 20000/);
assert.match(cloudTimerHealthScript, /Checking cloud timer:/);
assert.match(cloudTimerHealthScript, /连接云闹钟超时/);
assert.match(cloudTimerHealthScript, /Raw error:/);
assert.match(swScript, /setStateCloudTimerTrace/);
assert.match(swScript, /页面可见，转交前台处理/);
assert.match(swScript, /messages\.push\(\{ role: 'user', content: buildProactiveTriggerMessage/);
assert.match(swScript, /function getFallbackProactiveJob\(allChats\)/);
assert.match(swScript, /fallback: !!fallbackJob/);
assert.match(swScript, /收到云端 push，但本地没有可触发会话或任务/);
assert.match(script, /本地未命中到期任务，已用最近任务兜底/);
assert.match(swScript, /function latestCloudTargetCharId\(allChats\)/);
assert.doesNotMatch(swScript, /\(\!targetCharId \|\| r\.charId === targetCharId\).*r\.job\?\.dueAt/);
assert.match(swScript, /\.filter\(r => r\.job\?\.dueAt && Date\.parse\(r\.job\.dueAt\) <= now\)/);
assert.match(swScript, /function cleanApiKey\(value\)/);
assert.match(swScript, /后台记忆AI已调用/);
assert.match(swScript, /function localEmbedding\(text, dim = VECTOR_DIM\)/);
assert.match(swScript, /async function searchMemoryVectors\(charId, queryText/);
assert.match(swScript, /本轮向量召回记忆/);
assert.doesNotMatch(swScript, /重要事件和时间节点：\\n/);
assert.doesNotMatch(swScript, /稳定资料和关系状态：\\n/);
assert.match(swScript, /async function refreshBackgroundPaymentExpirations\(state, charId\)/);
assert.match(swScript, /evt_redpacket_expired_/);
assert.match(swScript, /vec_event_\$\{id\}/);
assert.match(swScript, /async function recordBackgroundScenarioMemory\(state, charId, title, detail/);
assert.match(swScript, /后台主动私聊/);
assert.match(swScript, /后台朋友圈动态/);
assert.match(swScript, /req\.onupgradeneeded/);
assert.match(swScript, /ensure\('vectors'/);
assert.match(swScript, /deleteObjectStore\('meta'\)/);
assert.match(swScript, /ensure\('meta', \[\['updatedAt', 'updatedAt'\]\]\)/);
assert.match(script, /deleteObjectStore\('meta'\)/);
assert.match(script, /ensure\('meta', \[\['updatedAt', 'updatedAt'\]\]\)/);
assert.match(script, /returnPromptDetails: true/);
assert.match(script, /diagnostic = responseDiagnostic\(json, raw\)/);
assert.match(swScript, /diagnostic = responseDiagnostic\(json, raw\)/);
assert.match(script, /记忆 API 有正文但不是可解析 JSON/);
assert.match(swScript, /记忆 API 有正文但不是可解析 JSON/);
assert.match(script, /async function prepareMemoryPackSafe\(charId, userInput, scene = 'chat'\)/);
assert.match(script, /return await prepareMemoryPack\(charId, userInput, scene\)/);
assert.match(script, /prepareMemoryPack\(charId, query, `proactive-\$\{kind\}`\)/);
assert.match(swScript, /buildMemoryPack\(charId, char, settings, memoryQuery, 'proactive-chat'\)/);
assert.match(swScript, /buildMemoryPack\(charId, char, settings, memoryQuery, 'moment-post'\)/);
assert.match(html, /id="new-personality"/);
assert.doesNotMatch(html, /id="new-first"/);
assert.match(html, /人物设定/);
assert.match(html, /说话方式/);
assert.match(html, /关系设定/);
assert.doesNotMatch(html, /个性签名/);
assert.doesNotMatch(html, /一句话设定/);
assert.doesNotMatch(html, /第一条消息/);
const composerPlusHtml = html.slice(html.indexOf('id="composer-plus"'), html.indexOf('<div id="screen-pay"'));
assert.match(composerPlusHtml, /转账/);
assert.match(composerPlusHtml, /红包/);
assert.doesNotMatch(composerPlusHtml, /记忆库/);
assert.doesNotMatch(composerPlusHtml, /主动消息/);
assert.doesNotMatch(composerPlusHtml, /发动态/);
const contactsHtml = html.slice(html.indexOf('id="screen-contacts"'), html.indexOf('<div id="screen-contact-profile"'));
assert.match(contactsHtml, /新的朋友/);
assert.match(contactsHtml, /角色卡/);
assert.doesNotMatch(contactsHtml, /showScreen\('tags'\)/);
assert.doesNotMatch(contactsHtml, /<div class="cell-body">标签<\/div>/);
assert.doesNotMatch(contactsHtml, /<div class="cell-body">记忆库<\/div>/);
const chatInfoHtml = html.slice(html.indexOf('id="screen-chat-info"'), html.indexOf('<div id="screen-moments"'));
assert.match(chatInfoHtml, /查找聊天内容/);
assert.match(chatInfoHtml, /<div class="cell-body">记忆库<\/div>/);
assert.match(chatInfoHtml, /openMemory\('chat-info'\)/);
assert.doesNotMatch(html, /id="screen-tags"/);
assert.doesNotMatch(script, /function renderTagsScreen/);
assert.match(html, /测试主动私聊/);
assert.match(html, /测试主动朋友圈/);
const settingsHtml = html.slice(html.indexOf('id="screen-settings"'), html.indexOf('<div id="screen-memory"'));
assert.match(settingsHtml, /openMemory\('settings'\)/);
assert.match(settingsHtml, /showScreen\('diagnostics'\)/);
assert.doesNotMatch(settingsHtml, /测试聊天连接/);
assert.doesNotMatch(settingsHtml, /测试记忆连接/);
assert.doesNotMatch(settingsHtml, /测试记忆筛选/);
assert.doesNotMatch(settingsHtml, /检测云端 Worker 版本/);
assert.doesNotMatch(settingsHtml, /查看云闹钟最近流水/);
assert.doesNotMatch(settingsHtml, /测试主动私聊/);
const diagnosticsHtml = html.slice(html.indexOf('id="screen-diagnostics"'), html.indexOf('<script>'));
assert.match(diagnosticsHtml, /测试聊天连接/);
assert.match(diagnosticsHtml, /测试记忆连接/);
assert.match(diagnosticsHtml, /测试记忆筛选/);
assert.match(diagnosticsHtml, /检测云端 Worker 版本/);
assert.match(diagnosticsHtml, /查看云闹钟最近流水/);
assert.match(diagnosticsHtml, /测试云闹钟推送/);
assert.match(diagnosticsHtml, /测试主动私聊/);
assert.match(diagnosticsHtml, /测试主动朋友圈/);
assert.match(html, /showScreen\(memoryReturnScreen \|\| 'settings'\)/);
assert.match(script, /let memoryReturnScreen = 'settings';/);
assert.match(script, /function openMemory\(returnScreen = activeScreen\)/);
assert.match(html, /class="memory-section-title"/);
assert.match(html, /class="memory-actions"/);
assert.match(html, /id="memory-list"><\/div>/);
assert.match(html, /id="memory-char-select"/);
assert.match(html, /id="memory-search-input"/);
assert.match(html, /filterMemoryList\(this\.value\)/);
assert.match(html, /id="screen-memory-edit"/);
assert.match(html, /id="memory-edit-char"/);
assert.match(html, /id="memory-edit-store"/);
assert.match(html, /id="memory-edit-detail"/);
assert.match(html, /saveMemoryEditor\(\)/);
assert.match(html, /addMemoryItem\('profiles'\)/);
assert.match(script, /function renderMemoryItem\(storeName, item\)/);
assert.match(script, /let memoryTargetCharId = '';/);
assert.match(script, /let memoryFilterText = '';/);
assert.match(script, /function memoryCurrentCharId\(\)/);
assert.match(script, /function memoryRowMatches\(row, query = ''\)/);
assert.match(script, /function filterMemoryList\(value\)/);
assert.match(script, /async function switchMemoryChar\(charId\)/);
assert.match(script, /memoryTargetCharId = currentCharId \|\| memoryTargetCharId \|\| characters\[0\]\?\.id \|\| '';/);
assert.match(script, /const selector = document\.getElementById\('memory-char-select'\)/);
assert.match(script, /const searchInput = document\.getElementById\('memory-search-input'\)/);
assert.match(script, /const validTarget = characters\.some\(c => c\.id === memoryTargetCharId\)/);
assert.match(script, /const filteredGroups = groups\.map\(group => \(\{ \.\.\.group, rows: group\.rows\.filter\(row => memoryRowMatches\(row, memoryFilterText\)\) \}\)\)/);
assert.match(script, /没有匹配的记忆/);
assert.match(script, /function addMemoryItem\(storeName\)/);
assert.match(script, /function editMemoryItem\(storeName, id\)/);
assert.match(script, /async function openMemoryEditor\(storeName = 'profiles', id = ''\)/);
assert.match(script, /async function renderMemoryEditor\(item = null\)/);
assert.match(script, /function memoryEditorDefaults\(storeName\)/);
assert.match(script, /function renderMemoryEditorFields\(\)/);
assert.match(script, /async function saveMemoryEditor\(\)/);
assert.match(script, /let memoryEditorState = \{ storeName: 'profiles', id: '', lastStoreName: 'profiles' \};/);
assert.match(script, /if \(charEl\) charEl\.textContent = char \? char\.name : '未选择';/);
assert.match(script, /if \(!memoryEditorState\.id && previousStore !== storeName\)/);
assert.match(script, /function deleteMemoryItem\(storeName, id\)/);
assert.match(script, /function syncMemoryVector\(storeName, item\)/);
assert.match(script, /manual: true/);
assert.match(script, /await syncMemoryVector\(storeName, item\)/);
assert.doesNotMatch(script, /prompt\('编辑摘要'/);
assert.doesNotMatch(script, /prompt\('新增摘要'/);
assert.match(script, /const charId = memoryCurrentCharId\(\);[\s\S]*await processMemoryAfterTurn\(charId, true\)/);
assert.match(script, /const charId = memoryCurrentCharId\(\);[\s\S]*await MemoryDB\.clearChar\(charId\)/);
assert.match(script, /if \(memoryTargetCharId === deletedId\) memoryTargetCharId = '';/);
assert.match(script, /MemoryDB\.remove\('vectors', `vec_\$\{memorySourceType\(storeName\)\}_\$\{id\}`\)/);
assert.match(script, /title: '资料', store: 'profiles'/);
assert.match(script, /title: '事件', store: 'events'/);
assert.match(script, /title: '摘要', store: 'summaries'/);
assert.match(script, /function friendAddedSystemMessage/);
assert.match(script, /你已添加了\$\{name\}，现在可以开始聊天了。/);
assert.match(script, /function chatClearedSystemMessage/);
assert.match(script, /你已清空与\$\{charName\(char\)\}的聊天记录。/);
assert.match(script, /function conversationMessages\(chat\)/);
assert.match(script, /function recentMessages\(chat, count = 30, charBudget = CHAT_HISTORY_CHAR_BUDGET\)/);
assert.match(script, /function removeCharacterMomentTraces\(charId\)/);
assert.match(script, /async function cancelCloudProactiveQuick\(charId, reason = '操作'\)/);
assert.match(script, /await withTimeout\(cancelCloudProactive\(charId, 'all'\), 8000, `\$\{reason\}取消云闹钟超时`\)/);
assert.match(script, /async function clearCurrentChat\(\)/);
assert.match(script, /cancelCloudProactiveQuick\(currentCharId, '清空当前聊天'\)/);
assert.match(script, /invalidateMemoryExtraction\(currentCharId\)/);
assert.match(script, /MemoryDB\.setMeta\(memoryMetaKey\(currentCharId\), 0\)/);
assert.match(script, /聊天已清空，增量整理游标已复位/);
assert.match(script, /messages: \[chatClearedSystemMessage\(char\)\]/);
assert.doesNotMatch(script, /role:'assistant', content:char\.firstMessage/);
assert.match(script, /async function deleteCurrentRole\(\)/);
assert.match(script, /cancelCloudProactiveQuick\(deletedId, '删除角色'\)/);
assert.match(script, /async function clearAllHistory\(\)/);
assert.match(script, /cancelCloudProactiveQuick\(charId, '清空全部聊天'\)/);
assert.match(script, /MemoryDB\.clearChar\(deletedId\)/);
assert.match(script, /removeCharacterMomentTraces\(deletedId\)/);
assert.match(script, /会同时删除它的聊天、云闹钟、本地记忆库和朋友圈痕迹/);
assert.match(html, /测试记忆筛选/);
assert.match(script, /async function testMemoryQueryPreset\(\)/);
assert.match(script, /scene: 'memory-query-test'/);
assert.match(script, /记忆检索失败：\$\{friendlyErrorMessage\(err\)\}；已跳过记忆包继续生成。/);
assert.match(script, /await prepareMemoryPackSafe\(requestCharId, userText, 'chat'\)/);
assert.match(script, /await prepareMemoryPackSafe\(char\.id, memoryQuery, 'moment-interaction'\)/);
assert.match(script, /await prepareMemoryPackSafe\(char\.id, memoryQuery, 'moment-reply'\)/);
assert.match(html, /onpointerdown="startVoiceRecording\(event\)"/);
assert.match(html, /id="set-voice-api-url"/);
assert.match(html, /id="set-voice-model"/);
assert.match(script, /async function sendVoiceMessage\(\)/);
assert.match(script, /async function transcribeVoiceBlob\(blob, duration/);
assert.match(script, /\/audio\/transcriptions/);
assert.match(script, /new FormData\(\)/);
assert.doesNotMatch(script, /'Content-Type': 'multipart\/form-data'/);
assert.match(script, /function renderVoiceCard\(m\)/);
assert.match(script, /\[语音消息 \$\{actualDuration\}秒，未转文字\]/);
assert.match(swScript, /promptBlocks: prompt\.promptBlocks/);
assert.match(script, /红包 24 小时未领取，已自动退回零钱/);
assert.match(html, /id="screen-diagnostics"/);
assert.match(html, /查看最近调用/);
assert.match(script, /function renderDiagnosticsScreen\(\)/);
assert.match(html, /导出本机数据/);
assert.match(html, /含 API Key、聊天、朋友圈和记忆库/);
assert.match(html, /导入本机备份/);
assert.match(script, /async function dumpMemoryStores\(\)/);
assert.match(script, /async function restoreMemoryStores\(memory = \{\}\)/);
assert.match(script, /async function exportBackup\(\)/);
assert.match(script, /备份文件会包含聊天接口、记忆接口、语音接口的地址和 API Key/);
assert.match(script, /已导出备份，请妥善保存，里面包含 API Key/);
assert.match(script, /async function importBackup\(event\)/);
assert.match(script, /function resetImportedDeviceBinding\(importedSettings\)/);
assert.match(script, /function clearImportedCloudJobs\(chats = \{\}\)/);
assert.match(script, /AL-backup-/);
assert.match(script, /导入会覆盖当前本机设置、角色、聊天、朋友圈和记忆库/);
assert.match(script, /备份已导入，云闹钟需重新绑定/);
assert.match(script, /已从备份恢复；云闹钟需要在本机重新绑定。/);
const cloudTimerWorkerCode = cloudTimerWorker.replace(/\/\/.*$/gm, '');
assert.doesNotMatch(cloudTimerWorkerCode, /\.list\s*\(/);
assert.match(cloudTimerWorker, /const CLOUD_TIMER_WORKER_VERSION = '2026-07-10\.9';/);
assert.match(cloudTimerWorker, /const IDLE_CRON_HEARTBEAT_MINUTES = 10;/);
assert.match(cloudTimerWorker, /const JOB_BUCKET_TTL_SECONDS = 7 \* 24 \* 60 \* 60;/);
assert.match(cloudTimerWorker, /const hasActivity = !summary\.ok \|\| summary\.jobsSeen > 0/);
assert.match(cloudTimerWorker, /const heartbeatDue = nowMinute % IDLE_CRON_HEARTBEAT_MINUTES === 0;/);
assert.match(cloudTimerWorker, /if \(hasActivity \|\| heartbeatDue\)/);
assert.match(cloudTimerWorker, /if \(hasActivity\) \{\s*await appendEvent/);
assert.equal((cloudTimerWorker.match(/expirationTtl: JOB_BUCKET_TTL_SECONDS/g) || []).length, 3);
assert.match(cloudTimerWorker, /version: CLOUD_TIMER_WORKER_VERSION/);
assert.match(cloudTimerWorker, /mode: body\.mode === 'dice' \? 'dice' : 'planned'/);
assert.match(cloudTimerWorker, /rollChance: job\.rollChance/);
assert.match(cloudTimerWorker, /diceRolls: job\.diceRolls/);
assert.match(cloudTimerWorker, /dicePrecomputed: !!job\.dicePrecomputed/);
assert.doesNotMatch(cloudTimerWorker, /AL_TIMER_KV\.list/);
const cloudWorkerModule = await import(`./cloud-timer-worker.js?quota-test=${Date.now()}`);
const idleCronWrites = [];
const idleCronWaits = [];
const idleCronEnv = {
  AL_TIMER_KV: {
    async get() { return null; },
    async put(key, value, options) { idleCronWrites.push({ key, value, options }); },
    async delete() {}
  }
};
await cloudWorkerModule.default.scheduled({}, idleCronEnv, { waitUntil(promise) { idleCronWaits.push(promise); } });
await Promise.all(idleCronWaits);
assert.equal(idleCronWrites.some(row => row.key === 'meta:recentEvents'), false, '空闲 cron 不得每分钟写流水');
assert.ok(idleCronWrites.filter(row => row.key === 'meta:lastCron').length <= 1, '空闲 cron 只能按心跳节流写一次状态');
assert.match(cloudTimerWorker, /url\.pathname === '\/logs'/);
assert.match(cloudTimerWorker, /meta:recentEvents/);
assert.match(cloudTimerWorker, /async function appendEvent\(env, event\)/);
assert.match(cloudTimerWorker, /async function sendEncryptedPush\(subscription, env, payload = \{\}\)/);
assert.match(cloudTimerWorker, /async function encryptPushPayload\(subscription, payloadText\)/);
assert.match(cloudTimerWorker, /'Content-Encoding': 'aes128gcm'/);
assert.match(swScript, /event\.data \? event\.data\.json\(\) : \{\}/);
assert.match(cloudTimerWorker, /cron: await getLastCron\(env\)/);
assert.equal(packageJson.scripts['cloud:deploy'], 'node scripts/deploy-cloud-timer.mjs');
assert.equal(packageJson.scripts['cloud:deploy:raw'], 'node scripts/run-wrangler.mjs deploy');
assert.equal(packageJson.scripts['cloud:health'], 'node scripts/check-cloud-timer.mjs');
assert.match(cloudTimerDeployScript, /Missing CLOUDFLARE_API_TOKEN/);
assert.match(cloudTimerDeployScript, /WRANGLER_CMD/);
assert.match(wranglerRunScript, /Tools\\\\bin\\\\wrangler\.cmd/);
assert.match(wranglerRunScript, /Missing CLOUDFLARE_API_TOKEN/);
assert.match(cloudTimerDeployScript, /scripts\/check-cloud-timer\.mjs/);
assert.match(cloudTimerHealthScript, /EXPECTED_VERSION = '2026-07-09\.7'/);
assert.match(cloudTimerHealthScript, /Cron: ok=/);
assert.match(cloudTimerDeployDoc, /CLOUDFLARE_API_TOKEN/);
assert.match(cloudTimerDeployDoc, /npm run cloud:deploy/);
assert.match(cloudTimerDeployDoc, /AL_TIMER_ENDPOINT/);
assert.match(cloudTimerDeployDoc, /npm run cloud:deploy:raw/);
assert.match(cloudTimerDeployDoc, /job=存在/);
assert.match(cloudTimerDeployDoc, /Cron 核验/);
assert.match(cloudTimerWorker, /meta:lastCron/);
assert.match(cloudTimerWorker, /async function getLastCron\(env\)/);
assert.match(script, /function formatCloudCronStatus\(cron\)/);
assert.match(cloudTimerWorker, /url\.pathname === '\/job-status'/);
assert.match(cloudTimerWorker, /async function jobStatus\(jobId, deviceId, env\)/);
assert.match(script, /async function verifyCloudJobStatus\(charId, job, kind = 'chat'\)/);
assert.match(script, /async function verifyCurrentCloudJobs\(\)/);
assert.match(script, /await verifyCurrentCloudJobs\(\)/);
assert.match(script, /当前本地没有待核验的云端任务/);
assert.match(script, /云端任务核验失败/);
assert.match(html, /id="moment-reply-bar"/);
assert.match(script, /function openMomentReplyBar\(momentId\)/);
assert.match(script, /function openMomentCommentReply\(momentId, commentId\)/);
assert.match(script, /async function submitMomentReply\(\)/);
assert.match(script, /replyToMoment\(targetId, text, \{ targetCommentId, targetCharId \}\)/);
assert.match(script, /const momentNotificationFlights = new Map\(\);/);
assert.match(script, /moment\.notifyFailures\?\.\[char\.id\]/);
assert.match(script, /互动失败，点右侧 ·· 重试/);
assert.match(script, /replyToCommentId: commentItem\.id/);
assert.match(script, /replyToCharId: char\.id/);
assert.match(script, /openMomentReplyBar\('\$\{moment\.id\}'\)/);
assert.match(script, /没有在评论区回复/);
assert.match(script, /function markMomentNotifiedToChar\(moment, char\)/);
assert.match(script, /markMomentNotifiedToChar\(moment, char\);\s*saveMoments\(\);\s*processMemoryAfterScenario\(char\.id\);/);
assert.match(script, /角色已看过，配置聊天接口后才能判断是否回复/);
assert.match(script, /角色已看过，配置聊天接口后才能判断是否点赞或回复/);
assert.match(script, /回复失败，但角色已看过/);
assert.match(script, /function cleanAssistantChatReply\(text\)/);
assert.match(script, /function cleanStreamingDraftText\(text\)/);
assert.match(script, /result = mergeStreamText\(result, deltaText\)/);
assert.match(swScript, /function cleanAssistantChatReply\(text\)/);
assert.match(swScript, /const replyText = cleanAssistantChatReply\(reply\)/);
assert.match(swScript, /appendAssistantMessages\(chat, replyText/);
assert.match(script, /'like' in json \|\| 'timeline' in json/);
assert.match(script, /return cleanAssistantChatReply\(reply\)/);
assert.match(cloudTimerWorker, /const bucketKey = `due:\$\{minute\}`/);
assert.match(cloudTimerWorker, /async function cancelJob\(jobId, env\)/);
assert.match(cloudTimerWorker, /removeJobFromBucket\(`due:\$\{minuteKey\(dueAtMs\)\}`, jobId, env\)/);
assert.doesNotMatch(cloudTimerWorker, /if \(body\.jobId\) await env\.AL_TIMER_KV\.delete\(`job:\$\{body\.jobId\}`\)/);
assert.match(cloudTimerWorker, /if \(job\.jobId && !delivered\.retry\) await cancelJob\(job\.jobId, env\)/);
assert.match(cloudTimerWorker, /if \(delivered\.retry\)/);
assert.match(cloudTimerWorker, /resp\.status === 404 \|\| resp\.status === 410/);
assert.match(cloudTimerWorker, /delete\(`sub:\$\{job\.deviceId\}`\)/);

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
const modelListFetch = context.fetch;

vm.createContext(context);
vm.runInContext(`${script}
globalThis.__appTest = {
  parseCharacterCard,
  buildCharPrompt,
  formatMsg,
  textFromContent,
  extractResponseText,
  streamDeltaText,
  mergeStreamText,
  cleanStreamingDraftText,
  previewText,
  messagePreview,
  normalizeChar,
  normalizePresetKey,
  resetImportedDeviceBinding,
  clearImportedCloudJobs,
  normalizeMemoryProcessedCursor,
  memoryRelevantMessages,
  fetchModels,
  selectFetchedModel,
  recentMessages,
  localEmbedding,
  createEmbedding,
  cosine,
  cleanApiKey,
  getTimeContext,
  getDayPeriod,
  formatElapsed,
  normalizeProactiveTriggerMode,
  proactiveConversationState,
  chatHasUnansweredProactive,
  buildProactiveTimeContext,
  buildProactiveTriggerMessage,
  proactiveRecentMessages,
  stripLeakedPromptMetadata,
  splitAssistantOutput,
  createPromptComposer,
  chatSceneFromOptions,
  buildChatSceneSystem,
  buildMomentInteractionPayload,
  buildMomentPostPayload,
  buildMomentReplyPayload,
  momentSeenNames,
  renderMomentComment,
  markMomentCommentSeen,
  markMomentNotifiedToChar,
  renderVoiceCard,
  voiceApiConfig,
  extractTranscriptionText,
  buildMemoryQueryPayload,
  buildMemoryExtractPayload,
  generateMemoryQuery,
  testMemoryQueryPreset,
  memoryAliasText,
  memorySignalTerms,
  scoreKeywordMemoryText,
  searchKeywordMemoryRows,
  composeMemoryPackSections,
  memoryStatusWithBudget,
  recordModelCall,
  getModelCallLogs,
  getAllModelCallLogs,
  formatModelCallStatus,
  formatModelCallDiagnostic,
  renderDiagnosticsScreen,
  clearModelCallLogs,
  shouldKeepEvent,
  memoryTextIsNoise,
  memoryTextSimilarity,
  findMemoryMergeCandidate,
  mergeMemoryItems,
  cloudTimerTargetCharId,
  proactiveJobId,
  proactiveDefaultScheduleOptions,
  proactiveDicePlan,
  RP_PRESETS,
};`, context);

const { parseCharacterCard, buildCharPrompt, formatMsg, textFromContent, extractResponseText, streamDeltaText, mergeStreamText, cleanStreamingDraftText, previewText, messagePreview, normalizeChar, normalizePresetKey, resetImportedDeviceBinding, clearImportedCloudJobs, normalizeMemoryProcessedCursor, memoryRelevantMessages, fetchModels, selectFetchedModel, recentMessages, localEmbedding, createEmbedding, cosine, cleanApiKey, getTimeContext, getDayPeriod, formatElapsed, normalizeProactiveTriggerMode, proactiveConversationState, chatHasUnansweredProactive, buildProactiveTimeContext, buildProactiveTriggerMessage, proactiveRecentMessages, stripLeakedPromptMetadata, splitAssistantOutput, createPromptComposer, chatSceneFromOptions, buildChatSceneSystem, buildMomentInteractionPayload, buildMomentPostPayload, buildMomentReplyPayload, momentSeenNames, renderMomentComment, markMomentCommentSeen, markMomentNotifiedToChar, renderVoiceCard, voiceApiConfig, extractTranscriptionText, buildMemoryQueryPayload, buildMemoryExtractPayload, generateMemoryQuery, testMemoryQueryPreset, memoryAliasText, memorySignalTerms, scoreKeywordMemoryText, searchKeywordMemoryRows, composeMemoryPackSections, memoryStatusWithBudget, recordModelCall, getModelCallLogs, getAllModelCallLogs, formatModelCallStatus, formatModelCallDiagnostic, renderDiagnosticsScreen, clearModelCallLogs, shouldKeepEvent, memoryTextIsNoise, memoryTextSimilarity, findMemoryMergeCandidate, mergeMemoryItems, cloudTimerTargetCharId, proactiveJobId, proactiveDefaultScheduleOptions, proactiveDicePlan, RP_PRESETS } = context.__appTest;

const memoryQueueProbe = await vm.runInContext(`(async () => {
  const original = processMemoryBatch;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  processMemoryBatch = async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await gate;
    active--;
    return true;
  };
  const first = processMemoryAfterTurn('queue-probe');
  const second = processMemoryAfterTurn('queue-probe');
  release();
  await Promise.all([first, second]);
  processMemoryBatch = original;
  return { calls, maxActive, samePromise: first === second };
})()`, context);
assert.equal(memoryQueueProbe.samePromise, true, '同一角色的并发整理请求应复用同一条队列');
assert.equal(memoryQueueProbe.maxActive, 1, '同一角色不得并发执行两个记忆整理批次');
assert.equal(memoryQueueProbe.calls, 2, '整理期间的新请求应合并为一次后续检查');

const momentNotifyProbe = await vm.runInContext(`(async () => {
  const original = runMomentNotification;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  runMomentNotification = async () => { calls++; await gate; return true; };
  const first = notifyMomentToCharacters('moment-flight');
  const second = notifyMomentToCharacters('moment-flight');
  release();
  await Promise.all([first, second]);
  runMomentNotification = original;
  return { calls, samePromise: first === second };
})()`, context);
assert.equal(momentNotifyProbe.samePromise, true, '同一条朋友圈的重复通知应复用同一任务');
assert.equal(momentNotifyProbe.calls, 1, '自动通知和手动点击不得重复调用角色 AI');

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
assert.match(prompt, /关系与相处设定：窗外落雨/);
assert.ok(RP_PRESETS.combined.prompt.includes('不写动作、神态、表情、环境'));
assert.ok(RP_PRESETS.combined.prompt.includes('拆成独立聊天气泡'));
assert.equal(normalizePresetKey('story'), 'combined');
assert.equal(normalizePresetKey('custom'), 'custom');

const contextBudgetChat = {
  messages: [
    { role: 'system', content: '系统消息不发送' },
    { role: 'user', content: '旧'.repeat(80) },
    { role: 'assistant', content: '中'.repeat(80) },
    { role: 'user', content: '新'.repeat(80) }
  ]
};
assert.equal(recentMessages(contextBudgetChat, 30, 150).map(row => row.content[0]).join(''), '新', '上下文预算应从最新消息向前保留连续尾部');
assert.equal(recentMessages(contextBudgetChat, 2, 1000).map(row => row.content[0]).join(''), '中新', '条数上限仍应生效');
const oversizedLatest = recentMessages({ messages: [{ role: 'user', content: '最'.repeat(500) }] }, 30, 120);
assert.equal(oversizedLatest.length, 1, '即使最新消息超过预算，也必须完整保留');
assert.equal(oversizedLatest[0].content.length, 500, '不得截断玩家最新一条消息');

assert.equal(formatMsg('<b>*动作*</b>\n台词'), '&lt;b&gt;*动作*&lt;/b&gt;<br>台词');
assert.equal(textFromContent([{ type: 'output_text', text: 'Responses 正文' }]), 'Responses 正文');
assert.equal(textFromContent({ value: { text: '嵌套正文' } }), '嵌套正文');
assert.equal(extractResponseText({ output: [{ content: [{ type: 'output_text', text: 'OpenAI Responses 正文' }] }] }), 'OpenAI Responses 正文');
assert.equal(extractResponseText({ candidates: [{ content: { parts: [{ text: 'Gemini 正文' }] } }] }), 'Gemini 正文');
assert.equal(streamDeltaText({ candidates: [{ content: { parts: [{ text: 'Gemini 流式正文' }] } }] }), 'Gemini 流式正文');
assert.equal(streamDeltaText({ choices: [{ message: { content: [{ type: 'text', text: '兼容流式正文' }] } }] }), '兼容流式正文');
assert.equal(streamDeltaText({ choices: [{ delta: { content: ' world' } }] }), ' world');
assert.equal(mergeStreamText('Hello', ' world'), 'Hello world');
assert.equal(mergeStreamText('你好', '你好，今天怎么样'), '你好，今天怎么样');
assert.equal(cleanStreamingDraftText('你好\n<al_s'), '你好');
assert.equal(cleanStreamingDraftText('你好\n<al_schedule>{"nextProactiveAt":"2026-07-10T12:00:00+08:00"}'), '你好');
assert.equal(cleanStreamingDraftText('你好\n【发送时'), '你好');
assert.equal(cleanStreamingDraftText('你好\n{"timeline":"今天天气很好"'), '你好');
assert.equal(cleanStreamingDraftText('正常聊天正文'), '正常聊天正文');
assert.equal(stripLeakedPromptMetadata('【发送时间 2026-07-09 22:03，距现在 1 天】换个话题吧'), '换个话题吧');
assert.equal(stripLeakedPromptMetadata('[历史消息元数据：2026-07-09 22:03] 今天天气怎么样'), '今天天气怎么样');
const proactiveStageNow = new Date('2026-07-10T22:03:00+08:00');
const staleProactiveChat = {
  messages: [
    { role: 'user', content: '红包你收到了吗', time: proactiveStageNow.getTime() - 30 * 60 * 60 * 1000 },
    { role: 'assistant', content: '收到了', time: proactiveStageNow.getTime() - 29 * 60 * 60 * 1000 },
    { role: 'assistant', content: '你人呢', time: proactiveStageNow.getTime() - 26 * 60 * 60 * 1000, proactive: true, proactiveMode: 'planned' },
    { role: 'user', content: '【朋友圈事件】林晚发了一条朋友圈', time: proactiveStageNow.getTime() - 2 * 60 * 1000, hidden: true }
  ]
};
const proactiveState = proactiveConversationState(staleProactiveChat, proactiveStageNow);
assert.equal(proactiveState.last.content, '你人呢', '隐藏朋友圈事件不得重置私聊最后消息时间');
assert.equal(proactiveState.proactiveSinceLastUser.length, 1);
assert.equal(chatHasUnansweredProactive(staleProactiveChat), true);
assert.equal(proactiveDefaultScheduleOptions('chat', staleProactiveChat).mode, 'dice', '已有未回复主动消息时补排只能进入骰子模式');
assert.equal(proactiveDefaultScheduleOptions('chat', { messages: staleProactiveChat.messages.slice(0, 2) }).mode, 'planned');
const staleDiceContext = buildProactiveTimeContext(staleProactiveChat, proactiveStageNow, 'dice');
assert.match(staleDiceContext, /随机再联系阶段/);
assert.match(staleDiceContext, /已有 1 条主动消息气泡/);
assert.match(staleDiceContext, /超过 24 小时/);
assert.doesNotMatch(staleDiceContext, /林晚发了一条朋友圈/);
const proactiveHistory = proactiveRecentMessages(staleProactiveChat, 30, proactiveStageNow);
assert.match(proactiveHistory.at(-1).content, /后台场景事件/);
assert.match(proactiveHistory.at(-1).content, /不是玩家刚发来的聊天气泡/);
assert.equal(previewText('[语音消息 5秒，未转文字]'), '[语音]');
assert.equal(previewText('[语音消息 5秒] 今晚早点睡'), '[语音] 今晚早点睡');
assert.equal(messagePreview({ type: 'voice', transcript: '今晚早点睡', voiceDuration: 5 }), '[语音] 今晚早点睡');
assert.match(renderVoiceCard({ type: 'voice', voiceDuration: 5 }), /voice-bubble/);
assert.match(renderVoiceCard({ type: 'voice', voiceDuration: 5 }), /5''/);
assert.match(renderVoiceCard({ type: 'voice', voiceDuration: 5, transcript: '今晚早点睡' }), /今晚早点睡/);
assert.equal(extractTranscriptionText({ text: '转写正文' }), '转写正文');
assert.equal(extractTranscriptionText({ transcript: '兼容转写' }), '兼容转写');
assert.equal(memoryTextIsNoise('[语音消息 5秒，未转文字]'), true);
assert.equal(memoryTextIsNoise('测试点赞了朋友圈，只评论哈哈，没有后续意义。'), true);
assert.ok(memoryTextSimilarity('姜答应周末提醒测试交稿', '姜答应周末提醒测试交稿。') > 0.95);
const manualProfile = { id: 'manual_profile', charId: 'char-1', type: 'user', title: '居住城市', detail: '姜目前住在上海', keywords: ['城市', '上海'], manual: true, createdAt: 1 };
const incomingProfile = { id: 'auto_profile', charId: 'char-1', type: 'user', title: '居住城市', detail: '姜目前住在上海市', keywords: ['城市', '上海'], createdAt: 2 };
assert.equal(findMemoryMergeCandidate([manualProfile], incomingProfile, 'profiles')?.id, 'manual_profile');
assert.equal(mergeMemoryItems(manualProfile, incomingProfile, 'profiles'), manualProfile, '手动编辑的记忆不得被 AI 覆盖');
const pendingPayment = { id: 'payment_500', charId: 'char-1', type: 'payment', title: '500元红包', detail: '姜给测试发了500元红包，仍待领取', status: 'open', keywords: ['红包', '500元'], createdAt: 1 };
const receivedPayment = { id: 'payment_500_done', charId: 'char-1', type: 'payment', title: '500元红包', detail: '测试领取了姜发的500元红包', status: 'done', keywords: ['红包', '500元'], createdAt: 2 };
assert.equal(findMemoryMergeCandidate([pendingPayment], receivedPayment, 'events')?.id, 'payment_500');
const mergedPayment = mergeMemoryItems(pendingPayment, receivedPayment, 'events', 3);
assert.equal(mergedPayment.id, 'payment_500');
assert.equal(mergedPayment.status, 'done');
assert.match(mergedPayment.detail, /仍待领取.*后续：.*领取/);
const otherAmount = { ...receivedPayment, id: 'payment_100_done', title: '100元红包', detail: '测试领取了姜发的100元红包', keywords: ['红包', '100元'] };
assert.equal(findMemoryMergeCandidate([pendingPayment], otherAmount, 'events'), null, '金额不同的事件不得误合并');
const datedPendingPayment = { ...pendingPayment, happenedAt: '2026-07-10 12:00' };
const datedOtherAmount = { ...otherAmount, happenedAt: '2026-07-10 12:00' };
assert.equal(findMemoryMergeCandidate([datedPendingPayment], datedOtherAmount, 'events'), null, '相同日期数字不能掩盖金额差异');
assert.equal(JSON.stringify(splitAssistantOutput('第一句\n\n第二句\r\n第三句')), JSON.stringify(['第一句', '第二句', '第三句']));
assert.equal(memoryAliasText('用户和角色约好下次继续聊', { name: '林晚' }), '玩家和林晚约好下次继续聊');
assert.equal(shouldKeepEvent({ type: 'fact', title: '时间校对分歧', detail: '用户说自己这里是48分，角色解释表快了几分钟。', importance: 3, keywords: ['时间校对'] }), false);
assert.equal(shouldKeepEvent({ type: 'moment', title: '普通朋友圈点赞', detail: '林晚给玩家朋友圈点了赞，只评论“哈哈”。', importance: 4, keywords: ['朋友圈', '点赞'] }), false);
assert.equal(shouldKeepEvent({ type: 'fact', title: 'AI身份争论', detail: '玩家质疑林晚是不是AI，林晚说名字“测试”不合理。', importance: 4, keywords: ['AI身份'] }), false);
assert.equal(shouldKeepEvent({ type: 'promise', title: '红包约定', detail: '玩家答应林晚回复“哟哟”后给180元红包。', importance: 4, keywords: ['红包', '约定'] }), true);
assert.equal(shouldKeepEvent({ type: 'moment', title: '朋友圈红包后续', detail: '林晚在朋友圈评论里提醒玩家别忘了答应过的180元红包，后续私聊需要记得这件事。', importance: 4, keywords: ['朋友圈', '红包', '约定'] }), true);
const promptComposer = createPromptComposer('chat');
promptComposer.add('late', '后写', { priority: 20 });
promptComposer.add('early', '先写', { priority: 10 });
promptComposer.add('other-scene', '不应出现', { priority: 1, scenes: ['proactive-chat'] });
assert.equal(promptComposer.compile(), '先写\n\n后写');
function blockIds(payload) {
  return (payload.promptBlocks || []).map(block => block.id);
}
assert.equal(chatSceneFromOptions({}), 'chat');
assert.equal(chatSceneFromOptions({ proactive: true }), 'proactive-chat');
assert.equal(chatSceneFromOptions({ payment: { kind: 'redpacket' } }), 'payment');
const chatSystem = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。' });
assert.match(chatSystem, /微信私聊/);
assert.match(chatSystem, /记忆：林晚和玩家约好周末见。/);
assert.match(chatSystem, /当前触发情况：玩家刚在私聊里发来消息/);
const chatPromptDetails = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。', returnPromptDetails: true });
assert.equal(blockIds(chatPromptDetails).slice(0, 3).join(','), 'scene-base,memory-pack,normal-chat-scene');
const proactivePromptDetails = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚和玩家约好周末见。', proactive: true, returnPromptDetails: true });
assert.ok(blockIds(proactivePromptDetails).includes('proactive-time-context'));
assert.ok(blockIds(proactivePromptDetails).includes('memory-pack'));
assert.match(proactivePromptDetails.system, /计划追发/);
const dicePromptDetails = buildChatSceneSystem(v2, staleProactiveChat, { memoryPack: '记忆：旧红包话题。', proactive: true, proactiveNow: proactiveStageNow, proactiveTriggerMode: 'dice', returnPromptDetails: true });
assert.match(dicePromptDetails.system, /随机再联系/);
assert.match(dicePromptDetails.system, /禁止.*自问自答/);
assert.match(dicePromptDetails.system, /超过 24 小时/);
const paymentPromptDetails = buildChatSceneSystem(v2, { messages: [] }, { memoryPack: '记忆：林晚刚收过红包。', payment: { kind: 'redpacket', amount: 66, note: '测试' }, returnPromptDetails: true });
assert.ok(blockIds(paymentPromptDetails).includes('payment-scene'));
assert.ok(blockIds(paymentPromptDetails).includes('memory-pack'));
const playerMoment = { text: '今天有点想喝热茶。', likes: [], comments: [], time: Date.now(), authorType: 'player' };
const interactionPayload = buildMomentInteractionPayload(v2, playerMoment, '记忆：林晚刚收过玩家的红包。');
assert.match(interactionPayload.system, /朋友圈动态互动/);
assert.match(interactionPayload.system, /只允许输出 JSON，不要输出解释：\{"like":true\/false,"comment":"留言正文或空字符串"\}/);
assert.match(interactionPayload.system, /记忆：林晚刚收过玩家的红包。/);
assert.match(interactionPayload.messages[0].content, /朋友圈正文：今天有点想喝热茶。/);
assert.equal(blockIds(interactionPayload).slice(0, 3).join(','), 'scene-base,memory-pack,moment-scene-rules');
const postPayload = buildMomentPostPayload(v2, { messages: [] }, '记忆：林晚和玩家约好周末见。');
assert.match(postPayload.system, /朋友圈发布动态/);
assert.match(postPayload.system, /只允许输出 JSON，不要输出解释：\{"text":"朋友圈正文"\}/);
assert.match(postPayload.messages[0].content, /最近私聊/);
assert.ok(blockIds(postPayload).includes('memory-pack'));
const ownMoment = { text: '雨停了。', comments: [{ name: '玩家', text: '终于能出门了' }], time: Date.now(), authorType: 'character' };
const replyPayload = buildMomentReplyPayload(v2, ownMoment, '终于能出门了', '记忆：玩家怕冷。');
assert.match(replyPayload.system, /朋友圈评论回复/);
assert.match(replyPayload.system, /只允许输出 JSON，不要输出解释：\{"comment":"回复评论正文或空字符串"\}/);
assert.match(replyPayload.system, /记忆：玩家怕冷。/);
assert.match(replyPayload.messages[0].content, /玩家刚发来的评论区文字：终于能出门了/);
assert.ok(blockIds(replyPayload).includes('memory-pack'));
const playerMomentThread = { authorType: 'player', text: '今天有点想喝热茶。', comments: [{ id: 'char-comment', charId: 'char_seen', name: '林晚', text: '少喝冰的。' }] };
const threadReplyPayload = buildMomentReplyPayload(v2, playerMomentThread, '知道啦', '记忆：玩家胃不好。', { targetComment: playerMomentThread.comments[0] });
assert.match(threadReplyPayload.system, /回复了林晚此前在玩家朋友圈下的评论/);
assert.match(threadReplyPayload.messages[0].content, /本次回复的是林晚此前的评论：少喝冰的/);
vm.runInContext("characters = [{ id: 'char_seen', name: '林晚' }, { id: 'char_liked', name: '谢韫' }];", context);
assert.equal(JSON.stringify(momentSeenNames({ authorType: 'player', notifiedCharIds: ['char_seen', 'char_liked'], likes: ['char_liked'], comments: [] })), JSON.stringify(['林晚']));
assert.match(renderMomentComment({ id: 'clickable-comment', charId: 'char_seen', name: '林晚', text: '少喝冰的。' }, { id: 'player-moment', authorType: 'player', comments: [] }), /openMomentCommentReply/);
const seenCommentMoment = { authorType: 'char', charId: 'char_seen', comments: [{ id: 'c1', charId: 'player', name: '玩家', text: '我来评论一下', seenBy: [] }] };
assert.equal(markMomentCommentSeen(seenCommentMoment, 'c1', 'char_seen'), true);
assert.match(renderMomentComment(seenCommentMoment.comments[0], seenCommentMoment), /已看过/);
const playerPostSeen = { authorType: 'player', text: '今天不想说话。', notifiedCharIds: [], likes: [], comments: [], time: Date.now() };
assert.equal(markMomentNotifiedToChar(playerPostSeen, { id: 'char_seen', name: '林晚' }), true);
assert.equal(JSON.stringify(playerPostSeen.notifiedCharIds), JSON.stringify(['char_seen']));
assert.match(JSON.parse(storage.get('rpchat_chats')).char_seen.messages.at(-1).content, /林晚看到了这条朋友圈/);
const momentThreadProbe = await vm.runInContext(`(async () => {
  const oldCharacters = characters;
  const oldMoments = allMoments;
  const oldChats = allChats;
  const oldSettings = settings;
  const oldProcess = processMemoryAfterScenario;
  characters = [{ id: 'thread-char', name: '林晚' }];
  allMoments = [{
    id: 'thread-moment',
    authorType: 'player',
    text: '今天有点想喝热茶。',
    time: Date.now(),
    likes: [],
    comments: [{ id: 'thread-comment', charId: 'thread-char', name: '林晚', text: '少喝冰的。', time: Date.now() }]
  }];
  allChats = {};
  settings = { ...settings, chatApiUrl: '', chatApiKey: '', chatModel: '' };
  processMemoryAfterScenario = () => {};
  await replyToMoment('thread-moment', '知道啦', { targetCommentId: 'thread-comment', targetCharId: 'thread-char' });
  const playerReply = allMoments[0].comments.at(-1);
  const result = {
    replyToCharId: playerReply.replyToCharId,
    replyToName: playerReply.replyToName,
    seenBy: playerReply.seenBy,
    eventText: allChats['thread-char']?.messages?.map(row => row.content).join('\\n') || ''
  };
  characters = oldCharacters;
  allMoments = oldMoments;
  allChats = oldChats;
  settings = oldSettings;
  processMemoryAfterScenario = oldProcess;
  return result;
})()`, context);
assert.equal(momentThreadProbe.replyToCharId, 'thread-char');
assert.equal(momentThreadProbe.replyToName, '林晚');
assert.equal(JSON.stringify(momentThreadProbe.seenBy), JSON.stringify(['thread-char']));
assert.match(momentThreadProbe.eventText, /玩家回复了林晚在自己朋友圈下的评论/);
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
  events: [{ id: 'evt1', type: 'promise', title: '红包约定', detail: '玩家答应林晚回复暗号后发180元红包。', status: 'open', importance: 4, keywords: ['红包', '约定'] }],
  profiles: [],
  summaries: [],
}, '你还记得红包吗？', ['红包'], v2);
assert.equal(keywordRows[0].sourceId, 'evt1');
assert.match(keywordRows[0].reason, /关键词:红包/);
assert.match(keywordRows[0].reason, /类型:promise/);
assert.match(keywordRows[0].reason, /未完成/);
assert.ok(scoreKeywordMemoryText('红包约定｜玩家答应林晚回复暗号后发180元红包。', ['红包'], 4) > 1);
const budgetedPack = composeMemoryPackSections('记忆前言', [
  { title: '高优先级', priority: 1, lines: ['红包约定必须保留'] },
  { title: '低优先级', priority: 90, lines: Array.from({ length: 8 }, (_, i) => `低优先级记忆${i}` + '很长'.repeat(50)) }
], 220);
assert.match(budgetedPack, /高优先级/);
assert.match(budgetedPack, /红包约定必须保留/);
assert.match(budgetedPack, /预算提示：已省略/);
assert.ok(budgetedPack.length < 320);
assert.match(memoryStatusWithBudget(budgetedPack, '记忆AI已调用'), /记忆预算：已省略/);
const wrappedMemoryStatus = memoryStatusWithBudget(budgetedPack, memoryStatusWithBudget(budgetedPack, '记忆AI已调用'));
assert.equal((wrappedMemoryStatus.match(/记忆预算：已省略/g) || []).length, 1);
recordModelCall({
  kind: 'chat',
  scene: 'proactive-chat',
  provider: 'openai',
  model: 'gpt-test',
  charId: 'char-1',
  system: '系统提示：不要保存 sk-secret123456',
  messages: [{ role: 'user', content: '你好' }],
  historyOmitted: 2,
  memoryChars: 12,
  memoryStatus: memoryStatusWithBudget(budgetedPack, '记忆AI已调用；关键词：红包；向量库召回 1 条。'),
  promptBlocks: [{ id: 'memory-pack', priority: 30, chars: 42, preview: '红包约定' }],
  output: '在。'
});
const callLogs = getModelCallLogs();
assert.equal(callLogs[0].scene, 'proactive-chat');
assert.equal(callLogs[0].model, 'gpt-test');
assert.equal(callLogs[0].messageCount, 1);
assert.equal(callLogs[0].messageChars, 2);
assert.equal(callLogs[0].historyOmitted, 2);
assert.equal(callLogs[0].memoryChars, 12);
assert.match(callLogs[0].memoryStatus, /记忆AI已调用/);
assert.match(callLogs[0].memoryStatus, /记忆预算：已省略/);
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
assert.match(diagnosticText, /memoryStatus=记忆AI已调用/);
assert.match(diagnosticText, /messageChars=2/);
assert.match(diagnosticText, /historyOmitted=2/);
assert.match(diagnosticText, /记忆预算：已省略/);
assert.match(diagnosticText, /promptBlocks=memory-pack@30:42/);
assert.match(diagnosticText, /promptBlockDetails=[\s\S]*红包约定/);
assert.doesNotMatch(diagnosticText, /sk-secret123456/);
await renderDiagnosticsScreen();
assert.match(element('diagnostic-list').innerHTML, /proactive-chat/);
assert.match(element('diagnostic-list').innerHTML, /记忆AI已调用/);
assert.match(element('diagnostic-list').innerHTML, /记忆预算：已省略/);
assert.match(element('diagnostic-list').innerHTML, /memory-pack/);
clearModelCallLogs();
assert.equal(getModelCallLogs().length, 0);
vm.runInContext("settings.memoryApiUrl='https://memory.example/v1'; settings.memoryApiKey='sk-memory'; settings.memoryModel=''; settings.memoryApiType='openai';", context);
const skippedMemoryQuery = await generateMemoryQuery(v2, '你还记得红包吗？', []);
assert.equal(skippedMemoryQuery._memoryAiStatus, 'skipped');
assert.match(getModelCallLogs()[0].diagnostic, /缺少模型/);
clearModelCallLogs();
context.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), options });
  return {
    ok: true,
    text: async () => JSON.stringify({ choices: [{ message: { content: '{"query":"红包约定","keywords":["红包","约定"],"focus":"payment"}' } }] })
  };
};
vm.runInContext("settings.memoryApiUrl='https://memory.example/v1'; settings.memoryApiKey='sk-memory'; settings.memoryModel='memory-chat-model'; settings.memoryApiType='openai';", context);
const memoryNetworkStart = fetchCalls.length;
const successfulMemoryQuery = await generateMemoryQuery(v2, '你还记得红包吗？', []);
assert.equal(successfulMemoryQuery._memoryAiStatus, 'ok');
assert.equal(fetchCalls.length, memoryNetworkStart + 1);
assert.match(fetchCalls.at(-1).url, /\/chat\/completions$/);
const memoryNetworkAfterQuery = fetchCalls.length;
await createEmbedding('红包约定');
assert.equal(fetchCalls.length, memoryNetworkAfterQuery, '本地向量化不得额外调用记忆 API');
context.fetch = modelListFetch;
clearModelCallLogs();
vm.runInContext("settings.memoryApiUrl=''; settings.memoryApiKey=''; settings.memoryModel='';", context);
assert.equal(await testMemoryQueryPreset(), false);
assert.equal(getModelCallLogs()[0].scene, 'memory-query-test');
assert.match(getModelCallLogs()[0].diagnostic, /缺少地址、Key、模型/);
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
const proactiveJobA = proactiveJobId('char_timer_test', 'chat');
const proactiveJobB = proactiveJobId('char_timer_test', 'chat');
assert.notEqual(proactiveJobA, proactiveJobB, '连续安排必须使用不同任务 ID，旧取消请求不能误删新任务');
assert.match(proactiveJobA, /^pro_.*_char_timer_test_[a-z0-9]+_[a-z0-9]+$/);
assert.equal(proactiveDefaultScheduleOptions('chat').mode, 'planned');
assert.equal(proactiveDefaultScheduleOptions('moment').mode, 'dice');
assert.equal(proactiveDefaultScheduleOptions('moment').rollChance, 0.05);
const firstDiceRoll = proactiveDicePlan({ intervalMs: 600000, rollChance: 0.05 }, 0, 0);
assert.equal(firstDiceRoll.rolls, 1);
assert.equal(firstDiceRoll.dueAt.getTime(), 600000);
const medianDiceRoll = proactiveDicePlan({ intervalMs: 600000, rollChance: 0.05 }, 0, 0.5);
assert.equal(medianDiceRoll.rolls, 14, '5% 独立抽签的中位命中轮次应为第 14 轮');
assert.equal(medianDiceRoll.dueAt.getTime(), 14 * 600000);
assert.equal(proactiveDicePlan({ rollChance: 1 }, 0, 0.99).rolls, 1);
assert.equal(proactiveDicePlan({ rollChance: 0 }, 0, 0.99).rolls, 432, '零概率和极端尾部必须受最长三天保护');
const diceScheduleProbe = await vm.runInContext(`(async () => {
  const savedSettings = settings;
  const savedChats = allChats;
  settings = { ...settings, proactiveEnabled: true, cloudTimerEnabled: false, deviceId: 'dice-device' };
  allChats = { dice_char: { messages: [{ role: 'user', content: '测试随机任务', time: Date.now() }] } };
  const startedAt = Date.now();
  await scheduleDiceProactive('dice_char', 'chat');
  const job = { ...allChats.dice_char.pendingProactiveJob };
  const legacyZeroChanceResult = rollProactiveDice('chat', { mode: 'dice', rollChance: 0 });
  const precomputedZeroChanceResult = rollProactiveDice('chat', { mode: 'dice', rollChance: 0, dicePrecomputed: true });
  settings = savedSettings;
  allChats = savedChats;
  return { job, startedAt, legacyZeroChanceResult, precomputedZeroChanceResult };
})()`, context);
assert.equal(diceScheduleProbe.job.mode, 'dice');
assert.equal(diceScheduleProbe.job.dicePrecomputed, true);
assert.ok(diceScheduleProbe.job.diceRolls >= 1 && diceScheduleProbe.job.diceRolls <= 432);
assert.equal(diceScheduleProbe.job.rollChance, 0.05);
assert.equal(diceScheduleProbe.job.diceIntervalMs, 600000);
assert.ok(Math.abs(Date.parse(diceScheduleProbe.job.dueAt) - diceScheduleProbe.startedAt - diceScheduleProbe.job.diceRolls * 600000) < 2000);
assert.equal(diceScheduleProbe.legacyZeroChanceResult, false, '旧骰子任务仍需在到点时兼容抽签');
assert.equal(diceScheduleProbe.precomputedZeroChanceResult, true, '预抽任务到点后不得再次抽签');
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
const proactiveTrigger = buildProactiveTriggerMessage({ name: '林晚' }, proactiveChat, proactiveNow);
assert.match(proactiveTrigger, /内部主动触发/);
assert.match(proactiveTrigger, /这不是玩家发来的聊天消息/);
assert.match(proactiveTrigger, /主动给玩家发一条微信私聊/);
assert.equal(normalizeMemoryProcessedCursor(12, 5), 0, '聊天被清空或缩短后，旧记忆游标必须复位');
assert.equal(normalizeMemoryProcessedCursor(3, 5), 3);
assert.deepEqual(memoryRelevantMessages([
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '玩家消息' },
  { role: 'assistant', content: '角色消息' },
  { role: 'user', content: '朋友圈隐藏事件', hidden: true }
]).map(row => row.content), ['玩家消息', '角色消息', '朋友圈隐藏事件']);
const importedSettings = resetImportedDeviceBinding({
  cloudTimerEnabled: true,
  timerEndpoint: 'https://timer.example',
  pushPublicKey: 'BPublic',
  pushSubscription: { endpoint: 'https://old-device.example' },
  deviceId: 'old-device',
  cloudTimerLastChatTrace: 'old trace'
});
assert.equal(importedSettings.cloudTimerEnabled, false);
assert.equal(importedSettings.deviceId, '');
assert.equal(importedSettings.pushSubscription, null);
assert.equal(importedSettings.timerEndpoint, 'https://timer.example');
assert.equal(importedSettings.pushPublicKey, 'BPublic');
assert.match(importedSettings.cloudTimerLastStatus, /重新绑定/);
const importedChats = clearImportedCloudJobs({
  c1: {
    messages: [],
    pendingProactiveJob: { jobId: 'old-chat' },
    pendingMomentJob: { jobId: 'old-moment' },
    cloudScheduleSyncedAt: 1,
    cloudMomentScheduleSyncedAt: 2
  }
});
assert.equal('pendingProactiveJob' in importedChats.c1, false);
assert.equal('pendingMomentJob' in importedChats.c1, false);
assert.equal('cloudScheduleSyncedAt' in importedChats.c1, false);
assert.equal('cloudMomentScheduleSyncedAt' in importedChats.c1, false);
vm.runInContext("currentCharId='current_chat'; allChats={ old_chat:{ messages:[{ role:'user', content:'旧会话', time:1 }] }, current_chat:{ messages:[{ role:'user', content:'当前会话', time:2 }] } };", context);
assert.equal(cloudTimerTargetCharId([{ char: { id: 'old_chat' }, chat: context.allChats?.old_chat }, { char: { id: 'current_chat' }, chat: context.allChats?.current_chat }]), 'current_chat');
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
