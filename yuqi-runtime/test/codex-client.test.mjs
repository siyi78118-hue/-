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

function assertEveryObjectRequiresEveryProperty(schema, path = 'root') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    const propertyNames = Object.keys(schema.properties || {}).sort();
    const requiredNames = [...(schema.required || [])].sort();
    assert.deepEqual(
      requiredNames,
      propertyNames,
      `${path} must require every declared property for strict structured output`
    );
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required') continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertEveryObjectRequiresEveryProperty(item, `${path}.${key}[${index}]`));
    } else if (value && typeof value === 'object') {
      assertEveryObjectRequiresEveryProperty(value, `${path}.${key}`);
    }
  }
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

test('adds validated local image paths after the text input for multimodal role turns', async () => fixture(async ({ client, logFile }) => {
  await client.runTurn('brain', 'look at this image', {
    localImagePaths: ['C:\\tmp\\yuqi-image-1.jpg']
  });
  const started = protocolLines(logFile).find(item => item.method === 'turn/start');
  assert.deepEqual(started.params.input, [
    { type: 'text', text: 'look at this image' },
    { type: 'localImage', path: 'C:\\tmp\\yuqi-image-1.jpg' }
  ]);
}));

test('pins the approved model, high effort, and a strict schema for every brain turn', async () => fixture(async ({ client, logFile }) => {
  await client.runTurn('brain', 'draft one reply');
  const started = protocolLines(logFile).find(item => item.method === 'turn/start');
  assert.equal(started.params.model, 'gpt-5.6-sol');
  assert.equal(started.params.effort, 'high');
  assert.deepEqual(started.params.outputSchema.required, [
    'action', 'reply', 'paymentAction', 'usedFactIds', 'momentAction', 'lifePlan', 'lifeAdjustment',
    'rolePlanOperationsJson', 'rewriteResolution'
  ]);
  assert.equal(started.params.outputSchema.additionalProperties, false);
  assert.deepEqual(started.params.outputSchema.properties.action.enum, ['send', 'skip']);
  assert.equal(started.params.outputSchema.properties.reply.type, 'string');
  assert.deepEqual(started.params.outputSchema.properties.lifeAdjustment.anyOf[0].required, [
    'type', 'targetEpisodeId', 'startAt', 'endAt', 'reason'
  ]);
  assert.equal(started.params.outputSchema.properties.rolePlanOperationsJson.type, 'string');
  assert.deepEqual(
    started.params.outputSchema.properties.rewriteResolution.anyOf[0].required,
    ['resolvedIssueIds', 'resolutionNotes', 'formedCharacterFacts']
  );
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
    'explicitBoundaries', 'recentCorrection', 'needsNuanceReview'
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

test('memory schema remains valid for strict structured output after nested fields are added', async () => fixture(async ({ client, logFile }) => {
  await client.runTurn('memory', 'validate the complete memory schema');
  const started = protocolLines(logFile).find(item => item.method === 'turn/start');

  assertEveryObjectRequiresEveryProperty(started.params.outputSchema, 'memory');
}));

test('reads a complete thread snapshot with turns for restart recovery', async () => fixture(async ({ client, logFile }) => {
  const thread = await client.readThread('thr_recovery');
  assert.equal(thread.id, 'thr_recovery');
  assert.deepEqual(thread.turns.map(turn => turn.id), ['turn_existing_1']);
  const read = protocolLines(logFile).find(item => item.method === 'thread/read');
  assert.deepEqual(read.params, { threadId: 'thr_recovery', includeTurns: true });
}));

test('treats a newly started unmaterialized thread as an empty recovery baseline', async () => fixture(async ({ client, store }) => {
  const threadId = await client.ensureThread('brain');
  assert.deepEqual(store.getSessionState('brain'), { threadId, turnCount: 0 });
  const baseline = await client.readThread(threadId);
  assert.equal(baseline.id, threadId);
  assert.deepEqual(baseline.turns, []);
  const result = await client.runTurn('brain', 'first materializing turn');
  assert.equal(result.threadId, threadId);
}, {
  env: { ...process.env, FAKE_APP_SERVER_LOG: '', FAKE_UNMATERIALIZED_EMPTY_THREAD: '1' },
}));

test('awaits onTurnStarted before installing completion handling', async () => fixture(async ({ client }) => {
  const events = [];
  const result = await client.runTurn('brain', 'hooked', {
    clientUserMessageId: 'client_hooked_1',
    async onTurnStarted(started) {
      events.push(['hook-start', started]);
      await new Promise(resolve => setTimeout(resolve, 10));
      events.push(['hook-finish', started.turnId]);
    }
  });
  events.push(['result', result.turnId]);
  assert.deepEqual(events, [
    ['hook-start', {
      threadId: 'thr_new_1',
      turnId: 'turn_fake_1',
      clientUserMessageId: 'client_hooked_1'
    }],
    ['hook-finish', 'turn_fake_1'],
    ['result', 'turn_fake_1']
  ]);
}));

test('thread read exposes the exact persisted client provenance and prompt after a completed turn', async () => fixture(async ({ client }) => {
  const result = await client.runTurn('brain', { turnId: 'quality-fixture' }, {
    clientUserMessageId: 'quality_client_1',
    outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  });
  const thread = await client.readThread(result.threadId);
  assert.equal(thread.turns.length, 1);
  assert.equal(thread.turns[0].id, result.turnId);
  assert.equal(thread.turns[0].status, 'completed');
  assert.deepEqual(thread.turns[0].items[0], {
    id: `user_${result.turnId}`,
    type: 'userMessage',
    clientId: 'quality_client_1',
    content: [{ type: 'text', text: JSON.stringify({ turnId: 'quality-fixture' }) }]
  });
  assert.equal(thread.turns[0].items.at(-1).type, 'agentMessage');
}));
