function projectSummary(summary) {
  if (!summary || typeof summary !== 'object') throw new Error('experience context summary is required');
  return {
    id: summary.id,
    revision: summary.revision,
    sourceDigest: summary.sourceDigest,
    keyEvents: structuredClone(summary.keyEvents),
    emotionalSummary: structuredClone(summary.emotionalSummary),
    importantDecisions: structuredClone(summary.importantDecisions)
  };
}

function projectPersonality(personalityState) {
  if (personalityState === null) return null;
  if (!personalityState || typeof personalityState !== 'object') throw new Error('experience context personality is invalid');
  return {
    selfDescription: personalityState.selfDescription,
    tendencies: structuredClone(personalityState.tendencies),
    tensions: structuredClone(personalityState.tensions)
  };
}

function projectMemory(memory) {
  return {
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    confidence: memory.confidence
  };
}

export function buildExperienceContext({ sessionSummary, personalityState = null, relevantMemories = [] } = {}) {
  if (!Array.isArray(relevantMemories)) throw new Error('experience context memories must be an array');
  return {
    sessionSummary: projectSummary(sessionSummary),
    personalityState: projectPersonality(personalityState),
    relevantMemories: relevantMemories.map(projectMemory)
  };
}
