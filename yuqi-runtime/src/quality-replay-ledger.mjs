import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, contentHash } from './protocol.mjs';
import { ROLE_OUTPUT_SCHEMAS } from './role-schemas.mjs';
import { sessionRoleForPipelineRole } from './codex-client.mjs';

const PHASES = Object.freeze([
  'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'
]);
const PHASE_SET = new Set(PHASES);
const MODEL_SESSION_ROLES = new Set(['memory', 'brain', 'supervisor']);
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_HEADER_KEYS = Object.freeze([
  'version', 'runId', 'finalKeys', 'planChecksum', 'sourceHead',
  'stableRelease', 'candidateRelease', 'attestationChecksum', 'artifactPaths', 'createdAt'
]);
const RELEASE_KEYS = Object.freeze(['releaseId', 'releaseChecksum']);
const ARTIFACT_KEYS = Object.freeze(['plan', 'ledger', 'raw']);
const REQUEST_KEYS = Object.freeze([
  'input', 'model', 'effort', 'outputSchema', 'localImagePaths', 'clientUserMessageId'
]);
const REQUEST_BASIS_KEYS = Object.freeze([
  'input', 'model', 'effort', 'outputSchema', 'localImagePaths'
]);
const PHASE_INPUT_KEYS = Object.freeze([
  'runId', 'finalKey', 'phase', 'subjectChecksum', 'authorityInputChecksum', 'input', 'now'
]);
const CALL_INPUT_KEYS = Object.freeze([
  'runId', 'finalKey', 'phase', 'ordinal', 'role', 'threadId', 'baseline', 'request', 'now'
]);
const LEDGER_SCHEMA_VERSION = 1;
const LEDGER_SCHEMA_SQL = `
  CREATE TABLE quality_runs(
    run_id TEXT PRIMARY KEY,
    header_json TEXT NOT NULL,
    header_checksum TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','finalized','blocked')),
    created_at INTEGER NOT NULL,
    finalized_at INTEGER
  );
  CREATE TABLE quality_phases(
    run_id TEXT NOT NULL,
    final_key TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('stable_execution','candidate_execution','evaluator_primary','evaluator_secondary')),
    state TEXT NOT NULL CHECK(state IN ('prepared','starting','running','succeeded','failed','uncertain')),
    subject_checksum TEXT NOT NULL,
    authority_input_checksum TEXT NOT NULL,
    input_json TEXT NOT NULL,
    input_checksum TEXT NOT NULL,
    output_json TEXT,
    output_checksum TEXT,
    error_json TEXT,
    starting_at INTEGER,
    running_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, final_key, phase),
    FOREIGN KEY(run_id) REFERENCES quality_runs(run_id)
  );
  CREATE TABLE quality_model_calls(
    run_id TEXT NOT NULL,
    final_key TEXT NOT NULL,
    phase TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('starting','running','succeeded','failed','uncertain')),
    role TEXT NOT NULL,
    call_id TEXT NOT NULL,
    client_user_message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    baseline_json TEXT NOT NULL,
    baseline_checksum TEXT NOT NULL,
    request_json TEXT NOT NULL,
    request_checksum TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    schema_checksum TEXT NOT NULL,
    output_json TEXT,
    output_checksum TEXT,
    error_json TEXT,
    running_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, final_key, phase, ordinal),
    UNIQUE(run_id, call_id),
    FOREIGN KEY(run_id, final_key, phase) REFERENCES quality_phases(run_id, final_key, phase)
  );
  CREATE TABLE quality_finals(
    run_id TEXT NOT NULL,
    final_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    value_checksum TEXT NOT NULL,
    finalized_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, final_key),
    FOREIGN KEY(run_id) REFERENCES quality_runs(run_id)
  );
`;
const LEDGER_TABLES = Object.freeze([
  'quality_finals', 'quality_model_calls', 'quality_phases', 'quality_runs'
]);
let expectedSchemaSql = null;
const SQLITE_BUSY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, message) {
  if (!isObject(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(message);
  }
}

function nativeInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(message);
  return value;
}

function nonEmpty(value, message) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value;
}

function checksum(value, message) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(message);
  return value;
}

function parse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function normalizedSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function schemaSql(db) {
  return Object.fromEntries(db.prepare(`
    SELECT name,sql FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => [row.name, normalizedSql(row.sql)]));
}

function expectedLedgerSchemaSql() {
  if (expectedSchemaSql) return expectedSchemaSql;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(LEDGER_SCHEMA_SQL);
    expectedSchemaSql = schemaSql(db);
    return expectedSchemaSql;
  } finally {
    db.close();
  }
}

function assertLedgerSchema(db) {
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  const actual = schemaSql(db);
  const names = Object.keys(actual).sort();
  const expected = expectedLedgerSchemaSql();
  const unexpectedObjects = db.prepare(`
    SELECT type,name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type != 'table'
  `).all();
  if (version !== LEDGER_SCHEMA_VERSION
    || canonicalJson(names) !== canonicalJson(LEDGER_TABLES)
    || LEDGER_TABLES.some(name => actual[name] !== expected[name])
    || unexpectedObjects.length !== 0) {
    throw new Error('quality ledger schema conflict');
  }
  const integrity = db.prepare('PRAGMA quick_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (integrity.length !== 1 || integrity[0].quick_check !== 'ok' || foreignKeys.length !== 0) {
    throw new Error('quality ledger schema integrity conflict');
  }
}

function ensureWalMode(db) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const current = String(db.prepare('PRAGMA journal_mode').get().journal_mode || '').toLowerCase();
      if (current === 'wal') return;
      const changed = String(db.prepare('PRAGMA journal_mode = WAL').get().journal_mode || '').toLowerCase();
      if (changed === 'wal') return;
      throw new Error('quality ledger journal mode conflict');
    } catch (error) {
      if (!/database is locked/i.test(String(error?.message || '')) || Date.now() >= deadline) throw error;
      Atomics.wait(SQLITE_BUSY_WAIT, 0, 0, 10);
    }
  }
}

function validateRunHeader(header) {
  exactKeys(header, RUN_HEADER_KEYS, 'quality run header shape conflict');
  if (header.version !== 1) throw new Error('quality run header version conflict');
  nonEmpty(header.runId, 'quality run id conflict');
  if (!Array.isArray(header.finalKeys) || header.finalKeys.length !== 246
    || header.finalKeys.some(key => typeof key !== 'string' || !key)
    || new Set(header.finalKeys).size !== header.finalKeys.length) {
    throw new Error('quality run requires exactly 246 final keys');
  }
  checksum(header.planChecksum, 'quality run plan checksum conflict');
  if (typeof header.sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(header.sourceHead)) {
    throw new Error('quality run source head conflict');
  }
  for (const [name, release] of [
    ['stable', header.stableRelease], ['candidate', header.candidateRelease]
  ]) {
    exactKeys(release, RELEASE_KEYS, `quality run ${name} release shape conflict`);
    nonEmpty(release.releaseId, `quality run ${name} release id conflict`);
    checksum(release.releaseChecksum, `quality run ${name} release checksum conflict`);
  }
  checksum(header.attestationChecksum, 'quality run attestation checksum conflict');
  exactKeys(header.artifactPaths, ARTIFACT_KEYS, 'quality run artifact paths conflict');
  Object.values(header.artifactPaths).forEach(value =>
    nonEmpty(value, 'quality run artifact path conflict'));
  nativeInteger(header.createdAt, 'quality run createdAt conflict');
  return JSON.parse(canonicalJson(header));
}

function mapRun(row) {
  if (!row) return null;
  const header = parse(row.header_json, {});
  return {
    ...header,
    headerChecksum: row.header_checksum,
    state: row.state,
    finalizedAt: row.finalized_at == null ? null : Number(row.finalized_at)
  };
}

function mapPhase(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    finalKey: row.final_key,
    phase: row.phase,
    state: row.state,
    subjectChecksum: row.subject_checksum,
    authorityInputChecksum: row.authority_input_checksum,
    input: parse(row.input_json, null),
    inputChecksum: row.input_checksum,
    output: row.output_json == null ? null : parse(row.output_json, null),
    outputChecksum: row.output_checksum,
    error: row.error_json == null ? null : parse(row.error_json, null),
    startingAt: row.starting_at == null ? null : Number(row.starting_at),
    runningAt: row.running_at == null ? null : Number(row.running_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function mapCall(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    finalKey: row.final_key,
    phase: row.phase,
    ordinal: Number(row.ordinal),
    state: row.state,
    role: row.role,
    callId: row.call_id,
    clientUserMessageId: row.client_user_message_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    baseline: parse(row.baseline_json, null),
    baselineChecksum: row.baseline_checksum,
    request: parse(row.request_json, null),
    requestChecksum: row.request_checksum,
    model: row.model,
    effort: row.effort,
    schemaChecksum: row.schema_checksum,
    output: row.output_json == null ? null : parse(row.output_json, null),
    outputChecksum: row.output_checksum,
    error: row.error_json == null ? null : parse(row.error_json, null),
    runningAt: row.running_at == null ? null : Number(row.running_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function mapFinal(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    finalKey: row.final_key,
    state: 'finalized',
    value: parse(row.value_json, null),
    checksum: row.value_checksum,
    finalizedAt: Number(row.finalized_at)
  };
}

function phaseIdentity(input) {
  if (!isObject(input)) throw new Error('quality phase input conflict');
  exactKeys(input, PHASE_INPUT_KEYS, 'quality phase input shape conflict');
  nonEmpty(input.runId, 'quality phase run id conflict');
  nonEmpty(input.finalKey, 'quality phase final key conflict');
  if (!PHASE_SET.has(input.phase)) throw new Error('quality phase kind conflict');
  checksum(input.subjectChecksum, 'quality phase subject checksum conflict');
  checksum(input.authorityInputChecksum, 'quality phase authority checksum conflict');
  if (!isObject(input.input)) throw new Error('quality phase payload conflict');
  nativeInteger(input.now, 'quality phase timestamp conflict');
  const value = {
    subjectChecksum: input.subjectChecksum,
    authorityInputChecksum: input.authorityInputChecksum,
    input: input.input
  };
  return {
    runId: input.runId,
    finalKey: input.finalKey,
    phase: input.phase,
    subjectChecksum: input.subjectChecksum,
    authorityInputChecksum: input.authorityInputChecksum,
    input: input.input,
    now: input.now,
    inputJson: canonicalJson(input.input),
    inputChecksum: contentHash(value)
  };
}

export function qualityClientUserMessageId(scope, requestBasis) {
  if (!isObject(scope) || !isObject(requestBasis)) {
    throw new Error('quality model call client identity conflict');
  }
  return `quality_${contentHash({
    runId: scope.runId,
    finalKey: scope.finalKey,
    phase: scope.phase,
    ordinal: scope.ordinal,
    requestBasisChecksum: contentHash(requestBasis)
  }).slice(0, 48)}`;
}

function callIdentity(input) {
  if (!isObject(input)) throw new Error('quality model call input conflict');
  exactKeys(input, CALL_INPUT_KEYS, 'quality model call input shape conflict');
  nonEmpty(input.runId, 'quality model call run id conflict');
  nonEmpty(input.finalKey, 'quality model call final key conflict');
  if (!PHASE_SET.has(input.phase)) throw new Error('quality model call phase conflict');
  nativeInteger(input.ordinal, 'quality model call ordinal conflict');
  if (!MODEL_SESSION_ROLES.has(input.role)) throw new Error('quality model call role conflict');
  nonEmpty(input.threadId, 'quality model call thread conflict');
  if (!isObject(input.baseline) || input.baseline.id !== input.threadId
    || !Array.isArray(input.baseline.turns)) {
    throw new Error('quality model call baseline conflict');
  }
  const baselineIds = input.baseline.turns.map(turn => String(turn?.id || ''));
  if (baselineIds.some(id => !id) || new Set(baselineIds).size !== baselineIds.length) {
    throw new Error('quality model call baseline conflict');
  }
  exactKeys(input.request, REQUEST_KEYS, 'quality model call request conflict');
  const requestBasis = Object.fromEntries(REQUEST_BASIS_KEYS.map(key => [key, input.request[key]]));
  if (typeof input.request.input !== 'string' || !input.request.input.trim()) {
    throw new Error('quality model call request conflict');
  }
  nonEmpty(input.request.model, 'quality model call model conflict');
  nonEmpty(input.request.effort, 'quality model call effort conflict');
  if (!isObject(input.request.outputSchema)
    || !Array.isArray(input.request.localImagePaths)
    || input.request.localImagePaths.some(path => typeof path !== 'string' || !path)) {
    throw new Error('quality model call request conflict');
  }
  const expectedClientId = qualityClientUserMessageId(input, requestBasis);
  if (input.request.clientUserMessageId !== expectedClientId) {
    throw new Error('quality model call client identity conflict');
  }
  nativeInteger(input.now, 'quality model call timestamp conflict');
  const callId = `qcall_${contentHash({
    runId: input.runId, finalKey: input.finalKey, phase: input.phase, ordinal: input.ordinal
  }).slice(0, 48)}`;
  return {
    ...input,
    callId,
    baselineJson: canonicalJson(input.baseline),
    baselineChecksum: contentHash(input.baseline),
    requestJson: canonicalJson(input.request),
    requestChecksum: contentHash(input.request),
    model: String(input.request.model || ''),
    effort: String(input.request.effort || ''),
    schemaChecksum: contentHash(input.request.outputSchema || null)
  };
}

function assertLedgerInvariants(db) {
  const runs = new Map();
  for (const row of db.prepare('SELECT * FROM quality_runs').all()) {
    let header;
    try { header = validateRunHeader(parse(row.header_json, null)); } catch {
      throw new Error('quality ledger invariant run conflict');
    }
    const finalizedAt = row.finalized_at == null ? null : Number(row.finalized_at);
    if (header.runId !== row.run_id || canonicalJson(header) !== row.header_json
      || contentHash(header) !== row.header_checksum
      || header.createdAt !== Number(row.created_at)
      || (row.state === 'finalized'
        ? (!Number.isSafeInteger(finalizedAt) || finalizedAt < Number(row.created_at))
        : finalizedAt !== null)) {
      throw new Error('quality ledger invariant run conflict');
    }
    runs.set(row.run_id, { row, header });
  }

  const phases = new Map();
  for (const row of db.prepare('SELECT * FROM quality_phases').all()) {
    const run = runs.get(row.run_id);
    const input = parse(row.input_json, null);
    const phaseKey = `${row.run_id}\0${row.final_key}\0${row.phase}`;
    const output = row.output_json == null ? null : parse(row.output_json, undefined);
    const error = row.error_json == null ? null : parse(row.error_json, undefined);
    const expectedInputChecksum = isObject(input)
      ? contentHash({
        subjectChecksum: row.subject_checksum,
        authorityInputChecksum: row.authority_input_checksum,
        input
      })
      : null;
    const isOpen = ['prepared', 'starting', 'running'].includes(row.state);
    const isSucceeded = row.state === 'succeeded';
    const isFailure = ['failed', 'uncertain'].includes(row.state);
    const startingAt = row.starting_at == null ? null : Number(row.starting_at);
    const runningAt = row.running_at == null ? null : Number(row.running_at);
    if (!run || !run.header.finalKeys.includes(row.final_key) || !PHASE_SET.has(row.phase)
      || phases.has(phaseKey) || !SHA256.test(row.subject_checksum)
      || !SHA256.test(row.authority_input_checksum) || !isObject(input)
      || canonicalJson(input) !== row.input_json || expectedInputChecksum !== row.input_checksum
      || !Number.isSafeInteger(Number(row.created_at))
      || Number(row.created_at) < Number(run.row.created_at)
      || !Number.isSafeInteger(Number(row.updated_at))
      || Number(row.updated_at) < Number(row.created_at)
      || (row.state === 'prepared' && (startingAt !== null || runningAt !== null
        || Number(row.updated_at) !== Number(row.created_at)))
      || (row.state === 'starting' && (!Number.isSafeInteger(startingAt)
        || startingAt < Number(row.created_at) || runningAt !== null
        || Number(row.updated_at) !== startingAt))
      || (row.state === 'running' && (!Number.isSafeInteger(startingAt)
        || startingAt < Number(row.created_at) || !Number.isSafeInteger(runningAt)
        || runningAt < startingAt
        || Number(row.updated_at) !== runningAt))
      || (!isOpen && (!Number.isSafeInteger(startingAt)
        || startingAt < Number(row.created_at) || !Number.isSafeInteger(runningAt)
        || runningAt < startingAt
        || Number(row.updated_at) < runningAt))
      || (isOpen && (row.output_json !== null || row.output_checksum !== null || row.error_json !== null))
      || (isSucceeded && (output === undefined || row.output_checksum !== contentHash(output)
        || canonicalJson(output) !== row.output_json || row.error_json !== null))
      || (isFailure && (error === undefined || canonicalJson(error) !== row.error_json
        || row.output_json !== null || row.output_checksum !== null))) {
      throw new Error('quality ledger invariant phase conflict');
    }
    phases.set(phaseKey, row);
  }

  const callsByPhase = new Map();
  for (const row of db.prepare(`
    SELECT * FROM quality_model_calls ORDER BY run_id,final_key,phase,ordinal
  `).all()) {
    const phaseKey = `${row.run_id}\0${row.final_key}\0${row.phase}`;
    const phase = phases.get(phaseKey);
    const baseline = parse(row.baseline_json, null);
    const request = parse(row.request_json, null);
    const output = row.output_json == null ? null : parse(row.output_json, undefined);
    const error = row.error_json == null ? null : parse(row.error_json, undefined);
    const rows = callsByPhase.get(phaseKey) || [];
    const baselineIds = Array.isArray(baseline?.turns)
      ? baseline.turns.map(turn => String(turn?.id || ''))
      : [];
    const requestBasis = isObject(request)
      ? Object.fromEntries(REQUEST_BASIS_KEYS.map(key => [key, request[key]]))
      : null;
    const expectedCallId = `qcall_${contentHash({
      runId: row.run_id, finalKey: row.final_key, phase: row.phase, ordinal: Number(row.ordinal)
    }).slice(0, 48)}`;
    const open = ['starting', 'running'].includes(row.state);
    const succeeded = row.state === 'succeeded';
    const failed = ['failed', 'uncertain'].includes(row.state);
    const runningAt = row.running_at == null ? null : Number(row.running_at);
    if (!phase || Number(row.ordinal) !== rows.length || row.call_id !== expectedCallId
      || !MODEL_SESSION_ROLES.has(row.role)
      || !isObject(baseline) || baseline.id !== row.thread_id || !Array.isArray(baseline.turns)
      || baselineIds.some(id => !id) || new Set(baselineIds).size !== baselineIds.length
      || canonicalJson(baseline) !== row.baseline_json
      || contentHash(baseline) !== row.baseline_checksum
      || !isObject(request) || canonicalJson(request) !== row.request_json
      || canonicalJson(Object.keys(request).sort()) !== canonicalJson([...REQUEST_KEYS].sort())
      || typeof request.input !== 'string' || !request.input.trim()
      || typeof request.model !== 'string' || !request.model.trim()
      || typeof request.effort !== 'string' || !request.effort.trim()
      || !isObject(request.outputSchema) || !Array.isArray(request.localImagePaths)
      || request.localImagePaths.some(path => typeof path !== 'string' || !path)
      || contentHash(request) !== row.request_checksum
      || request.clientUserMessageId !== row.client_user_message_id
      || request.clientUserMessageId !== qualityClientUserMessageId({
        runId: row.run_id, finalKey: row.final_key, phase: row.phase, ordinal: Number(row.ordinal)
      }, requestBasis)
      || String(request.model || '') !== row.model || String(request.effort || '') !== row.effort
      || contentHash(request.outputSchema || null) !== row.schema_checksum
      || !Number.isSafeInteger(Number(row.created_at))
      || Number(row.created_at) < Number(phase.created_at)
      || !Number.isSafeInteger(Number(row.updated_at))
      || Number(row.updated_at) < Number(row.created_at)
      || (row.state === 'starting' && (row.turn_id !== null || runningAt !== null
        || Number(row.updated_at) !== Number(row.created_at)))
      || (row.state === 'running' && (!row.turn_id || !Number.isSafeInteger(runningAt)
        || runningAt < Number(row.created_at) || Number(row.updated_at) !== runningAt))
      || (row.state === 'succeeded' && (!row.turn_id || !Number.isSafeInteger(runningAt)
        || runningAt < Number(row.created_at) || Number(row.updated_at) < runningAt))
      || (row.state === 'failed' && (!row.turn_id || !Number.isSafeInteger(runningAt)
        || runningAt < Number(row.created_at) || Number(row.updated_at) < runningAt))
      || (row.state === 'uncertain' && ((runningAt === null && row.turn_id !== null)
        || (runningAt !== null && (!Number.isSafeInteger(runningAt) || !row.turn_id
          || runningAt < Number(row.created_at) || Number(row.updated_at) < runningAt))))
      || (open && (row.output_json !== null || row.output_checksum !== null || row.error_json !== null))
      || (succeeded && (!row.turn_id || output === undefined
        || canonicalJson(output) !== row.output_json || contentHash(output) !== row.output_checksum
        || row.error_json !== null))
      || (failed && (error === undefined || canonicalJson(error) !== row.error_json
        || row.output_json !== null || row.output_checksum !== null))) {
      throw new Error('quality ledger invariant model call conflict');
    }
    rows.push(row);
    callsByPhase.set(phaseKey, rows);
  }

  for (const [phaseKey, phase] of phases) {
    const calls = callsByPhase.get(phaseKey) || [];
    const phaseIsTerminal = ['succeeded', 'failed', 'uncertain'].includes(phase.state);
    if ((['prepared', 'starting'].includes(phase.state) && calls.length !== 0)
      || (phase.state === 'running' && calls.some(call =>
        Number(call.created_at) < Number(phase.running_at)))
      || (phaseIsTerminal && calls.some(call => ['starting', 'running'].includes(call.state)
        || Number(call.created_at) < Number(phase.running_at)
        || Number(call.updated_at) > Number(phase.updated_at)))
      || (phase.state === 'succeeded'
        && (calls.length === 0 || calls.some(call => call.state !== 'succeeded')))) {
      throw new Error('quality ledger invariant phase model call ownership conflict');
    }
  }

  const finalCountByRun = new Map();
  for (const row of db.prepare('SELECT * FROM quality_finals').all()) {
    const run = runs.get(row.run_id);
    const value = parse(row.value_json, undefined);
    const owned = PHASES.map(phase => phases.get(`${row.run_id}\0${row.final_key}\0${phase}`));
    if (!run || !run.header.finalKeys.includes(row.final_key) || value === undefined
      || canonicalJson(value) !== row.value_json || contentHash(value) !== row.value_checksum
      || !Number.isSafeInteger(Number(row.finalized_at))
      || owned.some(phase => Number(phase.updated_at) > Number(row.finalized_at))
      || owned.some(phase => !phase || phase.state !== 'succeeded')) {
      throw new Error('quality ledger invariant final conflict');
    }
    finalCountByRun.set(row.run_id, (finalCountByRun.get(row.run_id) || 0) + 1);
  }
  const uncertainRuns = new Set([
    ...[...phases.values()].filter(row => row.state === 'uncertain').map(row => row.run_id),
    ...[...callsByPhase.values()].flat().filter(row => row.state === 'uncertain').map(row => row.run_id)
  ]);
  for (const [runId, run] of runs) {
    const latestFinal = db.prepare(`
      SELECT MAX(finalized_at) AS latest FROM quality_finals WHERE run_id=?
    `).get(runId).latest;
    if ((run.row.state === 'finalized' && finalCountByRun.get(runId) !== 246)
      || (run.row.state === 'finalized' && Number(run.row.finalized_at) < Number(latestFinal))
      || (run.row.state === 'blocked' && !uncertainRuns.has(runId))
      || (run.row.state === 'open' && uncertainRuns.has(runId))) {
      throw new Error('quality ledger invariant run state conflict');
    }
  }
}

export class QualityReplayLedger {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename) throw new Error('quality ledger filename required');
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.closed = false;
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      ensureWalMode(this.db);
      const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
      const tables = Object.keys(schemaSql(this.db));
      if (version === 0 && tables.length === 0) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const lockedVersion = Number(this.db.prepare('PRAGMA user_version').get().user_version);
          const lockedTables = Object.keys(schemaSql(this.db));
          if (lockedVersion === 0 && lockedTables.length === 0) {
            this.db.exec(LEDGER_SCHEMA_SQL);
            this.db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
          } else if (lockedVersion !== LEDGER_SCHEMA_VERSION) {
            throw new Error('quality ledger schema conflict');
          }
          this.db.exec('COMMIT');
        } catch (error) {
          try { this.db.exec('ROLLBACK'); } catch {}
          throw error;
        }
      } else if (version !== LEDGER_SCHEMA_VERSION) {
        throw new Error('quality ledger schema conflict');
      }
      assertLedgerSchema(this.db);
      assertLedgerInvariants(this.db);
    } catch (error) {
      this.closed = true;
      this.db.close();
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  immediate(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  createOrOpenRun(rawHeader) {
    const header = validateRunHeader(rawHeader);
    const headerJson = canonicalJson(header);
    const headerChecksum = contentHash(header);
    return this.immediate(() => {
      const existing = this.db.prepare('SELECT * FROM quality_runs WHERE run_id = ?').get(header.runId);
      if (existing) {
        if (existing.header_checksum !== headerChecksum || existing.header_json !== headerJson) {
          throw new Error('quality run header conflict');
        }
        return mapRun(existing);
      }
      this.db.prepare(`
        INSERT INTO quality_runs(run_id,header_json,header_checksum,state,created_at)
        VALUES (?,?,?,'open',?)
      `).run(header.runId, headerJson, headerChecksum, header.createdAt);
      return mapRun(this.db.prepare('SELECT * FROM quality_runs WHERE run_id = ?').get(header.runId));
    });
  }

  assertFinalMember(runId, finalKey) {
    const row = this.db.prepare(`
      SELECT header_json,state,created_at FROM quality_runs WHERE run_id = ?
    `).get(runId);
    const header = parse(row?.header_json, null);
    if (!row || !header?.finalKeys?.includes(finalKey)) throw new Error('quality final authority conflict');
    return row;
  }

  assertRunWritable(runId, { allowBlocked = false } = {}) {
    const row = this.db.prepare('SELECT state FROM quality_runs WHERE run_id=?').get(runId);
    if (!row || (row.state !== 'open' && !(allowBlocked && row.state === 'blocked'))) {
      throw new Error('quality run is not writable');
    }
    return row;
  }

  getPhase({ runId, finalKey, phase }) {
    return mapPhase(this.db.prepare(`
      SELECT * FROM quality_phases WHERE run_id=? AND final_key=? AND phase=?
    `).get(runId, finalKey, phase));
  }

  preparePhase(rawInput) {
    const input = phaseIdentity(rawInput);
    return this.immediate(() => {
      const run = this.assertFinalMember(input.runId, input.finalKey);
      const existing = this.getPhase(input);
      if (existing) {
        if (existing.inputChecksum !== input.inputChecksum
          || existing.subjectChecksum !== input.subjectChecksum
          || existing.authorityInputChecksum !== input.authorityInputChecksum) {
          throw new Error('quality phase input conflict');
        }
        if (existing.state === 'uncertain') throw new Error('quality phase is uncertain');
        return existing;
      }
      if (run.state !== 'open') throw new Error('quality run is not writable');
      if (input.now < Number(run.created_at)) throw new Error('quality phase timestamp conflict');
      this.db.prepare(`
        INSERT INTO quality_phases(
          run_id,final_key,phase,state,subject_checksum,authority_input_checksum,
          input_json,input_checksum,created_at,updated_at
        ) VALUES (?,?,?,'prepared',?,?,?,?,?,?)
      `).run(
        input.runId, input.finalKey, input.phase, input.subjectChecksum,
        input.authorityInputChecksum, input.inputJson, input.inputChecksum, input.now, input.now
      );
      return this.getPhase(input);
    });
  }

  startPhase(rawInput, { now }) {
    const input = phaseIdentity({ ...rawInput, now: rawInput.now });
    nativeInteger(now, 'quality phase transition timestamp conflict');
    return this.immediate(() => {
      this.assertRunWritable(input.runId);
      const existing = this.getPhase(input);
      if (!existing || existing.inputChecksum !== input.inputChecksum) {
        throw new Error('quality phase input conflict');
      }
      if (existing.state === 'starting') return existing;
      if (existing.state !== 'prepared') throw new Error('quality phase state conflict');
      if (now < existing.updatedAt) throw new Error('quality phase transition timestamp conflict');
      const result = this.db.prepare(`
        UPDATE quality_phases SET state='starting',starting_at=?,updated_at=?
        WHERE run_id=? AND final_key=? AND phase=? AND state='prepared'
      `).run(now, now, input.runId, input.finalKey, input.phase);
      if (Number(result.changes) !== 1) throw new Error('quality phase state conflict');
      return this.getPhase(input);
    });
  }

  markPhaseRunning(rawInput, { now }) {
    const input = phaseIdentity({ ...rawInput, now: rawInput.now });
    nativeInteger(now, 'quality phase transition timestamp conflict');
    return this.immediate(() => {
      this.assertRunWritable(input.runId);
      const existing = this.getPhase(input);
      if (!existing || existing.inputChecksum !== input.inputChecksum) {
        throw new Error('quality phase input conflict');
      }
      if (existing.state === 'running') return existing;
      if (existing.state !== 'starting') throw new Error('quality phase state conflict');
      if (now < existing.updatedAt) throw new Error('quality phase transition timestamp conflict');
      const result = this.db.prepare(`
        UPDATE quality_phases SET state='running',running_at=?,updated_at=?
        WHERE run_id=? AND final_key=? AND phase=? AND state='starting'
      `).run(now, now, input.runId, input.finalKey, input.phase);
      if (Number(result.changes) !== 1) throw new Error('quality phase state conflict');
      return this.getPhase(input);
    });
  }

  finishPhase(rawInput, { state, output = null, error = null, now }) {
    const input = phaseIdentity({ ...rawInput, now: rawInput.now });
    nativeInteger(now, 'quality phase transition timestamp conflict');
    if (!['succeeded', 'failed', 'uncertain'].includes(state)) {
      throw new Error('quality phase terminal state conflict');
    }
    if ((state === 'succeeded' && (output === null || error !== null))
      || (state !== 'succeeded' && (output !== null || error === null))) {
      throw new Error('quality phase terminal payload conflict');
    }
    const outputJson = output === null ? null : canonicalJson(output);
    const outputChecksum = output === null ? null : contentHash(output);
    const errorJson = error === null ? null : canonicalJson(error);
    return this.immediate(() => {
      this.assertRunWritable(input.runId, { allowBlocked: state === 'uncertain' });
      const existing = this.getPhase(input);
      if (!existing || existing.inputChecksum !== input.inputChecksum) {
        throw new Error('quality phase input conflict');
      }
      if (existing.state === state) {
        if (existing.outputChecksum !== outputChecksum
          || canonicalJson(existing.error) !== canonicalJson(error)) {
          throw new Error('quality phase state conflict');
        }
        return existing;
      }
      if (existing.state !== 'running') throw new Error('quality phase state conflict');
      if (now < existing.updatedAt) throw new Error('quality phase transition timestamp conflict');
      const calls = this.db.prepare(`
        SELECT state,updated_at FROM quality_model_calls
        WHERE run_id=? AND final_key=? AND phase=? ORDER BY ordinal
      `).all(input.runId, input.finalKey, input.phase);
      if (calls.some(call => ['starting', 'running'].includes(call.state)
        || Number(call.updated_at) > now)
        || (state === 'succeeded'
          && (calls.length === 0 || calls.some(call => call.state !== 'succeeded')))) {
        throw new Error('quality phase model call ownership conflict');
      }
      const result = this.db.prepare(`
        UPDATE quality_phases
        SET state=?,output_json=?,output_checksum=?,error_json=?,updated_at=?
        WHERE run_id=? AND final_key=? AND phase=? AND state='running'
      `).run(
        state, outputJson, outputChecksum, errorJson, now,
        input.runId, input.finalKey, input.phase
      );
      if (Number(result.changes) !== 1) throw new Error('quality phase state conflict');
      if (state === 'uncertain') {
        this.db.prepare(`UPDATE quality_runs SET state='blocked' WHERE run_id=? AND state='open'`)
          .run(input.runId);
      }
      return this.getPhase(input);
    });
  }

  succeedPhase(input, options) { return this.finishPhase(input, { ...options, state: 'succeeded' }); }
  failPhase(input, options) { return this.finishPhase(input, { ...options, state: 'failed' }); }
  markPhaseUncertain(input, options) {
    return this.finishPhase(input, { ...options, error: options.reason, state: 'uncertain' });
  }

  getModelCall({ runId, finalKey, phase, ordinal }) {
    return mapCall(this.db.prepare(`
      SELECT * FROM quality_model_calls
      WHERE run_id=? AND final_key=? AND phase=? AND ordinal=?
    `).get(runId, finalKey, phase, ordinal));
  }

  prepareModelCall(rawInput) {
    return this.claimModelCallStart(rawInput).row;
  }

  claimModelCallStart(rawInput) {
    const input = callIdentity(rawInput);
    return this.immediate(() => {
      const phase = this.getPhase(input);
      if (!phase || phase.state !== 'running') {
        throw new Error('quality model call phase conflict');
      }
      const existing = this.getModelCall(input);
      if (existing) {
        if (existing.callId !== input.callId || existing.role !== input.role
          || existing.threadId !== input.threadId
          || existing.baselineChecksum !== input.baselineChecksum
          || existing.requestChecksum !== input.requestChecksum
          || existing.clientUserMessageId !== input.request.clientUserMessageId) {
          throw new Error('quality model call conflict');
        }
        if (existing.state === 'uncertain') throw new Error('quality model call is uncertain');
        return { row: existing, claimed: false };
      }
      this.assertRunWritable(input.runId);
      if (input.now < phase.runningAt) throw new Error('quality model call timestamp conflict');
      const count = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM quality_model_calls
        WHERE run_id=? AND final_key=? AND phase=?
      `).get(input.runId, input.finalKey, input.phase).count);
      if (count !== input.ordinal) throw new Error('quality model call ordinal gap');
      this.db.prepare(`
        INSERT INTO quality_model_calls(
          run_id,final_key,phase,ordinal,state,role,call_id,client_user_message_id,
          thread_id,baseline_json,baseline_checksum,request_json,request_checksum,
          model,effort,schema_checksum,created_at,updated_at
        ) VALUES (?,?,?,?,'starting',?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        input.runId, input.finalKey, input.phase, input.ordinal, input.role,
        input.callId, input.request.clientUserMessageId, input.threadId,
        input.baselineJson, input.baselineChecksum, input.requestJson, input.requestChecksum,
        input.model, input.effort, input.schemaChecksum, input.now, input.now
      );
      return { row: this.getModelCall(input), claimed: true };
    });
  }

  markModelCallRunning(rawInput, { turnId, now }) {
    const input = callIdentity(rawInput);
    nonEmpty(turnId, 'quality model call turn id conflict');
    nativeInteger(now, 'quality model call timestamp conflict');
    return this.immediate(() => {
      const existing = this.getModelCall(input);
      if (!existing || existing.requestChecksum !== input.requestChecksum) {
        throw new Error('quality model call conflict');
      }
      if (existing.state === 'running' && existing.turnId === turnId) return existing;
      if (existing.state !== 'starting') throw new Error('quality model call state conflict');
      const phase = this.getPhase(input);
      if (!phase || phase.state !== 'running') throw new Error('quality model call phase conflict');
      this.assertRunWritable(input.runId);
      if (now < existing.updatedAt) throw new Error('quality model call timestamp conflict');
      const result = this.db.prepare(`
        UPDATE quality_model_calls SET state='running',turn_id=?,running_at=?,updated_at=?
        WHERE run_id=? AND final_key=? AND phase=? AND ordinal=? AND state='starting'
      `).run(turnId, now, now, input.runId, input.finalKey, input.phase, input.ordinal);
      if (Number(result.changes) !== 1) throw new Error('quality model call conflict');
      return this.getModelCall(input);
    });
  }

  finishModelCall(rawInput, { state, output = null, error = null, now }) {
    const input = callIdentity(rawInput);
    nativeInteger(now, 'quality model call timestamp conflict');
    if (!['succeeded', 'failed', 'uncertain'].includes(state)) {
      throw new Error('quality model call terminal state conflict');
    }
    if ((state === 'succeeded' && (output === null || error !== null))
      || (state !== 'succeeded' && (output !== null || error === null))) {
      throw new Error('quality model call terminal payload conflict');
    }
    const outputJson = output === null ? null : canonicalJson(output);
    const outputChecksum = output === null ? null : contentHash(output);
    const errorJson = error === null ? null : canonicalJson(error);
    return this.immediate(() => {
      const existing = this.getModelCall(input);
      if (!existing || existing.requestChecksum !== input.requestChecksum) {
        throw new Error('quality model call conflict');
      }
      if (existing.state === state) {
        if (existing.outputChecksum !== outputChecksum
          || canonicalJson(existing.error) !== canonicalJson(error)) {
          throw new Error('quality model call state conflict');
        }
        return existing;
      }
      const phase = this.getPhase(input);
      if (!phase || phase.state !== 'running') throw new Error('quality model call phase conflict');
      this.assertRunWritable(input.runId, { allowBlocked: state === 'uncertain' });
      if (now < existing.updatedAt) throw new Error('quality model call timestamp conflict');
      if (state === 'uncertain') {
        if (!['starting', 'running'].includes(existing.state)) {
          throw new Error('quality model call state conflict');
        }
      } else if (existing.state !== 'running') {
        throw new Error('quality model call state conflict');
      }
      const result = this.db.prepare(`
        UPDATE quality_model_calls
        SET state=?,output_json=?,output_checksum=?,error_json=?,updated_at=?
        WHERE run_id=? AND final_key=? AND phase=? AND ordinal=? AND state=?
      `).run(
        state, outputJson, outputChecksum, errorJson, now,
        input.runId, input.finalKey, input.phase, input.ordinal, existing.state
      );
      if (Number(result.changes) !== 1) throw new Error('quality model call state conflict');
      if (state === 'uncertain') {
        this.db.prepare(`UPDATE quality_runs SET state='blocked' WHERE run_id=? AND state='open'`)
          .run(input.runId);
      }
      return this.getModelCall(input);
    });
  }

  succeedModelCall(input, options) {
    return this.finishModelCall(input, { ...options, state: 'succeeded' });
  }
  failModelCall(input, options) {
    return this.finishModelCall(input, { ...options, state: 'failed' });
  }
  markModelCallUncertain(input, options) {
    return this.finishModelCall(input, {
      ...options, error: options.reason, state: 'uncertain'
    });
  }

  finalize({ runId, finalKey, value, now }) {
    nonEmpty(runId, 'quality final run id conflict');
    nonEmpty(finalKey, 'quality final key conflict');
    nativeInteger(now, 'quality final timestamp conflict');
    if (!isObject(value)) throw new Error('quality final value conflict');
    const valueJson = canonicalJson(value);
    const valueChecksum = contentHash(value);
    return this.immediate(() => {
      this.assertFinalMember(runId, finalKey);
      const existing = mapFinal(this.db.prepare(`
        SELECT * FROM quality_finals WHERE run_id=? AND final_key=?
      `).get(runId, finalKey));
      if (existing) {
        if (existing.checksum !== valueChecksum || canonicalJson(existing.value) !== valueJson) {
          throw new Error('quality final conflict');
        }
        return existing;
      }
      this.assertRunWritable(runId);
      const phases = this.db.prepare(`
        SELECT phase,state,updated_at FROM quality_phases WHERE run_id=? AND final_key=?
      `).all(runId, finalKey);
      if (phases.length !== PHASES.length
        || PHASES.some(phase => !phases.some(row => row.phase === phase
          && row.state === 'succeeded' && Number(row.updated_at) <= now))) {
        throw new Error('quality final phase conflict');
      }
      this.db.prepare(`
        INSERT INTO quality_finals(run_id,final_key,value_json,value_checksum,finalized_at)
        VALUES (?,?,?,?,?)
      `).run(runId, finalKey, valueJson, valueChecksum, now);
      return mapFinal(this.db.prepare(`
        SELECT * FROM quality_finals WHERE run_id=? AND final_key=?
      `).get(runId, finalKey));
    });
  }

  finalizeRun({ runId, now }) {
    nonEmpty(runId, 'quality final run id conflict');
    nativeInteger(now, 'quality final timestamp conflict');
    return this.immediate(() => {
      const row = this.db.prepare('SELECT * FROM quality_runs WHERE run_id=?').get(runId);
      if (!row) throw new Error('quality final run conflict');
      if (row.state === 'finalized') return mapRun(row);
      if (row.state !== 'open') throw new Error('quality run is not writable');
      const finalCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM quality_finals WHERE run_id=?
      `).get(runId).count);
      if (finalCount !== 246) throw new Error('quality run requires exactly 246 finals');
      const latestFinal = Number(this.db.prepare(`
        SELECT MAX(finalized_at) AS latest FROM quality_finals WHERE run_id=?
      `).get(runId).latest);
      if (now < latestFinal) throw new Error('quality final timestamp conflict');
      const phaseRows = this.db.prepare(`
        SELECT state FROM quality_phases WHERE run_id=?
      `).all(runId);
      if (phaseRows.length !== 246 * PHASES.length
        || phaseRows.some(phase => phase.state !== 'succeeded')) {
        throw new Error('quality run phase completion conflict');
      }
      const modelCounts = this.db.prepare(`
        SELECT p.final_key,p.phase,COUNT(c.ordinal) AS call_count,
               SUM(CASE WHEN c.state='succeeded' THEN 1 ELSE 0 END) AS succeeded_count
        FROM quality_phases p
        LEFT JOIN quality_model_calls c
          ON c.run_id=p.run_id AND c.final_key=p.final_key AND c.phase=p.phase
        WHERE p.run_id=?
        GROUP BY p.final_key,p.phase
      `).all(runId);
      if (modelCounts.length !== 246 * PHASES.length
        || modelCounts.some(item => Number(item.call_count) === 0
          || Number(item.call_count) !== Number(item.succeeded_count))) {
        throw new Error('quality run model call completion conflict');
      }
      const result = this.db.prepare(`
        UPDATE quality_runs SET state='finalized',finalized_at=?
        WHERE run_id=? AND state='open'
      `).run(now, runId);
      if (Number(result.changes) !== 1) throw new Error('quality final run conflict');
      return mapRun(this.db.prepare('SELECT * FROM quality_runs WHERE run_id=?').get(runId));
    });
  }
}

function deterministicClientId(scope, ordinal, requestBasis) {
  return qualityClientUserMessageId({ ...scope, ordinal }, requestBasis);
}

function outputFromRecoveredTurn(threadId, turn) {
  const text = [...(turn.items || [])].reverse()
    .find(item => item?.type === 'agentMessage' && typeof item.text === 'string')?.text;
  if (turn.status !== 'completed' || !text?.trim()) return null;
  return { threadId, turnId: turn.id, status: turn.status, error: turn.error || null, text };
}

function recoveredTurnMatchesRequest(turn, row) {
  if (!isObject(turn) || !Array.isArray(turn.items)) return false;
  const userItems = turn.items.filter(item => item?.type === 'userMessage');
  if (userItems.length !== 1 || userItems[0].clientId !== row.clientUserMessageId
    || !Array.isArray(userItems[0].content)) {
    return false;
  }
  const content = userItems[0].content;
  if (content.length !== 1 || content[0]?.type !== 'text'
    || (Object.hasOwn(content[0], 'text_elements')
      && (!Array.isArray(content[0].text_elements) || content[0].text_elements.length !== 0))) {
    return false;
  }
  const expectedText = typeof row.request.input === 'string'
    ? row.request.input
    : JSON.stringify(row.request.input);
  return content[0].text === expectedText
    && Array.isArray(row.request.localImagePaths)
    && row.request.localImagePaths.length === 0;
}

class LedgerPhaseModelClient {
  constructor(owner, scope) {
    this.owner = owner;
    this.scope = scope;
    this.ordinal = 0;
  }

  runTurn(role, input, options = {}) {
    return this.runMappedTurn(role, input, options);
  }

  runRole(role, payload, options = {}) {
    const mapped = sessionRoleForPipelineRole(role);
    if (!mapped) return Promise.reject(new Error(`unknown pipeline role: ${role}`));
    const { deadlineMs, outerDeadlineMs, ...turnOptions } = options;
    return this.runMappedTurn(mapped, payload, turnOptions);
  }

  async runMappedTurn(role, input, options) {
    if (!MODEL_SESSION_ROLES.has(role)) throw new Error(`unknown model session role: ${role}`);
    const ordinal = this.ordinal++;
    return this.owner.executeCall(this.scope, ordinal, role, input, options);
  }
}

export class LedgerBackedModelClient {
  constructor({ ledger, underlying, runId }) {
    if (!(ledger instanceof QualityReplayLedger) || !underlying) {
      throw new Error('quality ledger model client dependencies required');
    }
    this.ledger = ledger;
    this.underlying = underlying;
    this.runId = nonEmpty(runId, 'quality ledger model client run id conflict');
  }

  forPhase(rawScope) {
    const phase = phaseIdentity(rawScope);
    if (phase.runId !== this.runId) throw new Error('quality phase run conflict');
    const stored = this.ledger.preparePhase(rawScope);
    if (stored.inputChecksum !== phase.inputChecksum) throw new Error('quality phase input conflict');
    return new LedgerPhaseModelClient(this, {
      runId: phase.runId,
      finalKey: phase.finalKey,
      phase: phase.phase
    });
  }

  async recoverCall(row, identity) {
    try {
      const thread = await this.underlying.readThread(row.threadId);
      if (!isObject(thread) || thread.id !== row.threadId || !Array.isArray(thread.turns)) {
        throw new Error('REMOTE_THREAD_MALFORMED');
      }
      const baselineById = new Map(row.baseline.turns.map(turn => [String(turn.id || ''), turn]));
      const currentById = new Map(thread.turns.map(turn => [String(turn?.id || ''), turn]));
      const baselineIsExact = baselineById.size === row.baseline.turns.length
        && currentById.size === thread.turns.length
        && [...baselineById].every(([id, turn]) =>
          id && currentById.has(id) && canonicalJson(currentById.get(id)) === canonicalJson(turn));
      const candidates = thread.turns.filter(turn => !baselineById.has(String(turn?.id || '')));
      const exact = candidates.filter(turn =>
        (!row.turnId || turn.id === row.turnId) && recoveredTurnMatchesRequest(turn, row));
      if (!baselineIsExact || candidates.length !== 1 || exact.length !== 1) {
        throw new Error('REMOTE_RESULT_AMBIGUOUS');
      }
      const output = outputFromRecoveredTurn(row.threadId, exact[0]);
      if (!output) throw new Error('REMOTE_RESULT_UNPROVABLE');
      if (row.state === 'starting') {
        this.ledger.markModelCallRunning(identity, { turnId: exact[0].id, now: Date.now() });
      }
      this.ledger.succeedModelCall(identity, { output, now: Date.now() });
      return output;
    } catch (error) {
      const current = this.ledger.getModelCall(identity);
      if (current && ['starting', 'running'].includes(current.state)) {
        this.ledger.markModelCallUncertain(identity, {
          reason: {
            code: String(error?.message || '').startsWith('REMOTE_')
              ? String(error.message)
              : 'REMOTE_RESULT_UNPROVABLE'
          },
          now: Date.now()
        });
      }
      throw new Error('quality model call is uncertain');
    }
  }

  async executeCall(scope, ordinal, role, input, options) {
    const wireInput = typeof input === 'string' ? input : JSON.stringify(input);
    if (!wireInput.trim()) throw new Error('quality model call input is empty');
    const requestBasis = {
      input: wireInput,
      model: options.model || 'gpt-5.6-sol',
      effort: options.effort || 'high',
      outputSchema: options.outputSchema || ROLE_OUTPUT_SCHEMAS[role],
      localImagePaths: Array.isArray(options.localImagePaths) ? [...options.localImagePaths] : []
    };
    const clientUserMessageId = deterministicClientId(scope, ordinal, requestBasis);
    const request = { ...requestBasis, clientUserMessageId };
    const key = { ...scope, ordinal };
    const existing = this.ledger.getModelCall(key);
    if (existing) {
      if (existing.role !== role
        || existing.clientUserMessageId !== clientUserMessageId
        || existing.requestChecksum !== contentHash(request)) {
        throw new Error('quality model call conflict');
      }
      if (existing.state === 'succeeded') return existing.output;
      if (existing.state === 'uncertain') throw new Error('quality model call is uncertain');
      if (existing.state === 'failed') throw new Error('quality model call failed');
      return this.recoverCall(existing, {
        ...key, role, threadId: existing.threadId, baseline: existing.baseline,
        request: existing.request, now: existing.createdAt
      });
    }
    const threadId = await this.underlying.ensureThread(role);
    const baseline = await this.underlying.readThread(threadId);
    const identity = {
      ...key, role, threadId, baseline, request, now: Date.now()
    };
    const claim = this.ledger.claimModelCallStart(identity);
    if (!claim.claimed) {
      if (claim.row.state === 'succeeded') return claim.row.output;
      throw new Error('quality model call is already starting');
    }
    try {
      const result = await this.underlying.runTurn(role, wireInput, {
        ...options,
        model: request.model,
        effort: request.effort,
        outputSchema: request.outputSchema,
        localImagePaths: request.localImagePaths,
        clientUserMessageId,
        onTurnStarted: async started => {
          this.ledger.markModelCallRunning(identity, {
            turnId: started.turnId, now: Date.now()
          });
          await options.onTurnStarted?.(started);
        }
      });
      this.ledger.succeedModelCall(identity, { output: result, now: Date.now() });
      return result;
    } catch (error) {
      const current = this.ledger.getModelCall(key);
      const detail = { name: error?.name || 'Error', message: String(error?.message || error) };
      if (current && current.state === 'running' && error?.status && error.status !== 'timeout') {
        this.ledger.failModelCall(identity, { error: detail, now: Date.now() });
      } else if (current && ['starting', 'running'].includes(current.state)) {
        this.ledger.markModelCallUncertain(identity, { reason: detail, now: Date.now() });
      }
      throw error;
    }
  }
}

export { PHASES as QUALITY_REPLAY_PHASES };
