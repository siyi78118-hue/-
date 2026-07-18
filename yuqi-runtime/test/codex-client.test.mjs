import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CodexAppServerClient } from '../src/codex-client.mjs';
import { YuqiStore } from '../src/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, 'fixtures', 'fake-app-server.mjs');

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-codex-client-'));
  const logFile = join(dir, 'protocol.jsonl');
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [fakeServer],
    cwd: dir,
    store,
    env: { ...process.env, FAKE_APP_SERVER_LOG: logFile },
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000
  });
  try {
    await run({ client, store, logFile });
  } finally {
    await client.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function methods(logFile) {
  return readFileSync(logFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(item => item.method)
    .map(item => item.method);
}

test('initializes once and resumes a stored role thread', async () => fixture(async ({ client, store, logFile }) => {
  store.setSession('memory', 'thr_memory');
  const result = await client.runTurn('memory', 'find evidence');
  assert.equal(result.text, '{"query":"promise"}');
  assert.equal(result.threadId, 'thr_memory');
  assert.deepEqual(methods(logFile), ['initialize', 'initialized', 'thread/resume', 'turn/start']);
}));

test('starts and persists a thread when a role has no session', async () => fixture(async ({ client, store, logFile }) => {
  const result = await client.runTurn('brain', 'hello');
  assert.equal(result.threadId, 'thr_new_1');
  assert.equal(store.getSession('brain'), 'thr_new_1');
  assert.deepEqual(methods(logFile), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  const started = readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).find(item => item.method === 'thread/start');
  assert.equal(started.params.sandbox, 'read-only');
}));

test('keeps the three role sessions isolated', async () => fixture(async ({ client, store }) => {
  const memory = await client.runTurn('memory', 'm');
  const brain = await client.runTurn('brain', 'b');
  const supervisor = await client.runTurn('supervisor', 's');
  assert.notEqual(memory.threadId, brain.threadId);
  assert.notEqual(brain.threadId, supervisor.threadId);
  assert.equal(store.getSession('memory'), memory.threadId);
  assert.equal(store.getSession('brain'), brain.threadId);
  assert.equal(store.getSession('supervisor'), supervisor.threadId);
}));

test('collects only the final agent message from the matching turn', async () => fixture(async ({ client }) => {
  const result = await client.runTurn('brain', 'hello');
  assert.equal(result.text, 'reply:hello');
  assert.equal(result.turnId, 'turn_fake_1');
}));
