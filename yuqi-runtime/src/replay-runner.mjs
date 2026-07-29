import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { canonicalJson, contentHash, validateEnvelope } from './protocol.mjs';

function readDataset(datasetPath) {
  const root = resolve(datasetPath);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const cases = readFileSync(join(root, 'cases.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  if (cases.length !== manifest.caseCount || contentHash(cases) !== manifest.casesChecksum) {
    throw new Error('replay dataset checksum/count mismatch');
  }
  return { root, manifest, cases, checksum: contentHash({ manifest, cases }) };
}

function deterministicEvaluate(testCase, legacyResult, cognitionResult) {
  const findings = [];
  const expected = testCase.expected || {};
  const cognitionText = canonicalJson(cognitionResult || {});
  for (const messageId of expected.mustNoticeMessageIds || []) {
    const noticed = cognitionResult?.usedMessageIds?.includes?.(messageId)
      || cognitionText.includes(messageId);
    if (!noticed) findings.push({ code: 'MISSED_CURRENT_MESSAGE', messageId });
  }
  for (const action of expected.forbiddenActions || []) {
    if ((cognitionResult?.actions || []).some(item => item?.type === action)) {
      findings.push({ code: 'FORBIDDEN_ACTION', action });
    }
  }
  if (cognitionResult?.targetId && cognitionResult.targetId !== testCase.envelope.characterId
    && testCase.turnKind === 'DIRECT_REPLY') {
    findings.push({ code: 'WRONG_RECIPIENT' });
  }
  if (cognitionResult?.schemaValid === false) findings.push({ code: 'SCHEMA_INVALID' });
  return {
    criticalFindings: findings,
    metrics: {
      legacyProducedResult: legacyResult != null,
      cognitionProducedResult: cognitionResult != null,
      schemaFinalFailure: cognitionResult?.schemaValid === false ? 1 : 0
    }
  };
}

async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(2, Number(limit) || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function atomicWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, path);
}

export class ReplayRunner {
  constructor({
    store,
    legacyPipeline,
    cognitivePipeline,
    sandboxFactory,
    clock = Date.now,
    concurrency = 2,
    artifactRoot = 'artifacts/qa/cognition/replay'
  }) {
    if (!store || !legacyPipeline || !cognitivePipeline || !sandboxFactory) {
      throw new Error('replay runner dependencies are required');
    }
    this.store = store;
    this.legacyPipeline = legacyPipeline;
    this.cognitivePipeline = cognitivePipeline;
    this.sandboxFactory = sandboxFactory;
    this.clock = clock;
    this.concurrency = Math.max(1, Math.min(2, Number(concurrency) || 1));
    this.artifactRoot = resolve(artifactRoot);
  }

  async executeCase(runId, testCase) {
    const existing = this.store.getReplayRun(runId, testCase.caseId);
    if (existing?.state === 'completed') return existing;
    const envelope = validateEnvelope(testCase.envelope);
    const inputChecksum = contentHash({
      envelope,
      seedState: testCase.seedState,
      expected: testCase.expected,
      clock: testCase.clock
    });
    if (existing && existing.inputChecksum !== inputChecksum) {
      throw new Error(`replay input changed for ${testCase.caseId}`);
    }
    const startedAt = this.clock();
    const sandbox = await this.sandboxFactory({
      testCase: structuredClone(testCase),
      clock: () => testCase.clock,
      dryRun: true
    });
    this.store.putReplayRun({
      runId,
      caseId: testCase.caseId,
      rolloutKey: testCase.turnKind,
      sourceType: testCase.sourceType,
      inputChecksum,
      state: 'running',
      attemptCount: Number(existing?.attemptCount || 0) + 1,
      createdAt: existing?.createdAt || startedAt,
      updatedAt: startedAt
    });
    try {
      const legacyResult = await this.legacyPipeline.run({
        envelope: structuredClone(envelope),
        seedState: structuredClone(testCase.seedState),
        sandbox,
        dryRun: true
      });
      const cognitionResult = await this.cognitivePipeline.run({
        envelope: structuredClone(envelope),
        seedState: structuredClone(testCase.seedState),
        sandbox,
        dryRun: true
      });
      const evaluated = deterministicEvaluate(testCase, legacyResult, cognitionResult);
      return this.store.putReplayRun({
        runId,
        caseId: testCase.caseId,
        rolloutKey: testCase.turnKind,
        sourceType: testCase.sourceType,
        inputChecksum,
        legacyResultChecksum: contentHash(legacyResult),
        cognitionResultChecksum: contentHash(cognitionResult),
        metrics: evaluated.metrics,
        criticalFindings: evaluated.criticalFindings,
        state: 'completed',
        attemptCount: Number(existing?.attemptCount || 0) + 1,
        latencyMs: Math.max(0, this.clock() - startedAt),
        createdAt: existing?.createdAt || startedAt,
        updatedAt: this.clock()
      });
    } catch (error) {
      this.store.putReplayRun({
        runId,
        caseId: testCase.caseId,
        rolloutKey: testCase.turnKind,
        sourceType: testCase.sourceType,
        inputChecksum,
        state: 'failed',
        attemptCount: Number(existing?.attemptCount || 0) + 1,
        errorCode: String(error?.code || error?.name || 'REPLAY_FAILED'),
        createdAt: existing?.createdAt || startedAt,
        updatedAt: this.clock()
      });
      throw error;
    } finally {
      await sandbox?.close?.();
    }
  }

  async runFixtureBatch({ runId, datasetPath, presetVersion, modelProfileChecksum = 'default' }) {
    const dataset = readDataset(datasetPath);
    const existing = this.store.getReplayBatch(runId);
    if (existing && (
      existing.datasetChecksum !== dataset.checksum
      || existing.presetVersion !== presetVersion
      || existing.modelProfileChecksum !== modelProfileChecksum
    )) throw new Error('replay batch identity conflict');
    this.store.createReplayBatch({
      runId,
      datasetId: dataset.manifest.datasetId,
      datasetChecksum: dataset.checksum,
      presetVersion,
      modelProfileChecksum,
      sourceType: 'fixture',
      requestedConcurrency: this.concurrency,
      startedAt: this.clock()
    });
    await mapLimit(dataset.cases, this.concurrency, item => this.executeCase(runId, item));
    return this.finalize(runId, dataset.manifest);
  }

  async runLocalHistoryBatch({ runId, rolloutKey = 'DIRECT_REPLY', limit = 30, beforeTurnId = null }) {
    const turns = this.store.listReplayEligibleTurns?.({ rolloutKey, limit, beforeTurnId }) || [];
    const cases = turns.map((turn, index) => ({
      caseId: `local_${turn.turnId}`,
      turnKind: rolloutKey,
      sourceType: 'local_history',
      sourceRef: turn.turnId,
      clock: turn.createdAt,
      envelope: JSON.parse(turn.envelopeJson),
      seedState: {},
      expected: {
        mustNoticeMessageIds: turn.sourceMessageId ? [turn.sourceMessageId] : [],
        allowedActions: ['reply'],
        forbiddenActions: ['wrong_recipient', 'duplicate_action'],
        stageConstraints: {},
        publicPrivateConstraints: []
      },
      localIndex: index
    }));
    const datasetChecksum = contentHash(cases.map(item => ({
      caseId: item.caseId,
      input: contentHash(item.envelope)
    })));
    this.store.createReplayBatch({
      runId,
      datasetId: `local-history:${rolloutKey}`,
      datasetChecksum,
      presetVersion: 'local-current',
      modelProfileChecksum: 'local-current',
      sourceType: 'local_history',
      requestedConcurrency: this.concurrency,
      startedAt: this.clock()
    });
    await mapLimit(cases, this.concurrency, item => this.executeCase(runId, item));
    return this.finalize(runId, {
      datasetId: `local-history:${rolloutKey}`,
      caseCount: Number(limit),
      requiredPerTurnKind: Number(limit),
      turnKinds: [rolloutKey]
    });
  }

  async resume(runId) {
    const batch = this.store.getReplayBatch(runId);
    if (!batch) throw new Error('replay batch not found');
    return { batch, runs: this.store.listReplayRuns(runId) };
  }

  finalize(runId, manifest) {
    const runs = this.store.listReplayRuns(runId);
    const batch = this.store.getReplayBatch(runId);
    const completed = runs.filter(run => run.state === 'completed').length;
    const failed = runs.filter(run => run.state === 'failed').length;
    const criticalErrors = runs.reduce((sum, run) => sum + run.criticalFindings.length, 0);
    const schemaFinalFailures = runs.reduce(
      (sum, run) => sum + Number(run.metrics.schemaFinalFailure || 0),
      0
    );
    const byKind = Object.fromEntries((manifest.turnKinds || []).map(kind => [
      kind,
      runs.filter(run => run.rolloutKey === kind && run.state === 'completed').length
    ]));
    const realModelExecution = batch?.modelProfileChecksum !== 'structural-only-not-promotion-evidence';
    const eligible = realModelExecution
      && completed === Number(manifest.caseCount)
      && failed === 0
      && criticalErrors === 0
      && schemaFinalFailures === 0
      && Object.values(byKind).every(count => count === Number(manifest.requiredPerTurnKind));
    const summary = {
      runId,
      datasetId: manifest.datasetId,
      expected: Number(manifest.caseCount),
      completed,
      failed,
      criticalErrors,
      schemaFinalFailures,
      byKind,
      eligible,
      realModelExecution,
      productionDataChecksumChanges: 0
    };
    const directory = join(this.artifactRoot, runId);
    const summaryJson = `${canonicalJson(summary)}\n`;
    atomicWrite(join(directory, 'summary.json'), summaryJson);
    atomicWrite(
      join(directory, 'summary.md'),
      `# Yuqi cognition replay ${runId}\n\n- completed: ${completed}/${manifest.caseCount}\n- failed: ${failed}\n- critical: ${criticalErrors}\n- eligible: ${eligible}\n`
    );
    atomicWrite(
      join(directory, 'case-results.jsonl'),
      `${runs.map(run => canonicalJson({
        caseId: run.caseId,
        rolloutKey: run.rolloutKey,
        state: run.state,
        metrics: run.metrics,
        criticalFindings: run.criticalFindings,
        errorCode: run.errorCode
      })).join('\n')}\n`
    );
    const checksum = contentHash(summary);
    const reportId = `report_replay_${contentHash({ runId, checksum }).slice(0, 24)}`;
    this.store.putEvaluationReportInternal({
      reportId,
      reportType: 'replay',
      rolloutKey: manifest.turnKinds?.length === 1 ? manifest.turnKinds[0] : null,
      sourceType: 'replay_batch',
      sourceRef: runId,
      artifactPath: join(directory, 'summary.json'),
      artifactChecksum: checksum,
      artifactState: 'pending',
      summary,
      createdAt: this.clock()
    });
    this.store.markEvaluationReportMaterialized({
      reportId,
      expectedChecksum: checksum,
      now: this.clock()
    });
    this.store.completeReplayBatch({
      runId,
      state: failed ? 'failed' : 'completed',
      artifactPath: join(directory, 'summary.json'),
      artifactChecksum: checksum,
      now: this.clock()
    });
    return { summary, runs, artifactPath: directory, artifactChecksum: checksum, reportId };
  }
}

export { readDataset };
