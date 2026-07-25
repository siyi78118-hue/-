import { contentHash } from './protocol.mjs';

const HIGH_PRIORITY_CODES = new Set([
  'SPEAKER_ATTRIBUTION',
  'MEMORY_BOUNDARY',
  'COMMITMENT_ATTRIBUTION',
  'IDENTITY_CONFLICT',
  'PLAN_REPLY_MISMATCH',
  'ROLE_PLAN_MISMATCH',
  'PAYMENT_ACTION_MISMATCH',
  'INTERNAL_FORMAT_LEAKAGE'
]);

const LOW_RISK_CHARACTER_FACT_PREDICATES = new Set([
  'currently_reading',
  'current_meal',
  'current_activity',
  'minor_preference',
  'minor_encounter',
  'daily_detail'
]);

function strings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
    : [];
}

function issueSeverity(issue) {
  if (issue?.severity === 'hard' || issue?.severity === 'soft') return issue.severity;
  return HIGH_PRIORITY_CODES.has(String(issue?.code || '').trim()) ? 'hard' : 'soft';
}

function previousIssueAt(previous, code, occurrence) {
  const matching = (previous?.issues || []).filter(issue => issue.code === code);
  return matching[occurrence - 1] || null;
}

function normalizeIssue(issue, { previous, occurrence }) {
  const code = String(issue?.code || 'SUPERVISOR_FEEDBACK').trim() || 'SUPERVISOR_FEEDBACK';
  const message = String(issue?.message || '请重写当前回复').trim() || '请重写当前回复';
  const prior = previousIssueAt(previous, code, occurrence);
  const severity = issueSeverity(issue);
  return {
    issueId: String(issue?.issueId || prior?.issueId || `${code}:${occurrence}`),
    code,
    severity,
    message,
    mustPreserve: strings(issue?.mustPreserve).length
      ? strings(issue.mustPreserve)
      : ['保持事实归属、角色身份和当前关系连续性'],
    mustChange: strings(issue?.mustChange).length
      ? strings(issue.mustChange)
      : [message],
    allowedStrategies: strings(issue?.allowedStrategies).length
      ? strings(issue.allowedStrategies)
      : [severity === 'hard'
          ? '删除或改正冲突内容，并用虞栖的世界内口吻重新表达'
          : '按问题说明重写可见正文，同时保留已经正确的内容'],
    acceptanceCriteria: strings(issue?.acceptanceCriteria).length
      ? strings(issue.acceptanceCriteria)
      : [message]
  };
}

export function normalizeSupervisorResult(reviewed, {
  attempt = 1,
  previous = null,
  direct = false
} = {}) {
  const legacyDecision = reviewed?.approved === true
    ? 'approve'
    : reviewed?.approved === false
      ? 'rewrite'
      : null;
  let decision = ['approve', 'rewrite', 'skip', 'reject'].includes(reviewed?.decision)
    ? reviewed.decision
    : legacyDecision || 'reject';
  if (direct && ['reject', 'skip'].includes(decision)) decision = 'rewrite';

  const occurrences = new Map();
  const issues = [];
  for (const rawIssue of Array.isArray(reviewed?.issues) ? reviewed.issues : []) {
    const code = String(rawIssue?.code || 'SUPERVISOR_FEEDBACK').trim() || 'SUPERVISOR_FEEDBACK';
    const occurrence = Number(occurrences.get(code) || 0) + 1;
    occurrences.set(code, occurrence);
    const normalized = normalizeIssue(rawIssue, { previous, occurrence });
    const existedPreviously = Boolean(previousIssueAt(previous, normalized.code, occurrence));
    if (Number(attempt) > 1 && normalized.severity === 'soft' && !existedPreviously) continue;
    issues.push(normalized);
  }

  return {
    ...(reviewed && typeof reviewed === 'object' && !Array.isArray(reviewed) ? reviewed : {}),
    decision,
    approved: decision === 'approve',
    attempt: Math.max(1, Number(attempt) || 1),
    reviewedIssueIds: strings(reviewed?.reviewedIssueIds),
    resolvedIssueIds: strings(reviewed?.resolvedIssueIds),
    issues
  };
}

export function rewriteContractForBrain(supervisorResult) {
  const supervisor = supervisorResult && typeof supervisorResult === 'object'
    ? supervisorResult
    : {};
  return {
    attempt: Math.max(1, Number(supervisor.attempt) || 1),
    issues: (supervisor.issues || []).map(issue => ({
      issueId: issue.issueId,
      code: issue.code,
      severity: issue.severity,
      mustPreserve: strings(issue.mustPreserve),
      mustChange: strings(issue.mustChange),
      allowedStrategies: strings(issue.allowedStrategies),
      acceptanceCriteria: strings(issue.acceptanceCriteria)
    }))
  };
}

export function normalizeRewriteResolution(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    resolvedIssueIds: strings(source.resolvedIssueIds),
    resolutionNotes: (Array.isArray(source.resolutionNotes) ? source.resolutionNotes : [])
      .map(note => ({
        issueId: String(note?.issueId || '').trim(),
        strategy: String(note?.strategy || '').trim(),
        result: String(note?.result || '').trim()
      }))
      .filter(note => note.issueId && note.strategy && note.result),
    formedCharacterFacts: (Array.isArray(source.formedCharacterFacts) ? source.formedCharacterFacts : [])
      .map(fact => ({
        predicate: String(fact?.predicate || '').trim(),
        summary: String(fact?.summary || '').trim(),
        detailsJson: String(fact?.detailsJson || '{}').trim() || '{}',
        evidenceQuote: String(fact?.evidenceQuote || '').trim()
      }))
      .filter(fact => fact.predicate && fact.summary && fact.evidenceQuote)
  };
}

export function hasHighPriorityIssues(supervisorResult) {
  return (supervisorResult?.issues || []).some(issue => issue.severity === 'hard');
}

export function characterFactCandidatesForReply(resolution, reply) {
  const normalized = normalizeRewriteResolution(resolution);
  const content = String(reply?.content || '');
  const messageId = String(reply?.messageId || '');
  const characterId = String(reply?.characterId || reply?.speakerId || '');
  const speakerId = String(reply?.speakerId || '');
  if (!content || !messageId || !characterId || speakerId !== characterId) return [];

  return normalized.formedCharacterFacts
    .filter(fact => (
      LOW_RISK_CHARACTER_FACT_PREDICATES.has(fact.predicate)
      && content.includes(fact.evidenceQuote)
    ))
    .map(fact => ({
      factId: `fact_${contentHash({
        messageId,
        predicate: fact.predicate,
        summary: fact.summary
      }).slice(0, 24)}`,
      characterId,
      subjectId: characterId,
      predicate: fact.predicate,
      object: {
        summary: fact.summary,
        detailsJson: fact.detailsJson
      },
      evidenceMode: 'direct_character_statement',
      sourceMessageIds: [messageId],
      exactQuotes: [{
        messageId,
        speakerId,
        text: fact.evidenceQuote
      }],
      type: 'daily_detail',
      promisedBy: null,
      promisedTo: null,
      confidence: 0.95,
      supersedes: null,
      origin: 'brain_rewrite',
      createdAt: Number(reply.sentAt) || null,
      verifiedAt: Number(reply.sentAt) || null
    }));
}
