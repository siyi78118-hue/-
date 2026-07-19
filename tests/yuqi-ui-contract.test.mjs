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
