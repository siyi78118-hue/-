function normalizedScene(scene = {}) {
  const catalog = Array.isArray(scene.stageCatalog) && scene.stageCatalog.length
    ? scene.stageCatalog
    : [{ id: 'new', label: '初识', content: '' }];
  const currentId = String(scene.relationshipStage?.id || 'new');
  const currentCatalog = catalog.find(item => item.id === currentId) || catalog[0];
  return {
    ...scene,
    stageCatalog: catalog.map(item => ({
      id: String(item.id || ''),
      label: String(item.label || item.id || ''),
      content: String(item.content || '')
    })),
    relationshipStage: {
      id: currentId,
      label: String(scene.relationshipStage?.label || currentCatalog?.label || currentId),
      content: String(scene.relationshipStage?.content || currentCatalog?.content || ''),
      since: Math.max(0, Number(scene.relationshipStage?.since) || 0),
      reason: String(scene.relationshipStage?.reason || ''),
      confidence: Math.max(0, Math.min(1, Number(scene.relationshipStage?.confidence) || 0))
    }
  };
}

export function sceneFromEnvelope(envelope = {}) {
  return normalizedScene(envelope.context?.scene || envelope.trigger?.context?.scene || {});
}

export function resolveRelationshipStage(scene, review, recentMessages = [], now = Date.now()) {
  const normalized = normalizedScene(scene);
  const current = normalized.relationshipStage;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return { stage: current, action: null };
  const catalog = normalized.stageCatalog;
  const ids = catalog.map(item => item.id);
  const recommended = String(review.recommended || review.stage || current.id);
  if (!ids.includes(recommended) || recommended === current.id) return { stage: current, action: null };
  const confidence = Math.max(0, Math.min(1, Number(review.confidence) || 0));
  if (confidence < 0.82) return { stage: current, action: null };
  const available = new Set(recentMessages.map(message => String(message.messageId || '')).filter(Boolean));
  const evidenceMessageIds = [...new Set(
    (Array.isArray(review.evidenceMessageIds) ? review.evidenceMessageIds : []).map(String)
  )].filter(id => available.has(id)).slice(-12);
  const explicitMutualChange = review.explicitMutualChange === true;
  if (evidenceMessageIds.length < (explicitMutualChange ? 1 : 2)) return { stage: current, action: null };
  if (!explicitMutualChange && Math.abs(ids.indexOf(recommended) - ids.indexOf(current.id)) > 1) {
    return { stage: current, action: null };
  }
  const reason = String(review.reason || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!reason) return { stage: current, action: null };
  const target = catalog.find(item => item.id === recommended);
  const stage = {
    id: target.id,
    label: target.label,
    content: target.content,
    since: Number(now),
    reason,
    confidence
  };
  return {
    stage,
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
