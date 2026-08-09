import { contentHash } from './protocol.mjs';
import { resolvePipelinePair } from './release-pair.mjs';
import {
  comparisonContractForDirection,
  comparisonContractForMode
} from './comparison-contract.mjs';
import { laneKeyForEnvelope } from './interaction-lanes.mjs';
import { resolveCurrentUserBatch } from './current-user-batch.mjs';
import { RolloutRevisionConflictError } from './store.mjs';

export const COGNITION_ROLLOUT_KEYS = Object.freeze([
  'DIRECT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'LIFE_PLANNING'
]);

function rolloutKeyForEnvelope(envelope) {
  const key = String(envelope?.kind || '');
  if (!COGNITION_ROLLOUT_KEYS.includes(key) || key === 'LIFE_PLANNING') {
    throw new Error(`unsupported cognition rollout kind: ${key}`);
  }
  return key;
}

function reportSupportsTransition(report, rolloutKey, toMode, toPhase) {
  if (!report || report.artifactState !== 'materialized') return false;
  if (report.rolloutKey && report.rolloutKey !== rolloutKey) return false;
  const summary = report.summary || {};
  if (toMode === 'active' && toPhase === 'canary') {
    if (rolloutKey === 'DIRECT_REPLY' && summary.initialPromotion === true) {
      return Number(summary.fixtureCompleted) >= 30
        && Number(summary.localHistoryCompleted) >= 30
        && Number(summary.criticalErrors || 0) === 0;
    }
    return summary.promotionEligible === true
      && Number(summary.liveShadowSuccessCount) >= 30
      && Number(summary.criticalErrors || 0) === 0;
  }
  return true;
}

export class PromotionController {
  constructor({ store, clock = Date.now, presetRegistry, bootstrap = {} }) {
    if (!store || !presetRegistry) throw new Error('store and presetRegistry are required');
    this.store = store;
    this.clock = clock;
    this.presetRegistry = presetRegistry;
    this.bootstrap = {
      defaultMode: bootstrap.defaultMode || 'legacy',
      defaultPhase: bootstrap.defaultPhase || 'stable'
    };
  }

  evidenceEntries() {
    return COGNITION_ROLLOUT_KEYS.map(rolloutKey => {
      const evidence = this.presetRegistry.evidenceManifest(rolloutKey);
      return {
        rolloutKey,
        presetVersion: evidence.presetVersion,
        pipelineChecksum: evidence.checksum
      };
    });
  }

  initialize() {
    const entries = this.evidenceEntries();
    if (this.store.listCognitionRollouts().length === 0) {
      this.store.initializeCognitionRolloutsInternal({
        rows: entries.map(entry => ({
          ...entry,
          currentMode: this.bootstrap.defaultMode,
          rolloutPhase: this.bootstrap.defaultPhase
        })),
        now: this.clock()
      });
      return { initialized: true, changed: [], rollouts: this.store.listCognitionRollouts() };
    }
    const refreshed = this.refreshEvidenceManifest({
      reasonCode: 'runtime_evidence_refresh',
      now: this.clock()
    });
    return { initialized: false, ...refreshed };
  }

  getStatus(rolloutKey) {
    return this.store.getCognitionRollout(rolloutKey);
  }

  listStatus() {
    return this.store.listCognitionRollouts();
  }

  resolvePipelinePair(rollout) {
    return resolvePipelinePair(rollout);
  }

  selectPipelinePairForFreshSubject(rolloutKey, { now = this.clock() } = {}) {
    let rollout = this.getStatus(rolloutKey);
    if (!rollout) throw new Error(`cognition rollout is unavailable: ${rolloutKey}`);
    let pair = this.resolvePipelinePair(rollout);
    let rolledBack = false;
    if (pair.candidatePhase === 'canary') {
      const outstanding = this.store.readCanaryOutstandingAuthorityInternal({
        rolloutKey,
        canaryEpoch: rollout.canaryEpoch
      });
      const deadlineBreached = outstanding.oldestAt !== null
        && Number(now) - Number(outstanding.oldestAt) >= rollout.canaryCompareDeadlineMs;
      const allocatesComparison = pair.comparisonReleaseId !== null;
      if (deadlineBreached
        || (allocatesComparison && outstanding.count >= rollout.canaryMaxOutstanding)) {
        rollout = this.rollbackCandidate({
          rolloutKey,
          expectedRevision: rollout.revision,
          reasonCode: deadlineBreached ? 'CANARY_COMPARE_DEADLINE' : 'CANARY_COMPARE_BACKLOG'
        });
        pair = this.resolvePipelinePair(rollout);
        rolledBack = true;
      }
    }
    return { rollout, pair, rolledBack };
  }

  promotionCheck(rolloutKey) {
    const rollout = this.getStatus(rolloutKey);
    if (!rollout) throw new Error(`cognition rollout is unavailable: ${rolloutKey}`);
    const evidence = this.store.readCognitionPromotionEvidenceInternal(rolloutKey);
    const outstanding = rollout.candidatePhase === 'canary'
      ? this.store.readCanaryOutstandingAuthorityInternal({
        rolloutKey,
        canaryEpoch: rollout.canaryEpoch
      })
      : { count: 0, oldestAt: null };
    return {
      rolloutKey: rollout.rolloutKey,
      revision: rollout.revision,
      candidatePhase: rollout.candidatePhase,
      liveShadowSuccessCount: evidence.liveShadowSuccessCount,
      liveShadowFailureCount: evidence.liveShadowFailureCount,
      staleEvidenceCount: evidence.staleEvidenceCount,
      outstandingComparisonCount: evidence.outstandingComparisonCount,
      oldestOutstandingComparisonAt: evidence.oldestOutstandingComparisonAt,
      replayCount: evidence.replayCount,
      criticalErrors: evidence.liveShadowFailureCount,
      canaryOutstandingCount: outstanding.count,
      canaryOldestOutstandingAt: outstanding.oldestAt,
      canaryObserveUntil: rollout.canaryObserveUntil,
      canaryCompareDeadlineMs: rollout.canaryCompareDeadlineMs,
      lastReasonCode: rollout.lastReasonCode
    };
  }

  registerCandidate(input) {
    return this.store.registerCognitionCandidateInternal({ ...input, now: this.clock() });
  }

  promoteToCanary(input) {
    return this.store.promoteCognitionCandidateInternal({ ...input, now: this.clock() });
  }

  graduateCandidate(input) {
    return this.store.graduateCognitionCandidateInternal({ ...input, now: this.clock() });
  }

  rollbackCandidate(input) {
    return this.store.rollbackCognitionCandidateInternal({ ...input, now: this.clock() });
  }

  recordCriticalFinding(input) {
    return this.store.recordCriticalFindingInternal({
      ...input,
      ...(input?.occurredAt === undefined ? {} : { occurredAt: input.occurredAt })
    });
  }

  recordHardActionFinding(input) {
    return this.store.recordHardActionFindingInternal({ ...input, now: input.now ?? this.clock() });
  }

  createTurn({ envelope, presetVersion, annotationSnapshot, now = this.clock() }) {
    const rolloutKey = rolloutKeyForEnvelope(envelope);
    return this.store.createTurnWithRolloutInternal({
      envelope,
      rolloutKey,
      presetVersion,
      annotationSnapshot: annotationSnapshot || {}
    });
  }

  refreshEvidenceManifest({ reasonCode = 'evidence_changed', now = this.clock() } = {}) {
    const first = this.evidenceEntries();
    const second = this.evidenceEntries();
    if (contentHash(first) !== contentHash(second)) {
      throw new Error('evidence manifest changed while being read');
    }
    return this.store.refreshCognitionEvidenceInternal({
      entries: first,
      reasonCode,
      now
    });
  }

  startEvidenceEpoch({ rolloutKey, expectedRevision, presetVersion, reasonCode }) {
    const current = this.getStatus(rolloutKey);
    if (!current || current.revision !== expectedRevision) throw new RolloutRevisionConflictError();
    const evidence = this.presetRegistry.evidenceManifest(rolloutKey);
    if (presetVersion && presetVersion !== evidence.presetVersion) {
      throw new Error('preset version does not match loaded evidence');
    }
    return this.store.refreshCognitionEvidenceInternal({
      entries: this.evidenceEntries().map(entry => entry.rolloutKey === rolloutKey
        ? { ...entry, pipelineChecksum: evidence.checksum, presetVersion: evidence.presetVersion }
        : entry),
      reasonCode,
      now: this.clock()
    });
  }

  transition({
    rolloutKey,
    expectedRevision,
    toMode,
    toPhase,
    actor,
    reasonCode,
    reportId = null,
    reportChecksum = null,
    metadata = {}
  }) {
    if (toMode === 'active' && toPhase === 'canary') {
      throw new Error('active canary requires promotion candidate API');
    }
    const current = this.getStatus(rolloutKey);
    if (!current || current.revision !== Number(expectedRevision)) {
      throw new RolloutRevisionConflictError();
    }
    if (current.candidatePhase !== 'none') {
      throw new Error('candidate phase transitions require the candidate API');
    }
    let report = null;
    if (reportId) {
      report = this.store.getEvaluationReport(reportId);
      if (!report
        || report.artifactChecksum !== reportChecksum
        || !reportSupportsTransition(report, rolloutKey, toMode, toPhase)) {
        throw new Error('promotion report is not eligible');
      }
    }
    const initialShadow = current.currentMode === 'legacy'
      && toMode === 'shadow'
      && ['bootstrap', 'manual'].includes(String(actor));
    if (current.currentMode === 'legacy' && toMode === 'active' && rolloutKey !== 'DIRECT_REPLY') {
      throw new Error('only DIRECT_REPLY may initially promote directly to active');
    }
    if (current.currentMode === 'legacy' && toMode === 'shadow' && !initialShadow) {
      throw new Error('legacy to shadow requires bootstrap or manual actor');
    }
    if (current.currentMode === 'active' && current.rolloutPhase === 'canary'
      && toMode === 'active' && toPhase === 'stable') {
      const outstanding = this.store.countOutstandingComparisonSubjects(rolloutKey, {
        canaryEpoch: current.canaryEpoch
      });
      if (current.canaryCompletedCount < current.canaryTargetCount
        || outstanding.count > 0
        || Number(this.clock()) < Number(current.canaryObserveUntil || Infinity)) {
        throw new Error('active canary observation gate is incomplete');
      }
    }
    return this.store.transitionCognitionRolloutInternal({
      rolloutKey,
      expectedRevision,
      toMode,
      toPhase,
      actor,
      reasonCode,
      reportId,
      reportChecksum,
      metadata,
      now: this.clock()
    });
  }

  recordComparisonOutcome({
    jobId,
    workerId,
    run,
    report = {},
    criticalFindings = [],
    terminalCancellation = null,
    now = this.clock()
  }) {
    return this.store.recordComparisonOutcomeInternal({
      jobId,
      workerId,
      run,
      report,
      criticalFindings,
      terminalCancellation,
      now
    });
  }

  recordActivePipelineFailure({
    subjectType,
    subjectId,
    errorCode,
    failureClass,
    report = {},
    now = this.clock()
  }) {
    if (subjectType !== 'turn') throw new Error('unsupported active subject type');
    const subject = this.store.getTurn(subjectId);
    if (!subject || subject.pipelineMode !== 'active' || !subject.rolloutKey) {
      return { staleForRollout: true, rolledBack: false };
    }
    const rollout = this.getStatus(subject.rolloutKey);
    const matching = rollout
      && rollout.pipelineChecksum === subject.pipelineChecksum
      && rollout.evidenceEpoch === subject.rolloutEvidenceEpoch
      && (rollout.rolloutPhase !== 'canary' || rollout.canaryEpoch === subject.canaryEpoch);
    if (!matching) return { staleForRollout: true, rolledBack: false };
    const deterministic = ['deterministic', 'preset_unavailable', 'pipeline_unavailable'].includes(failureClass);
    const immediate = rollout.rolloutPhase === 'canary' || deterministic;
    if (!immediate) {
      return this.store.recordActiveTransientFailureInternal({
        rolloutKey: rollout.rolloutKey,
        expectedRevision: rollout.revision,
        subjectId,
        errorCode,
        report,
        now
      });
    }
    const summary = { subjectType, subjectId, errorCode, failureClass, ...report.summary };
    const reportId = report.reportId
      || `report_active_failure_${contentHash({ ...summary, now }).slice(0, 24)}`;
    const stored = this.store.putEvaluationReportInternal({
      reportId,
      reportType: 'active_failure',
      rolloutKey: rollout.rolloutKey,
      sourceType: 'active_subject',
      sourceRef: subjectId,
      artifactPath: report.artifactPath || '',
      summary,
      createdAt: now
    });
    const transitioned = this.store.rollbackCognitionCandidateInternal({
      rolloutKey: rollout.rolloutKey,
      expectedRevision: rollout.revision,
      reasonCode: errorCode || 'ACTIVE_PRECOMMIT_CRITICAL',
      findingIds: [],
      reportId,
      reportChecksum: stored.artifactChecksum,
      metadata: summary,
      actor: 'orchestrator',
      now
    });
    return { staleForRollout: false, rolledBack: true, rollout: transitioned };
  }

  recordActivePipelineSuccess({ subjectType, subjectId, now = this.clock() }) {
    if (subjectType !== 'turn') return { reset: false };
    const subject = this.store.getTurn(subjectId);
    if (!subject?.rolloutKey || subject.pipelineMode !== 'active') return { reset: false };
    return this.store.resetActiveTransientFailuresInternal({
      rolloutKey: subject.rolloutKey,
      pipelineChecksum: subject.pipelineChecksum,
      evidenceEpoch: subject.rolloutEvidenceEpoch,
      now
    });
  }

  createLifePlanningAttempt({ roleId, planningContext, now = this.clock() }) {
    return this.store.transaction(() => {
      const open = this.store.getOpenLifePlanningAttempt(roleId);
      if (open) {
        this.store.assertPersistedLifePlanningAttemptAuthorityInternal(open.planningId);
        return open;
      }
      const { rollout, pair } = this.selectPipelinePairForFreshSubject(
        'LIFE_PLANNING',
        { now }
      );
      const authoritativeRelease = this.store.getPipelineRelease(pair.visibleReleaseId);
      const comparisonRelease = pair.comparisonReleaseId
        ? this.store.getPipelineRelease(pair.comparisonReleaseId)
        : null;
      if (!authoritativeRelease || (pair.comparisonReleaseId && !comparisonRelease)) {
        throw new Error('LIFE_PLANNING release authority is unavailable');
      }
      const comparison = comparisonContractForDirection(pair.comparisonDirection);
      const startAt = Number(
        planningContext?.planWindowStartAt
        || Math.floor(Number(now) / 600_000) * 600_000
      );
      const endAt = Number(planningContext?.targetPlanEndAt || startAt + 12 * 60 * 60_000);
      const lifeBasisChecksum = this.store.getLifeBasisChecksum(roleId, {
        from: startAt,
        to: endAt
      });
      const inputSnapshot = {
        roleId: String(roleId),
        planningAnchorAt: startAt,
        planningWindow: { startAt, targetEndAt: endAt },
        current: planningContext?.current || null,
        recent: Array.isArray(planningContext?.recent) ? planningContext.recent : [],
        upcoming: Array.isArray(planningContext?.upcoming) ? planningContext.upcoming : [],
        cognitiveState: this.store.getCognitiveState(roleId)?.state || {},
        allowedActions: ['create_life_episode']
      };
      const contextChecksum = contentHash({
        cognitiveState: inputSnapshot.cognitiveState,
        allowedActions: inputSnapshot.allowedActions
      });
      const requestBaseKey = contentHash({
        roleId, startAt, endAt, lifeBasisChecksum, contextChecksum
      });
      const requestKey = contentHash({
        requestBaseKey,
        presetVersion: authoritativeRelease.presetVersion,
        pipelineMode: rollout.currentMode,
        pipelineChecksum: authoritativeRelease.releaseChecksum,
        authoritativeReleaseId: authoritativeRelease.releaseId,
        comparisonReleaseId: comparisonRelease?.releaseId || null,
        authoritativePipelineChecksum: authoritativeRelease.releaseChecksum,
        comparisonPipelineChecksum: comparisonRelease?.releaseChecksum || null,
        comparisonDirection: comparison.comparisonDirection,
        candidatePhase: pair.candidatePhase,
        evidenceEpoch: rollout.evidenceEpoch,
        shadowEpoch: rollout.shadowEpoch,
        canaryEpoch: rollout.canaryEpoch
      });
      return this.store.createLifePlanningAttemptInternal({
        roleId,
        requestBaseKey,
        requestKey,
        planningWindowStartAt: startAt,
        planningWindowEndAt: endAt,
        lifeBasisChecksum,
        contextChecksum,
        pipelineMode: rollout.currentMode,
        comparisonMode: comparison.comparisonMode,
        authoritativePipeline: rollout.currentMode === 'active' ? 'cognition' : 'legacy',
        comparisonDirection: comparison.comparisonDirection,
        rolloutRevision: rollout.revision,
        rolloutEvidenceEpoch: rollout.evidenceEpoch,
        pipelineChecksum: authoritativeRelease.releaseChecksum,
        shadowEpoch: pair.candidatePhase === 'shadow' ? rollout.shadowEpoch : null,
        canaryEpoch: pair.candidatePhase === 'canary' ? rollout.canaryEpoch : null,
        authoritativeReleaseId: authoritativeRelease.releaseId,
        comparisonReleaseId: comparisonRelease?.releaseId || null,
        authoritativePipelineChecksum: authoritativeRelease.releaseChecksum,
        comparisonPipelineChecksum: comparisonRelease?.releaseChecksum || null,
        presetVersion: authoritativeRelease.presetVersion,
        inputSnapshot,
        dueAt: now,
        now
      });
    });
  }

  commitLifePlanningAuthoritativeResult({
    planningId, workerId, validatedResult, now = this.clock()
  }) {
    return this.store.transaction(() => this.store.commitLifePlanningResultInternal({
      planningId, workerId, validatedResult, now
    }));
  }

  failLifePlanningAttempt({
    planningId, workerId, errorCode, failureClass, report = {}, now = this.clock()
  }) {
    return this.store.transaction(() => {
      const attempt = this.store.failLifePlanningAttemptInternal({
        planningId, workerId, errorCode, now
      });
      if (attempt.pipelineMode === 'active') {
        const rollout = this.getStatus('LIFE_PLANNING');
        if (rollout
          && rollout.pipelineChecksum === attempt.pipelineChecksum
          && rollout.evidenceEpoch === attempt.rolloutEvidenceEpoch) {
          const stored = this.store.putEvaluationReportInternal({
            reportId: `report_life_failure_${contentHash({ planningId, errorCode, now }).slice(0, 24)}`,
            reportType: 'active_failure',
            rolloutKey: 'LIFE_PLANNING',
            sourceType: 'active_subject',
            sourceRef: planningId,
            artifactPath: report.artifactPath || '',
            summary: { planningId, errorCode, failureClass, ...(report.summary || {}) },
            createdAt: now
          });
          this.store.rollbackCognitionCandidateInternal({
            rolloutKey: 'LIFE_PLANNING',
            expectedRevision: rollout.revision,
            reasonCode: errorCode || 'LIFE_PLANNING_ACTIVE_FAILURE',
            findingIds: [],
            reportId: stored.reportId,
            reportChecksum: stored.artifactChecksum,
            metadata: { planningId, failureClass },
            actor: 'life_planning_dispatcher',
            now
          });
        }
      }
      return attempt;
    });
  }
}
