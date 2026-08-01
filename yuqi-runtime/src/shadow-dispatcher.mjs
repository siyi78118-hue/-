import { evaluatePipelineComparison } from './comparison-evaluator.mjs';
import { contentHash } from './protocol.mjs';

export class ShadowDispatcher {
  constructor({
    store,
    cognitivePipeline,
    foregroundActivity,
    clock = Date.now,
    workerId = 'yuqi-shadow',
    promotionController = null,
    comparisonEvaluator = evaluatePipelineComparison,
    comparisonExecutor = null,
    releaseExecutor = null,
    legacyVersionZeroComparisonExecutor = null
  }) {
    if (!store || (!cognitivePipeline && !releaseExecutor)) {
      throw new Error('store and comparison release execution are required');
    }
    this.store = store;
    this.cognitivePipeline = cognitivePipeline;
    this.foregroundActivity = foregroundActivity || { isBusy: () => false };
    this.clock = clock;
    this.workerId = workerId;
    this.promotionController = promotionController;
    this.comparisonEvaluator = comparisonEvaluator;
    this.comparisonExecutor = comparisonExecutor;
    this.releaseExecutor = releaseExecutor;
    this.legacyVersionZeroComparisonExecutor = legacyVersionZeroComparisonExecutor;
    this.timer = null;
  }

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.foregroundActivity?.isBusy?.()) return null;
    const claimed = this.store.claimDueConsolidationJob({
      workerId: this.workerId,
      jobTypes: ['shadow_cognition', 'active_canary_compare'],
      now: this.clock(),
      leaseMs: 300_000
    });
    if (!claimed) return null;
    const startedAt = this.clock();
    try {
      const payload = claimed.payload;
      if (this.releaseExecutor
        && typeof this.store.loadComparisonExecutionAuthorityInternal === 'function') {
        const recordTerminalCancellation = authority => {
          if (this.promotionController) {
            this.promotionController.recordComparisonOutcome({
              jobId: claimed.jobId,
              workerId: this.workerId,
              terminalCancellation: 'cancelled_redacted',
              now: this.clock()
            });
          } else {
            this.store.completeConsolidationJob?.({
              jobId: claimed.jobId,
              workerId: this.workerId,
              now: this.clock()
            });
          }
          return authority;
        };
        const loadAuthority = () => this.store.loadComparisonExecutionAuthorityInternal({
          jobId: claimed.jobId,
          workerId: this.workerId
        });
        let authority = loadAuthority();
        const authorityVersion = Number(authority?.authorityVersion);
        if (![0, 1].includes(authorityVersion)) {
          throw new Error('comparison authority version conflict');
        }
        if (authority.status === 'cancelled_redacted') {
          return recordTerminalCancellation(authority);
        }
        if (authority.status !== 'ready') {
          throw new Error('comparison execution authority is unavailable');
        }
        let executionResult;
        if (authorityVersion === 0) {
          if (typeof this.legacyVersionZeroComparisonExecutor !== 'function') {
            const error = new Error('version-zero comparison executor is unavailable');
            error.code = 'PINNED_PIPELINE_UNAVAILABLE';
            throw error;
          }
          executionResult = await this.legacyVersionZeroComparisonExecutor(authority.execution);
        } else {
          executionResult = authority.subjectType === 'life_planning'
            ? await this.releaseExecutor.executeLife({
                releaseId: authority.comparisonReleaseId,
                releaseChecksum: authority.comparisonReleaseChecksum,
                execution: authority.execution,
                dryRun: true
              })
            : await this.releaseExecutor.executeTurn({
                releaseId: authority.comparisonReleaseId,
                releaseChecksum: authority.comparisonReleaseChecksum,
                execution: authority.execution,
                dryRun: true
              });
        }
        const finalAuthority = loadAuthority();
        if (Number(finalAuthority?.authorityVersion) !== authorityVersion) {
          throw new Error('comparison authority version conflict');
        }
        if (finalAuthority.status === 'cancelled_redacted') {
          return recordTerminalCancellation(finalAuthority);
        }
        if (finalAuthority.status !== 'ready') {
          throw new Error('comparison execution authority is unavailable');
        }
        authority = finalAuthority;
        const comparisonResult = executionResult?.draft || executionResult;
        const evaluated = this.comparisonEvaluator({
          subjectType: authority.subjectType,
          subject: authority.execution?.envelope
            || authority.execution?.inputSnapshot
            || authority.execution?.attempt
            || {},
          authoritativeResult: authority.authoritativeResult,
          comparisonResult,
          currentBatch: authority.execution?.currentBatch || null,
          scene: authority.execution?.scene || {},
          allowedActionTargets: authority.execution?.allowedActionTargets || []
        });
        if (this.promotionController) {
          this.promotionController.recordComparisonOutcome({
            jobId: claimed.jobId,
            workerId: this.workerId,
            run: {
              runId: `run_${contentHash({
                jobId: claimed.jobId,
                subjectId: authority.subjectId,
                comparisonResult
              }).slice(0, 24)}`,
              comparisonResultChecksum: contentHash(comparisonResult),
              metrics: evaluated.metrics,
              latencyMs: this.clock() - startedAt
            },
            report: {
              summary: {
                metrics: evaluated.metrics,
                warnings: evaluated.warnings
              }
            },
            criticalFindings: evaluated.criticalFindings,
            now: this.clock()
          });
        } else {
          this.store.completeConsolidationJob?.({
            jobId: claimed.jobId,
            workerId: this.workerId,
            now: this.clock()
          });
        }
        this.store.putDiagnostic?.({
          turnId: claimed.turnId || null,
          stage: 'release_comparison',
          detail: {
            subjectType: authority.subjectType,
            subjectId: authority.subjectId,
            releaseId: authority.comparisonReleaseId,
            latencyMs: this.clock() - startedAt
          }
        });
        return executionResult;
      }
      if (!this.promotionController && !payload.subjectType) {
        const result = await this.cognitivePipeline.runShadow(payload);
        this.store.completeConsolidationJob({
          jobId: claimed.jobId,
          workerId: this.workerId,
          now: this.clock()
        });
        this.store.putDiagnostic?.({
          turnId: claimed.turnId,
          stage: 'shadow_cognition',
          detail: {
            latencyMs: this.clock() - startedAt,
            draftChecksum: result?.draft?.draftChecksum || '',
            action: result?.draft?.action || ''
          }
        });
        return result;
      }
      const turn = payload.subjectType === 'turn' ? this.store.getTurn(payload.turnId) : null;
      if (!turn || contentHash({
        envelope: JSON.parse(turn.envelopeJson),
        route: turn.route,
        routeReasons: turn.routeReasons,
        presetVersion: turn.presetVersion,
        annotationSnapshot: turn.annotationSnapshot
      }) !== payload.inputChecksum) {
        const error = new Error('pinned comparison input is unavailable');
        error.code = 'PINNED_PIPELINE_UNAVAILABLE';
        throw error;
      }
      const envelope = JSON.parse(turn.envelopeJson);
      const authoritativeResult = JSON.parse(turn.replyJson || '{}');
      if (contentHash(authoritativeResult) !== payload.authoritativeResultChecksum) {
        throw new Error('authoritative result checksum mismatch');
      }
      const currentBatch = this.store.getCurrentUserBatch(turn.turnId);
      const execution = {
        turn,
        envelope,
        scene: {},
        currentBatch,
        routeDecision: {
          route: turn.route,
          allowedActionTargets: [envelope.characterId, 'user']
        }
      };
      const result = this.comparisonExecutor
        ? await this.comparisonExecutor({ claimed, payload, execution })
        : payload.comparisonPipeline === 'cognition'
          ? await this.cognitivePipeline.runShadow(execution)
          : await this.cognitivePipeline.runLegacyShadow?.(execution);
      if (!result) {
        const error = new Error('pinned comparison pipeline is unavailable');
        error.code = 'PINNED_PIPELINE_UNAVAILABLE';
        throw error;
      }
      const comparisonResult = result.draft || result;
      const evaluated = this.comparisonEvaluator({
        subjectType: payload.subjectType,
        subject: envelope,
        authoritativeResult,
        comparisonResult,
        currentBatch,
        scene: execution.scene,
        allowedActionTargets: [envelope.characterId, 'user']
      });
      if (this.promotionController) {
        this.promotionController.recordComparisonOutcome({
          jobId: claimed.jobId,
          workerId: this.workerId,
          run: {
            runId: `run_${contentHash({ jobId: claimed.jobId, payload }).slice(0, 24)}`,
            comparisonResultChecksum: contentHash(comparisonResult),
            metrics: evaluated.metrics,
            latencyMs: this.clock() - startedAt
          },
          report: {
            summary: {
              metrics: evaluated.metrics,
              warnings: evaluated.warnings
            }
          },
          criticalFindings: evaluated.criticalFindings,
          now: this.clock()
        });
      } else {
        this.store.completeConsolidationJob({
          jobId: claimed.jobId,
          workerId: this.workerId,
          now: this.clock()
        });
      }
      this.store.putDiagnostic?.({
        turnId: claimed.turnId,
        stage: 'shadow_cognition',
        detail: {
          latencyMs: this.clock() - startedAt,
          draftChecksum: result?.draft?.draftChecksum || '',
          action: result?.draft?.action || ''
        }
      });
      return result;
    } catch (error) {
      const attempt = Number(claimed.attemptCount || 1);
      const delays = claimed.jobType === 'active_canary_compare'
        ? [60_000, 300_000, 1_800_000]
        : [300_000, 1_800_000];
      this.store.failConsolidationJob({
        jobId: claimed.jobId,
        workerId: this.workerId,
        now: this.clock(),
        errorCode: String(error?.code || error?.name || 'SHADOW_FAILED'),
        nextDueAt: attempt <= delays.length ? this.clock() + delays[attempt - 1] : this.clock()
      });
      if (claimed.jobType === 'active_canary_compare' && attempt > delays.length
        && this.promotionController) {
        const turn = claimed.turnId ? this.store.getTurn(claimed.turnId) : null;
        if (turn?.pipelineMode === 'active') {
          this.promotionController.recordActivePipelineFailure({
            subjectType: 'turn',
            subjectId: turn.turnId,
            errorCode: String(error?.code || 'CANARY_COMPARE_UNAVAILABLE'),
            failureClass: 'pipeline_unavailable',
            report: { summary: { comparisonJobId: claimed.jobId } },
            now: this.clock()
          });
        }
      }
      return null;
    }
  }
}
