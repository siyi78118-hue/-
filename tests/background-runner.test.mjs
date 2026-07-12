import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const runnerSource = readFileSync('tavern-app/runners/al-background.js', 'utf8');

function createHarness({ queue, failChat = false } = {}) {
  const rows = new Map();
  const handlers = new Map();
  const fetchCalls = [];
  const notifications = [];
  const now = Date.now();
  const state = {
    settings: {
      timerEndpoint: 'https://timer.example',
      deviceId: 'device-a',
      cloudTimerEnabled: true,
      chatApiType: 'openai',
      chatApiUrl: 'https://chat.example/v1',
      chatApiKey: 'sk-chat',
      chatModel: 'chat-model',
      memoryApiType: 'openai',
      memoryApiUrl: 'https://memory.example/v1',
      memoryApiKey: 'sk-memory',
      memoryModel: 'memory-model',
      maxTokens: 800,
      temperature: 0.8
    },
    characters: [{ id: 'char-a', name: '许弥' }],
    allChats: {
      'char-a': {
        messages: [{ id: 'user-1', role: 'user', content: '晚点聊', time: now - 3600000 }],
        pendingProactiveJob: { jobId: 'chat-job', kind: 'chat' },
        pendingMomentJob: { jobId: 'moment-job', kind: 'moment' }
      }
    },
    allMoments: [],
    memory: {
      events: [{ id: 'memory-1', charId: 'char-a', type: 'promise', title: '晚点聊', detail: '玩家和许弥说晚点聊', happenedAt: new Date(now - 3600000).toISOString(), importance: 4 }]
    },
    prepared: {
      'char-a': {
        playerName: '姜隽倚',
        chatSystem: '你是许弥，只输出微信聊天正文。',
        momentSystem: '你是许弥，正在朋友圈发布动态。',
        momentMessages: [{ role: 'user', content: '根据现在的生活发一条朋友圈。' }]
      }
    },
    updatedAt: now
  };
  rows.set('state_json', JSON.stringify(state));
  rows.set('pending_push_queue', JSON.stringify(queue || [
    { type: 'proactive', deviceId: 'device-a', charId: 'char-a', jobId: 'chat-job', kind: 'chat', mode: 'planned' },
    { type: 'proactive', deviceId: 'device-a', charId: 'char-a', jobId: 'moment-job', kind: 'moment', mode: 'dice' }
  ]));

  const context = {
    console,
    Date,
    Math,
    JSON,
    URL,
    CapacitorKV: {
      get(key) { return rows.get(key) ?? null; },
      set(key, value) { rows.set(key, String(value)); },
      remove(key) { rows.delete(key); }
    },
    CapacitorNotifications: {
      schedule(items) { notifications.push(...items); }
    },
    addEventListener(name, handler) { handlers.set(name, handler); },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      fetchCalls.push({ url: String(url), body });
      if (String(url).startsWith('https://timer.example/')) {
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"ok":true}' };
      }
      if (String(url).startsWith('https://memory.example/')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ choices: [{ message: { content: '无相关记忆' } }] })
        };
      }
      if (failChat) throw new Error('chat provider offline');
      const isMoment = String(body?.messages?.[0]?.content || '').includes('朋友圈发布动态');
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ message: { content: isMoment ? '{"text":"刚忙完，出去透口气"}' : '刚看到\n还没睡？' } }] })
      };
    }
  };
  vm.createContext(context);
  vm.runInContext(runnerSource, context);

  return {
    context,
    rows,
    fetchCalls,
    notifications,
    async dispatch(name) {
      const handler = handlers.get(name);
      assert.ok(handler, `missing handler ${name}`);
      return new Promise((resolve, reject) => handler(resolve, reject, {}));
    }
  };
}

test('one remote notification wake drains every payload already persisted in the native queue', async () => {
  const harness = createHarness();
  await harness.dispatch('remoteNotification');

  assert.deepEqual(JSON.parse(harness.rows.get('pending_push_queue')), []);
  const state = JSON.parse(harness.rows.get('state_json'));
  assert.ok(state.allChats['char-a'].messages.some(row => row.proactive && row.role === 'assistant'));
  assert.ok(state.allMoments.some(row => row.proactive && row.charId === 'char-a'));
  const acknowledgements = harness.fetchCalls.filter(row => row.url === 'https://timer.example/ack');
  assert.deepEqual(acknowledgements.map(row => row.body.jobId).sort(), ['chat-job', 'moment-job']);
  assert.ok(harness.fetchCalls.some(row => row.url === 'https://memory.example/v1/chat/completions'));
  assert.ok(harness.fetchCalls.some(row => row.url === 'https://chat.example/v1/chat/completions'));
});

test('a failed generation remains queued and is not acknowledged', async () => {
  const harness = createHarness({
    failChat: true,
    queue: [{ type: 'proactive', deviceId: 'device-a', charId: 'char-a', jobId: 'chat-job', kind: 'chat', mode: 'planned' }]
  });
  await assert.rejects(harness.dispatch('remoteNotification'), /chat provider offline/);
  assert.deepEqual(JSON.parse(harness.rows.get('pending_push_queue')).map(row => row.jobId), ['chat-job']);
  assert.equal(harness.fetchCalls.some(row => row.url === 'https://timer.example/ack'), false);
  assert.equal(harness.fetchCalls.some(row => row.url === 'https://timer.example/schedule'), false, '失败任务由原云任务重试，不得另建随机任务');
});

test('the headless runner rejects an AL page as a model API root', () => {
  const harness = createHarness();
  assert.throws(
    () => harness.context.apiEndpoint('https://siyi78118-hue.github.io/-/tavern-app/', 'chat/completions'),
    /AL.*不是模型接口/
  );
});
