import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('tavern-app/index.html', 'utf8');
const engine = readFileSync('android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java', 'utf8');
const plugin = readFileSync('android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java', 'utf8');
const executionStore = readFileSync('android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java', 'utf8');
const executionDao = readFileSync('android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java', 'utf8');
const executionDatabase = readFileSync('android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java', 'utf8');
const chatTurnEntity = readFileSync('android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java', 'utf8');
const executionService = readFileSync('android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java', 'utf8');
const notificationFactory = readFileSync('android/app/src/main/java/com/siyi/al/execution/AlNotificationFactory.java', 'utf8');
const bridgeClient = readFileSync('android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java', 'utf8');
const worker = readFileSync('tavern-app/sw-v11.js', 'utf8');
const corePreset = readFileSync('tavern-app/lib/yuqi-core-preset.js', 'utf8');

test('v3 moment queue projects player authors and replies from the canonical target thread', () => {
  const queue = html.slice(
    html.indexOf('async function queueYuqiMomentTurn'),
    html.indexOf('async function queueAndroidUserReply', html.indexOf('async function queueYuqiMomentTurn'))
  );
  assert.match(queue, /authorType === 'player'[\s\S]{0,80}['"]user['"]/);
  assert.match(queue, /item\.charId === 'player'[\s\S]{0,80}['"]user['"]/);
  assert.match(queue, /matchingComments\s*=\s*playerCommentId/);
  assert.match(queue, /matchingComments\.length !== 1/);
  assert.match(queue, /structuredClone\(matchingComments\[0\]\)/);
  const canonicalComment = queue.slice(
    queue.indexOf('const canonicalComment'),
    queue.indexOf('const input')
  );
  assert.doesNotMatch(canonicalComment, /replyToCommentId:\s*context\.replyToCommentId/);
  assert.match(queue, /likes:\s*\[\.\.\.new Set\(\(moment\.likes \|\| \[\]\)\.map\(value => value === 'player' \? 'user'/);
});

test('every phone-side Yuqi scene composes the synchronized core preset after the combined RP foundation', () => {
  assert.match(html, /<script src="\.\/lib\/yuqi-core-preset\.js"><\/script>/);
  assert.match(corePreset, /globalThis\.AL_YUQI_CORE_PROMPT/);
  const builder = html.slice(html.indexOf('function buildCharPrompt'), html.indexOf('function isGeneratedCharacterPrompt'));
  assert.match(builder, /char\.id\s*===\s*'yuqi'/);
  assert.match(builder, /globalThis\.AL_YUQI_CORE_PROMPT/);
  assert.ok(builder.indexOf('preset.prompt') < builder.indexOf('globalThis.AL_YUQI_CORE_PROMPT'));
});

test('Yuqi controls expose secure AUTO, LAN, and CLOUD bridge settings', () => {
  for (const id of [
    'set-yuqi-enabled', 'set-yuqi-mode', 'set-yuqi-lan-url', 'set-yuqi-cloud-url',
    'set-yuqi-pairing-secret', 'set-yuqi-device-token', 'set-yuqi-encryption-key',
    'yuqi-runtime-status'
  ]) assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  assert.match(html, /value="AUTO"[\s\S]*value="LAN"[\s\S]*value="CLOUD"/);
  assert.match(plugin, /void\s+saveBridgeConfig\(PluginCall call\)/);
  assert.match(plugin, /void\s+loadBridgeConfig\(PluginCall call\)/);
  assert.match(plugin, /void\s+yuqiBridgeStatus\(PluginCall call\)/);
  assert.match(html, /set-yuqi-pairing-code/);
  assert.match(html, /importYuqiPairingCode/);
});

test('Android proactive scheduling is exposed through a closed native authority projection', () => {
  for (const method of [
    'configureAutomaticSchedule',
    'getAutomaticScheduleStatus',
    'migrateLegacyAutomaticScheduleCandidate'
  ]) assert.match(plugin, new RegExp(`void\\s+${method}\\(PluginCall call\\)`));

  const projection = plugin.slice(
    plugin.indexOf('private JSObject automaticScheduleResult('),
    plugin.indexOf('private static JSObject bridgeConfigResult(')
  );
  for (const key of [
    'characterId', 'kind', 'owner', 'epochFingerprint', 'generation', 'state',
    'jobId', 'dueAt', 'cloudSyncState', 'lastChangeSource', 'lastChangedAt',
    'lastDeliveryStage', 'lastDeliveryAt'
  ]) assert.match(projection, new RegExp(`result\\.put\\("${key}"`));
  for (const secret of ['authorityEpoch', 'semanticJson', 'payloadJson', 'leaseId']) {
    assert.doesNotMatch(projection, new RegExp(`result\\.put\\("${secret}"`));
  }
});

test('native schedule recovery exposes only a closed delivery-stage projection', () => {
  assert.match(html, /lastDeliveryStage/);
  assert.match(html, /push_replay_wake/);
  assert.match(html, /remote_paused_requeued/);
  assert.match(html, /reconcileAutomaticSchedules/);
});

test('manual cloud timer text is explicitly transport-only', () => {
  assert.match(html, /传输到达/);
  assert.match(html, /不代表主动消息已生成/);
});

test('native schedule diagnostics do not expose opaque job identity fields', () => {
  const start = html.indexOf('function cloudTimerDiagnosticText()');
  assert.ok(start >= 0);
  const diagnostic = html.slice(start, start + 2600);
  assert.doesNotMatch(diagnostic, /任务代数|status\.jobId|status\.generation|status\.epochFingerprint/);
  assert.match(diagnostic, /当前计划|云同步|最近真实变更/);
});

test('native foreground, input, and terminal paths cannot manufacture a Web schedule', () => {
  const refresh = html.slice(
    html.indexOf('async function refreshNativeAutomaticScheduleStatuses'),
    html.indexOf('function proactiveSyncKey')
  );
  assert.match(refresh, /getAutomaticScheduleStatus/);
  assert.match(refresh, /status\.state === 'unclaimed'/);
  assert.doesNotMatch(refresh, /\/schedule/);

  const apply = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  assert.doesNotMatch(apply, /pendingProactiveJob|pendingMomentJob|scheduleCloudProactive|ensureCloudProactiveKindScheduled|saveProactiveSnapshot|rescheduleAfterNativeDirectReply/);

  const direct = html.slice(
    html.indexOf('async function finishStagedBatch'),
    html.indexOf('function voiceButtonEl')
  );
  assert.match(direct, /if\s*\(!isNativeApp\(\)\)\s*reanchorProactiveAfterUserCommit/);
  assert.doesNotMatch(direct, /if\s*\(isNativeApp\(\)\)\s*reanchorProactiveAfterUserCommit/);

  for (const name of ['checkProactiveMessages', 'ensureLocalProactiveScheduled', 'catchUpDueCloudProactive']) {
    const start = html.indexOf(`async function ${name}`);
    const end = html.indexOf('\n}', start) + 2;
    const body = html.slice(start, end);
    assert.match(body, /isNativeApp\(\)[\s\S]*refreshNativeAutomaticScheduleStatuses/);
  }
});

test('manual cloud timer tests are isolated from the production proactive schedule', () => {
  const manualTest = html.slice(
    html.indexOf('async function testCloudTimerPush'),
    html.indexOf('async function cancelCloudProactive')
  );
  assert.match(manualTest, /chat\.cloudTimerTestJob\s*=/);
  assert.doesNotMatch(manualTest, /chat\.pendingProactiveJob\s*=/);
  assert.match(manualTest, /test:\s*true/);

  const foreground = html.slice(
    html.indexOf('async function completeCloudTimerTestPush'),
    html.indexOf('async function handleForegroundDueProactiveRequest')
  );
  assert.match(foreground, /cloudTimerTestJob[\s\S]*data\.test[\s\S]*completeCloudTimerTestPush/);

  const pushListener = html.slice(
    html.indexOf("PushNotifications.addListener('pushNotificationReceived'"),
    html.indexOf("PushNotifications.addListener('pushNotificationActionPerformed'")
  );
  assert.match(pushListener, /data\.test[\s\S]*completeCloudTimerTestPush/);

  const nativePush = worker.slice(
    worker.indexOf('async function handleProactivePush'),
    worker.indexOf('if \(!automaticTasksEnabled', worker.indexOf('async function handleProactivePush'))
  );
  assert.match(nativePush, /type:\s*'AL_NATIVE_PROACTIVE_DUE'[\s\S]*test:\s*!!payload\.test/);
});

test('Yuqi Bridge submission does not require ordinary chat or memory AI settings', () => {
  const sync = html.slice(
    html.indexOf('async function saveNativeExecutionApiConfigs'),
    html.indexOf('function nativeMemoryCandidateText')
  );
  assert.doesNotMatch(sync, /接口配置不完整/);
  assert.doesNotMatch(sync, /当前原生后台执行仅支持 OpenAI 兼容接口/);
  assert.match(sync, /config\.apiType === 'openai'/);
  assert.match(sync, /await plugin\.saveApiConfig\(config\)/);
  assert.match(sync, /await plugin\.removeApiConfig\(\{ configId: config\.configId \}\)/);
  assert.match(plugin, /void\s+removeApiConfig\(PluginCall call\)/);
  assert.match(plugin, /secrets\.removeApiConfig\(configId\)/);
});

test('memory evidence is 200 raw messages while chat generation is capped at 30', () => {
  assert.match(engine, /source\.length\(\)\s*-\s*30/);
  assert.match(html, /const NORMAL_RAW_CONTEXT_LIMIT = 200;/);
  assert.match(worker, /const NORMAL_RAW_CONTEXT_LIMIT = 200;/);
  assert.match(html, /const memoryRecent = sceneMessagesForAI\(chat, NORMAL_RAW_CONTEXT_LIMIT\)/);
  assert.match(html, /const chatRecent = sceneMessagesForAI\(chat, 30\)/);
  assert.match(html, /const messages = sceneMessagesForAI\(chat, 30,/);
});

test('private proactive chat uses the approved higher consideration cadence on foreground and worker paths', () => {
  for (const source of [html, worker]) {
    assert.match(source, /const PROACTIVE_DICE_INTERVAL_MS = 10 \* 60 \* 1000;/);
    assert.match(source, /const PROACTIVE_DICE_CHANCE = 0\.15;/);
    assert.match(source, /const PROACTIVE_DICE_MAX_ROLLS = 144;/);
    assert.match(source, /const MOMENT_DICE_INTERVAL_MS = 2 \* 60 \* 60 \* 1000;/);
    assert.match(source, /const MOMENT_DICE_CHANCE = 0\.20;/);
    assert.match(source, /const MOMENT_DICE_MAX_ROLLS = 12;/);
  }
});

test('Yuqi begins at first acquaintance without a Xu Mi memory migration', () => {
  assert.match(html, /YUQI_FIRST_ACQUAINTANCE/);
  assert.match(html, /双方的手机意外建立了与另一个平行世界的联系/);
  assert.match(html, /profileVersion:\s*'1\.1\.0'/);
  assert.match(html, /24岁，生活在另一个平行世界的现代临江城市/);
  assert.match(html, /目前双方处于初识阶段/);
  assert.match(html, /唯一的爱人和心中最重要的人/);
  assert.match(html, /char\.profileVersion\s*!==\s*YUQI_FIRST_PROFILE\.profileVersion/);
  assert.doesNotMatch(html, /神奇手机/);
  assert.doesNotMatch(html, /迁移许弥|导入许弥|xu\s*mi.*memory/i);
});

test('manual annotations retain evidence and preset version for the maintenance workbench', () => {
  for (const id of ['yuqi-annotation-turn-id', 'yuqi-annotation-message-id', 'yuqi-annotation-correction', 'yuqi-annotation-behavior']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(html, /function\s+submitYuqiAnnotation\(/);
  assert.match(plugin, /void\s+saveYuqiAnnotation\(PluginCall call\)/);
  assert.match(plugin, /presetVersion/);
});

test('native direct replies submit a canonical attributed user message', () => {
  assert.match(html, /function\s+batchMessageForAI\(charId,\s*message\)/);
  assert.match(html, /messageId:\s*String\(message\?\.id\s*\|\|\s*''\)/);
  assert.match(html, /speakerId:\s*'user'[\s\S]*?speakerType:\s*'user'/);
  assert.match(html, /content:\s*messageContentForAI\(message\)/, '桥接原话库必须持久化引用归属和用户本次正文');
  assert.match(html, /sentAt:\s*Math\.max\(1,\s*Number\(message\?\.time\)\s*\|\|\s*Date\.now\(\)\)/);
  assert.match(html, /message:\s*wireSourceMessage/);
});

test('chat composer stages compressed user images and forwards them as canonical attachments', () => {
  assert.match(html, /id="chat-image-input"[^>]+accept="image\/\*"/);
  assert.match(html, /onclick="chooseChatImage\(\)"/);
  assert.match(html, />图片<\/button>/);
  assert.match(html, /async function\s+compressChatImage\(/);
  assert.match(html, /async function\s+handleChatImage\(/);
  assert.match(html, /type:\s*'image'/);
  assert.match(html, /imageData:/);
  assert.match(html, /class="chat-image-message"/);
  assert.match(html, /const\s+attachments\s*=\s*messageAttachmentsForAI\(message\)/);
  assert.match(html, /\.\.\.\(attachments\.length\s*\?\s*\{\s*attachments\s*\}\s*:\s*\{\s*\}\)/);
  assert.match(html, /const\s+wireBatchMessages\s*=\s*task\.options\.batchMessages\?\.length/);
  assert.match(html, /const\s+batchAttachments\s*=\s*committed\.messages\.flatMap\(messageAttachmentsForAI\)/);
});

test('native direct replies preserve the complete current batch time boundary', () => {
  const builder = html.slice(
    html.indexOf('function buildAndroidUserReplyTask'),
    html.indexOf('async function dumpCharacterMemoryForRunner')
  );
  assert.match(builder, /batchMessageIds/);
  assert.match(builder, /batchStartedAt/);
  assert.match(builder, /batchCommittedAt/);
  const commit = html.slice(
    html.indexOf('async function finishStagedBatch'),
    html.indexOf('async function sendInput')
  );
  assert.match(commit, /batchStartedAt:\s*Number\(committed\.messages\?\.\[0\]\?\.time\)/);
  assert.match(commit, /batchCommittedAt:\s*committed\.committedAt/);
});

test('native snapshots expose the current Yuqi dynamic scene separately from fixed RP', () => {
  assert.match(html, /function\s+buildYuqiDynamicScene\(char,\s*chat\)/);
  const builder = html.slice(
    html.indexOf('function buildYuqiDynamicScene'),
    html.indexOf('async function buildNativeExecutionSnapshot')
  );
  assert.match(builder, /relationshipStage/);
  assert.match(builder, /conversationExtraPrompt/);
  assert.match(builder, /stageCatalog/);
  assert.match(builder, /phaseCatalog/);
  assert.match(builder, /currentPhase/);
  assert.match(builder, /rolePlanCatalog:\s*rolePlanCatalogForPrompt\(char\.id\)/);
  assert.match(builder, /roleScheduleContext:\s*roleScheduleContextForPrompt\(char\.id\)/);
  assert.match(builder, /momentContext:\s*buildMomentChatContext\(char\.id\)/);
  const snapshot = html.slice(
    html.indexOf('async function buildNativeExecutionSnapshot'),
    html.indexOf('function nativeProactiveSnapshotIds')
  );
  assert.match(snapshot, /scene:\s*buildYuqiDynamicScene\(char,\s*chat\)/);
});

test('active role plans always persist a native execution snapshot before optional cloud scheduling', () => {
  const sync = html.slice(
    html.indexOf('async function syncRolePlanCloudJobs'),
    html.indexOf('async function patchRolePlanCloudState')
  );
  const snapshotAt = sync.indexOf('saveNativeRolePlanSnapshot');
  const cloudGateAt = sync.indexOf('cloudTimerTransportReady');
  assert.ok(snapshotAt >= 0, 'local role-plan snapshot must be written');
  assert.ok(cloudGateAt >= 0, 'cloud transport gate must remain explicit');
  assert.ok(snapshotAt < cloudGateAt, 'local durability must not depend on cloud transport readiness');
});

test('phone role-plan landing recognizes native advancement and never skips a second recurrence', () => {
  const completion = html.slice(
    html.indexOf('async function completeRolePlanFromNativeResult'),
    html.indexOf('function nativeReplyFailureMessage')
  );
  assert.match(completion, /Number\(trigger\.scheduledFor\)/);
  assert.match(completion, /Number\(plan\.lastScheduledFor\)\s*>=\s*scheduledFor/);
  assert.match(completion, /Number\(plan\.nextRunAt\)\s*>\s*scheduledFor/);
  assert.doesNotMatch(completion, /nextRunAt\)\s*>\s*scheduledFor\s*&&\s*plan\.cloudJobId/);
});

test('native relationship writeback applies base and phase actions atomically', () => {
  const source = html.slice(
    html.indexOf('function applyNativeRelationshipStagePart'),
    html.indexOf('function applyNativeMomentActionPart')
  );
  assert.match(source, /action\.baseAction/);
  assert.match(source, /action\.phaseAction/);
  assert.match(source, /config\.currentPhase/);
  assert.match(source, /action\.expectedSceneRevision/);
  assert.match(source, /config\.revision\s*!==\s*action\.expectedSceneRevision/);
  assert.match(source, /config\.revision\s*\+=\s*1/);
  assert.match(html, /熟悉 · 闹矛盾期/);
});

test('native manual resend creates a fresh canonical message root without claiming a forbidden retry', () => {
  const retry = html.slice(html.indexOf('async function retryFailedReply'), html.indexOf('function showReplyFailureReason'));
  assert.match(retry, /const\s+task\s*=\s*buildAndroidUserReplyTask/);
  assert.match(retry, /const\s+snapshot\s*=\s*await\s+buildNativeExecutionSnapshot\(charId,\s*task\)/);
  assert.match(retry, /buildNativeManualResendBatch\(/);
  assert.match(retry, /oldPending\?\.nativeSourceMessageId\s*\|\|\s*userMessageId/);
  assert.match(retry, /oldPending\?\.nativeMessageIdAliases\s*\|\|\s*\{\}/);
  assert.match(retry, /Object\.values\(resendBatch\.messageIdAliases\)/);
  assert.match(retry, /syncYuqiVisibleHistory\(charId,\s*resendHistoryExclusions\)/);
  assert.match(retry, /nativeSourceMessageId:\s*resendBatch\.sourceMessageId/);
  assert.match(retry, /plugin\.submitTurn\(\{[\s\S]*?turnId[\s\S]*?sourceMessageId:\s*resendBatch\.sourceMessageId[\s\S]*?inputJson:[\s\S]*?message:\s*resendBatch\.sourceMessage[\s\S]*?snapshotJson:\s*JSON\.stringify\(snapshot\)/);
  assert.doesNotMatch(retry, /retryOfTurnId|canonicalMessageId/);
  assert.doesNotMatch(retry, /plugin\.retryTurn/);
});

test('manual resend reidentifies the complete batch under one fresh deterministic root', () => {
  const helpersStart = html.indexOf('function nativeTurnIdForMessage');
  const helpersEnd = html.indexOf('async function saveNativeExecutionApiConfigs');
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
  const helpers = new Function(
    `${html.slice(helpersStart, helpersEnd)}
     return { nativeTurnIdForMessage, buildNativeManualResendBatch };`
  )();
  const resend = helpers.buildNativeManualResendBatch([
    { messageId: 'msg_phone_1', content: '第一泡', sentAt: 10, attachments: [] },
    { messageId: 'msg_phone_2', content: '第二泡', sentAt: 11, attachments: [{ kind: 'image', checksum: 'a' }] }
  ], 'msg_phone_2', 1000, 'fixed_token');
  assert.equal(resend.batchId, 'batch_resend_fixed_token');
  assert.equal(resend.messages.length, 2);
  assert.deepEqual(resend.messages.map(row => row.content), ['第一泡', '第二泡']);
  assert.deepEqual(resend.messages.map(row => row.sentAt), [1000, 1001]);
  assert.equal(new Set(resend.messageIds).size, 2);
  assert.ok(resend.messageIds.every(id => id.startsWith('msg_resend_')));
  assert.ok(!resend.messageIds.includes('msg_phone_1'));
  assert.ok(!resend.messageIds.includes('msg_phone_2'));
  assert.equal(resend.sourceMessage.messageId, resend.sourceMessageId);
  assert.equal(resend.sourceMessage.content, '第二泡');
  assert.equal(resend.messages[1].attachments[0].checksum, 'a');
  assert.equal(resend.messages[1].attachments[0].messageId, resend.sourceMessageId);
  assert.equal(resend.messageIdAliases[resend.sourceMessageId], 'msg_phone_2');
  assert.equal(resend.messageIdForOriginal.msg_phone_2, resend.sourceMessageId);
  assert.equal(helpers.nativeTurnIdForMessage(resend.sourceMessageId), `turn_${resend.sourceMessageId}`);

  const secondResend = helpers.buildNativeManualResendBatch(
    resend.messages,
    resend.sourceMessageId,
    2000,
    'second_token',
    resend.messageIdAliases
  );
  assert.equal(secondResend.messages.length, 2);
  assert.equal(secondResend.messageIdAliases[secondResend.sourceMessageId], 'msg_phone_2');
  assert.equal(secondResend.messageIdForOriginal.msg_phone_2, secondResend.sourceMessageId);
  assert.ok(secondResend.messageIds.every(id => !resend.messageIds.includes(id)));
});

test('Room persists fresh retry turns and only deduplicates an exact turn id', () => {
  assert.doesNotMatch(chatTurnEntity, /@Index\(value = \{"sourceMessageId"\}, unique = true\)/);
  assert.match(chatTurnEntity, /@Index\(value = \{"sourceMessageId"\}\)/);
  assert.match(executionDatabase, /version\s*=\s*AlExecutionDatabase\.SCHEMA_VERSION/);
  assert.match(executionDatabase, /SCHEMA_VERSION\s*=\s*16/);
  assert.match(executionDatabase, /new Migration\(8,\s*9\)/);
  assert.match(executionDatabase, /MIGRATION_10_11/);
  assert.match(executionDatabase, /MIGRATION_11_12/);
  assert.match(executionDatabase, /MIGRATION_12_13/);
  assert.match(executionDatabase, /MIGRATION_13_14/);
  assert.match(executionDatabase, /MIGRATION_14_15/);
  assert.match(executionDatabase, /MIGRATION_15_16/);
  assert.match(executionDatabase, /MIGRATION_9_10,\s*MIGRATION_10_11,\s*MIGRATION_11_12,\s*MIGRATION_12_13,[\s\S]*MIGRATION_13_14/);
  assert.match(executionDatabase, /DROP INDEX IF EXISTS `index_chat_turns_sourceMessageId`/);
  assert.match(executionDatabase, /CREATE INDEX IF NOT EXISTS `index_chat_turns_sourceMessageId`/);
  const submit = executionStore.slice(
    executionStore.indexOf('public ChatTurnEntity submitTurn'),
    executionStore.indexOf('public ExecutionAttemptEntity startRetry')
  );
  assert.match(submit, /dao\.turn\(submission\.turnId\)/);
  assert.doesNotMatch(submit, /dao\.turnBySourceMessage\(submission\.sourceMessageId\)/);
});

test('native manual resend is accepted only when Room returns its fresh requested turn id', () => {
  const retry = html.slice(html.indexOf('async function retryFailedReply'), html.indexOf('function showReplyFailureReason'));
  assert.match(retry, /String\(result\?\.turnId\s*\|\|\s*''\)\s*!==\s*turnId/);
  assert.match(retry, /throw new Error\(/);
  assert.ok(
    retry.indexOf("String(result?.turnId || '') !== turnId") < retry.indexOf('nativeAcceptedAt'),
    'a mismatched native turn must be rejected before the retry is marked accepted'
  );
});

test('native manual resend maps the fresh wire source back to the original visible bubble', () => {
  const apply = html.slice(
    html.indexOf('function nativeResultDisplaySourceMessageId'),
    html.indexOf('async function applyNativeExecutionTurnUnlocked')
  );
  const unlocked = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  assert.match(apply, /pending\?\.nativeSourceMessageId\s*===\s*sourceMessageId/);
  assert.match(apply, /return\s+String\(pending\.userMessageId\)/);
  assert.match(unlocked, /nativeResultDisplaySourceMessageId\(chat,\s*result\)/);
  assert.match(unlocked, /messageById\(chat,\s*displaySourceMessageId\)/);
});

test('Android chat clear is native-first and does not use the desktop localStorage path', () => {
  const clear = html.slice(html.indexOf('async function getYuqiClearCursorForClear'), html.indexOf('async function deleteCurrentRole'));
  assert.match(clear, /getConversationCursor/);
  assert.match(clear, /createConversationClear/);
  assert.ok(clear.indexOf('getConversationCursor') < clear.indexOf('createConversationClear'));
  assert.ok(clear.indexOf('createConversationClear') < clear.indexOf('DB.set'));
  assert.match(clear, /expectedCursorChecksum/);
  assert.match(clear, /catch[\s\S]{0,500}(?:失败|pending|等待)/i);
  assert.match(clear, /isNativeApp\(\)/);
});

test('Android role deletion is backup-first, remains visible while pending, and only cleans the browser after native applied', () => {
  const deletion = html.slice(
    html.indexOf('async function roleDeleteControlStatus'),
    html.indexOf('function openCurrentProfile')
  );
  assert.match(plugin, /void\s+createRoleDelete\(PluginCall call\)/);
  assert.match(plugin, /void\s+getRoleDeleteStatus\(PluginCall call\)/);

  assert.match(deletion, /requestVerifiedYuqiBackup/);
  assert.match(deletion, /createRoleDelete/);
  assert.match(deletion, /getRoleDeleteStatus/);
  const nativeFirstDelete = deletion.slice(
    deletion.indexOf('async function nativeFirstRoleDelete'),
    deletion.indexOf('async function enforceNativeRoleDeletionTombstones')
  );
  assert.ok(nativeFirstDelete.indexOf('requestVerifiedYuqiBackup') < nativeFirstDelete.indexOf('createRoleDelete'));
  assert.match(deletion, /roleDeletePending/);
  const deleteCurrentRole = deletion.slice(
    deletion.indexOf('async function deleteCurrentRole'),
    deletion.indexOf('function openCurrentProfile')
  );
  assert.match(deleteCurrentRole, /control\.state\s*===\s*['"]applied['"]/);
  const appliedGate = deleteCurrentRole.indexOf("control.state === 'applied'");
  assert.ok(
    appliedGate < deleteCurrentRole.indexOf('finalizeBrowserRoleDeletion', appliedGate),
    'the browser role deletion must be gated by native applied state'
  );
  assert.match(deletion, /restorePendingRoleDeletions/);
});

test('a native role-deletion tombstone blocks late UI results, new work, mirrors, and backup resurrection', () => {
  assert.match(html, /function\s+roleDeletionFrozen\(charId\)/);

  const apply = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  assert.match(apply, /roleDeletionFrozen\(charId\)/);
  assert.ok(
    apply.indexOf('roleDeletionFrozen(charId)') < apply.indexOf('nativeTerminalDispositionLanding'),
    'role deletion must suppress a late native result before any chat, action, moment, or plan landing'
  );

  for (const [start, end] of [
    ['async function syncYuqiVisibleHistory', 'async function queueAndroidProactiveTurn'],
    ['async function queueAndroidProactiveTurn', 'async function queueYuqiMomentTurn'],
    ['async function queueYuqiMomentTurn', 'async function queueAndroidUserReply'],
    ['async function queueAndroidUserReply', 'async function mirrorAppStateNow']
  ]) {
    const source = html.slice(html.indexOf(start), html.indexOf(end));
    assert.match(source, /assertRoleDeletionAcceptsWork\(charId\)|roleDeletionFrozen\(charId\)/, `${start} must honor the retained deletion tombstone`);
  }

  const mirror = html.slice(
    html.indexOf('async function restoreAppStateFromMirror'),
    html.indexOf('const RELATIONSHIP_STAGE_DEFS')
  );
  assert.match(mirror, /assertNativeRoleDeletionAllowsStateReplacement/);

  const enforcement = html.slice(
    html.indexOf('async function enforceNativeRoleDeletionTombstones'),
    html.indexOf('async function finalizeBrowserRoleDeletion')
  );
  assert.match(enforcement, /roleDeletePending\s*=\s*\{[\s\S]{0,300}state:\s*['"]unknown['"]/);
  const failureBranch = enforcement.slice(enforcement.indexOf('catch (error)'), enforcement.indexOf("if (control.state === 'none')"));
  assert.doesNotMatch(failureBranch, /MemoryDB\.clearChar|removeCharacterMomentTraces|getRolePlanRepository\(\)\.replace/);

  const restore = html.slice(
    html.indexOf('async function restorePendingRoleDeletions'),
    html.indexOf('async function deleteCurrentRole')
  );
  const restoreFailure = restore.slice(restore.indexOf('catch (error)'), restore.indexOf("if (control.state === 'none')"));
  assert.match(restoreFailure, /roleDeletePending\s*=\s*\{[\s\S]{0,220}state:\s*['"]unknown['"]/);
  assert.match(restore, /control\.state === 'none'[\s\S]{0,180}delete\s+char\.roleDeletePending/);

  for (const [start, end] of [
    ['async function importChatBackup', 'async function importBackup'],
    ['async function importBackup', 'let mirrorTimer']
  ]) {
    const source = html.slice(html.indexOf(start), html.indexOf(end));
    assert.match(source, /assertNativeRoleDeletionAllowsStateReplacement/, `${start} must not resurrect a native-deleted role`);
  }

  const stagedWrite = html.slice(
    html.indexOf('function stagePlayerMessage'),
    html.indexOf('function commitStagedBatch')
  );
  assert.match(stagedWrite, /assertRoleDeletionAcceptsChat\(chat\)/);
  const pendingWrite = html.slice(
    html.indexOf('function createPendingUserMessage'),
    html.indexOf('async function retryFailedReply')
  );
  assert.match(pendingWrite, /assertRoleDeletionAcceptsChat\(chat\)/);
  const retry = html.slice(
    html.indexOf('async function retryFailedReply'),
    html.indexOf('function showReplyFailureReason')
  );
  assert.match(retry, /assertRoleDeletionAcceptsWork\(charId\)/);
  const retryFinalGate = retry.lastIndexOf('await assertNativeRoleDeletionAcceptsWork(charId');
  assert.ok(
    retryFinalGate >= 0 && retryFinalGate < retry.indexOf('plugin.submitTurn'),
    'retry must recheck native deletion authority immediately before submission'
  );

  for (const [start, end] of [
    ['async function queueAndroidProactiveTurn', 'async function queueYuqiMomentTurn'],
    ['async function queueYuqiMomentTurn', 'async function queueAndroidUserReply'],
    ['async function queueAndroidUserReply', 'async function mirrorAppStateNow']
  ]) {
    const source = html.slice(html.indexOf(start), html.indexOf(end));
    const finalGate = source.lastIndexOf('await assertNativeRoleDeletionAcceptsWork(charId');
    const submit = source.indexOf('plugin.submitTurn');
    assert.ok(finalGate >= 0 && finalGate < submit, `${start} must recheck Room authority before native submit`);
  }

  const payment = html.slice(
    html.indexOf('async function submitPayMessage'),
    html.indexOf('function uid')
  );
  assert.ok(
    payment.indexOf('await assertNativeRoleDeletionAcceptsWork') >= 0
      && payment.indexOf('await assertNativeRoleDeletionAcceptsWork') < payment.indexOf('stagePlayerMessage'),
    'payment must verify the native tombstone before creating the message or changing the wallet'
  );
  assert.ok(
    payment.indexOf('stagePlayerMessage') < payment.indexOf('saveWalletBalance'),
    'wallet balance may change only after the role-deletion-aware message write succeeds'
  );
});

test('role deletion suppresses stale native UI without using the ordinary UI-applied receipt', () => {
  const drain = html.slice(
    html.indexOf('async function drainNativeUiInbox'),
    html.indexOf('async function replayRecentNativeCompletedTurns')
  );
  const suppression = html.slice(
    html.indexOf('async function nativeRoleDeletionResultDisposition'),
    html.indexOf('async function drainNativeUiInbox')
  );
  assert.match(drain, /suppressNativeRoleDeletedResult/);
  assert.doesNotMatch(drain, /roleDeletionFrozen[\s\S]{0,500}acknowledgeNativeUiAppliedOnce/);
  assert.match(suppression, /getRoleDeleteStatus/);
  assert.match(suppression, /!plugin\?\.suppressRoleDeletedTurn[\s\S]{0,80}return null/);
  assert.ok(
    suppression.indexOf('suppressRoleDeletedTurn') < suppression.indexOf('nativeUiAcknowledgedTurnIds.add'),
    'native suppression must commit before the Web inbox marks a turn handled'
  );
  const replay = html.slice(
    html.indexOf('async function replayRecentNativeCompletedTurns'),
    html.indexOf('function nativeRetryLineageTurnIds')
  );
  assert.match(replay, /suppressNativeRoleDeletedResult/);
});

test('native result suppression is durable for an applied deleted role and defers without proof', async () => {
  const source = html.slice(
    html.indexOf('async function nativeRoleDeletionResultDisposition'),
    html.indexOf('async function drainNativeUiInbox')
  );
  const build = new Function('state', `
    const nativeReplyQueuedIds = new Set(state.queued || []);
    const nativeUiAcknowledgedTurnIds = new Set();
    function roleDeletionFrozen(characterId){ return state.localFrozen === characterId; }
    async function roleDeleteControlStatus(characterId, plugin){ return plugin.getRoleDeleteStatus({ characterId }); }
    async function nativeBridgeCall(promise){ return promise; }
    ${source}
    return { suppressNativeRoleDeletedResult, nativeReplyQueuedIds, nativeUiAcknowledgedTurnIds };
  `);

  const appliedState = { queued: ['late-turn'], localFrozen: '' };
  const applied = build(appliedState);
  const suppressCalls = [];
  const appliedPlugin = {
    async getRoleDeleteStatus(){ return { state: 'applied' }; },
    async suppressRoleDeletedTurn(input){ suppressCalls.push(input); return { suppressed: true }; }
  };
  assert.equal(await applied.suppressNativeRoleDeletedResult(appliedPlugin, {
    turnId: 'late-turn', characterId: 'deleted-role'
  }), true);
  assert.deepEqual(suppressCalls, [{ turnId: 'late-turn', characterId: 'deleted-role' }]);
  assert.equal(applied.nativeReplyQueuedIds.has('late-turn'), false);
  assert.equal(applied.nativeUiAcknowledgedTurnIds.has('late-turn'), true);

  const missingState = { queued: ['defer-turn'], localFrozen: 'deleted-role' };
  const missing = build(missingState);
  assert.equal(await missing.suppressNativeRoleDeletedResult({
    async getRoleDeleteStatus(){ return { state: 'applied' }; }
  }, { turnId: 'defer-turn', characterId: 'deleted-role' }), null);
  assert.equal(missing.nativeReplyQueuedIds.has('defer-turn'), true);
  assert.equal(missing.nativeUiAcknowledgedTurnIds.size, 0);

  const unknownState = { queued: ['unknown-turn'], localFrozen: '' };
  const unknown = build(unknownState);
  assert.equal(await unknown.suppressNativeRoleDeletedResult({
    async getRoleDeleteStatus(){ throw new Error('bridge unavailable'); },
    async suppressRoleDeletedTurn(){ throw new Error('must not run'); }
  }, { turnId: 'unknown-turn', characterId: 'deleted-role' }), null);
  assert.equal(unknown.nativeReplyQueuedIds.has('unknown-turn'), true);
  assert.equal(unknown.nativeUiAcknowledgedTurnIds.size, 0);

  const oldPluginState = { queued: ['old-plugin-turn'], localFrozen: '' };
  const oldPlugin = build(oldPluginState);
  assert.equal(await oldPlugin.suppressNativeRoleDeletedResult({}, {
    turnId: 'old-plugin-turn', characterId: 'deleted-role'
  }), false, 'a legacy binary with neither role-delete method has no retained tombstone to suppress');
  assert.equal(oldPlugin.nativeReplyQueuedIds.has('old-plugin-turn'), true);
  assert.equal(oldPlugin.nativeUiAcknowledgedTurnIds.size, 0);

  const partialPluginState = { queued: ['partial-plugin-turn'], localFrozen: '' };
  const partialPlugin = build(partialPluginState);
  assert.equal(await partialPlugin.suppressNativeRoleDeletedResult({
    async suppressRoleDeletedTurn(){ throw new Error('must not run without status proof'); }
  }, { turnId: 'partial-plugin-turn', characterId: 'deleted-role' }), null);
  assert.equal(partialPlugin.nativeReplyQueuedIds.has('partial-plugin-turn'), true);
  assert.equal(partialPlugin.nativeUiAcknowledgedTurnIds.size, 0);
});

test('role deletion stays frozen but preserves Web semantics until native applied', () => {
  const enforcement = html.slice(
    html.indexOf('async function enforceNativeRoleDeletionTombstones'),
    html.indexOf('async function finalizeBrowserRoleDeletion')
  );
  const pendingBranch = enforcement.slice(
    enforcement.indexOf('markRoleDeletePending'),
    enforcement.indexOf('return changed')
  );
  assert.doesNotMatch(
    pendingBranch,
    /MemoryDB\.clearChar|removeCharacterMomentTraces|getRolePlanRepository\(\)\.replace|rolePlanCache\.delete/,
    'pending/quarantined role deletion may freeze Web state but cannot erase it before applied'
  );
  assert.match(
    pendingBranch,
    /retained\s*\|\|\s*allChats\[char\.id\]\s*\|\|/,
    'a newly discovered pending tombstone must retain the current chat instead of replacing it with an empty shell'
  );

  for (const [start, end] of [
    ['async function importChatBackup', 'async function importBackup'],
    ['async function importBackup', 'let mirrorTimer'],
    ['async function restoreAppStateFromMirror', 'const RELATIONSHIP_STAGE_DEFS']
  ]) {
    const source = html.slice(html.indexOf(start), html.indexOf(end));
    assert.match(
      source,
      /await assertNativeRoleDeletionAllowsStateReplacement/,
      `${start} must reject a stale replacement before it can overwrite a retained native tombstone`
    );
    const validations = source.match(/await assertNativeRoleDeletionAllowsStateReplacement/g) || [];
    assert.ok(validations.length >= 2, `${start} must revalidate after the replacement work completes`);
    assert.match(source, /restoreWebStateReplacementSnapshot/);
    if (start !== 'async function restoreAppStateFromMirror') {
      assert.ok(
        source.indexOf('await mirrorAppStateNow()') < source.indexOf('replacementCommitted = true'),
        `${start} must not commit until its durable Web mirror succeeds`
      );
    }
  }
});

test('failed Web state replacement restores the exact pre-import semantic snapshot', async () => {
  const source = html.slice(
    html.indexOf('function cloneWebStateValue'),
    html.indexOf('async function importChatBackup')
  );
  const build = new Function('initial', `
    const localRows = new Map(Object.entries(initial.localStorage));
    const localStorage = {
      getItem(key){ return localRows.has(key) ? localRows.get(key) : null; },
      setItem(key, value){ localRows.set(key, String(value)); },
      removeItem(key){ localRows.delete(key); }
    };
    let settings = structuredClone(initial.settings);
    let characters = structuredClone(initial.characters);
    let allChats = structuredClone(initial.allChats);
    let allMoments = structuredClone(initial.allMoments);
    let currentCharId = initial.currentCharId;
    let restoredMemory = null;
    async function dumpChatMemoryStores(){ return structuredClone(initial.chatMemory); }
    async function dumpMemoryStores(){ return structuredClone(initial.fullMemory); }
    async function restoreChatMemoryStores(value){ restoredMemory = { mode: 'chat', value: structuredClone(value) }; }
    async function restoreMemoryStores(value){ restoredMemory = { mode: 'full', value: structuredClone(value) }; }
    ${source}
    return {
      captureWebStateReplacementSnapshot,
      restoreWebStateReplacementSnapshot,
      replace(){
        settings = { changed: true };
        characters = [{ id: 'imported' }];
        allChats = { imported: { messages: ['stale'] } };
        allMoments = [{ id: 'stale' }];
        currentCharId = 'imported';
        localStorage.setItem('rpchat_settings', 'new-settings');
        localStorage.setItem('rpchat_characters', 'new-characters');
        localStorage.setItem('rpchat_chats', 'new-chats');
        localStorage.setItem('rpchat_moments', 'new-moments');
        localStorage.setItem('rpchat_app_state_updated_at', '999');
      },
      read(){ return {
        settings, characters, allChats, allMoments, currentCharId, restoredMemory,
        localStorage: Object.fromEntries(localRows)
      }; }
    };
  `);
  const initial = {
    settings: { theme: 'pink' },
    characters: [{ id: 'retained' }],
    allChats: { retained: { messages: [{ id: 'm1', content: 'keep' }] } },
    allMoments: [{ id: 'moment1', charId: 'retained' }],
    currentCharId: 'retained',
    localStorage: {
      rpchat_settings: 'old-settings',
      rpchat_characters: 'old-characters',
      rpchat_chats: 'old-chats',
      rpchat_moments: 'old-moments',
      rpchat_app_state_updated_at: '123'
    },
    chatMemory: { summaries: [{ id: 's1', charId: 'retained' }] },
    fullMemory: { events: [{ id: 'e1', charId: 'retained' }] }
  };
  const runtime = build(initial);
  const snapshot = await runtime.captureWebStateReplacementSnapshot('full');
  runtime.replace();
  await runtime.restoreWebStateReplacementSnapshot(snapshot);
  assert.deepEqual(runtime.read(), {
    settings: initial.settings,
    characters: initial.characters,
    allChats: initial.allChats,
    allMoments: initial.allMoments,
    currentCharId: 'retained',
    restoredMemory: { mode: 'full', value: initial.fullMemory },
    localStorage: initial.localStorage
  });
});

test('a newly observed native role tombstone rolls back only unaccepted local semantic work', () => {
  assert.match(html, /function\s+suppressPendingWebTurnForRoleDeletion\(charId\)/);
  const suppress = html.slice(
    html.indexOf('function suppressPendingWebTurnForRoleDeletion'),
    html.indexOf('function markRoleDeletePending')
  );
  assert.match(suppress, /nativeAcceptedAt/);
  assert.match(suppress, /refundStagedOutgoingPayment/);
  assert.match(suppress, /deliveryState\s*=\s*['"]staged['"]/);
  assert.match(suppress, /provisionalNativeOnly/);
  assert.match(suppress, /previousReplyState/);
  assert.match(suppress, /delete\s+chat\.pendingReply/);

  const markPending = html.slice(
    html.indexOf('function markRoleDeletePending'),
    html.indexOf('async function roleDeleteControlStatus')
  );
  assert.ok(
    markPending.indexOf('suppressPendingWebTurnForRoleDeletion') >= 0
      && markPending.indexOf('suppressPendingWebTurnForRoleDeletion') < markPending.indexOf("DB.set('characters'"),
    'the semantic rollback must happen as soon as a native tombstone is observed'
  );

  const retry = html.slice(
    html.indexOf('async function retryFailedReply'),
    html.indexOf('function showReplyFailureReason')
  );
  assert.match(retry, /previousReplyState/);
  const voice = html.slice(
    html.indexOf('async function sendVoicePlaceholderMessage'),
    html.indexOf('async function sendVoiceMessage')
  );
  assert.match(voice, /provisionalNativeOnly:\s*true/);
});

test('role-deletion rollback refunds once and distinguishes staged, provisional, retry, and accepted work', () => {
  const batchHelpers = html.slice(
    html.indexOf('function currentStagedBatch'),
    html.indexOf('function commitStagedBatch')
  );
  const refund = html.slice(
    html.indexOf('function refundStagedOutgoingPayment'),
    html.indexOf('async function retractMessage')
  );
  const suppress = html.slice(
    html.indexOf('function suppressPendingWebTurnForRoleDeletion'),
    html.indexOf('function markRoleDeletePending')
  );
  const build = new Function('state', `
    let allChats = state.allChats;
    let wallet = state.wallet;
    const nativeReplyQueuedIds = new Set(state.queued || []);
    const DB = { set(){ state.writes += 1; } };
    function walletBalance(){ return wallet; }
    function saveWalletBalance(value){ wallet = value; state.wallet = value; }
    function uid(prefix){ return prefix + '_test'; }
    function messageById(chat, id){ return (chat?.messages || []).find(message => message.id === id); }
    ${batchHelpers}
    ${refund}
    ${suppress}
    return { suppressPendingWebTurnForRoleDeletion, nativeReplyQueuedIds };
  `);

  const state = {
    wallet: 70,
    writes: 0,
    queued: ['turn-batch'],
    allChats: {
      role: {
        messages: [
          { id: 'text', role: 'user', content: 'hi', batchId: 'b', deliveryState: 'sent', batchCommittedAt: 10 },
          { id: 'pay', role: 'user', type: 'transfer', payType: 'transfer', amount: 30, batchId: 'b', deliveryState: 'sent', batchCommittedAt: 10 }
        ],
        pendingReply: {
          userMessageId: 'pay', nativeTurnId: 'turn-batch', batchId: 'b',
          batchMessageIds: ['text', 'pay'], batchStartedAt: 5, createdAt: 10
        }
      }
    }
  };
  const runtime = build(state);
  assert.equal(runtime.suppressPendingWebTurnForRoleDeletion('role'), true);
  assert.equal(state.wallet, 100);
  assert.equal(state.allChats.role.messages[0].deliveryState, 'staged');
  assert.equal(state.allChats.role.messages[1].deliveryState, 'cancelled');
  assert.equal(state.allChats.role.messages[1].refunded, true);
  assert.deepEqual(state.allChats.role.stagedBatch.messageIds, ['text']);
  assert.equal(state.allChats.role.pendingReply, undefined);
  assert.equal(runtime.nativeReplyQueuedIds.has('turn-batch'), false);
  assert.equal(runtime.suppressPendingWebTurnForRoleDeletion('role'), false);
  assert.equal(state.wallet, 100, 'a repeated tombstone must not refund twice');

  state.allChats.voice = {
    messages: [{ id: 'voice', role: 'user', type: 'voice', provisionalNativeOnly: true, replyState: 'pending' }],
    pendingReply: { userMessageId: 'voice', nativeTurnId: 'turn-voice' }
  };
  assert.equal(runtime.suppressPendingWebTurnForRoleDeletion('voice'), true);
  assert.deepEqual(state.allChats.voice.messages, []);

  state.allChats.retry = {
    messages: [{ id: 'retry', role: 'user', replyState: 'pending' }],
    pendingReply: {
      userMessageId: 'retry', nativeTurnId: 'turn-retry',
      previousReplyState: 'failed', previousReplyError: 'old failure'
    }
  };
  assert.equal(runtime.suppressPendingWebTurnForRoleDeletion('retry'), true);
  assert.equal(state.allChats.retry.messages[0].replyState, 'failed');
  assert.equal(state.allChats.retry.messages[0].replyError, 'old failure');

  state.allChats.accepted = {
    messages: [{ id: 'accepted', role: 'user', replyState: 'pending' }],
    pendingReply: { userMessageId: 'accepted', nativeTurnId: 'turn-accepted', nativeAcceptedAt: 99 }
  };
  assert.equal(runtime.suppressPendingWebTurnForRoleDeletion('accepted'), true);
  assert.equal(state.allChats.accepted.messages[0].replyState, 'suppressed');
  assert.equal(state.allChats.accepted.pendingReply, undefined);
});

test('Android clear durably prearms lifecycle recovery before its Room transaction commits', () => {
  const pluginClear = plugin.slice(
    plugin.indexOf('void createConversationClear(PluginCall call)'),
    plugin.indexOf('@PluginMethod', plugin.indexOf('void createConversationClear(PluginCall call)') + 1)
  );
  assert.match(pluginClear, /createConversationClear\([\s\S]{0,300}prearmLifecycle/);
  assert.ok(pluginClear.indexOf('prearmLifecycle') < pluginClear.indexOf('requestRun'));

  const nativeClear = executionStore.slice(
    executionStore.indexOf('LifecycleControl createConversationClear('),
    executionStore.indexOf('private static LifecycleControlEntity encodedToEntity')
  );
  assert.match(nativeClear, /database\.runInTransaction\([\s\S]*durableWakePrearm\.run\(\)/);
  assert.equal(nativeClear.match(/durableWakePrearm\.run\(\)/g)?.length, 2);
  assert.ok(nativeClear.indexOf('insertLifecycleControl') < nativeClear.lastIndexOf('durableWakePrearm.run()'));
});

test('clear-all history is explicitly serial and reports per-role failures', () => {
  const clearAll = html.slice(html.indexOf('async function clearAllHistory'), html.indexOf('async function syncFromServiceWorkerState'));
  assert.match(clearAll, /runNativeClearAllSerial\(clearedCharIds/);
  assert.doesNotMatch(clearAll, /Promise\.all/);
  assert.doesNotMatch(clearAll, /allChats\s*=\s*\{\}/);
  assert.match(clearAll, /DB\.set\('chats', allChats\)/);
  assert.match(clearAll, /failed|失败|partial|部分/i);
});

test('native late results are cursor-gated before UI application', () => {
  const apply = html.slice(html.indexOf('async function applyNativeExecutionTurnUnlocked'), html.indexOf('function applyNativeExecutionTurn(result)'));
  assert.match(apply, /getConversationCursor|nativeResultSuppressedByClear/);
  const gateAt = Math.min(...['getConversationCursor', 'nativeResultSuppressedByClear'].map(token => {
    const index = apply.indexOf(token);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  }));
  const writeAt = Math.min(...['nativeTerminalDispositionLanding', 'appendNativeReplyTextParts', 'createCharacterMoment'].map(token => {
    const index = apply.indexOf(token);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  }));
  assert.ok(gateAt < writeAt, 'cursor suppression must run before DOM/cache writes');
});

test('a completed retry ancestor wins over its pending descendant', () => {
  const lineageStart = html.indexOf('function nativePendingRetryLineage');
  const supersededStart = html.indexOf('function nativeDirectTurnIsSuperseded');
  const applyStart = html.indexOf('async function applyNativeExecutionTurnUnlocked');
  assert.ok(lineageStart >= 0 && supersededStart > lineageStart && applyStart > supersededStart);
  const makeHelpers = new Function(
    `${html.slice(lineageStart, supersededStart)}
     ${html.slice(supersededStart, applyStart)}
     return { nativePendingRetryLineage, nativeDirectTurnIsSuperseded };`
  );
  const { nativeDirectTurnIsSuperseded } = makeHelpers();
  const chat = {
    pendingReply: {
      userMessageId: 'msg-1',
      nativeTurnId: 'turn-retry-2',
      retryOfTurnId: 'turn-retry-1',
      retryLineageTurnIds: ['turn-original', 'turn-retry-1']
    },
    messages: []
  };

  assert.equal(nativeDirectTurnIsSuperseded(chat, {
    kind: 'DIRECT_REPLY',
    state: 'COMPLETED',
    sourceMessageId: 'msg-1',
    turnId: 'turn-original'
  }), false);
  assert.equal(nativeDirectTurnIsSuperseded(chat, {
    kind: 'DIRECT_REPLY',
    state: 'COMPLETED',
    sourceMessageId: 'msg-1',
    turnId: 'turn-unrelated'
  }), true);
});

test('a superseded direct turn cannot render or apply actions', () => {
  const apply = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  assert.match(apply, /function\s+nativeDirectTurnIsSuperseded|nativeDirectTurnIsSuperseded\(/);
  assert.ok(
    apply.indexOf('nativeDirectTurnIsSuperseded') < apply.indexOf('applyNativeRelationshipStagePart'),
    'superseded direct turns must be rejected before any action is applied'
  );
});

test('native completed replies retain bridge provenance without changing bubble copy', () => {
  assert.match(plugin, /result\.put\("origin",[\s\S]*result\.put\("fallback",[\s\S]*result\.put\("attemptedRoutes",/);
  assert.match(html, /function\s+nativeReplyProvenance\(result\)/);
  assert.match(html, /replyOrigin:\s*String\(result\?\.origin/);
  assert.match(html, /replyFallback:\s*result\?\.fallback\s*===\s*true/);
  assert.match(html, /replyAttemptedRoutes:\s*Array\.isArray\(result\?\.attemptedRoutes\)/);
});

test('native completed turns are serialized across submit, poll, inbox, and foreground replay', () => {
  assert.match(html, /let\s+nativeExecutionReconcilePromise\s*=\s*null/);
  assert.match(html, /const\s+nativeTurnApplyPromises\s*=\s*new Map\(\)/);
  assert.match(html, /function\s+withNativeTurnApplyLock\(turnId,\s*operation\)/);
  assert.match(html, /async function\s+applyNativeExecutionTurnUnlocked\(result\)/);
  assert.match(html, /function\s+applyNativeExecutionTurn\(result\)\s*\{\s*return\s+withNativeTurnApplyLock\(result\?\.turnId,\s*\(\)\s*=>\s*applyNativeExecutionTurnUnlocked\(result\)\)/);
  assert.match(html, /if\s*\(nativeExecutionReconcilePromise\)\s*return\s+nativeExecutionReconcilePromise/);
});

test('native inbox flushes the coalesced durable app_state mirror before acknowledgement', () => {
  const apply = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  const drain = html.slice(
    html.indexOf('async function drainNativeUiInbox'),
    html.indexOf('async function replayRecentNativeCompletedTurns')
  );
  assert.ok(apply.includes("DB.set('chats', allChats)"));
  assert.doesNotMatch(apply, /await\s+mirrorAppStateNow\(\)/,
    'terminal apply must not bypass the coalesced mirror scheduler');
  const flush = drain.indexOf('await flushLatestAppStateMirror()');
  const ack = drain.indexOf('await acknowledgeNativeUiAppliedOnce');
  assert.ok(flush >= 0 && flush < ack,
    'native acknowledgement must follow the unified durable mirror gate');
  assert.match(html, /async function flushLatestAppStateMirror\(\)/);
});

test('native delivery diagnostics persist and expose four independent convergence stages', () => {
  assert.match(executionDatabase, /version\s*=\s*AlExecutionDatabase\.SCHEMA_VERSION/);
  assert.match(executionDatabase, /SCHEMA_VERSION\s*=\s*16/);
  assert.match(executionDatabase, /MIGRATION_9_10/);
  assert.match(executionDatabase, /MIGRATION_10_11/);
  assert.match(executionDatabase, /MIGRATION_11_12/);
  assert.match(executionDatabase, /MIGRATION_12_13/);
  assert.match(executionDatabase, /MIGRATION_13_14/);
  assert.match(executionDatabase, /MIGRATION_14_15/);
  assert.match(executionDatabase, /MIGRATION_15_16/);
  assert.match(chatTurnEntity, /Long\s+notificationShownAt/);
  assert.match(chatTurnEntity, /Long\s+cloudConfirmedAt/);
  assert.match(executionDao, /markNotificationShown/);
  assert.match(executionDao, /markCloudConfirmed/);
  assert.match(plugin, /result\.put\("notificationShownAt",\s*turn\.notificationShownAt\)/);
  assert.match(plugin, /result\.put\("cloudConfirmedAt",\s*turn\.cloudConfirmedAt\)/);
  assert.match(plugin, /result\.put\("cloudConfirmationRequired"/);
  assert.match(plugin, /result\.put\("deliveryStages",\s*deliveryStages\)/);
  for (const label of ['cloudConfirmed', 'nativeCompleted', 'notificationShown', 'uiApplied']) {
    assert.match(html, new RegExp(label));
  }
});

test('notification idempotency is persisted immediately after notify succeeds', () => {
  const delivery = executionService.slice(
    executionService.indexOf('NotificationManagerCompat.from(this).notify('),
    executionService.indexOf('private void confirmBridgeDelivery')
  );
  assert.ok(delivery.indexOf('.notify(') < delivery.indexOf('putBoolean(key, true)'));
  assert.ok(delivery.indexOf('putBoolean(key, true)') < delivery.indexOf('markNotificationShown'));
  assert.doesNotMatch(delivery, /if\s*\(notificationWasPosted\(notificationId\)\)/);
  assert.doesNotMatch(executionService, /AlNotificationStatus\.inspect\(this\)\.healthy/);
  const messageNotification = notificationFactory.slice(
    notificationFactory.indexOf('Notification messageNotification('),
    notificationFactory.indexOf('Notification progressNotification(')
  );
  assert.match(messageNotification, /setOnlyAlertOnce\(true\)/);
});

test('native completion event and polling share a bounded self-clearing reconciliation path', () => {
  assert.match(html, /const\s+NATIVE_RECONCILE_TIMEOUT_MS\s*=/);
  assert.match(html, /function\s+withNativePromiseTimeout\(/);
  const reconcile = html.slice(
    html.indexOf('function reconcileNativeExecutionTurns()'),
    html.indexOf('function startNativeReplyPolling()')
  );
  assert.match(reconcile, /withNativePromiseTimeout\(/);
  assert.match(reconcile, /\.finally\(\(\)\s*=>/);
  const listener = html.slice(
    html.indexOf('async function ensureNativeExecutionCompletedListener()'),
    html.indexOf('function yuqiImmersiveProgressText')
  );
  assert.match(listener, /reconcileNativeReplyState\(\)/);
  assert.doesNotMatch(listener, /drainNativeUiInbox\(plugin\)/);
});

test('native boot starts critical poll/listener before optional Browser and push awaits', () => {
  const boot = html.slice(html.indexOf('async function bootApp()'), html.indexOf('bootApp();'));
  assert.ok(boot.indexOf('startNativeReplyPolling();') < boot.indexOf('closeStaleUpdateBrowser().catch'));
  assert.match(boot, /ensureNativeExecutionCompletedListener\(\)\.catch/);
  assert.doesNotMatch(boot, /await\s+ensureNativeExecutionCompletedListener/);
  assert.doesNotMatch(boot, /await\s+ensureNativePushListeners/);
  const listener = html.slice(html.indexOf('async function ensureNativeExecutionCompletedListener()'), html.indexOf('function yuqiImmersiveProgressText'));
  assert.match(listener, /nativeExecutionCompletedListenerInFlight/);
  assert.match(listener, /nativeBridgeCall\(/);
  assert.match(listener, /nativeExecutionCompletedListenerReady\s*=\s*true/);
});

test('long chats mount only the latest 120 visible messages and expand in bounded pages', () => {
  assert.match(html, /const CHAT_RENDER_WINDOW_SIZE = 120;/);
  assert.match(html, /const CHAT_RENDER_PAGE_SIZE = 120;/);
  const selectStart = html.indexOf('function selectChatRenderWindow');
  const windowStart = html.indexOf('function chatRenderWindow');
  assert.ok(selectStart >= 0 && windowStart > selectStart);
  const selectChatRenderWindow = new Function(
    `${html.slice(selectStart, windowStart)}
     return selectChatRenderWindow;`
  )();
  const messages = Array.from({ length: 1900 }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`
  }));
  messages[50].hidden = true;
  messages[60].deleted = true;

  const initial = selectChatRenderWindow(messages, 120);
  assert.equal(initial.messages.length, 120);
  assert.equal(initial.hiddenCount, 1778);
  assert.equal(initial.messages[0].id, 'msg-1780');
  const expanded = selectChatRenderWindow(messages, 240);
  assert.equal(expanded.messages.length, 240);
  assert.equal(expanded.messages[0].id, 'msg-1660');

  const renderer = html.slice(html.indexOf('function renderMessages'), html.indexOf('function scrollChatBottom'));
  assert.match(renderer, /const\s+renderWindow\s*=\s*chatRenderWindow\(chat,\s*currentCharId\)/);
  assert.match(renderer, /loadOlderChatMessages\(currentCharId\)/);
  assert.doesNotMatch(renderer, /const\s+displayMessages\s*=\s*visibleChatMessages\(chat\)/);
  const opener = html.slice(html.indexOf('function openChat'), html.indexOf('function buildCharPrompt'));
  assert.match(opener, /chatRenderLimits\.set\(charId,\s*CHAT_RENDER_WINDOW_SIZE\)/);
});

test('chat message actions use one delegated listener set instead of rebinding every bubble', () => {
  const binding = html.slice(html.indexOf('function bindMessageActions'), html.indexOf('function startMessageLongPress'));
  assert.match(binding, /root\.dataset\.messageActionsBound/);
  assert.match(binding, /root\.addEventListener\('pointerdown'/);
  assert.match(binding, /closest\('\[data-message-id\]'\)/);
  assert.doesNotMatch(binding, /querySelectorAll/);
  assert.doesNotMatch(binding, /\.forEach\(/);
});

test('native polling ignores elapsed-counter-only changes', () => {
  const currentStart = html.indexOf('function nativePendingStateIsCurrent');
  const needsSubmissionStart = html.indexOf('function nativePendingReplyNeedsSubmission');
  assert.ok(currentStart >= 0 && needsSubmissionStart > currentStart);
  const nativePendingStateIsCurrent = new Function(
    `${html.slice(currentStart, needsSubmissionStart)}
     return nativePendingStateIsCurrent;`
  )();
  const chat = {
    pendingReply: {
      nativeTurnId: 'turn-1',
      state: 'running',
      nativeState: 'CHAT_RUNNING',
      nativeUpdatedAt: 10,
      bridgeRoute: 'cloud',
      bridgeDisplayStage: '正在想',
      bridgeTechnicalStage: 'chat',
      bridgeStageModel: 'model',
      bridgeStageEffort: 'high',
      bridgeStageElapsedMs: 1000,
      bridgeTotalElapsedMs: 2000
    }
  };
  const result = {
    turnId: 'turn-1',
    state: 'CHAT_RUNNING',
    updatedAt: 10,
    route: 'cloud',
    displayStage: '正在想',
    technicalStage: 'chat',
    stageModel: 'model',
    stageEffort: 'high',
    stageElapsedMs: 4000,
    totalElapsedMs: 5000
  };
  assert.equal(nativePendingStateIsCurrent(chat, { replyState: 'pending' }, result), true);
  const apply = html.slice(
    html.indexOf('const displaySourceMessageId = nativeResultDisplaySourceMessageId(chat, result);', html.indexOf('async function applyNativeExecutionTurnUnlocked')),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  const currentCheckAt = apply.indexOf('nativePendingStateIsCurrent(chat, userMessage, result)');
  const retryableAt = apply.indexOf("state === 'FAILED_RETRYABLE'");
  assert.ok(currentCheckAt >= 0 && currentCheckAt < retryableAt, 'all nonterminal states must share the no-op guard');
});

test('acknowledged native completions remain recoverable until their exact bubble exists', () => {
  assert.match(executionDao, /state = 'COMPLETED' AND deletedAt IS NULL ORDER BY completedAt DESC LIMIT :limit/);
  assert.match(executionStore, /recentCompletedTurns\(int limit\)/);
  assert.match(plugin, /void\s+recentCompletedTurns\(PluginCall call\)/);
  assert.match(html, /async function\s+replayRecentNativeCompletedTurns\(/);
  assert.match(html, /plugin\.recentCompletedTurns\(\{\s*limit:\s*50\s*\}\)/);
  assert.match(html, /changed\s*=\s*await\s+replayRecentNativeCompletedTurns\(plugin\)\s*\|\|\s*changed/);
  const landing = html.slice(
    html.indexOf('function nativeTurnHasUiLanding'),
    html.indexOf('async function drainNativeUiInbox')
  );
  assert.match(landing, /message\.sourceTurnId\s*===\s*sourceTurnId/);
  assert.doesNotMatch(landing, /message\.replyToMessageId\s*===\s*userMessage\.id/);
});

test('wire3 missing moment target cannot virtualize or mark the UI applied', async () => {
  const landingSource = html.slice(
    html.indexOf('function nativeActionEnvelope'),
    html.indexOf('async function drainNativeUiInbox')
  );
  const executionSource = html.slice(
    html.indexOf('function nativeActionEnvelope'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  const allChats = { yuqi: { messages: [], nativeActionProofs: {} } };
  const allMoments = [];
  const applyNativeExecutionTurnUnlocked = new Function(
    'allChats', 'allMoments', 'characters', 'DB',
    `${executionSource}; return applyNativeExecutionTurnUnlocked;`
  )(allChats, allMoments, [], { set() {} });
  const result = {
    turnId: 'turn_missing_moment_target',
    characterId: 'yuqi',
    kind: 'MOMENT_INTERACTION',
    state: 'COMPLETED',
    terminalDisposition: 'action_only',
    resultAuthorityVersion: 1,
    bridgeProtocolVersion: 3,
    commitChecksum: 'a'.repeat(64),
    replyParts: [{
      replyPartId: 'missing-action',
      type: 'MOMENT_ACTION',
      payloadJson: JSON.stringify({ canonicalAction: {
        actionId: 'missing-action',
        kind: 'moment_like',
        targetKey: 'moment:missing_target',
        targetRevision: '1',
        actionChecksum: 'b'.repeat(64),
        payload: { like: true }
      } })
    }]
  };
  assert.equal(await applyNativeExecutionTurnUnlocked(result), false);
  assert.deepEqual(allMoments, [], 'unknown v3 target must not materialize a virtual moment');
  assert.deepEqual(allChats.yuqi.messages, [], 'unknown v3 target must not mark UI/chat applied');
});

test('an applied action-only native result is a UI landing without a chat bubble', () => {
  const landingSource = html.slice(
    html.indexOf('function nativeActionEnvelope'),
    html.indexOf('async function drainNativeUiInbox')
  );
  const makeLanding = new Function(
    'allChats',
    'allMoments',
    `${landingSource}; return nativeTurnHasUiLanding;`
  );
  const nativeTurnHasUiLanding = makeLanding({
    yuqi: {
      messages: [],
      nativeActionProofs: {
        'turn_action_only:act_1': {
          turnId: 'turn_action_only', replyPartId: 'act_1', targetKey: 'relationship:yuqi',
          actionId: 'act_1', kind: 'relationship_transition', actionChecksum: 'c'.repeat(64),
          targetRevision: 'b'.repeat(64), checkpointChecksum: 'a'.repeat(64)
        }
      }
    }
  }, [{ id: 'moment-post', sourceTurnId: 'native:turn_public_moment_visible' }]);
  const nativeCanonicalAction = new Function(
    `${landingSource}; return nativeCanonicalAction;`
  )();
  const validActionPart = {
    replyPartId: 'act-format', type: 'RELATIONSHIP_STAGE', payloadJson: JSON.stringify({
      canonicalAction: {
        actionId: 'act-format', kind: 'relationship_transition', targetKey: 'relationship:yuqi',
        targetRevision: 'b'.repeat(64), actionChecksum: 'c'.repeat(64), payload: {}
      }
    })
  };
  const validActionResult = { turnId: 'turn-format', commitChecksum: 'a'.repeat(64) };
  assert.ok(nativeCanonicalAction(validActionPart, validActionResult), 'plain 64hex action tuple is the wire format');
  for (const bad of [
    `sha256:${'c'.repeat(64)}`,
    'C'.repeat(64),
    'c'.repeat(63),
    123
  ]) {
    const mutated = JSON.parse(validActionPart.payloadJson);
    mutated.canonicalAction.actionChecksum = bad;
    assert.equal(nativeCanonicalAction({ ...validActionPart, payloadJson: JSON.stringify(mutated) }, validActionResult), null, 'prefixed/uppercase/short checksum must fail closed');
  }
  for (const bad of [`sha256:${'b'.repeat(64)}`, 'B'.repeat(64), 'b'.repeat(63), 12]) {
    const mutated = JSON.parse(validActionPart.payloadJson);
    mutated.canonicalAction.targetRevision = bad;
    assert.equal(nativeCanonicalAction({ ...validActionPart, payloadJson: JSON.stringify(mutated) }, validActionResult), null, 'prefixed/uppercase/short target revision must fail closed');
  }
  assert.equal(nativeCanonicalAction(validActionPart, { turnId: 'turn-format', commitChecksum: 42 }), null, 'numeric checkpoint/commit checksum must fail closed');

  assert.equal(nativeTurnHasUiLanding({
    turnId: 'turn_action_only',
    characterId: 'yuqi',
    kind: 'DIRECT_REPLY',
    terminalDisposition: 'action_only',
    actionApplied: true,
    commitChecksum: 'a'.repeat(64),
    replyParts: [{
      replyPartId: 'act_1',
      type: 'RELATIONSHIP_STAGE',
      payloadJson: JSON.stringify({
        version: 1,
        canonicalAction: {
          actionId: 'act_1', ordinal: 0, kind: 'relationship_transition',
          targetKey: 'relationship:yuqi', targetRevision: 'b'.repeat(64),
          payload: { expectedSceneRevision: 0 }, actionChecksum: 'c'.repeat(64)
        },
        legacyPayload: { expectedSceneRevision: 0, baseAction: null, phaseAction: null }
      })
    }]
  }), true);
  assert.equal(nativeTurnHasUiLanding({
    turnId: 'turn_action_only', characterId: 'yuqi', kind: 'DIRECT_REPLY',
    terminalDisposition: 'action_only',
    commitChecksum: 'a'.repeat(64),
    replyParts: [{
      replyPartId: 'act_1', type: 'RELATIONSHIP_STAGE',
      payloadJson: JSON.stringify({ canonicalAction: {
        actionId: 'act_1', kind: 'relationship_transition', targetKey: 'relationship:yuqi', targetRevision: 'b'.repeat(64),
        payload: { expectedSceneRevision: 0 }, actionChecksum: 'c'.repeat(64)
      } })
    }]
  }), true, 'persisted action proof must survive reload without transient actionApplied input');
  assert.equal(nativeTurnHasUiLanding({
    turnId: 'turn_action_only', characterId: 'yuqi', kind: 'DIRECT_REPLY',
    terminalDisposition: 'action_only', actionApplied: true,
    commitChecksum: 'a'.repeat(64),
    replyParts: [{
      replyPartId: 'act_1', type: 'RELATIONSHIP_STAGE',
      payloadJson: JSON.stringify({
        canonicalAction: {
          actionId: 'act_1', ordinal: 0, kind: 'relationship_transition',
          targetKey: 'relationship:yuqi', targetRevision: 'b'.repeat(64),
          payload: { expectedSceneRevision: 0 }, actionChecksum: 'd'.repeat(64)
        }, legacyPayload: {}
      })
    }]
  }), false, '相同part/target/revision但actionChecksum变化不得复用旧proof');
  assert.equal(nativeTurnHasUiLanding({
    turnId: 'turn_action_missing_proof', characterId: 'yuqi', kind: 'DIRECT_REPLY',
    terminalDisposition: 'action_only', actionApplied: true,
    replyParts: [{ replyPartId: 'act_2', type: 'PLAN', payloadJson: '{}' }]
  }), false, '任意非TEXT标记不能冒充动作落地证明');
  assert.equal(nativeTurnHasUiLanding({
    turnId: 'turn_action_bad_target', characterId: 'yuqi', kind: 'DIRECT_REPLY',
    terminalDisposition: 'action_only', actionApplied: true,
    commitChecksum: 'a'.repeat(64),
    replyParts: [{
      replyPartId: 'act_3', type: 'RELATIONSHIP_STAGE',
      payloadJson: JSON.stringify({
        canonicalAction: {
          actionId: 'act_3', ordinal: 0, kind: 'relationship_transition',
          targetKey: 'relationship:forged', targetRevision: 'forged', payload: {},
          actionChecksum: 'c'.repeat(64)
        }, legacyPayload: {}
      })
    }]
  }), false, '错误动作靶点或revision不得落地');
  assert.equal(nativeTurnHasUiLanding({
    turnId: 'turn_visible_missing',
    characterId: 'yuqi',
    kind: 'DIRECT_REPLY',
    terminalDisposition: 'visible',
    replyParts: [{ replyPartId: 'msg_1', type: 'TEXT', content: '还没落地' }]
  }), false);

  assert.equal(nativeTurnHasUiLanding({
    turnId: 'turn_public_moment_visible',
    characterId: 'yuqi',
    kind: 'PROACTIVE_MOMENT',
    terminalDisposition: 'visible',
    replyParts: [{ replyPartId: 'moment-post', type: 'TEXT', content: '公开动态' }]
  }), true, 'public moment visible landing must use allMoments, not chat messages');

  const nativeTerminalUiLanding = new Function(
    'allChats', 'allMoments', `${landingSource}; return nativeTerminalUiLanding;`
  )(
    { yuqi: { messages: [] } },
    [{ sourceTurnId: 'native:turn_public_moment_visible' }]
  );
  assert.equal(nativeTerminalUiLanding({
    turnId: 'turn_public_moment_visible',
    characterId: 'yuqi',
    kind: 'PROACTIVE_MOMENT',
    terminalDisposition: 'visible',
    replyParts: [{ replyPartId: 'moment-post', type: 'TEXT', content: '公开动态' }]
  }, { messages: [] }, 'native:turn_public_moment_visible'), true,
  'the unique terminal landing helper must use allMoments for public moments');

  const mixedLanding = new Function(
    'allChats', 'allMoments', `${landingSource}; return nativeTurnHasUiLanding;`
  )({
    yuqi: {
      messages: [
        { sourceTurnId: 'native:turn-mixed', sourceReplyPartId: 'text-1' },
        { sourceTurnId: 'native:turn-mixed', sourceReplyPartId: 'text-2' },
        { sourceTurnId: 'native:turn-mixed', sourceReplyPartId: 'text-3' }
      ],
      nativeActionProofs: {
        'turn-mixed:act-mixed': {
          turnId: 'turn-mixed', replyPartId: 'act-mixed', actionId: 'act-mixed',
          kind: 'relationship_transition', actionChecksum: 'c'.repeat(64),
          targetKey: 'relationship:yuqi', targetRevision: 'b'.repeat(64), checkpointChecksum: 'a'.repeat(64)
        }
      }
    }
  }, []);
  const mixedParts = [
    { replyPartId: 'text-1', type: 'TEXT', content: '一' },
    { replyPartId: 'text-2', type: 'TEXT', content: '二' },
    { replyPartId: 'text-3', type: 'TEXT', content: '三' },
    { replyPartId: 'act-mixed', type: 'RELATIONSHIP_STAGE', payloadJson: JSON.stringify({ canonicalAction: {
      actionId: 'act-mixed', kind: 'relationship_transition', targetKey: 'relationship:yuqi', targetRevision: 'b'.repeat(64),
      actionChecksum: 'c'.repeat(64), payload: {}
    } }) }
  ];
  assert.equal(mixedLanding({ turnId: 'turn-mixed', characterId: 'yuqi', kind: 'DIRECT_REPLY', terminalDisposition: 'visible', commitChecksum: 'a'.repeat(64), replyParts: mixedParts }), true, 'visible mixed text+action requires all text and action proof');
  const forgedMixedParts = mixedParts.map(part => part.replyPartId === 'act-mixed'
    ? { ...part, payloadJson: JSON.stringify({ canonicalAction: {
      actionId: 'act-mixed', kind: 'relationship_transition', targetKey: 'relationship:yuqi', targetRevision: 'b'.repeat(64),
      actionChecksum: 'd'.repeat(64), payload: {}
    } }) }
    : part);
  assert.equal(mixedLanding({ turnId: 'turn-mixed', characterId: 'yuqi', kind: 'DIRECT_REPLY', terminalDisposition: 'visible', commitChecksum: 'a'.repeat(64), replyParts: forgedMixedParts }), false, 'visible text cannot mask an invalid structured action');
  const actionDescriptor = {
    actionId: 'act-mixed', ordinal: 0, kind: 'relationship_transition', targetKey: 'relationship:yuqi',
    targetRevision: 'b'.repeat(64), actionChecksum: 'c'.repeat(64), payload: {}
  };
  assert.equal(mixedLanding({
    turnId: 'turn-mixed', characterId: 'yuqi', kind: 'DIRECT_REPLY', terminalDisposition: 'visible', commitChecksum: 'a'.repeat(64),
    replyParts: [
      { replyPartId: 'text-1', type: 'TEXT', content: '一' },
      { replyPartId: 'text-2', type: 'TEXT', content: '二' },
      { replyPartId: 'text-3', type: 'TEXT', content: '三' }
    ],
    actions: [actionDescriptor]
  }), true, 'wire actions must join the same visible proof gate as text parts');
  assert.equal(mixedLanding({
    turnId: 'turn-mixed', characterId: 'yuqi', kind: 'DIRECT_REPLY', terminalDisposition: 'visible', commitChecksum: 'a'.repeat(64),
    replyParts: [
      { replyPartId: 'text-1', type: 'TEXT', content: '一' },
      { replyPartId: 'text-2', type: 'TEXT', content: '二' },
      { replyPartId: 'text-3', type: 'TEXT', content: '三' }
    ],
    actions: [{ ...actionDescriptor, actionChecksum: 'd'.repeat(64) }]
  }), false, 'wire action checksum corruption cannot be hidden by visible text');
  assert.equal(mixedLanding({
    turnId: 'turn-mixed', characterId: 'yuqi', kind: 'DIRECT_REPLY', terminalDisposition: 'visible', commitChecksum: 'a'.repeat(64),
    replyParts: [
      { replyPartId: 'text-1', type: 'TEXT', content: '一' },
      { replyPartId: 'text-2', type: 'TEXT', content: '二' },
      { replyPartId: 'text-3', type: 'TEXT', content: '三' }
    ],
    actions: [{ ...actionDescriptor, actionId: 42 }]
  }), false, 'malformed action identity cannot be silently dropped beside visible text');
  assert.equal(mixedLanding({
    turnId: 'turn-mixed', characterId: 'yuqi', kind: 'DIRECT_REPLY', terminalDisposition: 'visible', commitChecksum: 'a'.repeat(64),
    replyParts: mixedParts,
    actions: [actionDescriptor]
  }), true, 'exact duplicate action descriptors may be deduplicated');
  assert.equal(mixedLanding({
    turnId: 'turn-mixed', characterId: 'yuqi', kind: 'DIRECT_REPLY', terminalDisposition: 'visible', commitChecksum: 'a'.repeat(64),
    replyParts: mixedParts,
    actions: [{ ...actionDescriptor, actionChecksum: 'd'.repeat(64) }]
  }), false, 'duplicate action identity with changed checksum must fail closed');
});

test('native action proofs bind moment creation and role-plan operation output, not input booleans or plan existence', () => {
  const proofSource = html.slice(
    html.indexOf('function nativeRolePlanOperationProof'),
    html.indexOf('async function applyAndVerifyNativeStructuredParts')
  );
  const nativeRolePlanOperationProof = new Function(
    `${proofSource}; return nativeRolePlanOperationProof;`
  )();
  const canonical = {
    legacyPayload: { operations: [{ op: 'update', planId: 'plan-1', evidenceMessageIds: ['turn-plan'], patch: { title: '新标题' } }] },
    action: { actionId: 'act-plan', actionChecksum: 'c'.repeat(64), targetRevision: 'b'.repeat(64) }
  };
  assert.equal(nativeRolePlanOperationProof(
    'yuqi', {}, { turnId: 'turn-plan' },
    { changed: true, plans: [{ planId: 'plan-1', characterId: 'yuqi', title: '新标题', status: 'active', evidenceMessageIds: ['turn-plan'] }] },
    canonical
  ), true);
  assert.equal(nativeRolePlanOperationProof(
    'yuqi', {}, { turnId: 'turn-plan' },
    { changed: false, plans: [{ planId: 'plan-1', characterId: 'yuqi', title: '新标题', status: 'active' }] },
    canonical
  ), false, '仅计划存在或输入applied标记不能证明操作已经落地');
  assert.equal(nativeRolePlanOperationProof(
    'yuqi', {}, { turnId: 'turn-plan' },
    { changed: false, plans: [{ planId: 'plan-1', characterId: 'yuqi', title: '新标题', status: 'active', evidenceMessageIds: ['turn-plan'] }] },
    canonical
  ), true, '上次已落地但proof尚未写入时，持久evidence与精确目标状态应恢复proof');
  assert.match(html, /created\.nativeActionTurnIds\s*=\s*\[result\.turnId\]/);
  assert.match(html, /proof\.actionChecksum\s*===\s*canonical\.action\.actionChecksum/);
  const applySource = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  const actionOnlyBlock = applySource.slice(applySource.indexOf("terminalDisposition || '') === 'action_only'"));
  assert.ok(actionOnlyBlock.indexOf("allParts.some(part => part?.type === 'TEXT')") >= 0, 'action_only must reject text before applying structured actions');
  assert.ok(actionOnlyBlock.indexOf('nativeStructuredActionParts') >= 0, 'action_only must require canonical structured parts before applying');
});

test('canonical action validation is closed before any legacy writer and rejects alias or forged legacy payloads', async () => {
  const landingSource = html.slice(
    html.indexOf('function nativeActionEnvelope'),
    html.indexOf('function nativePendingRetryLineage')
  );
  const nativeCanonicalAction = new Function(`${landingSource}; return nativeCanonicalAction;`)();
  const canonicalAction = {
    actionId: 'act-closed', kind: 'relationship_transition', targetKey: 'relationship:yuqi',
    targetRevision: 'b'.repeat(64), actionChecksum: 'c'.repeat(64),
    payload: { expectedSceneRevision: 0, baseAction: { from: 'new', to: 'acquainted' } }
  };
  const baseEnvelope = {
    canonicalAction,
    legacyPayload: { expectedSceneRevision: 0, baseAction: { from: 'new', to: 'acquainted' }, phaseAction: null }
  };
  const basePart = { replyPartId: 'act-closed', type: 'RELATIONSHIP_STAGE', payloadJson: JSON.stringify(baseEnvelope) };
  assert.ok(nativeCanonicalAction(basePart, { turnId: 'turn-closed', commitChecksum: 'a'.repeat(64) }));
  assert.equal(nativeCanonicalAction({
    ...basePart,
    payloadJson: JSON.stringify({ ...baseEnvelope, legacyPayload: { baseAction: { from: 'new', to: 'forged' } } })
  }, { turnId: 'turn-closed', commitChecksum: 'a'.repeat(64) }), null, 'legacyPayload must equal canonical derivation');
  assert.equal(nativeCanonicalAction({
    ...basePart,
    payloadJson: JSON.stringify({ canonicalAction: { ...canonicalAction, actionChecksum: undefined, checksum: 'c'.repeat(64) } })
  }, { turnId: 'turn-closed', commitChecksum: 'a'.repeat(64) }), null, 'action.checksum is not a wire alias');

  const applySource = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  const makeApply = new Function(
    'allChats', 'nativeDirectTurnIsSuperseded', 'nativeReplyQueuedIds', 'nativeTerminalDispositionLanding',
    'nativeStructuredActionParts', 'applyAndVerifyNativeStructuredParts', 'applyNativeRelationshipStagePart',
    'messageById', 'nativeResultDisplaySourceMessageId',
    `${applySource}; return applyNativeExecutionTurnUnlocked;`
  );
  let relationshipWrites = 0;
  const apply = makeApply(
    { yuqi: { messages: [{ id: 'user-closed', role: 'user', replyState: 'pending' }], pendingReply: { nativeTurnId: 'turn-closed', userMessageId: 'user-closed' } } },
    () => false,
    new Set(),
    () => ({ handled: false, changed: false }),
    (_result, parts) => parts.filter(part => part?.type !== 'TEXT'),
    async () => false,
    () => { relationshipWrites += 1; return true; },
    chat => chat.messages[0],
    (_chat, result) => result.sourceMessageId
  );
  const failedCanonicalResult = {
    characterId: 'yuqi', kind: 'DIRECT_REPLY', state: 'COMPLETED', terminalDisposition: 'visible',
    resultAuthorityVersion: 1, turnId: 'turn-closed', sourceMessageId: 'user-closed',
    commitChecksum: 'a'.repeat(64),
    replyParts: [
      basePart,
      { replyPartId: 'payment-forged', type: 'PAYMENT_STATUS', payloadJson: JSON.stringify({ canonicalAction: {
        actionId: 'payment-forged', kind: 'payment_accept', targetKey: 'payment:missing', targetRevision: 'd'.repeat(64),
        actionChecksum: 'e'.repeat(64), payload: {}
      } }) }
    ]
  };
  await apply(failedCanonicalResult);
  assert.equal(relationshipWrites, 0, 'invalid canonical action must not run relationship/plan/payment writers');
  for (const invalidPart of [
    { replyPartId: 'moment-forged', type: 'MOMENT_ACTION', payloadJson: JSON.stringify({ canonicalAction: {
      actionId: 'moment-forged', kind: 'moment_like', targetKey: 'moment:missing', targetRevision: 'd'.repeat(64),
      actionChecksum: 'e'.repeat(64), payload: {}
    } }) },
    { replyPartId: 'plan-forged', type: 'PLAN', payloadJson: JSON.stringify({ canonicalAction: {
      actionId: 'plan-forged', kind: 'role_plan_update', targetKey: 'role_plan:missing', targetRevision: 'd'.repeat(64),
      actionChecksum: 'e'.repeat(64), payload: {}
    } }) }
  ]) {
    relationshipWrites = 0;
    await apply({ ...failedCanonicalResult, replyParts: [basePart, invalidPart] });
    assert.equal(relationshipWrites, 0, 'invalid moment/plan targets must not run an earlier relationship writer');
  }
});

test('cognition-v3 relationship, life, and author settings use explicit compact allow-lists', () => {
  const snapshotSource = html.slice(
    html.indexOf('function nativeSnapshotClone'),
    html.indexOf('function withLocalFallbackExecution')
  );
  const { withCognitionV3Snapshot } = new Function(`${snapshotSource}; return { withCognitionV3Snapshot };`)();
  const snapshot = withCognitionV3Snapshot({
    roleId: 'yuqi',
    relationship: {
      id: 'acquainted', label: '熟悉', content: '稳定', since: 10, reason: 'evidence', confidence: 0.8,
      base: { id: 'acquainted', label: '熟悉', content: 'base', changedAt: 11, reason: 'base', confidence: 0.7, evidenceMessageIds: ['m1'], token: 'secret' },
      phase: { id: 'normal', label: '日常', content: 'phase', since: 12, reason: 'phase', confidence: 0.6, evidenceMessageIds: ['m2'], apiKey: 'secret' },
      token: 'secret'
    },
    lifeSignals: {
      mood: 'calm', currentFocus: 'work', energy: 0.5, nextEvent: 'later', updatedAt: 20,
      schedule: { next: 'tomorrow' }, endpoint: 'https://secret', nested: { apiKey: 'secret' }
    },
    authorSettings: {
      displayName: 'Yuqi', tone: 'warm', language: 'zh-CN', timezone: 'Asia/Shanghai',
      quietHours: { start: '23:00', end: '07:00' }, responseStyle: 'natural', apiKey: 'secret',
      fallbackExecution: { contract: 'secret' }
    }
  });
  assert.equal(snapshot.relationship.id, 'acquainted');
  assert.equal(snapshot.relationship.base.evidenceMessageIds[0], 'm1');
  assert.equal(snapshot.lifeSignals.currentFocus, 'work');
  assert.equal(snapshot.authorSettings.quietHours.start, '23:00');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|endpoint|apiKey|fallbackExecution/);
});

test('v3 completion uses Room authority before legacy receipts and exposes its UI contract', () => {
  const receiptFlow = executionService.slice(
    executionService.indexOf('private void confirmBridgeDelivery'),
    executionService.indexOf('private void acknowledgeCloudTurn')
  );
  assert.match(executionService, /new\s+BridgeReceiptDeliveryCoordinator\(/);
  assert.ok(
    receiptFlow.indexOf('shouldUseCanonicalReceipt') < receiptFlow.indexOf('attempt.memoryResult'),
    'v3 must branch to the Room authority coordinator before the legacy memoryResult receipt'
  );
  assert.match(receiptFlow, /bridgeReceiptCoordinator\.deliver\(turn\.turnId\)/);
  assert.match(executionService, /AlNotificationPolicy\.shouldNotifyCompletedTurn\(/);
  for (const field of [
    'bridgeProtocolVersion', 'authorityLineageKey', 'visibleGroupId', 'commitChecksum',
    'terminalDisposition', 'lineageRevision', 'turnRevision', 'laneRevision',
    'inputVisibilitySequence', 'inputClearEpoch', 'bridgeAuthorityCheckpointChecksum',
    'bridgeDeliveryRoute', 'bridgeRelayMessageId'
  ]) {
    assert.match(plugin, new RegExp(`result\\.put\\("${field}"`), `plugin must expose ${field}`);
  }
});

test('native text bubbles use deterministic per-turn part and chunk identities', () => {
  assert.match(html, /function\s+nativeReplyBubbleId\(turnId,\s*replyPartId,\s*chunkIndex\)/);
  assert.match(html, /nativeReplyBubbleId\(result\.turnId,\s*part\.replyPartId,\s*index\)/);
  assert.match(html, /if\s*\(messageById\(chat,\s*messageId\)\)\s*return/);
  assert.match(html, /sourceReplyChunkId/);
});

test('startup cleanup removes only empty native reply envelopes from assistant bubbles', () => {
  assert.match(html, /function\s+isLeakedNativeReplyEnvelope\(message\)/);
  const cleanup = html.slice(
    html.indexOf('function isLeakedNativeReplyEnvelope'),
    html.indexOf('function scrubEmptyReplyMessages')
  );
  assert.match(cleanup, /message\?\.role\s*!==\s*'assistant'/);
  assert.match(cleanup, /startsWith\('native:'\)/);
  assert.match(cleanup, /KNOWN_LEAKED_NATIVE_TURN_IDS\.has\(sourceTurnId\)/);
  assert.match(cleanup, /JSON\.parse\(/);
  assert.match(cleanup, /parsed\.reply\s*===\s*''/);
  assert.match(cleanup, /Array\.isArray\(parsed\.usedFactIds\)/);
  assert.match(html, /isLeakedNativeReplyEnvelope\(m\)/);
});

test('startup cleanup removes the two duplicate cloud backfill turns already shown on the phone', () => {
  assert.match(html, /native:cloud_backfill_8ab238352447c110cb4fd7dd/);
  assert.match(html, /native:cloud_backfill_849cd4bbf59b290244ea0a64/);
});

test('a late bridge failure cannot overwrite a reply that already completed', () => {
  const markFailed = executionStore.slice(
    executionStore.indexOf('public void markFailed('),
    executionStore.indexOf('@Override\n    public void commitReply(')
  );
  assert.match(markFailed, /TurnState\.COMPLETED\.name\(\)\.equals\(turn\.state\)/);
  assert.match(markFailed, /throw new StaleAttemptException\(turnId, attemptId\)/);
  assert.match(executionDao, /UPDATE chat_turns SET state = :state[^\n]+state != 'COMPLETED'/);
});

test('retryable Android bridge failures stay pending and are recovered in the background', () => {
  const applyTurn = html.slice(
    html.indexOf('async function applyNativeExecutionTurnUnlocked'),
    html.indexOf('function applyNativeExecutionTurn(result)')
  );
  assert.match(applyTurn, /state === 'FAILED_RETRYABLE'/);
  assert.doesNotMatch(applyTurn, /\['FAILED_RETRYABLE',\s*'FAILED_FINAL',\s*'INTERRUPTED'\]/);
  assert.match(applyTurn, /userMessage\.replyState = 'pending'/);
  assert.match(applyTurn, /网络不稳定，正在重新送达/);
  assert.match(executionDao, /state = 'FAILED_RETRYABLE'/);
  assert.match(executionStore, /recoverDueRetries\(long now\)/);
  assert.match(executionStore, /latestDirectCreatedAtByCharacter/);
  assert.match(executionService, /executionStore\.recoverDueRetries\(System\.currentTimeMillis\(\)\)/);
  assert.match(executionService, /AlExecutionWakeWorker\.enqueue\(this,\s*retries\.nextDelaySeconds\)/);
});

test('a previously stored late reply repairs a stale failed turn instead of returning early', () => {
  const importReply = executionDao.slice(
    executionDao.indexOf('default boolean importCloudBacklogReply('),
    executionDao.indexOf('default boolean importCloudBacklogFailure(')
  );
  assert.match(importReply, /boolean\s+replyAlreadyStored/);
  assert.match(importReply, /replyAlreadyStored[\s\S]*completeImportedCloudTurn/);
  assert.doesNotMatch(importReply, /value\.replyPartId\.equals\(part\.replyPartId\)[^\n]+return true/);
});

test('startup repairs the known delivered reply that still carries a failed badge', () => {
  assert.match(html, /function\s+repairKnownDeliveredReplyStates\(chats\)/);
  assert.match(html, /native:cloud_backfill_b64cf8b2ea6e81b54e9b8f3b/);
  assert.match(html, /turn_msg_1784629780470_5kv9vd/);
  assert.match(html, /delete userMessage\.replyState/);
  assert.match(html, /delete userMessage\.replyError/);
});

test('Android foreground proactive chat enters the native PROACTIVE_CHAT queue', () => {
  assert.match(html, /async function\s+queueAndroidProactiveTurn\(/);
  assert.match(html, /kind:\s*'PROACTIVE_CHAT'/);
  assert.match(html, /await\s+syncYuqiVisibleHistory\(charId/);
  const proactive = html.slice(
    html.indexOf('async function triggerProactiveMessage'),
    html.indexOf('async function triggerProactiveMoment')
  );
  assert.match(proactive, /if\s*\(isNativeApp\(\)\)\s*\{\s*return\s+queueAndroidProactiveTurn/);
  assert.ok(
    proactive.indexOf('if (isNativeApp())') < proactive.indexOf('prepareConversationContextSafe'),
    'native delegation must happen before the legacy memory/chat API path'
  );
});

test('phone-visible history is ingested before direct and proactive bridge submission', () => {
  assert.match(html, /async function\s+syncYuqiVisibleHistory\(/);
  assert.match(plugin, /void\s+ingestVisibleMessages\(PluginCall call\)/);
  const direct = html.slice(
    html.indexOf('async function queueAndroidUserReply'),
    html.indexOf('async function mirrorAppStateNow')
  );
  assert.match(direct, /await\s+syncYuqiVisibleHistory\(charId/);
});

test('Android Service Worker proactive pushes defer to native execution before model calls', () => {
  const proactiveWorker = worker.slice(
    worker.indexOf('async function handleProactivePush'),
    worker.indexOf('async function handleProactiveMomentPush')
  );
  assert.match(proactiveWorker, /isAndroidNativeDelivery\(payload\)/);
  assert.match(proactiveWorker, /AL_NATIVE_PROACTIVE_DUE/);
  assert.ok(
    proactiveWorker.indexOf('isAndroidNativeDelivery(payload)') < proactiveWorker.indexOf('callModel('),
    'Android native guard must run before legacy model generation'
  );
});

test('immersive bridge progress uses natural copy while diagnostics retain technical fields', () => {
  assert.match(html, /function\s+yuqiImmersiveProgressText\(/);
  assert.match(html, /正在翻一下我们以前说过的话/);
  assert.match(html, /正在认真想/);
  assert.match(html, /快好了/);
  const immersive = html.slice(
    html.indexOf('function yuqiImmersiveProgressText'),
    html.indexOf('function stableLegacyVisibleMessageId')
  );
  assert.doesNotMatch(immersive, /gpt-|terra|sol|提示词|记忆库/i);
  assert.match(plugin, /BRIDGE_STATUS/);
  assert.match(plugin, /stageModel/);
  assert.match(plugin, /stageEffort/);
  assert.match(plugin, /stageElapsedMs/);
  assert.match(plugin, /totalElapsedMs/);
});

test('local queue and cloud handoff are not presented as remote model thinking', () => {
  const progress = html.slice(
    html.indexOf('function yuqiImmersiveProgressText'),
    html.indexOf('function stableLegacyVisibleMessageId')
  );
  assert.match(progress, /正在把消息交给后台/);
  assert.match(progress, /正在把消息送过去/);
  assert.match(progress, /bridge_waiting|cloud_accepted/);
});

test('cloud enqueue hands off to the independent inbox drain without long polling', () => {
  const sendCloud = bridgeClient.slice(
    bridgeClient.indexOf('public BridgeResult sendCloud'),
    bridgeClient.indexOf('public int drainCloudInbox')
  );
  assert.match(sendCloud, /requireSuccess\(enqueued,\s*"cloud enqueue"\)[\s\S]*completeCloudHandoff\(\)/);
  assert.doesNotMatch(sendCloud, /bridge\/poll|while\s*\(clock\.now\(\)\s*<\s*deadline\)/);
});

test('canonical role-plan bundles use one browser-side compare-and-swap boundary', () => {
  const memoryDb = html.slice(
    html.indexOf('const MemoryDB = {'),
    html.indexOf('async function saveMemory')
  );
  assert.match(memoryDb, /async compareAndSwapRolePlanBundle\(bundle\)/);
  assert.match(memoryDb, /db\.transaction\('meta', 'readwrite'\)/);
  assert.match(memoryDb, /globalThis\.navigator\?\.locks/);
  assert.match(memoryDb, /canonical role plan CAS unavailable/);
  assert.match(memoryDb, /expectedScopeChecksum/);
  assert.match(memoryDb, /incomingActionIds/);
  assert.match(memoryDb, /canonicalActionApplications/);
  assert.match(memoryDb, /status: 'stale'/);
});

test('Task15 exposes a bounded cognition-v3 semantic view and separate local fallback carrier', () => {
  assert.match(html, /function\s+withCognitionV3Snapshot\(/);
  assert.match(html, /function\s+withLocalFallbackExecution\(/);
  const snapshot = html.slice(html.indexOf('function withCognitionV3Snapshot'), html.indexOf('async function buildNativeExecutionSnapshot'));
  for (const key of ['contract', 'schemaVersion', 'roleId', 'hardConstraints', 'preferences', 'currentStances', 'relationship', 'recentGroups', 'verifiedFacts', 'lifeSignals', 'authorSettings']) {
    assert.match(snapshot, new RegExp(`['"]?${key}['"]?`), `missing semantic key ${key}`);
  }
  assert.match(snapshot, /fallbackExecution/);
  assert.match(snapshot, /cognition-v3-fallback-v1/);
  assert.match(snapshot, /deviceId/);
  assert.match(snapshot, /Object\.keys\(fallbackExecution\)/);
});

test('Task15 keeps local fallback inputs out of direct wire context and allows compact semantic data only for automatic triggers', () => {
  const queue = html.slice(html.indexOf('async function queueAndroidUserReply'), html.indexOf('async function mirrorAppStateNow'));
  assert.match(queue, /getYuqiVisibilityCursor/);
  assert.match(queue, /buildAndroidUserReplyTask/);
  assert.match(queue, /submitTurn/);
  assert.ok(queue.indexOf('getYuqiVisibilityCursor') < queue.indexOf('buildAndroidUserReplyTask'), 'cursor must be read before task serialization');
  assert.ok(queue.indexOf('buildAndroidUserReplyTask') < queue.lastIndexOf('plugin.submitTurn'), 'task serialization must precede native submit');
  const bridgePreparation = html.slice(html.indexOf('function buildAndroidUserReplyTask'), html.indexOf('async function dumpCharacterMemoryForRunner'));
  assert.doesNotMatch(bridgePreparation, /fallbackExecution/);
  const automatic = html.slice(html.indexOf('async function syncNativeProactiveSnapshot'), html.indexOf('function rolePlanSnapshotId'));
  assert.match(automatic, /snapshot/);
  assert.match(automatic, /withCognitionV3Snapshot/);
});

test('Task15 completion handling has one shared event/poll/reload drain and disposition-specific landing rules', () => {
  const reconcile = html.slice(html.indexOf('async function drainNativeUiInbox'), html.indexOf('function nativeReplyFailureMessage'));
  assert.match(reconcile, /drainNativeUiInbox/);
  assert.match(html.slice(html.indexOf('function reconcileNativeExecutionTurns()'), html.indexOf('function startNativeReplyPolling')), /finally/);
  assert.match(html.slice(html.indexOf('function nativeTerminalUiLanding'), html.indexOf('function withNativePromiseTimeout')), /replyParts/);
  const apply = html.slice(html.indexOf('function nativeTerminalUiLanding'), html.indexOf('async function applyNativeExecutionTurnUnlocked'));
  assert.match(apply, /action_only/);
  assert.match(apply, /skip/);
  assert.match(apply, /replyParts/);
  assert.match(html, /acknowledgeUiApplied/);
  assert.match(html, /notification/i);
  assert.match(html, /stage === 'queued' \|\| stage === 'pending'/);
  assert.match(html, /stage\.includes\('cloud_accepted'\)/);
  assert.match(html, /正在把消息送过去/);
  assert.match(html, /消息已到云端，正在等待电脑接收/);
});

test('phone recovery guard owns the first native boot decision and blocks state writers', () => {
  assert.match(html, /<script src="\.\/lib\/app-state-recovery\.js"><\/script>/);
  const db = html.slice(html.indexOf('const DB ='), html.indexOf('const EMOJI_CATEGORIES'));
  assert.match(db, /appStateRecoveryGuard\.assertWritable\(k\)/);

  const mirror = html.slice(
    html.indexOf('async function mirrorAppStateNow'),
    html.indexOf('async function mirrorAppState()')
  );
  assert.match(mirror, /appStateRecoveryGuard\.assertWritable\('app_state'\)/);

  const sync = html.slice(
    html.indexOf('async function syncFromServiceWorkerState'),
    html.indexOf('async function bootApp()')
  );
  assert.match(sync, /if\s*\(appStateRecoveryGuard\.frozen\)\s*return false/);

  const boot = html.slice(html.indexOf('async function bootApp()'), html.indexOf('bootApp();'));
  const recovery = boot.indexOf('await prepareAppStateRecovery()');
  assert.ok(recovery >= 0, 'boot must resolve recovery before native side effects');
  for (const sideEffect of [
    'startNativeReplyPolling();',
    'ensureNativeExecutionCompletedListener()',
    'syncFromServiceWorkerState(',
    'startProactiveLoop();',
    'mirrorAppStateNow()'
  ]) {
    assert.ok(recovery < boot.indexOf(sideEffect), `recovery gate must precede ${sideEffect}`);
  }
  assert.match(boot, /if\s*\(recoveryDecision\.frozen\)\s*\{[\s\S]*renderAppStateRecoveryBlocker/);
});
