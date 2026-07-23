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

async function fixture(run, options = {}) {
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
    turnTimeoutMs: 2_000,
    ...options
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
  return protocolLines(logFile)
    .filter(item => item.method)
    .map(item => item.method);
}

function protocolLines(logFile) {
  return readFileSync(logFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
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

test('replaces a stored role thread only when its rollout no longer exists', async () => fixture(async ({ client, store, logFile }) => {
  store.setSession('memory', 'thr_missing');
  const result = await client.runTurn('memory', 'find evidence');
  assert.equal(result.threadId, 'thr_new_1');
  assert.equal(store.getSession('memory'), 'thr_new_1');
  assert.deepEqual(methods(logFile), [
    'initialize', 'initialized', 'thread/resume', 'thread/start', 'turn/start'
  ]);
}));

test('does not replace a stored role thread for unrelated resume errors', async () => fixture(async ({ client, store, logFile }) => {
  store.setSession('memory', 'thr_denied');
  await assert.rejects(client.runTurn('memory', 'find evidence'), /permission denied/);
  assert.equal(store.getSession('memory'), 'thr_denied');
  assert.deepEqual(methods(logFile), ['initialize', 'initialized', 'thread/resume']);
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

test('rotates a dedicated role thread after the configured successful turn count', async () => fixture(async ({ client, store, logFile }) => {
  const first = await client.runTurn('brain', 'one');
  const second = await client.runTurn('brain', 'two');
  const third = await client.runTurn('brain', 'three');

  assert.equal(second.threadId, first.threadId);
  assert.notEqual(third.threadId, first.threadId);
  assert.equal(store.getSession('brain'), third.threadId);
  assert.deepEqual(store.getSessionState('brain'), { threadId: third.threadId, turnCount: 1 });
  assert.equal(methods(logFile).filter(method => method === 'thread/start').length, 2);
}, { maxRoleTurns: 2 }));

test('collects only the final agent message from the matching turn', async () => fixture(async ({ client }) => {
  const result = await client.runTurn('brain', 'hello');
  assert.equal(result.text, 'reply:hello');
  assert.equal(result.turnId, 'turn_fake_1');
}));

test('pins the approved model, high effort, and a strict schema for every brain turn', async () => fixture(async ({ client, logFile }) => {
  await client.runTurn('brain', 'draft one reply');
  const started = protocolLines(logFile).find(item => item.method === 'turn/start');
  assert.equal(started.params.model, 'gpt-5.6-sol');
  assert.equal(started.params.effort, 'high');
  assert.deepEqual(started.params.outputSchema.required, ['action', 'reply', 'paymentAction', 'usedFactIds', 'momentAction']);
  assert.equal(started.params.outputSchema.additionalProperties, false);
  assert.deepEqual(started.params.outputSchema.properties.action.enum, ['send', 'skip']);
  assert.equal(started.params.outputSchema.properties.reply.type, 'string');
}));

test('memory candidate objects use the strict nested schema required by the real App Server', async () => fixture(async ({ client, logFile }) => {
  await client.runTurn('memory', 'retrieve evidence');
  const started = protocolLines(logFile).find(item => item.method === 'turn/start');
  const candidate = started.params.outputSchema.properties.candidates.items;
  assert.equal(candidate.additionalProperties, false);
  assert.deepEqual(candidate.required, [
    'factId', 'characterId', 'subjectId', 'predicate', 'object', 'evidenceMode',
    'sourceMessageIds', 'exactQuotes', 'type', 'promisedBy', 'promisedTo', 'confidence',
    'supersedes', 'origin', 'createdAt', 'verifiedAt'
  ]);
  assert.equal(candidate.properties.exactQuotes.items.additionalProperties, false);
}));

test('memory schema requires an evidence-linked ephemeral conversation frame', async () => fixture(async ({ client, logFile }) => {
  await client.runTurn('memory', 'understand the current turn');
  const started = protocolLines(logFile).find(item => item.method === 'turn/start');
  const schema = started.params.outputSchema;
  const frame = schema.properties.conversationFrame;

  assert.ok(schema.required.includes('conversationFrame'));
  assert.deepEqual(frame.required, [
    'surfaceAct', 'intentHypotheses', 'interactionMode', 'emotionalTone', 'relationshipMove',
    'initiative', 'priorTopic', 'interruption', 'activeHooks', 'ambiguities', 'responseRisks',
    'needsNuanceReview'
  ]);
  assert.deepEqual(frame.properties.priorTopic.required, [
    'status', 'summary', 'waitingOn', 'evidenceMessageIds', 'reason'
  ]);
  assert.deepEqual(frame.properties.interruption.required, [
    'requiresReaction', 'reactionReason'
  ]);
  assert.deepEqual(frame.properties.intentHypotheses.items.required, [
    'intent', 'confidence', 'evidenceMessageIds'
  ]);
  assert.equal(frame.additionalProperties, false);
}));
