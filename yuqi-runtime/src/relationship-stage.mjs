const DEFAULT_BASE_CATALOG = [
  { id: 'new', label: '初识', content: '' }
];

const DEFAULT_PHASE_CATALOG = [
  { id: 'normal', label: '正常相处', content: '' },
  { id: 'conflict', label: '闹矛盾期', content: '仍然在意，但存在尚未解决的矛盾。' },
  { id: 'cooling', label: '冷却期', content: '暂时拉开一点距离，情绪仍有余波。' },
  { id: 'repair', label: '修复期', content: '双方正在处理矛盾并重新靠近。' }
];

function normalizeCatalog(input, fallback) {
  const source = Array.isArray(input) && input.length ? input : fallback;
  return source.map(item => ({
    id: String(item?.id || ''),
    label: String(item?.label || item?.id || ''),
    content: String(item?.content || '')
  })).filter(item => item.id);
}

function normalizeAxis(input, catalog, fallbackId, legacy = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = String(source.id || fallbackId);
  const catalogItem = catalog.find(item => item.id === id) || catalog[0];
  return {
    id: catalogItem.id,
    label: String(source.label || catalogItem.label),
    content: String(source.content || catalogItem.content),
    since: Math.max(0, Number(source.since ?? legacy.since) || 0),
    reason: String(source.reason ?? legacy.reason ?? ''),
    confidence: Math.max(0, Math.min(1, Number(source.confidence ?? legacy.confidence) || 0))
  };
}

function combinedStage(base, phase) {
  const phaseSuffix = phase.id === 'normal' ? '' : ` · ${phase.label}`;
  return {
    id: base.id,
    label: `${base.label}${phaseSuffix}`,
    content: [base.content, phase.id === 'normal' ? '' : phase.content].filter(Boolean).join('\n'),
    since: base.since,
    reason: base.reason,
    confidence: base.confidence,
    base,
    phase
  };
}

function normalizedScene(scene = {}) {
  const stageCatalog = normalizeCatalog(scene.stageCatalog, DEFAULT_BASE_CATALOG);
  const phaseCatalog = normalizeCatalog(scene.phaseCatalog, DEFAULT_PHASE_CATALOG);
  const relationship = scene.relationshipStage && typeof scene.relationshipStage === 'object'
    ? scene.relationshipStage
    : {};
  const baseSource = relationship.base || relationship;
  const phaseSource = relationship.phase || scene.relationshipPhase || {};
  const base = normalizeAxis(baseSource, stageCatalog, 'new', relationship);
  const phase = normalizeAxis(phaseSource, phaseCatalog, 'normal');
  return {
    ...scene,
    stageCatalog,
    phaseCatalog,
    relationshipStage: combinedStage(base, phase)
  };
}

function realEvidence(review, available) {
  return [...new Set(
    (Array.isArray(review?.evidenceMessageIds) ? review.evidenceMessageIds : []).map(String)
  )].filter(id => available.has(id)).slice(-12);
}

function baseConfidenceThreshold(currentId, targetId, ids) {
  const currentIndex = ids.indexOf(currentId);
  const targetIndex = ids.indexOf(targetId);
  const depth = Math.max(currentIndex, targetIndex);
  if (depth <= 1) return 0.78;
  if (depth === 2) return 0.80;
  if (depth === 3) return 0.84;
  return 0.88;
}

function phaseTransitionAllowed(currentId, targetId) {
  const graph = {
    normal: new Set(['conflict']),
    conflict: new Set(['cooling', 'repair']),
    cooling: new Set(['conflict', 'repair']),
    repair: new Set(['normal', 'conflict', 'cooling'])
  };
  return graph[currentId]?.has(targetId) === true;
}

function resolveBase(current, catalog, review, available, now) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return { value: current, action: null };
  const ids = catalog.map(item => item.id);
  const recommended = String(review.recommended || review.stage || current.id);
  const confidence = Math.max(0, Math.min(1, Number(review.confidence) || 0));
  const evidenceMessageIds = realEvidence(review, available);
  const explicitMutualChange = review.explicitMutualChange === true;
  const reason = String(review.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const threshold = baseConfidenceThreshold(current.id, recommended, ids);
  if (
    !ids.includes(recommended)
    || recommended === current.id
    || confidence < threshold
    || evidenceMessageIds.length < (explicitMutualChange ? 1 : 2)
    || (!explicitMutualChange && Math.abs(ids.indexOf(recommended) - ids.indexOf(current.id)) > 1)
    || (recommended === 'committed' && !explicitMutualChange)
    || !reason
  ) return { value: current, action: null };
  const target = catalog.find(item => item.id === recommended);
  const value = {
    ...target,
    since: Number(now),
    reason,
    confidence
  };
  return {
    value,
    action: {
      from: current.id,
      to: target.id,
      label: target.label,
      reason,
      confidence,
      evidenceMessageIds,
      explicitMutualChange,
      changedAt: Number(now)
    }
  };
}

function resolvePhase(current, catalog, review, available, now) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return { value: current, action: null };
  const ids = catalog.map(item => item.id);
  const recommended = String(review.recommended || current.id);
  const confidence = Math.max(0, Math.min(1, Number(review.confidence) || 0));
  const evidenceMessageIds = realEvidence(review, available);
  const explicitAcknowledgedChange = review.explicitAcknowledgedChange === true;
  const reason = String(review.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const threshold = explicitAcknowledgedChange ? 0.78 : 0.80;
  if (
    !ids.includes(recommended)
    || recommended === current.id
    || confidence < threshold
    || evidenceMessageIds.length < (explicitAcknowledgedChange ? 1 : 2)
    || !reason
    || !phaseTransitionAllowed(current.id, recommended)
  ) return { value: current, action: null };
  const target = catalog.find(item => item.id === recommended);
  const value = {
    ...target,
    since: Number(now),
    reason,
    confidence
  };
  return {
    value,
    action: {
      from: current.id,
      to: target.id,
      label: target.label,
      reason,
      confidence,
      evidenceMessageIds,
      explicitAcknowledgedChange,
      changedAt: Number(now)
    }
  };
}

export function sceneFromEnvelope(envelope = {}) {
  return normalizedScene(envelope.context?.scene || envelope.trigger?.context?.scene || {});
}

export function resolveRelationshipStage(scene, review, recentMessages = [], now = Date.now()) {
  const normalized = normalizedScene(scene);
  const available = new Set(recentMessages.map(message => String(message?.messageId || '')).filter(Boolean));
  const legacyReview = review && !Object.hasOwn(review, 'base') && !Object.hasOwn(review, 'phase')
    ? review
    : null;
  const baseResult = resolveBase(
    normalized.relationshipStage.base,
    normalized.stageCatalog,
    legacyReview || review?.base,
    available,
    now
  );
  const phaseResult = resolvePhase(
    normalized.relationshipStage.phase,
    normalized.phaseCatalog,
    review?.phase,
    available,
    now
  );
  const stage = combinedStage(baseResult.value, phaseResult.value);
  if (!baseResult.action && !phaseResult.action) return { stage, action: null };
  return {
    stage,
    action: {
      baseAction: baseResult.action,
      phaseAction: phaseResult.action,
      label: stage.label,
      changedAt: Number(now),
      ...(baseResult.action ? {
        from: baseResult.action.from,
        to: baseResult.action.to,
        reason: baseResult.action.reason,
        confidence: baseResult.action.confidence,
        evidenceMessageIds: baseResult.action.evidenceMessageIds,
        explicitMutualChange: baseResult.action.explicitMutualChange
      } : {})
    }
  };
}
