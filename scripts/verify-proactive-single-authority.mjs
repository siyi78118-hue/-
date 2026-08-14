import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloud-timer-worker.js';
import {
  scheduleSemanticChecksum,
  scheduleTransitionChecksum,
  validateScheduleTransition
} from '../automatic-schedule-contract.mjs';

const FIXTURE_URL = new URL('../tests/fixtures/automatic-schedule-authority-v1.json', import.meta.url);
const MIGRATION_URLS = [
  new URL('../migrations/0001_timer_store.sql', import.meta.url),
  new URL('../migrations/0003_automatic_schedule_authority.sql', import.meta.url)
];

class NodeD1Statement {
  constructor(owner, sql, args = []) {
    this.owner = owner;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new NodeD1Statement(this.owner, this.sql, args);
  }

  first() {
    const row = this.owner.db.prepare(this.sql).get(...this.args);
    return row ? { ...row } : null;
  }

  all() {
    return { results: this.owner.db.prepare(this.sql).all(...this.args).map(row => ({ ...row })) };
  }

  run() {
    const result = this.owner.db.prepare(this.sql).run(...this.args);
    if (/^(?:INSERT|UPDATE|DELETE)/i.test(this.sql.trim())) this.owner.writeCount += Number(result.changes || 0);
    return { meta: { changes: Number(result.changes || 0), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class NodeD1Database {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.writeCount = 0;
  }

  prepare(sql) {
    return new NodeD1Statement(this, sql);
  }

  batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

async function initializedD1() {
  const adapter = new NodeD1Database();
  for (const url of MIGRATION_URLS) adapter.db.exec(await readFile(url, 'utf8'));
  return adapter;
}

export async function fixtureTransition() {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, 'utf8'));
  return structuredClone(fixture.vectors[0].transition);
}

function sourceChecksum(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function signedTransition(value) {
  const transition = structuredClone(value);
  transition.transitionChecksum = await scheduleTransitionChecksum(transition);
  if (transition.operation === 'schedule') {
    transition.jobId = `${transition.kind === 'moment' ? 'mom' : 'pro'}_${transition.transitionChecksum.slice(0, 16)}_${transition.generation}`;
  } else {
    transition.jobId = null;
    transition.dueAt = null;
    transition.mode = null;
  }
  transition.scheduleChecksum = await scheduleSemanticChecksum(transition);
  return validateScheduleTransition(transition);
}

async function workerPost(env, path, body, quiet = true) {
  const originalLog = console.log;
  const originalError = console.error;
  if (quiet) {
    console.log = () => {};
    console.error = () => {};
  }
  try {
    const response = await worker.fetch(new Request(`https://timer.invalid${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }), env);
    return { status: response.status, ...(await response.json()) };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

export async function createProactiveAuthorityHarness(options = {}) {
  const deviceId = options.deviceId || 'device-a';
  const characterId = options.characterId || 'char-a';
  const kind = options.kind === 'moment' ? 'moment' : 'chat';
  const quiet = options.quiet !== false;
  const db = await initializedD1();
  const env = { AL_TIMER_DB: db };
  const room = {
    authority: null,
    state: 'unclaimed',
    conversationSequence: 0,
    sourceReceipts: new Map(),
    outboxes: new Map(),
    terminalAdvancements: 0
  };
  const projections = { alarms: new Set(), works: new Set(), web: null, roomLegacy: null };
  const claimed = new Set();
  const d1WriteGenerations = new Set();
  let semanticOutputs = 0;
  let staleSemanticOutputs = 0;

  function replaceProjection(previousJobId, nextJobId) {
    if (previousJobId) {
      projections.alarms.delete(previousJobId);
      projections.works.delete(previousJobId);
    }
    if (nextJobId) {
      projections.alarms.add(nextJobId);
      projections.works.add(nextJobId);
    }
  }

  function commitRoom(transition, sourceId, disposition = 'visible') {
    const previousJobId = room.authority?.jobId || null;
    room.authority = structuredClone(transition);
    room.state = transition.operation === 'schedule' ? 'scheduled'
      : transition.operation === 'pause' ? 'paused' : 'disabled';
    room.outboxes.set(transition.generation, {
      generation: transition.generation,
      transition: structuredClone(transition),
      state: 'waiting'
    });
    if (sourceId) room.sourceReceipts.set(sourceId, { generation: transition.generation, disposition });
    replaceProjection(previousJobId, transition.jobId);
    claimed.clear();
    return structuredClone(transition);
  }

  async function nextTransition(sourceId, conversationSequence, operation = 'schedule') {
    const current = room.authority;
    const generation = current ? current.generation + 1 : 1;
    const dueAt = operation === 'schedule'
      ? Number(current?.dueAt || Date.now()) + 90_000 + generation
      : null;
    return signedTransition({
      protocolVersion: 2,
      operation,
      owner: 'android-v1',
      authorityEpoch: current?.authorityEpoch || '00112233445566778899aabbccddeeff',
      generation,
      expectedPreviousJobId: current?.jobId || null,
      deviceId,
      characterId,
      kind,
      streamKey: `active:${deviceId}:${characterId}:${kind}`,
      jobId: null,
      dueAt,
      mode: operation === 'schedule' ? 'planned' : null,
      sourceType: operation === 'disable' ? 'lifecycle' : 'proactive_terminal',
      sourceId,
      sourceChecksum: sourceChecksum(`${sourceId}:${conversationSequence}:${operation}`),
      policyRevision: 1,
      policyChecksum: 'a'.repeat(64),
      transitionChecksum: '0'.repeat(64),
      scheduleChecksum: '0'.repeat(64)
    });
  }

  const api = {
    async bootstrap() {
      if (room.authority) return structuredClone(room.authority);
      const base = await fixtureTransition();
      const transition = kind === 'chat' ? base : await signedTransition({
        ...base,
        kind,
        streamKey: `active:${deviceId}:${characterId}:${kind}`,
        sourceId: `bootstrap:${characterId}:${kind}`
      });
      return commitRoom(transition, 'bootstrap', 'visible');
    },

    async terminal(sourceId, disposition, conversationSequence) {
      if (conversationSequence < room.conversationSequence) return { status: 'stale' };
      const replay = room.sourceReceipts.get(sourceId);
      if (replay) return { ...structuredClone(room.authority), generation: replay.generation };
      const transition = await nextTransition(sourceId, conversationSequence);
      room.conversationSequence = Math.max(room.conversationSequence, conversationSequence);
      room.terminalAdvancements += 1;
      return commitRoom(transition, sourceId, disposition);
    },

    observeUserMessage(sequence) {
      room.conversationSequence = Math.max(room.conversationSequence, Number(sequence) || 0);
    },

    async close(reason) {
      const transition = await nextTransition(`close:${reason}`, room.conversationSequence, 'disable');
      return commitRoom(transition, `close:${reason}`, 'skip');
    },

    async flushOutbox({ loseResponse = false } = {}) {
      const pending = [...room.outboxes.values()]
        .filter(row => row.state === 'waiting')
        .sort((left, right) => left.generation - right.generation)[0];
      if (!pending) return { ok: true, idempotent: true };
      const result = await workerPost(env, '/v2/schedule-transitions', pending.transition, quiet);
      if (result.status < 300) d1WriteGenerations.add(`${pending.transition.streamKey}:${pending.generation}`);
      if (result.status < 300 && !loseResponse) pending.state = 'synced';
      return result;
    },

    restartProcess() {
      claimed.clear();
    },

    async postTransition(input) {
      const transition = await signedTransition(input);
      return workerPost(env, '/v2/schedule-transitions', transition, quiet);
    },

    async deliveryDefer(token) {
      return workerPost(env, '/v2/schedule-defer', {
        protocolVersion: 2,
        streamKey: token.streamKey,
        authorityEpoch: token.authorityEpoch,
        generation: token.generation,
        jobId: token.jobId,
        nextAttemptAt: Date.now() + 60_000,
        awaitingAck: false
      }, quiet);
    },

    async deliveryAck(token) {
      return workerPost(env, '/v2/schedule-ack', {
        protocolVersion: 2,
        streamKey: token.streamKey,
        authorityEpoch: token.authorityEpoch,
        generation: token.generation,
        jobId: token.jobId
      }, quiet);
    },

    async deliveryCallback(token, origin) {
      const current = room.authority;
      const exact = room.state === 'scheduled' && current
        && token.authorityEpoch === current.authorityEpoch
        && token.generation === current.generation
        && token.jobId === current.jobId;
      if (!exact) return false;
      const claimKey = `${current.authorityEpoch}:${current.generation}:${current.jobId}`;
      if (claimed.has(claimKey)) return false;
      claimed.add(claimKey);
      semanticOutputs += 1;
      room.state = 'claimed';
      projections.alarms.delete(current.jobId);
      projections.works.delete(current.jobId);
      return origin === 'alarm' || origin === 'fcm' || origin === 'worker';
    },

    async migrateThreeLegacyCandidates() {
      projections.web = { jobId: 'legacy-web' };
      projections.roomLegacy = { jobId: 'legacy-room' };
      projections.alarms.add('legacy-room');
      projections.works.add('legacy-room');
      await workerPost(env, '/schedule', {
        deviceId, charId: characterId, kind, jobId: 'legacy-d1',
        dueAt: new Date(Date.now() + 300_000).toISOString(), type: 'proactive'
      }, quiet);
      const transition = await api.bootstrap();
      await api.flushOutbox();
      projections.web = null;
      projections.roomLegacy = null;
      projections.alarms.delete('legacy-room');
      projections.works.delete('legacy-room');
      return transition;
    },

    async postLegacySchedule() {
      return workerPost(env, '/schedule', {
        deviceId, charId: characterId, kind, jobId: 'old-ownerless-write',
        dueAt: new Date(Date.now() + 600_000).toISOString(), type: 'proactive'
      }, quiet);
    },

    async refreshStatus() {
      return workerPost(env, '/v2/schedule-status', { deviceId, characterId, kind }, quiet);
    },

    snapshot() {
      const generations = [...room.outboxes.values()].map(row => row.generation);
      const duplicates = generations.filter((value, index) => generations.indexOf(value) !== index);
      const legacyCount = Number(!!projections.web) + Number(!!projections.roomLegacy)
        + Number(Boolean(db.db.prepare('SELECT 1 FROM timer_jobs LIMIT 1').get()));
      return {
        authorityCount: room.authority ? 1 : 0,
        alarmProjectionCount: projections.alarms.size,
        workProjectionCount: projections.works.size,
        legacyProjectionCount: legacyCount,
        duplicateOutboxGenerations: [...new Set(duplicates)],
        terminalAdvancements: room.terminalAdvancements,
        semanticOutputs,
        staleSemanticOutputs,
        state: room.state,
        generation: room.authority?.generation || 0,
        jobId: room.authority?.jobId || null,
        dueAt: room.authority?.dueAt || null,
        d1WriteGenerations: [...d1WriteGenerations].sort(),
        statusWriteCount: db.writeCount
      };
    },

    closeDatabase() {
      db.close();
    }
  };
  return api;
}

async function runSoak({ transitions, streams }) {
  const harnesses = new Map();
  const committed = [];
  let staleOverwrites = 0;
  let duplicateTerminalAdvancements = 0;
  let noOpStatusWrites = 0;
  for (const kind of streams) {
    const harness = await createProactiveAuthorityHarness({ kind });
    harnesses.set(kind, harness);
  }
  for (let index = 0; index < transitions; index += 1) {
    const kind = streams[index % streams.length];
    const harness = harnesses.get(kind);
    const before = harness.snapshot();
    const sourceId = before.generation === 0 ? 'bootstrap' : `soak:${kind}:${index}`;
    const transition = before.generation === 0
      ? await harness.bootstrap()
      : await harness.terminal(sourceId, index % 4 === 1 ? 'action_only' : index % 4 === 2 ? 'skip' : index % 4 === 3 ? 'failed' : 'visible', index + 1);
    await harness.flushOutbox();
    const replay = await harness.terminal(sourceId, 'visible', index + 1);
    if (replay.generation !== transition.generation) duplicateTerminalAdvancements += 1;
    const statusBefore = harness.snapshot().statusWriteCount;
    await harness.refreshStatus();
    if (harness.snapshot().statusWriteCount !== statusBefore) noOpStatusWrites += 1;
    const stale = await harness.postTransition({
      ...transition,
      owner: 'web-v1',
      authorityEpoch: 'ffeeddccbbaa99887766554433221100'
    });
    if (stale.status < 400) staleOverwrites += 1;
    committed.push(`${kind}:${transition.generation}`);
  }
  for (const harness of harnesses.values()) harness.closeDatabase();
  return {
    generatedAt: new Date().toISOString(),
    requestedTransitions: transitions,
    committedTransitions: committed.length,
    uniqueMonotonicGenerations: new Set(committed).size,
    staleOverwrites,
    duplicateTerminalAdvancements,
    noOpStatusWrites,
    streams
  };
}

function parseArgs(argv) {
  const value = flag => argv[argv.indexOf(flag) + 1];
  const transitions = Number(value('--transitions') || 100);
  const streams = String(value('--streams') || 'chat,moment').split(',').map(item => item.trim()).filter(Boolean);
  const out = value('--out') || 'artifacts/qa/proactive-single-authority-soak.json';
  if (!Number.isSafeInteger(transitions) || transitions < 1 || streams.some(kind => !['chat', 'moment'].includes(kind))) {
    throw new Error('invalid proactive authority soak arguments');
  }
  return { transitions, streams: [...new Set(streams)], out };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`))) {
  const options = parseArgs(process.argv.slice(2));
  const report = await runSoak(options);
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.committedTransitions !== options.transitions
      || report.uniqueMonotonicGenerations !== options.transitions
      || report.staleOverwrites !== 0
      || report.duplicateTerminalAdvancements !== 0
      || report.noOpStatusWrites !== 0) process.exitCode = 1;
}
