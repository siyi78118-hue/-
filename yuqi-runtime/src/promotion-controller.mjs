import { contentHash } from './protocol.mjs';
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

  createTurn({ envelope, presetVersion, annotationSnapshot, now = this.clock() }) {
    const rolloutKey = rolloutKeyForEnvelope(envelope);
    let rollout = this.store.getCognitionRollout(rolloutKey);
    if (!rollout) throw new Error(`cognition rollout is unavailable: ${rolloutKey}`);
    if (rollout.currentMode === 'active' && rollout.rolloutPhase === 'canary') {
      const outstanding = this.store.countOutstandingComparisonSubjects(rolloutKey, {
        canaryEpoch: rollout.canaryEpoch
      });
      const tooOld = outstanding.oldestAt !== null
        && Number(now) - Number(outstanding.oldestAt) > rollout.canaryCompareDeadlineMs;
      if (outstanding.count >= rollout.canaryMaxOutstanding || tooOld) {
        const summary = {
          rolloutKey,
          canaryEpoch: rollout.canaryEpoch,
          outstandingCount: outstanding.count,
          oldestAt: outstanding.oldestAt,
          reasonCode: 'CANARY_COMPARE_BACKLOG'
        };
        const reportId = `report_backlog_${contentHash({ ...summary, now }).slice(0, 24)}`;
        const report = this.store.putEvaluationReportInternal({
          reportId,
          reportType: 'active_failure',
          rolloutKey,
          sourceType: 'aggregate_gate',
          sourceRef: `canary:${rollout.canaryEpoch}`,
          artifactPath: '',
          summary,
          createdAt: now
        });
        rollout = this.store.transitionCognitionRolloutInternal({
          rolloutKey,
          expectedRevision: rollout.revision,
          toMode: 'shadow',
          toPhase: 'rolled_back',
          actor: 'promotion_controller',
          reasonCode: 'CANARY_COMPARE_BACKLOG',
          reportId,
          reportChecksum: report.artifactChecksum,
          metadata: summary,
          now
        });
      }
    }
    return this.store.createTurnWithRolloutInternal({
      envelope,
      rolloutKey,
      presetVersion: presetVersion || rollout.presetVersion,
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
    const current = this.getStatus(rolloutKey);
    if (!current || current.revision !== Number(expectedRevision)) {
      throw new RolloutRevisionConflictError();
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
    if (toMode === 'active' && toPhase === 'canary' && !report) {
      throw new Error('active canary requires a materialized promotion report');
    }
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
    now = this.clock()
  }) {
    return this.store.recordComparisonOutcomeInternal({
      jobId,
      workerId,
      run,
      report,
      criticalFindings,
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
    const transitioned = this.store.transitionCognitionRolloutInternal({
      rolloutKey: rollout.rolloutKey,
      expectedRevision: rollout.revision,
      toMode: 'shadow',
      toPhase: 'rolled_back',
      actor: 'orchestrator',
      reasonCode: errorCode || 'ACTIVE_PRECOMMIT_CRITICAL',
      reportId,
      reportChecksum: stored.artifactChecksum,
      metadata: summary,
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
}
