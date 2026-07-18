function searchableText(fact) {
  return [
    fact.type,
    fact.subjectId,
    fact.predicate,
    JSON.stringify(fact.object || {}),
    ...(fact.exactQuotes || []).map(quote => quote.text)
  ].filter(Boolean).join(' ').toLowerCase();
}

function scoreFact(fact, terms) {
  const text = searchableText(fact);
  let score = fact.status === 'verified' ? 2 : 0;
  for (const term of terms) if (term && text.includes(term)) score += 3;
  if (fact.type === 'commitment') score += 1;
  return score;
}

export function buildEvidencePack(store, { characterId, query = '', keywords = [], limit = 12 }) {
  const terms = [...new Set([
    ...String(query).toLowerCase().split(/\s+/),
    ...(keywords || []).map(item => String(item).toLowerCase())
  ].filter(Boolean))];
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
  const ranked = store.listFacts(characterId)
    .map(fact => ({ fact, score: scoreFact(fact, terms) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.fact.confidence - left.fact.confidence)
    .slice(0, safeLimit);

  return {
    characterId,
    query,
    facts: ranked.map(({ fact, score }) => ({
      ...fact,
      relevanceScore: score,
      evidence: (fact.sourceMessageIds || []).map(messageId => {
        const message = store.getMessage(messageId);
        if (!message) return { messageId, missing: true, context: [] };
        return {
          messageId,
          speakerId: message.speakerId,
          speakerType: message.speakerType,
          text: message.content,
          sentAt: message.sentAt,
          context: store.getMessageContext(messageId, 1)
        };
      })
    }))
  };
}
