import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  bindQualityPhaseClientSlot,
  createQualityPhaseBinding,
  createQualityPhaseClientSlot,
  LedgerBackedModelClient,
  QualityReplayLedger,
  qualityClientUserMessageId
} from '../src/quality-replay-ledger.mjs';
import { contentHash } from '../src/protocol.mjs';

function withLedger(run) {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-quality-ledger-'));
  const path = join(root, 'quality.sqlite');
  const remove = () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  try {
    const result = run({ root, path });
    if (result && typeof result.then === 'function') {
      return result.then(value => {
        remove();
        return value;
      }, error => {
        try { remove(); } catch {}
        throw error;
      });
    }
    remove();
    return result;
  } catch (error) {
    try { remove(); } catch {}
    throw error;
  }
}

test('public ledger constructor cannot create a production meta row', () => withLedger(({ path }) => {
  assert.throws(() => new QualityReplayLedger(path, { evidenceClass: 'production' }), /production|private|authority/i);
  assert.equal(existsSync(path), false);
}));

function runHeader(overrides = {}) {
  const finalKeys = Array.from({ length: 246 }, (_, index) => `coverage:scene-${index}:0`);
  const sourceHead = 'a'.repeat(40);
  const stableRelease = {
    releaseId: 'stable-r2', pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.0.0',
    cognitionSchemaVersion: 3, expressionSchemaVersion: 3, evaluatorVersion: 'quality-test',
    modelProfile: { cognition: 'test', expression: 'test' }, componentManifest: { test: 'stable' },
    releaseChecksum: 'b'.repeat(64), createdAt: 900, retiredAt: null,
  };
  const candidateRelease = {
    ...stableRelease, releaseId: 'candidate-r3', componentManifest: { test: 'candidate' },
    releaseChecksum: 'c'.repeat(64),
  };
  const attestation = {
    version: 1, sourceHead,
    stableRuntime: { sourceHead, adapterIds: { turn: [], life: [] } },
    candidateRuntime: { sourceHead, adapterIds: { turn: [], life: [] } },
    evaluatorPrimary: {
      evaluatorId: 'evaluator-primary', evaluatorVersion: 'quality-test',
      modelProfileChecksum: '1'.repeat(64), clientConfigChecksum: '2'.repeat(64),
      sessionNamespaceChecksum: '3'.repeat(64),
    },
    evaluatorSecondary: {
      evaluatorId: 'evaluator-secondary', evaluatorVersion: 'quality-test',
      modelProfileChecksum: '4'.repeat(64), clientConfigChecksum: '5'.repeat(64),
      sessionNamespaceChecksum: '6'.repeat(64),
    },
  };
  return {
    version: 1,
    runId: '123e4567-e89b-42d3-a456-426614174000',
    finalKeys,
    planChecksum: contentHash(finalKeys),
    sourceHead, stableRelease, candidateRelease, attestation,
    attestationChecksum: contentHash(attestation),
    artifactPaths: { plan: 'plan.json', ledger: 'quality.sqlite', raw: 'raw.jsonl' },
    createdAt: 1000,
    ...overrides
  };
}

test('quality ledger meta is immutable and distinguishes fixture evidence', () => withLedger(({ path }) => {
  const ledger = new QualityReplayLedger(path);
  assert.deepEqual(ledger.getMeta(), { schemaVersion: 1, evidenceClass: 'fixture' });
  ledger.close();
  const db = new DatabaseSync(path, {});
  db.prepare('UPDATE quality_ledger_meta SET evidence_class=?').run('production');
  db.close();
  assert.throws(() => new QualityReplayLedger(path), /meta authority conflict/);
}));

function phaseInput(overrides = {}) {
  return {
    runId: '123e4567-e89b-42d3-a456-426614174000',
    finalKey: 'coverage:scene-0:0',
    phase: 'stable_execution',
    subjectChecksum: '1'.repeat(64),
    authorityInputChecksum: '2'.repeat(64),
    input: { subjectType: 'turn', value: 'same' },
    now: 1100,
    ...overrides
  };
}

function callInput(overrides = {}) {
  const { request: requestOverride = {}, ...identityOverrides } = overrides;
  const scope = {
    runId: identityOverrides.runId || '123e4567-e89b-42d3-a456-426614174000',
    finalKey: identityOverrides.finalKey || 'coverage:scene-0:0',
    phase: identityOverrides.phase || 'stable_execution',
    ordinal: identityOverrides.ordinal ?? 0
  };
  const requestBasis = {
    input: 'hello', model: 'gpt-5.6-sol', effort: 'high',
    outputSchema: { type: 'object' }, localImagePaths: [],
    ...Object.fromEntries(Object.entries(requestOverride)
      .filter(([key]) => key !== 'clientUserMessageId'))
  };
  return {
    ...scope,
    role: 'brain',
    threadId: 'thr_brain',
    baseline: { id: 'thr_brain', turns: [{ id: 'old', status: 'completed' }] },
    request: {
      ...requestBasis,
      clientUserMessageId: requestOverride.clientUserMessageId
        || qualityClientUserMessageId(scope, requestBasis)
    },
    now: 1200,
    ...identityOverrides
  };
}

function succeedOwnedPhase(ledger, input, ordinal = 0, baseNow = input.now + 160) {
  const call = callInput({
    finalKey: input.finalKey,
    phase: input.phase,
    ordinal,
    now: baseNow
  });
  ledger.prepareModelCall(call);
  ledger.markModelCallRunning(call, {
    turnId: `turn_${input.finalKey}_${input.phase}_${ordinal}`,
    now: baseNow + 1
  });
  ledger.succeedModelCall(call, { output: { owned: true }, now: baseNow + 2 });
  return ledger.succeedPhase(input, { output: { phase: input.phase }, now: baseNow + 3 });
}

function exactFinalValue(finalKey, finalIndex = 0) {
  const scores = Object.fromEntries([
    'socialUnderstanding', 'agency', 'relationshipParticipation',
    'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'
  ].map(key => [key, 4]));
  const output = { version: 1, scores, preference: 'tie', findings: [], unresolved: false };
  const inputChecksum = '7'.repeat(64);
  const judgment = id => ({ evaluatorId: id, evaluatorVersion: 'quality-test',
    inputChecksum, output, outputChecksum: contentHash(output) });
  const phaseInputChecksum = contentHash({
    subjectChecksum: '1'.repeat(64), authorityInputChecksum: '2'.repeat(64),
    input: { subjectType: 'turn', value: 'same' }
  });
  return {
    version: 1, finalKey, subjectType: 'turn', subjectChecksum: '1'.repeat(64),
    stablePhase: { inputChecksum: phaseInputChecksum,
      outputChecksum: contentHash({ phase: 'stable_execution' }) },
    candidatePhase: { inputChecksum: phaseInputChecksum,
      outputChecksum: contentHash({ phase: 'candidate_execution' }) },
    blindInputChecksum: inputChecksum, primary: judgment('primary'),
    secondary: judgment('secondary'),
    comparison: { version: 1, differences: [], manualReview: false,
      unresolved: false, agreedCriticalFindings: [] },
  };
}

test('run header binds the full plan and reopens only with exact authority', () => withLedger(({ path }) => {
  const invalid = new QualityReplayLedger(path.replace('.sqlite', '-invalid.sqlite'));
  assert.throws(() => invalid.createOrOpenRun(runHeader({
    finalKeys: runHeader().finalKeys.slice(1)
  })), /246.*final/i);
  invalid.close();
  const invalidSource = new QualityReplayLedger(path.replace('.sqlite', '-source.sqlite'));
  assert.throws(() => invalidSource.createOrOpenRun(runHeader({ sourceHead: 'not-a-commit' })), /source head/i);
  invalidSource.close();
  const ledger = new QualityReplayLedger(path);
  const header = runHeader();
  const created = ledger.createOrOpenRun(header);
  assert.equal(created.headerChecksum, contentHash(header));
  assert.equal(created.finalKeys.length, 246);
  ledger.close();

  const reopened = new QualityReplayLedger(path);
  assert.deepEqual(reopened.createOrOpenRun(header), created);
  assert.throws(() => reopened.createOrOpenRun(runHeader({ sourceHead: 'e'.repeat(40) })), /conflict/i);
  assert.throws(() => reopened.createOrOpenRun(runHeader({
    stableRelease: { releaseId: 'stable-r2', releaseChecksum: 'e'.repeat(64) }
  })), /conflict/i);
  assert.throws(() => reopened.createOrOpenRun(runHeader({
    candidateRelease: { releaseId: 'candidate-r4', releaseChecksum: 'c'.repeat(64) }
  })), /conflict/i);
  assert.throws(() => reopened.createOrOpenRun(runHeader({
    attestationChecksum: 'e'.repeat(64)
  })), /conflict/i);
  assert.throws(() => reopened.createOrOpenRun(runHeader({
    artifactPaths: { plan: 'changed.json', ledger: 'quality.sqlite', raw: 'raw.jsonl' }
  })), /run header.*conflict/i);
  assert.throws(() => reopened.createOrOpenRun(runHeader({
    finalKeys: [...header.finalKeys.slice(0, -1), 'coverage:changed:0']
  })), /run header.*conflict/i);
  reopened.close();
}));

test('restart invariants reject corrupted checksums, call gaps, and incomplete finalized joins', () => withLedger(({ path }) => {
  const make = suffix => {
    const file = path.replace('.sqlite', `-${suffix}.sqlite`);
    const ledger = new QualityReplayLedger(file);
    ledger.createOrOpenRun(runHeader());
    return { file, ledger };
  };

  {
    const { file, ledger } = make('phase');
    ledger.preparePhase(phaseInput());
    ledger.db.prepare(`UPDATE quality_phases SET input_json=? WHERE run_id=?`).run(
      JSON.stringify({ subjectType: 'turn', value: 'tampered' }), '123e4567-e89b-42d3-a456-426614174000'
    );
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /ledger invariant.*phase/i);
  }

  {
    const { file, ledger } = make('call-gap');
    ledger.preparePhase(phaseInput());
    ledger.startPhase(phaseInput(), { now: 1101 });
    ledger.markPhaseRunning(phaseInput(), { now: 1102 });
    ledger.prepareModelCall(callInput());
    ledger.db.prepare(`UPDATE quality_model_calls SET ordinal=2 WHERE run_id=?`).run('123e4567-e89b-42d3-a456-426614174000');
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /ledger invariant.*call/i);
  }

  {
    const { file, ledger } = make('client-id');
    ledger.preparePhase(phaseInput());
    ledger.startPhase(phaseInput(), { now: 1101 });
    ledger.markPhaseRunning(phaseInput(), { now: 1102 });
    ledger.prepareModelCall(callInput());
    const forged = { ...callInput().request, clientUserMessageId: 'forged_client' };
    ledger.db.prepare(`
      UPDATE quality_model_calls
      SET client_user_message_id=?,request_json=?,request_checksum=?
      WHERE run_id=?
    `).run('forged_client', JSON.stringify(forged), contentHash(forged), '123e4567-e89b-42d3-a456-426614174000');
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /ledger invariant.*call/i);
  }

  {
    const { file, ledger } = make('phase-call-time');
    const phase = phaseInput();
    const call = callInput();
    ledger.preparePhase(phase);
    ledger.startPhase(phase, { now: 1101 });
    ledger.markPhaseRunning(phase, { now: 1102 });
    ledger.prepareModelCall(call);
    ledger.markModelCallRunning(call, { turnId: 'turn_time', now: 1201 });
    ledger.succeedModelCall(call, { output: { ok: true }, now: 1202 });
    ledger.succeedPhase(phase, { output: { ok: true }, now: 1300 });
    ledger.db.prepare(`
      UPDATE quality_phases SET running_at=? WHERE run_id=? AND final_key=? AND phase=?
    `).run(1250, phase.runId, phase.finalKey, phase.phase);
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /phase model call ownership/i);
  }

  {
    const { file, ledger } = make('phase-start-time');
    const phase = phaseInput();
    ledger.preparePhase(phase);
    ledger.startPhase(phase, { now: 1200 });
    ledger.markPhaseRunning(phase, { now: 1250 });
    ledger.db.prepare(`
      UPDATE quality_phases SET starting_at=? WHERE run_id=? AND final_key=? AND phase=?
    `).run(1000, phase.runId, phase.finalKey, phase.phase);
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /ledger invariant phase conflict/i);
  }

  {
    const { file, ledger } = make('final');
    for (const phase of [
      'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'
    ]) {
      const input = phaseInput({ phase });
      ledger.preparePhase(input);
      ledger.startPhase(input, { now: 1200 });
      ledger.markPhaseRunning(input, { now: 1250 });
      succeedOwnedPhase(ledger, input);
    }
    ledger.finalize({
      runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
      value: exactFinalValue('coverage:scene-0:0'), now: 1400
    });
    ledger.db.prepare(`
      UPDATE quality_phases
      SET state='failed',output_json=NULL,output_checksum=NULL,error_json=?
      WHERE run_id=? AND phase=?
    `).run(JSON.stringify({ code: 'tampered' }), '123e4567-e89b-42d3-a456-426614174000', 'evaluator_secondary');
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /ledger invariant.*final/i);
  }

  {
    const { file, ledger } = make('schema');
    ledger.db.exec('DROP TABLE quality_model_calls');
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /ledger schema.*conflict/i);
  }

  {
    const { file, ledger } = make('schema-object');
    ledger.db.exec(`
      CREATE TRIGGER unexpected_quality_trigger
      AFTER INSERT ON quality_runs BEGIN SELECT 1; END
    `);
    ledger.close();
    assert.throws(() => new QualityReplayLedger(file), /ledger schema.*conflict/i);
  }
}));

test('phase state machine survives restart and binds subject plus authority input', () => withLedger(({ path }) => {
  let ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  const prepared = ledger.preparePhase(phaseInput());
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.inputChecksum, contentHash({
    subjectChecksum: '1'.repeat(64),
    authorityInputChecksum: '2'.repeat(64),
    input: { subjectType: 'turn', value: 'same' }
  }));
  ledger.close();

  ledger = new QualityReplayLedger(path);
  assert.deepEqual(ledger.preparePhase(phaseInput()), prepared);
  assert.throws(() => ledger.preparePhase(phaseInput({
    authorityInputChecksum: '3'.repeat(64)
  })), /phase input.*conflict/i);
  assert.throws(() => ledger.preparePhase({ ...phaseInput(), ignored: true }), /phase input shape.*conflict/i);
  assert.equal(ledger.startPhase(phaseInput(), { now: 1200 }).state, 'starting');
  assert.equal(ledger.resetStartingPhase(phaseInput(), { now: 1210 }).state, 'prepared');
  assert.equal(ledger.startPhase(phaseInput(), { now: 1220 }).state, 'starting');
  ledger.close();
  ledger = new QualityReplayLedger(path);
  assert.equal(ledger.markPhaseRunning(phaseInput(), { now: 1250 }).state, 'running');
  assert.equal(succeedOwnedPhase(ledger, phaseInput()).state, 'succeeded');
  assert.throws(() => ledger.failPhase(phaseInput(), {
    error: { code: 'LATE_FAILURE' }, now: 1400
  }), /phase state.*conflict/i);
  ledger.close();
}));

test('model calls enforce contiguous ordinals, exact replay, CAS, and terminal uncertainty', () => withLedger(({ path }) => {
  const first = new QualityReplayLedger(path);
  first.createOrOpenRun(runHeader());
  first.preparePhase(phaseInput());
  first.startPhase(phaseInput(), { now: 1101 });
  first.markPhaseRunning(phaseInput(), { now: 1102 });
  const prepared = first.prepareModelCall(callInput());
  assert.equal(prepared.state, 'starting');
  assert.equal(prepared.ordinal, 0);
  assert.deepEqual(first.prepareModelCall(callInput()), prepared);
  assert.throws(() => first.prepareModelCall(callInput({
    request: { ...callInput().request, input: 'changed' }
  })), /model call.*conflict/i);
  assert.throws(() => first.prepareModelCall(callInput({ ordinal: 2 })), /ordinal.*gap/i);

  const second = new QualityReplayLedger(path);
  const claimed = first.markModelCallRunning(callInput(), { turnId: 'turn_remote_1', now: 1250 });
  assert.equal(claimed.state, 'running');
  assert.throws(() => second.markModelCallRunning(callInput(), {
    turnId: 'turn_remote_2', now: 1251
  }), /model call.*conflict/i);
  const uncertain = second.markModelCallUncertain(callInput(), {
    reason: { code: 'REMOTE_RESULT_AMBIGUOUS' }, now: 1300
  });
  assert.equal(uncertain.state, 'uncertain');
  assert.throws(() => first.prepareModelCall(callInput()), /uncertain/i);
  assert.throws(() => first.succeedModelCall(callInput(), {
    output: { text: 'late' }, now: 1400
  }), /not writable|model call state.*conflict/i);
  first.close();
  second.close();
}));

test('a phase cannot terminate around an open or late model call', () => withLedger(({ path }) => {
  let ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  const phase = phaseInput();
  const call = callInput();
  ledger.preparePhase(phase);
  ledger.startPhase(phase, { now: 1101 });
  ledger.markPhaseRunning(phase, { now: 1102 });
  ledger.prepareModelCall(call);
  ledger.markModelCallRunning(call, { turnId: 'turn_open', now: 1201 });
  assert.throws(() => ledger.failPhase(phase, {
    error: { code: 'PHASE_FAILED_EARLY' }, now: 1202
  }), /model call ownership/i);
  ledger.failModelCall(call, { error: { code: 'REMOTE_FAILED' }, now: 1203 });
  assert.equal(ledger.failPhase(phase, {
    error: { code: 'PHASE_FAILED' }, now: 1204
  }).state, 'failed');
  assert.throws(() => ledger.succeedModelCall(call, {
    output: { late: true }, now: 1205
  }), /model call phase|model call state/i);
  ledger.close();

  ledger = new QualityReplayLedger(path);
  assert.equal(ledger.getPhase(phase).state, 'failed');
  assert.equal(ledger.getModelCall(call).state, 'failed');
  ledger.close();
}));

test('model-call authority rejects duplicate baseline identities and forged deterministic client ids', () => withLedger(({ path }) => {
  const ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  const phase = phaseInput({ finalKey: 'coverage:scene-1:0' });
  ledger.preparePhase(phase);
  ledger.startPhase(phase, { now: 1101 });
  ledger.markPhaseRunning(phase, { now: 1102 });
  assert.throws(() => ledger.prepareModelCall(callInput({
    finalKey: phase.finalKey,
    baseline: { id: 'thr_brain', turns: [
      { id: 'same', status: 'completed', items: [] },
      { id: 'same', status: 'completed', items: [] }
    ] }
  })), /baseline.*conflict/i);
  assert.throws(() => ledger.prepareModelCall(callInput({
    finalKey: phase.finalKey,
    request: { ...callInput({ finalKey: phase.finalKey }).request, clientUserMessageId: 'forged' }
  })), /client.*conflict/i);
  assert.throws(() => ledger.prepareModelCall({
    ...callInput({ finalKey: phase.finalKey }), ignored: true
  }), /model call input shape.*conflict/i);
  ledger.close();
}));

test('finalization requires four succeeded phases and is exact on replay', () => withLedger(({ path }) => {
  const ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  for (const phase of [
    'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'
  ]) {
    const input = phaseInput({ phase });
    ledger.preparePhase(input);
    ledger.startPhase(input, { now: 1200 });
    ledger.markPhaseRunning(input, { now: 1250 });
    if (phase === 'stable_execution') {
      assert.throws(() => ledger.succeedPhase(input, {
        output: { phase }, now: 1290
      }), /model call.*ownership/i);
    }
    const call = callInput({ phase, now: 1260 });
    ledger.prepareModelCall(call);
    ledger.markModelCallRunning(call, { turnId: `turn_${phase}`, now: 1270 });
    ledger.succeedModelCall(call, { output: { phase }, now: 1280 });
    ledger.succeedPhase(input, { output: { phase }, now: 1300 });
  }
  const final = ledger.finalize({
    runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
    value: exactFinalValue('coverage:scene-0:0'), now: 1400
  });
  assert.equal(final.state, 'finalized');
  assert.deepEqual(ledger.finalize({
    runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
    value: exactFinalValue('coverage:scene-0:0'), now: 1400
  }), final);
  assert.throws(() => ledger.finalize({
    runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
    value: { ...exactFinalValue('coverage:scene-0:0'), comparison: { version: 1,
      differences: ['scores'], manualReview: true, unresolved: false,
      agreedCriticalFindings: [] } }, now: 1400
  }), /final.*conflict/i);
  assert.throws(() => ledger.finalizeRun({ runId: '123e4567-e89b-42d3-a456-426614174000', now: 1500 }), /246.*final/i);
  ledger.close();
}));

test('a run seals only after all 246 finals and 984 owned phases are complete', () => withLedger(({ path }) => {
  let ledger = new QualityReplayLedger(path);
  const header = runHeader();
  ledger.createOrOpenRun(header);
  for (const [finalIndex, finalKey] of header.finalKeys.entries()) {
    const baseNow = 2000 + finalIndex * 200;
    for (const [phaseIndex, phase] of [
      'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'
    ].entries()) {
      const input = phaseInput({ finalKey, phase, now: baseNow + phaseIndex * 20 });
      ledger.preparePhase(input);
      ledger.startPhase(input, { now: baseNow + phaseIndex * 20 + 1 });
      ledger.markPhaseRunning(input, { now: baseNow + phaseIndex * 20 + 2 });
      succeedOwnedPhase(ledger, input, 0, baseNow + phaseIndex * 20 + 3);
    }
    ledger.finalize({
      runId: header.runId,
      finalKey,
      value: exactFinalValue(finalKey, finalIndex),
      now: baseNow + 190
    });
  }
  const sealed = ledger.finalizeRun({ runId: header.runId, now: 100000 });
  assert.equal(sealed.state, 'finalized');
  assert.equal(sealed.finalizedAt, 100000);
  assert.deepEqual(ledger.finalizeRun({ runId: header.runId, now: 100001 }), sealed);
  assert.throws(() => ledger.startPhase(phaseInput(), { now: 100002 }), /not writable/i);
  ledger.close();

  ledger = new QualityReplayLedger(path);
  assert.equal(ledger.createOrOpenRun(header).state, 'finalized');
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM quality_finals').get().count, 246);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM quality_phases').get().count, 984);
  ledger.close();
}));

test('ledger-backed client maps runRole through runTurn and replays succeeded nested calls', async () => withLedger(async ({ path }) => {
  const ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  ledger.preparePhase(phaseInput());
  ledger.startPhase(phaseInput(), { now: 1101 });
  ledger.markPhaseRunning(phaseInput(), { now: 1102 });
  const calls = [];
  const underlying = {
    async ensureThread(role) { calls.push(['ensure', role]); return `thr_${role}`; },
    async readThread(threadId) { calls.push(['read', threadId]); return { id: threadId, turns: [] }; },
    async runTurn(role, input, options) {
      calls.push(['turn', role, input, options.clientUserMessageId]);
      await options.onTurnStarted({
        threadId: `thr_${role}`, turnId: `remote_${calls.length}`,
        clientUserMessageId: options.clientUserMessageId
      });
      return { threadId: `thr_${role}`, turnId: `remote_${calls.length}`, text: `reply:${role}` };
    },
    async runRole() { throw new Error('runRole bypassed ledger'); }
  };
  const client = new LedgerBackedModelClient({ ledger, underlying, runId: '123e4567-e89b-42d3-a456-426614174000' });
  const scoped = client.forPhase(phaseInput());
  const first = await scoped.runRole('expression_v3', { turnId: 't1' }, {
    model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
  });
  assert.equal(first.text, 'reply:brain');
  const callCount = calls.length;
  const replay = client.forPhase(phaseInput());
  assert.deepEqual(await replay.runRole('expression_v3', { turnId: 't1' }, {
    model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
  }), first);
  assert.equal(calls.length, callCount);
  assert.equal(calls.some(call => call[0] === 'runRole'), false);
  ledger.close();
}));

test('unbound phase slots are inert until their exact persisted phase is running', async () => withLedger(async ({ path }) => {
  const ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  const underlying = {
    async readThread(id) { return { id, turns: [] }; },
    async ensureThread(role) { return `thr_${role}`; },
    async runTurn(_role, input, options) {
      await options.onTurnStarted({ threadId: 'thr_brain', turnId: 'remote_1' });
      return { threadId: 'thr_brain', turnId: 'remote_1', status: 'completed', text: String(input) };
    },
  };
  const client = new LedgerBackedModelClient({ ledger, underlying, runId: '123e4567-e89b-42d3-a456-426614174000' });
  const raw = phaseInput();
  const slot = createQualityPhaseClientSlot({
    runId: raw.runId, finalKey: raw.finalKey, phase: raw.phase, side: 'stable'
  });
  assert.throws(() => createQualityPhaseClientSlot({
    runId: raw.runId, finalKey: raw.finalKey, phase: raw.phase, side: 'evil'
  }), /slot|side/i);
  assert.throws(() => createQualityPhaseClientSlot({
    runId: raw.runId, finalKey: raw.finalKey, phase: 'candidate_execution', side: 'stable'
  }), /slot|side/i);
  await assert.rejects(() => slot.runTurn('brain', { hello: 'before' }), /phase slot.*bound|running/i);
  const phaseRowCount = () => Number(ledger.db.prepare(
    'SELECT COUNT(*) AS count FROM quality_phases'
  ).get().count);
  assert.throws(() => client.forPhase(raw), /persisted|running/i);
  assert.equal(phaseRowCount(), 0);
  ledger.preparePhase(raw);
  const preparedCount = phaseRowCount();
  assert.throws(() => client.forPhase(raw), /running/i);
  assert.equal(phaseRowCount(), preparedCount);
  assert.throws(() => bindQualityPhaseClientSlot(slot, client, raw), /running/i);
  ledger.startPhase(raw, { now: 1101 });
  ledger.markPhaseRunning(raw, { now: 1102 });
  const bound = bindQualityPhaseClientSlot(slot, client, raw);
  assert.equal(bound, slot);
  const result = await slot.runTurn('brain', { hello: 'after' });
  assert.equal(result.text, JSON.stringify({ hello: 'after' }));
  assert.throws(() => bindQualityPhaseClientSlot(slot, client, raw), /bound|conflict/i);
  const roleResult = await slot.runRole('expression_v3', { hello: 'role' }, {});
  assert.equal(roleResult.status, 'completed');
  ledger.close();
}));

test('ledger phase runRole preserves production deadline conversion and never calls underlying runRole', async () => withLedger(async ({ path }) => {
  const ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  const calls = [];
  const underlying = {
    turnTimeoutMs: 180000,
    async readThread(id) { return { id, turns: [] }; },
    async ensureThread(role) { return `thr_${role}`; },
    async runRole() { throw new Error('underlying runRole bypass'); },
    async runTurn(role, input, options) {
      calls.push({ role, input, options });
      await options.onTurnStarted({ threadId: 'thr_brain', turnId: 'remote_deadline' });
      return { threadId: 'thr_brain', turnId: 'remote_deadline', status: 'completed', text: String(input) };
    },
  };
  const client = new LedgerBackedModelClient({ ledger, underlying, runId: '123e4567-e89b-42d3-a456-426614174000' });
  const raw = phaseInput();
  ledger.preparePhase(raw); ledger.startPhase(raw, { now: 1101 }); ledger.markPhaseRunning(raw, { now: 1102 });
  const scoped = client.forPhase(raw);
  await scoped.runRole('expression_v3', { hello: 'deadline' }, { deadlineMs: 9000, outerDeadlineMs: 4000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, 'brain');
  assert.equal(calls[0].options.turnTimeoutMs, 4000);
  ledger.close();
}));

test('foreign ledger identity is rejected before either ledger can record a call', async () => withLedger(async ({ root }) => {
  const first = new QualityReplayLedger(join(root, 'first.sqlite'));
  const second = new QualityReplayLedger(join(root, 'second.sqlite'));
  first.createOrOpenRun(runHeader());
  second.createOrOpenRun(runHeader());
  const raw = phaseInput();
  first.preparePhase(raw); first.startPhase(raw, { now: 1101 }); first.markPhaseRunning(raw, { now: 1102 });
  second.preparePhase(raw); second.startPhase(raw, { now: 1101 }); second.markPhaseRunning(raw, { now: 1102 });
  const underlying = {
    async ensureThread(role) { return `thr_${role}`; },
    async readThread(id) { return { id, turns: [] }; },
    async runTurn(role, input, options) {
      await options.onTurnStarted({ threadId: `thr_${role}`, turnId: 'foreign-turn' });
      return { threadId: `thr_${role}`, turnId: 'foreign-turn', status: 'completed', text: String(input) };
    },
  };
  const firstClient = new LedgerBackedModelClient({ ledger: first, underlying, runId: raw.runId });
  const secondClient = new LedgerBackedModelClient({ ledger: second, underlying, runId: raw.runId });
  const slot = createQualityPhaseClientSlot({
    runId: raw.runId, finalKey: raw.finalKey, phase: raw.phase, side: 'stable'
  }, { ledger: first });
  const foreignCallsBefore = Number(second.db.prepare(
    'SELECT COUNT(*) AS count FROM quality_model_calls'
  ).get().count);
  assert.throws(() => bindQualityPhaseClientSlot(
    slot, createQualityPhaseBinding(secondClient, raw),
  ), /ledger identity|conflict/i);
  assert.equal(Number(second.db.prepare(
    'SELECT COUNT(*) AS count FROM quality_model_calls'
  ).get().count), foreignCallsBefore);
  bindQualityPhaseClientSlot(slot, createQualityPhaseBinding(firstClient, raw));
  first.close(); second.close();
}));

function remoteTurn({
  id = 'remote_1', clientId = null, input = { turnId: 't1' },
  status = 'completed', text = 'recovered'
} = {}) {
  return {
    id,
    status,
    error: null,
    items: [
      {
        id: `user_${id}`,
        type: 'userMessage',
        clientId,
        content: [{ type: 'text', text: typeof input === 'string' ? input : JSON.stringify(input) }]
      },
      ...(text === null ? [] : [{ id: `agent_${id}`, type: 'agentMessage', text }])
    ]
  };
}

function recoveryUnderlying(snapshot, calls = []) {
  return {
    async ensureThread(role) { calls.push(['ensure', role]); return `thr_${role}`; },
    async readThread(threadId) {
      calls.push(['read', threadId]);
      if (snapshot instanceof Error) throw snapshot;
      return structuredClone(snapshot);
    },
    async runTurn() { calls.push(['turn']); throw new Error('turn/start must not run during recovery'); },
    async runRole() { calls.push(['role']); throw new Error('runRole must never bypass ledger'); }
  };
}

function seedInterruptedCall(ledger, { running = false } = {}) {
  ledger.createOrOpenRun(runHeader());
  ledger.preparePhase(phaseInput());
  ledger.startPhase(phaseInput(), { now: 1101 });
  ledger.markPhaseRunning(phaseInput(), { now: 1102 });
  const requestBasis = {
    input: JSON.stringify({ turnId: 't1' }),
    model: 'gpt-5.6-sol',
    effort: 'high',
    outputSchema: { type: 'object' },
    localImagePaths: []
  };
  const request = {
    ...requestBasis,
    clientUserMessageId: `quality_${contentHash({
      runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
      phase: 'stable_execution', ordinal: 0,
      requestBasisChecksum: contentHash(requestBasis)
    }).slice(0, 48)}`
  };
  const identity = callInput({
    threadId: 'thr_brain',
    baseline: { id: 'thr_brain', turns: [{ id: 'old', status: 'completed', items: [] }] },
    request
  });
  ledger.prepareModelCall(identity);
  if (running) ledger.markModelCallRunning(identity, { turnId: 'remote_1', now: 1201 });
  return identity;
}

test('a single exact completed remote turn recovers both sides of the awaited start hook without a new call', async () => withLedger(async ({ path }) => {
  for (const running of [false, true]) {
    const file = running ? path.replace('.sqlite', '-running.sqlite') : path;
    let ledger = new QualityReplayLedger(file);
    const identity = seedInterruptedCall(ledger, { running });
    ledger.close();

    ledger = new QualityReplayLedger(file);
    const calls = [];
    const snapshot = {
      id: 'thr_brain',
      turns: [
        ...identity.baseline.turns,
        remoteTurn({ clientId: identity.request.clientUserMessageId })
      ]
    };
    const client = new LedgerBackedModelClient({
      ledger, underlying: recoveryUnderlying(snapshot, calls), runId: '123e4567-e89b-42d3-a456-426614174000'
    });
    const result = await client.forPhase(phaseInput()).runTurn('brain', { turnId: 't1' }, {
      model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
    });
    assert.equal(result.turnId, 'remote_1');
    assert.equal(result.text, 'recovered');
    assert.deepEqual(calls, [['read', 'thr_brain']]);
    assert.equal(ledger.getModelCall({
      runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
      phase: 'stable_execution', ordinal: 0
    }).state, 'succeeded');
    ledger.close();
  }
}));

test('zero active multiple changed input changed client and conflicting baseline recoveries become terminal uncertain', async () => withLedger(async ({ path }) => {
  const cases = [
    ['zero', old => ({ id: 'thr_brain', turns: [old] })],
    ['active', (old, identity) => ({ id: 'thr_brain', turns: [old, remoteTurn({
      clientId: identity.request.clientUserMessageId, status: 'inProgress', text: null
    })] })],
    ['multiple', (old, identity) => ({ id: 'thr_brain', turns: [old,
      remoteTurn({ clientId: identity.request.clientUserMessageId }),
      remoteTurn({ id: 'remote_2', clientId: identity.request.clientUserMessageId })
    ] })],
    ['changed-input', (old, identity) => ({ id: 'thr_brain', turns: [old,
      remoteTurn({ clientId: identity.request.clientUserMessageId, input: { turnId: 'changed' } })
    ] })],
    ['changed-client', old => ({ id: 'thr_brain', turns: [old,
      remoteTurn({ clientId: 'forged_client' })
    ] })],
    ['conflicting-baseline', (_old, identity) => ({ id: 'thr_brain', turns: [
      { id: 'old', status: 'completed', items: [{ type: 'agentMessage', text: 'mutated' }] },
      remoteTurn({ clientId: identity.request.clientUserMessageId })
    ] })],
    ['malformed-thread', () => ({ id: 'thr_brain', turns: 'not-an-array' })],
    ['read-error', () => new Error('thread/read failed')]
  ];
  for (const [name, makeSnapshot] of cases) {
    const file = path.replace('.sqlite', `-${name}.sqlite`);
    let ledger = new QualityReplayLedger(file);
    const identity = seedInterruptedCall(ledger);
    ledger.close();
    ledger = new QualityReplayLedger(file);
    const calls = [];
    const client = new LedgerBackedModelClient({
      ledger,
      underlying: recoveryUnderlying(makeSnapshot(identity.baseline.turns[0], identity), calls),
      runId: '123e4567-e89b-42d3-a456-426614174000'
    });
    await assert.rejects(() => client.forPhase(phaseInput()).runTurn('brain', { turnId: 't1' }, {
      model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
    }), /uncertain/i, name);
    assert.deepEqual(calls, [['read', 'thr_brain']], name);
    assert.equal(ledger.getModelCall({
      runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
      phase: 'stable_execution', ordinal: 0
    }).state, 'uncertain', name);
    assert.equal(ledger.createOrOpenRun(runHeader()).state, 'blocked', name);
    assert.throws(() => ledger.preparePhase(phaseInput({
      finalKey: 'coverage:scene-1:0'
    })), /not writable/i, name);
    const retryCalls = [];
    const replay = new LedgerBackedModelClient({
      ledger, underlying: recoveryUnderlying(makeSnapshot(identity.baseline.turns[0], identity), retryCalls),
      runId: '123e4567-e89b-42d3-a456-426614174000'
    });
    await assert.rejects(() => replay.forPhase(phaseInput()).runTurn('brain', { turnId: 't1' }, {
      model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
    }), /uncertain/i);
    assert.deepEqual(retryCalls, []);
    ledger.close();
  }
}));

test('changed local request is rejected before a succeeded replay or recovery read', async () => withLedger(async ({ path }) => {
  const ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  ledger.preparePhase(phaseInput());
  ledger.startPhase(phaseInput(), { now: 1101 });
  ledger.markPhaseRunning(phaseInput(), { now: 1102 });
  const calls = [];
  const underlying = {
    async ensureThread() { return 'thr_brain'; },
    async readThread(threadId) { calls.push(['read', threadId]); return { id: threadId, turns: [] }; },
    async runTurn(role, input, options) {
      await options.onTurnStarted({ threadId: 'thr_brain', turnId: 'remote_1', clientUserMessageId: options.clientUserMessageId });
      return { threadId: 'thr_brain', turnId: 'remote_1', text: 'done' };
    }
  };
  const client = new LedgerBackedModelClient({ ledger, underlying, runId: '123e4567-e89b-42d3-a456-426614174000' });
  await client.forPhase(phaseInput()).runTurn('brain', { turnId: 't1' }, {
    model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
  });
  const before = calls.length;
  await assert.rejects(() => client.forPhase(phaseInput()).runTurn('brain', { turnId: 'changed' }, {
    model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
  }), /model call.*conflict/i);
  assert.equal(calls.length, before);
  ledger.close();
}));

test('all production role families share one contiguous ledger ordinal sequence and exact restart replay', async () => withLedger(async ({ path }) => {
  const ledger = new QualityReplayLedger(path);
  ledger.createOrOpenRun(runHeader());
  ledger.preparePhase(phaseInput());
  ledger.startPhase(phaseInput(), { now: 1101 });
  ledger.markPhaseRunning(phaseInput(), { now: 1102 });
  const calls = [];
  const underlying = {
    async ensureThread(role) { return `thr_${role}`; },
    async readThread(threadId) { return { id: threadId, turns: [] }; },
    async runTurn(role, input, options) {
      calls.push([role, input]);
      const turnId = `remote_${calls.length}`;
      await options.onTurnStarted({ threadId: `thr_${role}`, turnId, clientUserMessageId: options.clientUserMessageId });
      return { threadId: `thr_${role}`, turnId, text: `${role}:${calls.length}` };
    },
    async runRole() { throw new Error('runRole bypass'); }
  };
  const sequence = async scoped => [
    await scoped.runTurn('memory', { step: 'memory' }),
    await scoped.runTurn('brain', { step: 'brain' }),
    await scoped.runTurn('supervisor', { step: 'supervisor' }),
    await scoped.runRole('cognition_fast', { step: 'cognition' }),
    await scoped.runRole('expression_v3', { step: 'expression' }),
    await scoped.runRole('expression_v3', { step: 'repair' }),
    await scoped.runRole('cognition_deep', { step: 'fallback' })
  ];
  const client = new LedgerBackedModelClient({ ledger, underlying, runId: '123e4567-e89b-42d3-a456-426614174000' });
  const firstScope = client.forPhase(phaseInput());
  await assert.rejects(() => firstScope.runTurn('repair', { step: 'bypass' }), /unknown.*role/i);
  const first = await sequence(firstScope);
  assert.equal(calls.length, 7);
  const replay = await sequence(client.forPhase(phaseInput()));
  assert.deepEqual(replay, first);
  assert.equal(calls.length, 7);
  const ordinals = ledger.db.prepare(`
    SELECT ordinal,role FROM quality_model_calls
    WHERE run_id=? AND final_key=? AND phase=? ORDER BY ordinal
  `).all('123e4567-e89b-42d3-a456-426614174000', 'coverage:scene-0:0', 'stable_execution');
  assert.deepEqual(ordinals.map(row => Number(row.ordinal)), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ordinals.map(row => row.role), [
    'memory', 'brain', 'supervisor', 'memory', 'brain', 'brain', 'memory'
  ]);
  ledger.close();
}));

test('two ledger-backed processes race one starting row but only one may issue turn/start', async () => withLedger(async ({ path }) => {
  const seed = new QualityReplayLedger(path);
  seed.createOrOpenRun(runHeader());
  seed.preparePhase(phaseInput());
  seed.startPhase(phaseInput(), { now: 1101 });
  seed.markPhaseRunning(phaseInput(), { now: 1102 });
  seed.close();

  const firstLedger = new QualityReplayLedger(path);
  const secondLedger = new QualityReplayLedger(path);
  let reads = 0;
  let releaseReads;
  const bothRead = new Promise(resolve => { releaseReads = resolve; });
  let starts = 0;
  const underlying = {
    async ensureThread() { return 'thr_brain'; },
    async readThread() {
      reads += 1;
      if (reads === 2) releaseReads();
      await bothRead;
      return { id: 'thr_brain', turns: [] };
    },
    async runTurn(_role, _input, options) {
      starts += 1;
      await options.onTurnStarted({
        threadId: 'thr_brain', turnId: 'remote_winner',
        clientUserMessageId: options.clientUserMessageId
      });
      return { threadId: 'thr_brain', turnId: 'remote_winner', text: 'winner' };
    }
  };
  const run = ledger => new LedgerBackedModelClient({
    ledger, underlying, runId: '123e4567-e89b-42d3-a456-426614174000'
  }).forPhase(phaseInput()).runTurn('brain', { turnId: 't1' }, {
    model: 'gpt-5.6-sol', effort: 'high', outputSchema: { type: 'object' }
  });
  const settled = await Promise.allSettled([run(firstLedger), run(secondLedger)]);
  assert.equal(starts, 1);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  assert.match(settled.find(item => item.status === 'rejected').reason.message, /already starting/i);
  assert.equal(firstLedger.getModelCall({
    runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
    phase: 'stable_execution', ordinal: 0
  }).state, 'succeeded');
  firstLedger.close();
  secondLedger.close();
}));

test('two operating-system processes converge on one fresh closed schema', async () => withLedger(async ({ path }) => {
  const moduleUrl = pathToFileURL(join(
    process.cwd(), 'yuqi-runtime', 'src', 'quality-replay-ledger.mjs'
  )).href;
  const childSource = `
    const { QualityReplayLedger } = await import(process.env.QLEDGER_MODULE);
    const ledger = new QualityReplayLedger(process.env.QLEDGER_PATH);
    ledger.close();
  `;
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: process.cwd(),
      env: { ...process.env, QLEDGER_MODULE: moduleUrl, QLEDGER_PATH: path },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child ${code}`)));
  });
  await Promise.all([launch(), launch()]);
  const ledger = new QualityReplayLedger(path);
  ledger.close();
}));

test('two operating-system processes CAS the same model-call start to one remote owner', async () => withLedger(async ({ root, path }) => {
  const seed = new QualityReplayLedger(path);
  seed.createOrOpenRun(runHeader());
  seed.preparePhase(phaseInput());
  seed.startPhase(phaseInput(), { now: 1101 });
  seed.markPhaseRunning(phaseInput(), { now: 1102 });
  seed.close();
  const counter = join(root, 'remote-starts.txt');
  const moduleUrl = pathToFileURL(join(
    process.cwd(), 'yuqi-runtime', 'src', 'quality-replay-ledger.mjs'
  )).href;
  const childSource = `
    import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const { QualityReplayLedger } = await import(process.env.QLEDGER_MODULE);
    writeFileSync(join(process.env.QLEDGER_ROOT, 'ready-' + process.pid), 'ready');
    while (readdirSync(process.env.QLEDGER_ROOT).filter(name => name.startsWith('ready-')).length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const ledger = new QualityReplayLedger(process.env.QLEDGER_PATH);
    const claim = ledger.claimModelCallStart(JSON.parse(process.env.QLEDGER_CALL));
    if (claim.claimed) appendFileSync(process.env.QLEDGER_COUNTER, 'remote-start\\n');
    ledger.close();
  `;
  const env = {
    ...process.env,
    QLEDGER_MODULE: moduleUrl,
    QLEDGER_ROOT: root,
    QLEDGER_PATH: path,
    QLEDGER_CALL: JSON.stringify(callInput()),
    QLEDGER_COUNTER: counter
  };
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `child ${code}`)));
  });
  await Promise.all([launch(), launch()]);
  assert.deepEqual(readFileSync(counter, 'utf8').trim().split(/\r?\n/), ['remote-start']);
  const ledger = new QualityReplayLedger(path);
  assert.equal(ledger.getModelCall({
    runId: '123e4567-e89b-42d3-a456-426614174000', finalKey: 'coverage:scene-0:0',
    phase: 'stable_execution', ordinal: 0
  }).state, 'starting');
  ledger.close();
}));
