import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('tavern-app/index.html', 'utf8');
const engine = readFileSync('android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java', 'utf8');
const plugin = readFileSync('android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java', 'utf8');
const worker = readFileSync('tavern-app/sw-v11.js', 'utf8');

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

test('normal direct and background context is 200 raw messages', () => {
  assert.match(engine, /source\.length\(\)\s*-\s*200/);
  assert.match(html, /const NORMAL_RAW_CONTEXT_LIMIT = 200;/);
  assert.match(worker, /const NORMAL_RAW_CONTEXT_LIMIT = 200;/);
  assert.doesNotMatch(html, /固定最近30条|最近30条聊天会完整提供/);
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
  assert.match(html, /content:\s*task\.userText/);
  assert.match(html, /sentAt:\s*Number\(userMessage\.time\)\s*\|\|\s*task\.createdAt/);
});

test('native retry repairs a legacy failed turn with current canonical input and snapshot', () => {
  const retry = html.slice(html.indexOf('async function retryFailedReply'), html.indexOf('function showReplyFailureReason'));
  assert.match(retry, /const\s+task\s*=\s*buildAndroidUserReplyTask/);
  assert.match(retry, /const\s+snapshot\s*=\s*await\s+buildNativeExecutionSnapshot\(charId,\s*task\)/);
  assert.match(retry, /plugin\.retryTurn\(\{[\s\S]*?turnId[\s\S]*?inputJson:[\s\S]*?speakerId:\s*'user'[\s\S]*?content:\s*task\.userText[\s\S]*?snapshotJson:\s*JSON\.stringify\(snapshot\)/);
});

test('native completed replies retain bridge provenance without changing bubble copy', () => {
  assert.match(plugin, /result\.put\("origin",[\s\S]*result\.put\("fallback",[\s\S]*result\.put\("attemptedRoutes",/);
  assert.match(html, /function\s+nativeReplyProvenance\(result\)/);
  assert.match(html, /replyOrigin:\s*String\(result\?\.origin/);
  assert.match(html, /replyFallback:\s*result\?\.fallback\s*===\s*true/);
  assert.match(html, /replyAttemptedRoutes:\s*Array\.isArray\(result\?\.attemptedRoutes\)/);
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
