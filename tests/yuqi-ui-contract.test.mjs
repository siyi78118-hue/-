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
const worker = readFileSync('tavern-app/sw-v11.js', 'utf8');
const corePreset = readFileSync('tavern-app/lib/yuqi-core-preset.js', 'utf8');

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

test('normal direct and background context is 200 raw messages', () => {
  assert.match(engine, /source\.length\(\)\s*-\s*200/);
  assert.match(html, /const NORMAL_RAW_CONTEXT_LIMIT = 200;/);
  assert.match(worker, /const NORMAL_RAW_CONTEXT_LIMIT = 200;/);
  assert.doesNotMatch(html, /固定最近30条|最近30条聊天会完整提供/);
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
  assert.match(html, /inputJson:\s*JSON\.stringify\(\{[\s\S]*?message:\s*\{[\s\S]*?messageId:\s*userMessageId/);
  assert.match(html, /speakerId:\s*'user'[\s\S]*?speakerType:\s*'user'/);
  assert.match(html, /content:\s*messageContentForAI\(userMessage\)/, '桥接原话库必须持久化引用归属和用户本次正文');
  assert.match(html, /sentAt:\s*Number\(userMessage\.time\)\s*\|\|\s*task\.createdAt/);
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
  assert.match(html, /const\s+wireAttachments\s*=\s*\(task\.options\.attachments/);
  assert.match(html, /\.\.\.\(wireAttachments\.length\s*\?\s*\{\s*attachments:\s*wireAttachments\s*\}\s*:\s*\{\s*\}\)/);
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
  assert.match(html, /熟悉 · 闹矛盾期/);
});

test('native retry creates a fresh execution turn for the canonical message', () => {
  const retry = html.slice(html.indexOf('async function retryFailedReply'), html.indexOf('function showReplyFailureReason'));
  assert.match(retry, /const\s+task\s*=\s*buildAndroidUserReplyTask/);
  assert.match(retry, /const\s+snapshot\s*=\s*await\s+buildNativeExecutionSnapshot\(charId,\s*task\)/);
  assert.match(retry, /const\s+retryOfTurnId\s*=/);
  assert.match(retry, /nativeRetryTurnIdForMessage\(userMessageId\)/);
  assert.match(retry, /plugin\.submitTurn\(\{[\s\S]*?turnId[\s\S]*?inputJson:[\s\S]*?retryOfTurnId[\s\S]*?canonicalMessageId:\s*userMessageId[\s\S]*?snapshotJson:\s*JSON\.stringify\(snapshot\)/);
  assert.doesNotMatch(retry, /plugin\.retryTurn/);
});

test('Room persists fresh retry turns and only deduplicates an exact turn id', () => {
  assert.doesNotMatch(chatTurnEntity, /@Index\(value = \{"sourceMessageId"\}, unique = true\)/);
  assert.match(chatTurnEntity, /@Index\(value = \{"sourceMessageId"\}\)/);
  assert.match(executionDatabase, /version\s*=\s*9/);
  assert.match(executionDatabase, /new Migration\(8,\s*9\)/);
  assert.match(executionDatabase, /DROP INDEX IF EXISTS `index_chat_turns_sourceMessageId`/);
  assert.match(executionDatabase, /CREATE INDEX IF NOT EXISTS `index_chat_turns_sourceMessageId`/);
  const submit = executionStore.slice(
    executionStore.indexOf('public ChatTurnEntity submitTurn'),
    executionStore.indexOf('public ExecutionAttemptEntity startRetry')
  );
  assert.match(submit, /dao\.turn\(submission\.turnId\)/);
  assert.doesNotMatch(submit, /dao\.turnBySourceMessage\(submission\.sourceMessageId\)/);
});

test('native retry is accepted only when Room returns the requested turn id', () => {
  const retry = html.slice(html.indexOf('async function retryFailedReply'), html.indexOf('function showReplyFailureReason'));
  assert.match(retry, /String\(result\?\.turnId\s*\|\|\s*''\)\s*!==\s*turnId/);
  assert.match(retry, /throw new Error\(/);
  assert.ok(
    retry.indexOf("String(result?.turnId || '') !== turnId") < retry.indexOf('nativeAcceptedAt'),
    'a mismatched native turn must be rejected before the retry is marked accepted'
  );
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
    html.indexOf('const userMessage = messageById(chat, result?.sourceMessageId)'),
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
    proactive.indexOf('if (isNativeApp())') < proactive.indexOf('prepareProactiveMemoryPack'),
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
