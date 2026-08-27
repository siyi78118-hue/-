import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilePersonaEvolutionRepository } from '../src/persona-evolution/file-repository.mjs';
import {
  SessionSummarizer,
  createSessionSourceDigest
} from '../src/persona-evolution/session-summarizer.mjs';
import {
  CodexSessionSummaryGenerator,
  validateSessionSummaryOutput
} from '../src/persona-evolution/session-summary-generator.mjs';
import { SessionSummaryWorker } from '../src/persona-evolution/session-summary-worker.mjs';

function clock() {
  let value = Date.parse('2026-08-27T12:00:00.000Z');
  return () => new Date(value++).toISOString();
}

function ids() {
  let next = 0;
  return prefix => `${prefix}_${++next}`;
}

function messages(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg_${index + 1}`,
    speaker: index % 2 ? 'assistant' : 'user',
    createdAt: new Date(Date.parse('2026-08-27T10:00:00.000Z') + index * 60_000).toISOString(),
    content: `可见消息 ${index + 1}`
  }));
}

function input(overrides = {}) {
  return {
    roleId: 'role_a',
    conversationId: 'private:role_a',
    sessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    messages: messages(),
    startedAt: '2026-08-27T10:00:00.000Z',
    endedAt: '2026-08-27T10:01:00.000Z',
    ...overrides
  };
}

function output(overrides = {}) {
  return {
    keyEvents: ['用户和 A.L. 继续了可见对话。'],
    emotionalSummary: { user: null, al: null, interaction: '交流平稳。' },
    importantDecisions: [],
    ...overrides
  };
}

async function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'al-session-summary-'));
  try {
    const repository = new FilePersonaEvolutionRepository({ rootDir: root, now: clock(), idFactory: ids() });
    await fn({ root, repository });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts only the exact summary output contract', () => {
  assert.deepEqual(validateSessionSummaryOutput(output()), output());
  assert.deepEqual(validateSessionSummaryOutput(output({
    emotionalSummary: { user: null, al: null, interaction: null }
  })).emotionalSummary, { user: null, al: null, interaction: null });
  for (const invalid of [
    output({ topic: 'forbidden' }),
    output({ importantDecisions: 'none' }),
    output({ emotionalSummary: { user: null, al: null } }),
    output({ emotionalSummary: { user: 1, al: null, interaction: null } })
  ]) assert.throws(() => validateSessionSummaryOutput(invalid), /summary/i);
});

test('Codex generator uses one isolated structured turn and validates the returned JSON', async () => {
  const calls = [];
  const codexClient = {
    async runIsolatedTurn(value, options) {
      calls.push({ value, options });
      return { text: JSON.stringify(output()) };
    }
  };
  const generator = new CodexSessionSummaryGenerator({
    codexClient, model: 'gpt-5.6-sol', effort: 'medium', turnTimeoutMs: 12_000
  });
  assert.deepEqual(await generator.generate({ sessionId: input().sessionId, messages: messages() }), output());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.model, 'gpt-5.6-sol');
  assert.equal(calls[0].options.effort, 'medium');
  assert.equal(calls[0].options.turnTimeoutMs, 12_000);
  assert.equal(calls[0].options.outputSchema.additionalProperties, false);
  assert.equal(calls[0].value.session.sessionId, input().sessionId);
  assert.equal(Object.hasOwn(calls[0].value, 'promptBuffer'), false);
});

test('creates one automatic summary and does not create downstream persona entities', async () => withFixture(async ({ repository }) => {
  const calls = [];
  const summarizer = new SessionSummarizer({
    repository,
    generator: { model: 'fake-model', generate: async value => { calls.push(value); return output(); } }
  });
  const result = await summarizer.summarizeSession(input());
  assert.deepEqual(result, { status: 'created', summaryId: 'sum_1', revision: 1 });
  assert.equal(calls.length, 1);
  const [stored] = await repository.listSessionSummaries('role_a');
  assert.equal(stored.sourceSessionId, input().sessionId);
  assert.deepEqual(stored.sourceMessageIds, ['msg_1', 'msg_2']);
  assert.equal(stored.sourceDigest, createSessionSourceDigest(messages()));
  assert.deepEqual(stored.emotionalSummary, output().emotionalSummary);
  assert.deepEqual(await repository.listMemories('role_a'), []);
  assert.deepEqual(await repository.listExperienceInterpretations('role_a'), []);
  assert.deepEqual(await repository.listChangeProposals('role_a'), []);
  assert.equal(await repository.getPersonalityState('role_a'), null);
}));

test('unchanged digest skips the generator and changed source updates the same summary revision', async () => withFixture(async ({ repository }) => {
  let calls = 0;
  const summarizer = new SessionSummarizer({
    repository,
    generator: { model: 'fake-model', generate: async () => { calls += 1; return output(); } }
  });
  const created = await summarizer.summarizeSession(input());
  const unchanged = await summarizer.summarizeSession(input());
  assert.deepEqual(unchanged, { status: 'unchanged', summaryId: created.summaryId, revision: 1 });
  assert.equal(calls, 1);

  const changedMessages = [...messages(), {
    id: 'msg_3', speaker: 'user', createdAt: '2026-08-27T10:02:00.000Z', content: '新增可见消息'
  }];
  const updated = await summarizer.summarizeSession(input({ messages: changedMessages, endedAt: changedMessages[2].createdAt }));
  assert.deepEqual(updated, { status: 'updated', summaryId: created.summaryId, revision: 2 });
  assert.equal(calls, 2);
  assert.equal((await repository.listSessionSummaries('role_a')).length, 1);
}));

test('deduplicates simultaneous triggers for the same role and session', async () => withFixture(async ({ repository }) => {
  let calls = 0;
  const summarizer = new SessionSummarizer({
    repository,
    generator: { model: 'fake-model', generate: async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return output();
    } }
  });
  const [left, right] = await Promise.all([
    summarizer.finalizeSession(input()), summarizer.finalizeSession(input())
  ]);
  assert.equal(calls, 1);
  assert.equal(left.summaryId, right.summaryId);
  assert.equal((await repository.listSessionSummaries('role_a')).length, 1);
}));

test('generator and invalid-output failures leave no partial summary and are retryable', async () => withFixture(async ({ repository }) => {
  let mode = 'throw';
  const summarizer = new SessionSummarizer({
    repository,
    generator: { model: 'fake-model', generate: async () => {
      if (mode === 'throw') throw new Error('synthetic generator failure');
      if (mode === 'invalid') return { ...output(), topic: 'forbidden' };
      return output();
    } }
  });
  await assert.rejects(summarizer.summarizeSession(input()), /synthetic generator failure/);
  assert.deepEqual(await repository.listSessionSummaries('role_a'), []);
  mode = 'invalid';
  await assert.rejects(summarizer.summarizeSession(input()), /summary/i);
  assert.deepEqual(await repository.listSessionSummaries('role_a'), []);
  mode = 'ok';
  assert.equal((await summarizer.summarizeSession(input())).status, 'created');
}));

test('isolates summaries by role even when session IDs match', async () => withFixture(async ({ repository }) => {
  const summarizer = new SessionSummarizer({
    repository,
    generator: { model: 'fake-model', generate: async () => output() }
  });
  await summarizer.summarizeSession(input({ roleId: 'role_a' }));
  await summarizer.summarizeSession(input({ roleId: 'role_b', conversationId: 'private:role_b' }));
  assert.equal((await repository.listSessionSummaries('role_a')).length, 1);
  assert.equal((await repository.listSessionSummaries('role_b')).length, 1);
}));

test('chunks a long session without dropping or duplicating source messages and persists only the merge result', async () => withFixture(async ({ repository }) => {
  const seen = [];
  const generator = {
    model: 'fake-model',
    generate: async value => {
      seen.push(value);
      if (value.mode === 'merge') return output({ keyEvents: ['merged'] });
      return output({ keyEvents: [`chunk:${value.messages.map(item => item.id).join(',')}`] });
    }
  };
  const summarizer = new SessionSummarizer({ repository, generator, maxInputBytes: 450 });
  const source = messages(12).map(item => ({ ...item, content: `${item.content}-${'字'.repeat(80)}` }));
  await summarizer.summarizeSession(input({ messages: source, endedAt: source.at(-1).createdAt }));
  const chunkCalls = seen.filter(value => value.mode === 'chunk');
  assert.ok(chunkCalls.length > 1);
  assert.deepEqual(chunkCalls.flatMap(value => value.messages.map(item => item.id)), source.map(item => item.id));
  assert.equal(seen.filter(value => value.mode === 'merge').length, 1);
  const [stored] = await repository.listSessionSummaries('role_a');
  assert.deepEqual(stored.keyEvents, ['merged']);
  assert.equal((await repository.listSessionSummaries('role_a')).length, 1);
}));

test('startup recovery and idle sweep finalize persisted closed sessions without duplicating summaries', async () => withFixture(async ({ repository }) => {
  const sourceMessages = messages();
  const source = {
    async listAll(roleId) {
      return sourceMessages.map(item => ({ ...item, roleId, conversationId: `private:${roleId}` }));
    }
  };
  let generated = 0;
  const summarizer = new SessionSummarizer({
    repository,
    generator: { model: 'fake-model', generate: async () => { generated += 1; return output(); } }
  });
  const worker = new SessionSummaryWorker({
    source, summarizer, roleIds: ['role_a'],
    now: () => Date.parse('2026-08-27T11:00:00.000Z'),
    idleTimeoutMs: 30 * 60_000,
    sweepIntervalMs: 60_000
  });
  assert.equal((await worker.recover()).created, 1);
  assert.equal((await worker.sweep()).unchanged, 1);
  assert.equal(generated, 1);
  worker.stop();
}));

test('new-message observation backfills the preceding idle session and never blocks its caller on failure', async () => {
  const all = [
    ...messages(),
    { id: 'msg_3', speaker: 'user', createdAt: '2026-08-27T11:00:00.000Z', content: '新会话' }
  ];
  const finalized = [];
  const source = { async listAll() { return all.map(item => ({ ...item, roleId: 'role_a', conversationId: 'private:role_a' })); } };
  const summarizer = { async finalizeSession(session) { finalized.push(session); throw new Error('synthetic background failure'); } };
  const worker = new SessionSummaryWorker({
    source, summarizer, roleIds: ['role_a'],
    now: () => Date.parse('2026-08-27T11:00:01.000Z'),
    idleTimeoutMs: 30 * 60_000,
    sweepIntervalMs: 60_000
  });
  assert.equal(worker.observeVisibleMessage({ roleId: 'role_a' }), undefined);
  await worker.idle();
  assert.equal(finalized.length, 1);
  assert.deepEqual(finalized[0].messages.map(item => item.id), ['msg_1', 'msg_2']);
  worker.stop();
});
