const REPORTED_CLAIM = /(你|他|她|对方).{0,10}(之前|曾经|刚才)?\s*(答应|保证|承诺|说过)|据说|听说/;
const NEGATED_OR_JOKING = /(不|没|未|不会|别想|休想).{0,5}(答应|保证|承诺|同意|回来|做到)|开玩笑|逗你|骗你的|闹着玩/;
const DIRECT_COMMITMENT = /我.{0,4}(答应|保证|承诺|同意|愿意|会|记住)|说定了|交给我/;

function normalizeCandidate(candidate, status) {
  return {
    ...candidate,
    sourceMessageIds: [...new Set(candidate.sourceMessageIds || [])],
    exactQuotes: (candidate.exactQuotes || []).map(quote => ({ ...quote })),
    status,
    origin: candidate.origin || 'memory'
  };
}

export function validateFactCandidate(candidate, rawMessages) {
  const reasons = [];
  if (!candidate?.factId || !candidate.characterId || !candidate.subjectId || !candidate.predicate) {
    return { status: 'rejected', reasons: ['candidate identity is incomplete'], fact: candidate };
  }

  const byId = new Map((rawMessages || []).map(message => [message.messageId, message]));
  const sourceIds = [...new Set(candidate.sourceMessageIds || [])];
  const quotes = candidate.exactQuotes || [];
  if (!sourceIds.length || !quotes.length) {
    return { status: 'rejected', reasons: ['raw message evidence and exact quote are required'], fact: candidate };
  }

  for (const sourceId of sourceIds) {
    if (!byId.has(sourceId)) reasons.push(`source message is missing: ${sourceId}`);
  }
  for (const quote of quotes) {
    const raw = byId.get(quote.messageId);
    if (!raw) {
      reasons.push(`quoted message is missing: ${quote.messageId}`);
      continue;
    }
    if (!sourceIds.includes(quote.messageId)) reasons.push(`quote is not listed as source: ${quote.messageId}`);
    if (quote.speakerId !== raw.speakerId) reasons.push(`quote speaker mismatch for ${quote.messageId}`);
    if (!quote.text || !raw.content.includes(quote.text)) reasons.push(`quote text mismatch for ${quote.messageId}`);
  }
  if (reasons.length) return { status: 'rejected', reasons, fact: normalizeCandidate(candidate, 'rejected') };

  let status = 'verified';
  if (candidate.evidenceSource === 'fallback_provisional') {
    status = 'provisional';
    reasons.push('fallback or undelivered character text is provisional until delivery is confirmed');
  }
  if (candidate.type === 'commitment') {
    for (const sourceId of sourceIds) {
      const raw = byId.get(sourceId);
      if (raw.speakerId !== candidate.promisedBy || candidate.subjectId !== candidate.promisedBy) {
        status = 'provisional';
        reasons.push(`promisedBy ${candidate.promisedBy} does not match source speaker ${raw.speakerId}`);
      }
      if (REPORTED_CLAIM.test(raw.content)) {
        status = 'provisional';
        reasons.push('reported claim is not direct commitment evidence');
      }
      if (NEGATED_OR_JOKING.test(raw.content)) {
        status = 'provisional';
        reasons.push('negative or joking statement is not a stable commitment');
      } else if (!DIRECT_COMMITMENT.test(raw.content)) {
        status = 'provisional';
        reasons.push('direct commitment marker is absent');
      }
    }
  }

  return { status, reasons, fact: normalizeCandidate(candidate, status) };
}

export function commitVerifiedFacts(store, candidates, rawMessages) {
  const result = { verified: [], provisional: [], rejected: [] };
  for (const candidate of candidates || []) {
    const validation = validateFactCandidate(candidate, rawMessages);
    if (validation.status === 'rejected') {
      result.rejected.push(validation);
      continue;
    }
    try {
      store.putFact(validation.fact);
      result[validation.status].push(validation);
    } catch (error) {
      if (String(error?.message || error) !== 'fact checksum conflict') throw error;
      result.rejected.push({
        status: 'rejected',
        reasons: [...validation.reasons, 'fact identity conflict with an existing stored fact'],
        fact: normalizeCandidate(validation.fact, 'rejected')
      });
    }
  }
  return result;
}
