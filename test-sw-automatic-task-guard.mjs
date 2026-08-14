import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('tavern-app/sw-v11.js', 'utf8');
const directorSource = readFileSync('tavern-app/lib/live-chat-director.js', 'utf8');

assert.match(source, /function automaticTasksEnabled\(currentSettings\s*=\s*\{\}\)/);
assert.match(source, /async function automaticTasksStillEnabled\(\)/);
assert.match(source, /if \(!automaticTasksEnabled\(state\.settings\)\) return false;/);

const listeners = new Map();
const context = vm.createContext({
  URL,
  crypto: webcrypto,
  TextEncoder,
  structuredClone,
  console,
  fetch: async () => { throw new Error('unexpected fetch'); },
  setTimeout,
  clearTimeout,
  importScripts() {},
  caches: {
    open: async () => ({ addAll: async () => {}, put: async () => {} }),
    keys: async () => [],
    delete: async () => true,
    match: async () => null
  },
  self: {
    addEventListener(type, handler) { listeners.set(type, handler); },
    skipWaiting() {},
    clients: {
      claim: async () => {},
      matchAll: async () => []
    },
    registration: {
      showNotification: async () => {},
      getNotifications: async () => []
    }
  }
});

vm.runInContext(directorSource, context, { filename: 'tavern-app/lib/live-chat-director.js' });
context.self.ALLiveChatDirector = context.ALLiveChatDirector;
vm.runInContext(source, context, { filename: 'tavern-app/sw-v11.js' });
vm.runInContext('globalThis.__originalScheduleNextCloudProactive = scheduleNextCloudProactive;', context);

const enabledSemantics = vm.runInContext(`JSON.stringify([
  automaticTasksEnabled({ proactiveEnabled: true, cloudTimerEnabled: true }),
  automaticTasksEnabled({ proactiveEnabled: true, cloudTimerEnabled: false }),
  automaticTasksEnabled({ proactiveEnabled: false, cloudTimerEnabled: true }),
  automaticTasksEnabled({})
])`, context);
assert.equal(enabledSemantics, JSON.stringify([true, false, false, false]));

const disabledEntry = await vm.runInContext(`(async () => {
  let setMetaCalls = 0;
  let modelCalls = 0;
  const disabledState = {
    settings: { proactiveEnabled: false, cloudTimerEnabled: false },
    characters: [],
    allChats: {}
  };
  getMeta = async () => disabledState;
  setMeta = async () => { setMetaCalls += 1; };
  callModel = async () => { modelCalls += 1; return 'unexpected'; };
  const result = await handleProactivePush({ type: 'proactive', charId: 'char-1', kind: 'moment' });
  return JSON.stringify({ result, setMetaCalls, modelCalls });
})()`, context);
assert.deepEqual(JSON.parse(disabledEntry), { result: false, setMetaCalls: 0, modelCalls: 0 });

const disabledRecovery = await vm.runInContext(`(async () => {
  let scheduleCalls = 0;
  let setMetaCalls = 0;
  const disabledState = {
    settings: { proactiveEnabled: false, cloudTimerEnabled: false },
    allChats: { 'char-1': { pendingMomentJob: { jobId: 'mom-old' } } }
  };
  getMeta = async () => disabledState;
  setMeta = async () => { setMetaCalls += 1; };
  scheduleNextCloudProactive = async () => { scheduleCalls += 1; return true; };
  const result = await recoverProactivePushFailure({ charId: 'char-1', kind: 'moment' }, new Error('boom'));
  return JSON.stringify({ result, scheduleCalls, setMetaCalls });
})()`, context);
assert.deepEqual(JSON.parse(disabledRecovery), { result: false, scheduleCalls: 0, setMetaCalls: 0 });

const midFlightDisable = await vm.runInContext(`(async () => {
  let mirroredEnabled = true;
  let scheduleCalls = 0;
  let setMetaCalls = 0;
  const state = {
    settings: {
      proactiveEnabled: true,
      cloudTimerEnabled: true,
      chatApiUrl: 'https://chat.example/v1',
      chatApiKey: 'key',
      chatModel: 'model'
    },
    characters: [{ id: 'char-1', name: '角色' }],
    allChats: {
      'char-1': {
        messages: [{ role: 'user', content: 'hello', time: 1 }],
        pendingMomentJob: { jobId: 'mom-current' }
      }
    },
    allMoments: []
  };
  getMeta = async () => ({
    settings: {
      proactiveEnabled: mirroredEnabled,
      cloudTimerEnabled: mirroredEnabled
    }
  });
  setMeta = async () => { setMetaCalls += 1; };
  refreshBackgroundPaymentExpirations = async () => false;
  buildBackgroundMomentContext = () => '';
  buildMemoryPack = async () => '';
  buildBackgroundMomentPostSystem = () => ({ system: '', promptBlocks: [] });
  proactiveRecentMessages = () => [];
  recentMessageCandidateCount = () => 0;
  callModel = async () => {
    mirroredEnabled = false;
    return '{"text":"不应写入的动态"}';
  };
  scheduleNextCloudProactive = async () => { scheduleCalls += 1; return true; };
  const result = await handleProactiveMomentPush(state, 'char-1', { kind: 'moment', jobId: 'mom-current' });
  return JSON.stringify({
    result,
    scheduleCalls,
    setMetaCalls,
    moments: state.allMoments.length,
    messages: state.allChats['char-1'].messages.length,
    pendingJobKept: state.allChats['char-1'].pendingMomentJob?.jobId === 'mom-current'
  });
})()`, context);
assert.deepEqual(JSON.parse(midFlightDisable), {
  result: false,
  scheduleCalls: 0,
  setMetaCalls: 0,
  moments: 0,
  messages: 1,
  pendingJobKept: true
});

const enabledRecovery = await vm.runInContext(`(async () => {
  let scheduleCalls = 0;
  let setMetaCalls = 0;
  const enabledState = {
    settings: { proactiveEnabled: true, cloudTimerEnabled: true },
    allChats: { 'char-1': { pendingProactiveJob: { jobId: 'pro-current' } } }
  };
  getMeta = async () => enabledState;
  setMeta = async () => { setMetaCalls += 1; };
  scheduleNextCloudProactive = async () => { scheduleCalls += 1; return true; };
  const result = await recoverProactivePushFailure({ charId: 'char-1', kind: 'chat' }, new Error('boom'));
  return JSON.stringify({ result, scheduleCalls, setMetaCalls });
})()`, context);
assert.deepEqual(JSON.parse(enabledRecovery), { result: true, scheduleCalls: 1, setMetaCalls: 1 });

const nativeOwnerReadOnly = await vm.runInContext(`(async () => {
  let fetchCalls = 0;
  const chat = {
    stable: 'unchanged',
    pendingProactiveJob: { jobId: 'legacy-chat', dueAt: '2026-08-15T12:00:00.000Z' }
  };
  const state = {
    automaticScheduleOwner: 'android-v1',
    settings: {
      proactiveEnabled: true,
      cloudTimerEnabled: true,
      timerEndpoint: 'https://timer.example',
      pushSubscription: { transport: 'fcm', token: 'keep-token' },
      deviceId: 'device-1'
    },
    allChats: { 'char-1': chat }
  };
  fetchWithTimeout = async () => { fetchCalls += 1; throw new Error('native owner must not fetch'); };
  const before = JSON.stringify(state);
  const result = await __originalScheduleNextCloudProactive(state, 'char-1', 'chat', { mode: 'planned' });
  return JSON.stringify({ result, fetchCalls, before, after: JSON.stringify(state) });
})()`, context);
const nativeOwnerResult = JSON.parse(nativeOwnerReadOnly);
assert.equal(nativeOwnerResult.result, false);
assert.equal(nativeOwnerResult.fetchCalls, 0);
assert.equal(nativeOwnerResult.after, nativeOwnerResult.before, 'Android-owned SW scheduling must be read-only');

const enabledScheduling = await vm.runInContext(`(async () => {
  const paths = [];
  const payloads = [];
  const state = {
    settings: {
      proactiveEnabled: true,
      cloudTimerEnabled: true,
      timerEndpoint: 'https://timer.example',
      pushSubscription: { transport: 'fcm', token: 'keep-token' },
      deviceId: 'device-1',
      proactiveIdleMinutes: 30
    },
    allChats: { 'char-1': {} }
  };
  getMeta = async () => state;
  fetchWithTimeout = async (url, options = {}) => {
    paths.push(new URL(url).pathname);
    payloads.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const result = await __originalScheduleNextCloudProactive(state, 'char-1', 'chat', { mode: 'planned' });
  return JSON.stringify({
    result,
    paths,
    payloads,
    jobKind: state.allChats['char-1'].pendingProactiveJob?.kind,
    jobMode: state.allChats['char-1'].pendingProactiveJob?.mode,
    jobOwner: state.allChats['char-1'].pendingProactiveJob?.owner
  });
})()`, context);
const enabledResult = JSON.parse(enabledScheduling);
assert.deepEqual({
  result: enabledResult.result,
  paths: enabledResult.paths,
  jobKind: enabledResult.jobKind,
  jobMode: enabledResult.jobMode,
  jobOwner: enabledResult.jobOwner
}, {
  result: true,
  paths: ['/v2/schedule-transitions'],
  jobKind: 'chat',
  jobMode: 'planned',
  jobOwner: 'web-v1'
});
assert.equal(enabledResult.payloads[0].protocolVersion, 2);
assert.equal(enabledResult.payloads[0].owner, 'web-v1');
assert.equal(enabledResult.payloads[0].generation, 1);
assert.equal(enabledResult.payloads[0].expectedPreviousJobId, null);
assert.match(enabledResult.payloads[0].authorityEpoch, /^[a-f0-9]{32}$/);
assert.equal(enabledResult.payloads[0].jobId, `pro_${enabledResult.payloads[0].transitionChecksum.slice(0, 16)}_1`);

console.log('Service Worker automatic-task guard tests passed.');
