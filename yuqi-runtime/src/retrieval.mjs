function searchableText(fact) {
  return [
    fact.type,
    fact.subjectId,
    fact.predicate,
    JSON.stringify(fact.object || {}),
    ...(fact.exactQuotes || []).map(quote => quote.text),
    ...(fact.exactActions || []).map(action => [
      action.kind,
      action.targetKey,
      JSON.stringify(action.payload || {})
    ].join(' '))
  ].filter(Boolean).join(' ').toLowerCase();
}

function scoreFact(fact, terms) {
  const text = searchableText(fact);
  let score = fact.status === 'verified' ? 2 : 0;
  for (const term of terms) if (term && text.includes(term)) score += 3;
  if (fact.type === 'commitment') score += 1;
  return score;
}

function authorityGroupsAreRetrievable(store, fact) {
  const rawGroupIds = fact?.evidenceAuthority?.authorityGroupIds;
  if (rawGroupIds != null && (!Array.isArray(rawGroupIds)
    || rawGroupIds.some(groupId => typeof groupId !== 'string' || !groupId.trim()))) return false;
  const groupIds = Array.isArray(rawGroupIds) ? [...rawGroupIds] : [];
  if (!groupIds.length || typeof store.assertVisibleGroupAuthorityInternal !== 'function') return true;
  return groupIds.every(groupId => {
    try {
      const closure = store.assertVisibleGroupAuthorityInternal(groupId, {
        purpose: 'memory_retrieval'
      });
      return closure?.status !== 'redacted'
        && closure?.group?.redactedAt == null
        && closure?.receipt?.redactedAt == null;
    } catch {
      return false;
    }
  });
}

function actionEvidenceForFact(fact) {
  if (fact?.sourceActionIds != null && !Array.isArray(fact.sourceActionIds)) return [];
  const actionIds = Array.isArray(fact?.sourceActionIds)
    ? fact.sourceActionIds.every(actionId => typeof actionId === 'string' && actionId.trim())
      ? [...fact.sourceActionIds]
      : []
    : [];
  const exactActions = Array.isArray(fact?.exactActions) ? fact.exactActions : [];
  if (!actionIds.length) return [];
  const byId = new Map();
  for (const action of exactActions) {
    const actionId = typeof action?.actionId === 'string' ? action.actionId : '';
    if (!actionId || byId.has(actionId)
      || Object.keys(action).some(key => ![
        'actionId', 'kind', 'targetKey', 'targetRevision', 'payload', 'actionChecksum'
      ].includes(key))
      || typeof action.kind !== 'string' || !action.kind.trim()
      || typeof action.targetKey !== 'string' || !action.targetKey.trim()
      || typeof action.targetRevision !== 'string' || !action.targetRevision.trim()
      || !action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)
      || !/^[a-f0-9]{64}$/.test(action.actionChecksum || '')) {
      return [];
    }
    byId.set(actionId, action);
  }
  if (byId.size !== actionIds.length || actionIds.some(actionId => !byId.has(actionId))) return [];
  return actionIds.map(actionId => ({ evidenceKind: 'action', ...byId.get(actionId) }));
}

function factIsRetrievable(store, fact, now) {
  if (typeof store?.validateMemoryFactLifecycleInternal === 'function'
    && !store.validateMemoryFactLifecycleInternal(fact)) return false;
  if (!fact || fact.status !== 'verified') return false;
  if (fact.redacted || fact.withdrawn || fact.archived || fact.suppressed || fact.superseded) return false;
  if (fact.lifecycleStatus != null
    && (typeof fact.lifecycleStatus !== 'string'
      || ['redacted', 'withdrawn', 'archived', 'suppressed', 'superseded', 'expired']
        .includes(fact.lifecycleStatus))) {
    return false;
  }
  const expiresAt = fact.expiresAt ?? fact.expiryAt ?? null;
  if (expiresAt != null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) return false;
  if (expiresAt != null && expiresAt <= now) return false;
  if (fact.sourceMessageIds != null && !Array.isArray(fact.sourceMessageIds)) return false;
  if (fact.sourceActionIds != null && !Array.isArray(fact.sourceActionIds)) return false;
  const sourceIds = Array.isArray(fact.sourceMessageIds)
    ? fact.sourceMessageIds.every(messageId => typeof messageId === 'string' && messageId.trim())
      ? [...fact.sourceMessageIds]
      : []
    : [];
  const actionIds = Array.isArray(fact.sourceActionIds)
    ? fact.sourceActionIds.every(actionId => typeof actionId === 'string' && actionId.trim())
      ? [...fact.sourceActionIds]
      : []
    : [];
  if (!sourceIds.length && !actionIds.length) return false;
  if (typeof store.isMessageSuppressed === 'function'
    && sourceIds.some(messageId => store.isMessageSuppressed(messageId))) return false;
  if (!authorityGroupsAreRetrievable(store, fact)) return false;
  if (actionIds.length && actionEvidenceForFact(fact).length !== actionIds.length) return false;
  return true;
}

function safeMessageContext(store, messageId) {
  const context = typeof store.getMessageContext === 'function'
    ? store.getMessageContext(messageId, 1)
    : [];
  if (!Array.isArray(context)) return [];
  return context.filter(message => {
    if (!message || typeof message.content !== 'string' || !message.content.trim()) return false;
    if (message.redacted || message.withdrawn || message.archived || message.superseded || message.suppressed) return false;
    if (message.lifecycleStatus != null
      && (typeof message.lifecycleStatus !== 'string'
        || ['redacted', 'withdrawn', 'archived', 'superseded', 'suppressed']
          .includes(message.lifecycleStatus))) return false;
    if (typeof store.isMessageSuppressed === 'function' && store.isMessageSuppressed(message.messageId)) return false;
    return true;
  });
}

export function buildEvidencePack(store, { characterId, query = '', keywords = [], limit = 12, now = Date.now() }) {
  const terms = [...new Set([
    ...String(query).toLowerCase().split(/\s+/),
    ...(keywords || []).map(item => String(item).toLowerCase())
  ].filter(Boolean))];
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
  const ranked = (typeof store.listRetrievableFacts === 'function'
    ? store.listRetrievableFacts(characterId)
    : store.listFacts(characterId))
    .filter(fact => factIsRetrievable(store, fact, now))
    .map(fact => ({ fact, score: scoreFact(fact, terms) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.fact.confidence - left.fact.confidence)
    .slice(0, safeLimit);

  const facts = ranked.map(({ fact, score }) => {
    const messageEvidence = (Array.isArray(fact.sourceMessageIds) ? fact.sourceMessageIds : []).map(messageId => {
      const message = store.getMessage(messageId);
        if (!message || typeof message.content !== 'string' || !message.content.trim()
          || message.redacted || message.withdrawn || message.archived
          || message.superseded || message.suppressed
          || (message.lifecycleStatus != null
            && (typeof message.lifecycleStatus !== 'string'
              || ['redacted', 'withdrawn', 'archived', 'superseded', 'suppressed']
                .includes(message.lifecycleStatus)))) return null;
        return {
          messageId,
          speakerId: message.speakerId,
          speakerType: message.speakerType,
          text: message.content,
          sentAt: message.sentAt,
          context: safeMessageContext(store, messageId)
        };
      });
    const actionEvidence = actionEvidenceForFact(fact);
    return {
      ...fact,
      relevanceScore: score,
      evidence: [...messageEvidence, ...actionEvidence]
    };
  });
  return {
    characterId,
    query,
    facts: facts.filter(fact => fact.evidence.every(Boolean))
  };
}
