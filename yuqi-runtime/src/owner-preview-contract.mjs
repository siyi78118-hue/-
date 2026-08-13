import { contentHash } from './protocol.mjs';

export const OWNER_PREVIEW_EVIDENCE_CLASS = 'owner_preview_v1';
export const OWNER_PREVIEW_ROLLOUT_KEY = 'DIRECT_REPLY';
export const OWNER_PREVIEW_PRESET_VERSION = '2.1.1';
export const OWNER_PREVIEW_MODEL_PROFILE = Object.freeze({
  cognitionFast: 'gpt-5.6-sol/medium',
  cognitionDeep: 'gpt-5.6-sol/xhigh',
  expression: 'gpt-5.6-sol/medium',
  supervisor: 'gpt-5.6-sol/medium'
});

const SUMMARY_KEYS = Object.freeze([
  'eligible',
  'evidenceClass',
  'internalPreview',
  'authorizedBy',
  'authorizationId',
  'authorizedAt',
  'sourceHead',
  'rolloutScope',
  'stableBaselineReleaseId',
  'stableBaselineReleaseChecksum',
  'candidateRelease',
  'evaluatorVersion',
  'suiteChecksum',
  'presetVersion',
  'modelProfile'
]);

function exactKeys(value, keys) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function isOwnerPreviewSummary(summary) {
  return summary?.evidenceClass === OWNER_PREVIEW_EVIDENCE_CLASS;
}

export function assertOwnerPreviewSummary(summary, {
  candidate,
  stable,
  authorizationId,
  sourceHead
} = {}) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)
    || !exactKeys(summary, SUMMARY_KEYS)) {
    throw new Error('owner preview summary closed shape conflict');
  }
  if (summary.eligible !== true
    || summary.evidenceClass !== OWNER_PREVIEW_EVIDENCE_CLASS
    || summary.internalPreview !== true
    || summary.authorizedBy !== 'owner'
    || summary.presetVersion !== OWNER_PREVIEW_PRESET_VERSION
    || summary.evaluatorVersion !== 'lived-quality-supervisor-v3') {
    throw new Error('owner preview summary authority conflict');
  }
  if (typeof summary.authorizationId !== 'string'
    || !/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(summary.authorizationId)
    || (authorizationId !== undefined && summary.authorizationId !== authorizationId)
    || !Number.isSafeInteger(summary.authorizedAt)
    || summary.authorizedAt < 0) {
    throw new Error('owner preview authorization conflict');
  }
  if (typeof summary.sourceHead !== 'string'
    || !/^[0-9a-f]{40}$/.test(summary.sourceHead)
    || (sourceHead !== undefined && summary.sourceHead !== sourceHead)
    || !Array.isArray(summary.rolloutScope)
    || summary.rolloutScope.length !== 1
    || summary.rolloutScope[0] !== OWNER_PREVIEW_ROLLOUT_KEY) {
    throw new Error('owner preview scope authority conflict');
  }
  if (typeof summary.suiteChecksum !== 'string'
    || !/^[0-9a-f]{64}$/.test(summary.suiteChecksum)
    || contentHash(summary.modelProfile) !== contentHash(OWNER_PREVIEW_MODEL_PROFILE)) {
    throw new Error('owner preview model profile conflict');
  }
  const release = summary.candidateRelease;
  if (!release || typeof release !== 'object' || Array.isArray(release)
    || release.pipelineVersion !== 'yuqi-lived-agency-v3'
    || release.presetVersion !== OWNER_PREVIEW_PRESET_VERSION
    || release.cognitionSchemaVersion !== 3
    || release.expressionSchemaVersion !== 3
    || release.evaluatorVersion !== 'lived-quality-supervisor-v3'
    || contentHash(release.modelProfile) !== contentHash(OWNER_PREVIEW_MODEL_PROFILE)
    || (candidate && (release.releaseId !== candidate.releaseId
      || release.releaseChecksum !== candidate.releaseChecksum))) {
    throw new Error('owner preview candidate release conflict');
  }
  if (stable && (summary.stableBaselineReleaseId !== stable.releaseId
    || summary.stableBaselineReleaseChecksum !== stable.releaseChecksum)) {
    throw new Error('owner preview stable release conflict');
  }
  return Object.freeze(structuredClone(summary));
}
