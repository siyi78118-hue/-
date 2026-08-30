function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function lexicalTokens(value) {
  const text = normalizeText(value);
  const tokens = new Set((text.match(/[\p{L}\p{N}_-]+/gu) || []).filter(
    token => !/\p{Script=Han}/u.test(token)
  ));
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
    const chars = [...run];
    for (const size of [2, 3]) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        tokens.add(chars.slice(index, index + size).join(''));
      }
    }
  }
  return tokens;
}

function summaryText(summary) {
  const emotions = summary?.emotionalSummary || {};
  return [
    ...(summary?.keyEvents || []),
    emotions.user, emotions.al, emotions.interaction,
    ...(summary?.importantDecisions || [])
  ].filter(value => typeof value === 'string' && value.trim()).join('\n');
}

function overlapScore(query, candidate) {
  let score = 0;
  for (const token of candidate) {
    if (query.has(token)) score += token.length >= 3 ? 3 : 2;
  }
  return score;
}

function kindAffinity(kind, queryText) {
  const patterns = {
    relationship: /关系|相处|亲密|relationship/iu,
    commitment: /承诺|约定|答应|commit/iu,
    preference: /喜欢|偏好|讨厌|prefer/iu,
    event: /发生|经历|事件|过去|event/iu
  };
  return patterns[kind]?.test(queryText) ? 1 : 0;
}

export class ExperienceMemoryRetriever {
  retrieve({ roleId, sessionSummary, memories, limit = 8 } = {}) {
    if (typeof roleId !== 'string' || !roleId.trim()) throw new Error('experience retrieval roleId is required');
    if (!sessionSummary || typeof sessionSummary !== 'object') throw new Error('experience retrieval summary is required');
    if (!Array.isArray(memories)) throw new Error('experience retrieval memories must be an array');
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw new Error('experience retrieval limit is invalid');
    if (limit === 0) return [];
    const queryText = summaryText(sessionSummary);
    const queryTokens = lexicalTokens(queryText);
    return memories
      .filter(memory => memory?.roleId === roleId && memory.status === 'active')
      .map(memory => {
        const explicit = Array.isArray(memory.sourceRefs) && memory.sourceRefs.some(
          ref => ref?.type === 'session_summary' && ref.id === sessionSummary.id
        );
        const lexical = overlapScore(queryTokens, lexicalTokens(memory.content));
        const affinity = kindAffinity(memory.kind, queryText);
        return { memory, explicit, lexical, affinity };
      })
      .filter(candidate => candidate.explicit || candidate.lexical >= 3 || candidate.affinity > 0)
      .sort((left, right) =>
        Number(right.explicit) - Number(left.explicit)
        || right.lexical - left.lexical
        || right.affinity - left.affinity
        || String(right.memory.updatedAt || right.memory.createdAt || '').localeCompare(
          String(left.memory.updatedAt || left.memory.createdAt || '')
        )
        || String(left.memory.id).localeCompare(String(right.memory.id))
      )
      .slice(0, limit)
      .map(candidate => structuredClone(candidate.memory));
  }
}
