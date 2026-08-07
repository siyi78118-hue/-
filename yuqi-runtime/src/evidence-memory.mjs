import { canonicalJson } from './protocol.mjs';

const REPORTED_CLAIM = /(你|他|她|对方).{0,10}(之前|曾经|刚才)?\s*(答应|保证|承诺|说过)|据说|听说/;
const NEGATED_OR_JOKING = /(不|没|未|不会|别想|休想).{0,5}(答应|保证|承诺|同意|回来|做到)|开玩笑|逗你|骗你的|闹着玩/;
const DIRECT_COMMITMENT = /我.{0,4}(答应|保证|承诺|同意|愿意|会|记住)|说定了|交给我/;

const CONSOLIDATION_CANDIDATE_TYPES = new Set([
  'user_fact',
  'delivered_yuqi_life_fact',
  'formal_commitment',
  'retrievable_event',
  'stable_preference',
  'fact_conflict',
  'fact_supersession'
]);

const CONSOLIDATION_COMMON_KEYS = new Set([
  'factId', 'characterId', 'type', 'subjectId', 'predicate', 'object',
  'evidenceMode', 'sourceMessageIds', 'exactQuotes', 'confidence',
  'sourceActionIds', 'exactActions', 'origin', 'evidenceSource',
  'authorityContractVersion'
]);

const CANONICAL_ACTION_KEYS = new Set([
  'actionId', 'kind', 'targetKey', 'targetRevision', 'payload', 'actionChecksum'
]);

// Only these canonical actions carry a directly verifiable life-event fact.
// Payment, moment, relationship, and arbitrary role-plan actions are not
// sufficient proof that Yuqi herself experienced a life event.
const LIFE_EVIDENCE_ACTION_KINDS = new Set([
  'life_episode_create',
  'life_episode_update',
  'life_episode_cancel'
]);

const CONSOLIDATION_ALLOWED_KEYS = new Map([
  ...[...CONSOLIDATION_CANDIDATE_TYPES]
    .filter(type => type !== 'formal_commitment')
    .map(type => [type, CONSOLIDATION_COMMON_KEYS]),
  ['formal_commitment', new Set([
    ...CONSOLIDATION_COMMON_KEYS,
    'promisedBy', 'promisedTo'
  ])]
]);

function evidenceMap(evidence) {
  const records = Array.isArray(evidence)
    ? evidence
      : Array.isArray(evidence?.messages)
        ? evidence.messages
        : [];
  return {
    messages: new Map(records
      .filter(record => record
        && record.evidenceKind !== 'action'
        && isNativeNonEmptyString(record.messageId))
      .map(record => [record.messageId, record])),
    actions: new Map(records
      .filter(record => record
        && record.evidenceKind === 'action'
        && isNativeNonEmptyString(record.actionId))
      .map(record => [record.actionId, record]))
  };
}

function canonicalActionProjection(action) {
  return {
    actionId: action?.actionId,
    kind: action?.kind,
    targetKey: action?.targetKey,
    targetRevision: action?.targetRevision,
    payload: action?.payload,
    actionChecksum: action?.actionChecksum
  };
}

function isNativeNonEmptyStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(item => typeof item === 'string' && item.trim().length > 0);
}

function isNativeNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectedEvidenceSource(records) {
  const list = Array.isArray(records) ? records : [];
  if (list.some(record => record?.evidenceSource === 'legacy_provisional')) {
    return 'legacy_provisional';
  }
  if (list.some(record => record?.evidenceKind === 'action')) return 'yuqi_delivered_action';
  if (list.some(record => record?.speakerType === 'character')) return 'yuqi_delivered_message';
  return 'user_visible_message';
}

function rejectCandidate(candidate, reasons) {
  return {
    status: 'rejected',
    reasons,
    fact: normalizeCandidate(candidate || {}, 'rejected')
  };
}

/**
 * Store-independent, closed validator for evidence that may become durable
 * memory.  The caller must provide the persisted authority projection for
 * every source message; raw model text or a caller-selected status is not
 * sufficient proof.
 */
export function validateConsolidationCandidate(candidate, evidence) {
  const reasons = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return rejectCandidate(candidate, ['candidate must be an object']);
  }
  if (!CONSOLIDATION_CANDIDATE_TYPES.has(candidate.type)) {
    return rejectCandidate(candidate, ['candidate type is not in the closed consolidation allowlist']);
  }
  const allowedKeys = CONSOLIDATION_ALLOWED_KEYS.get(candidate.type) || CONSOLIDATION_COMMON_KEYS;
  const unknownKeys = Object.keys(candidate).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length) {
    reasons.push(`candidate contains unknown fields: ${unknownKeys.join(',')}`);
  }
  for (const field of ['factId', 'characterId', 'subjectId', 'predicate', 'evidenceMode', 'origin', 'evidenceSource', 'authorityContractVersion']) {
    if (!isNativeNonEmptyString(candidate[field])) {
      reasons.push(`${field} must be a native non-empty string`);
    }
  }
  if (candidate.confidence !== undefined
    && (typeof candidate.confidence !== 'number'
      || !Number.isFinite(candidate.confidence)
      || candidate.confidence < 0
      || candidate.confidence > 1)) {
    reasons.push('confidence must be a finite number between 0 and 1');
  }
  if (!isPlainJsonObject(candidate.object)) {
    reasons.push('object must be a plain JSON object');
  }
  if (candidate.promisedTo !== undefined && !isNativeNonEmptyString(candidate.promisedTo)) {
    reasons.push('promisedTo must be a native non-empty string');
  }
  const hasSourceMessageIds = Object.prototype.hasOwnProperty.call(candidate, 'sourceMessageIds');
  const hasSourceActionIds = Object.prototype.hasOwnProperty.call(candidate, 'sourceActionIds');
  if (hasSourceMessageIds && !isNativeNonEmptyStringArray(candidate.sourceMessageIds)) {
    reasons.push('sourceMessageIds must be a non-empty native string array');
  }
  if (hasSourceActionIds && !isNativeNonEmptyStringArray(candidate.sourceActionIds)) {
    reasons.push('sourceActionIds must be a non-empty native string array');
  }
  const sourceIds = hasSourceMessageIds && isNativeNonEmptyStringArray(candidate.sourceMessageIds)
    ? [...candidate.sourceMessageIds]
    : [];
  const sourceActionIds = hasSourceActionIds && isNativeNonEmptyStringArray(candidate.sourceActionIds)
    ? [...candidate.sourceActionIds]
    : [];
  if (new Set(sourceIds).size !== sourceIds.length) {
    reasons.push('source message IDs must be unique');
  }
  if (new Set(sourceActionIds).size !== sourceActionIds.length) {
    reasons.push('source action IDs must be unique');
  }
  if (!sourceIds.length && !sourceActionIds.length) {
    reasons.push('at least one source message or action is required');
  }
  const hasQuotes = Object.prototype.hasOwnProperty.call(candidate, 'exactQuotes');
  if (hasQuotes && !Array.isArray(candidate.exactQuotes)) {
    reasons.push('exactQuotes must be an array');
  }
  const quotes = Array.isArray(candidate.exactQuotes) ? candidate.exactQuotes : [];
  if (quotes.length !== sourceIds.length) {
    reasons.push('every source message needs one exact quote');
  }
  for (const quote of quotes) {
    if (!quote || typeof quote !== 'object' || Array.isArray(quote)
      || typeof quote.messageId !== 'string'
      || typeof quote.speakerId !== 'string'
      || typeof quote.text !== 'string'
      || !quote.messageId.trim() || !quote.speakerId.trim()) {
      reasons.push('exact quote must contain native messageId, speakerId, and text strings');
      continue;
    }
    const unknownQuoteKeys = Object.keys(quote || {})
      .filter(key => !['messageId', 'speakerId', 'text'].includes(key));
    if (unknownQuoteKeys.length) {
      reasons.push(`exact quote contains unknown fields: ${unknownQuoteKeys.join(',')}`);
    }
  }
  const exactActions = Array.isArray(candidate.exactActions) ? candidate.exactActions : [];
  if (exactActions.length !== sourceActionIds.length) {
    reasons.push('every source action needs one exact action projection');
  }

  const byId = evidenceMap(evidence);
  const authorities = [];
  for (const sourceId of sourceIds) {
    const message = byId.messages.get(sourceId);
    if (!message) {
      reasons.push(`authoritative source message is missing: ${sourceId}`);
      continue;
    }
    const messageTurnState = Object.prototype.hasOwnProperty.call(message, 'turnState')
      ? message.turnState
      : message.state;
    const messageGroupId = Object.prototype.hasOwnProperty.call(message, 'authorityGroupId')
      ? message.authorityGroupId
      : message.groupId;
    const messageLineageKey = Object.prototype.hasOwnProperty.call(message, 'authorityLineageKey')
      ? message.authorityLineageKey
      : message.lineageKey;
    const messageCommitChecksum = Object.prototype.hasOwnProperty.call(message, 'authorityCommitChecksum')
      ? message.authorityCommitChecksum
      : message.commitChecksum;
    if (message.committed !== true
      || message.resultAuthorityVersion !== 1
      || typeof message.messageId !== 'string'
      || message.messageId !== sourceId
      || typeof messageTurnState !== 'string'
      || !['committed', 'completed', 'delivered'].includes(messageTurnState)
      || typeof message.speakerId !== 'string'
      || !message.speakerId.trim()
      || !['user', 'character'].includes(message.speakerType)
      || typeof message.content !== 'string'
      || !message.content.trim()
      || !Number.isSafeInteger(message.sentAt)) {
      reasons.push(`source message is not a committed canonical projection: ${sourceId}`);
    }
    if (message.authorityVerified !== true
      || !isNativeNonEmptyString(messageGroupId)
      || !isNativeNonEmptyString(messageLineageKey)
      || !/^[a-f0-9]{64}$/.test(messageCommitChecksum || '')) {
      reasons.push(`source authority proof is incomplete: ${sourceId}`);
    }
    if (message.redacted === true || message.withdrawn === true || message.archived === true
      || message.superseded === true || message.suppressed === true
      || typeof message.content !== 'string' || !message.content.trim()) {
      reasons.push(`source message is not live evidence: ${sourceId}`);
    }
    if (message.terminalDisposition === 'skip' || message.isSkip === true) {
      reasons.push(`skip has no message evidence: ${sourceId}`);
    }
    if (candidate.type === 'delivered_yuqi_life_fact' && message.deliveryState !== 'confirmed') {
      reasons.push(`source message is not delivery-confirmed: ${sourceId}`);
    }
    if (message.speakerType === 'character'
      && candidate.type !== 'user_fact'
      && message.deliveryState !== 'confirmed') {
      reasons.push(`character evidence is not delivery-confirmed: ${sourceId}`);
    }
    authorities.push({
      messageId: sourceId,
      authorityGroupId: messageGroupId || null,
      authorityLineageKey: messageLineageKey || null,
      authorityCommitChecksum: messageCommitChecksum || null
    });
  }

  const exactActionById = new Map();
  for (const exactAction of exactActions) {
    const actionId = typeof exactAction?.actionId === 'string' ? exactAction.actionId : '';
    const unknownActionKeys = Object.keys(exactAction || {}).filter(key => !CANONICAL_ACTION_KEYS.has(key));
    if (unknownActionKeys.length) {
      reasons.push(`exact action contains unknown fields: ${unknownActionKeys.join(',')}`);
    }
    if (!actionId || exactActionById.has(actionId)) {
      reasons.push('exact actions must have unique non-empty IDs');
      continue;
    }
    const exactActionKeys = Object.keys(exactAction).sort();
    if (canonicalJson(exactActionKeys) !== canonicalJson([...CANONICAL_ACTION_KEYS].sort())
      || typeof exactAction.kind !== 'string'
      || typeof exactAction.targetKey !== 'string'
      || typeof exactAction.targetRevision !== 'string'
      || !exactAction.payload || typeof exactAction.payload !== 'object'
      || Array.isArray(exactAction.payload)
      || !/^[a-f0-9]{64}$/.test(exactAction.actionChecksum || '')) {
      reasons.push(`exact action is not a native closed projection: ${actionId}`);
    }
    exactActionById.set(actionId, exactAction);
  }
  for (const sourceActionId of sourceActionIds) {
    const action = byId.actions.get(sourceActionId);
    const exactAction = exactActionById.get(sourceActionId);
    if (!action) {
      reasons.push(`authoritative source action is missing: ${sourceActionId}`);
      continue;
    }
    if (!exactAction) {
      reasons.push(`exact action projection is missing: ${sourceActionId}`);
      continue;
    }
    const actionTurnState = Object.prototype.hasOwnProperty.call(action, 'turnState')
      ? action.turnState
      : action.state;
    const actionGroupId = Object.prototype.hasOwnProperty.call(action, 'authorityGroupId')
      ? action.authorityGroupId
      : action.groupId;
    const actionLineageKey = Object.prototype.hasOwnProperty.call(action, 'authorityLineageKey')
      ? action.authorityLineageKey
      : action.lineageKey;
    const actionCommitChecksum = Object.prototype.hasOwnProperty.call(action, 'authorityCommitChecksum')
      ? action.authorityCommitChecksum
      : action.commitChecksum;
    if (action.evidenceKind !== 'action'
      || action.authorityVerified !== true
      || action.resultAuthorityVersion !== 1
      || typeof action.actionId !== 'string'
      || action.actionId !== sourceActionId
      || typeof actionTurnState !== 'string'
      || !['committed', 'completed', 'delivered'].includes(actionTurnState)
      || action.deliveryState !== 'confirmed'
      || action.redacted === true
      || action.suppressed === true
      || !isNativeNonEmptyString(actionGroupId)
      || !isNativeNonEmptyString(actionLineageKey)
      || !/^[a-f0-9]{64}$/.test(actionCommitChecksum || '')
      || !isNativeNonEmptyString(action.authorityRoleId)
      || action.authorityRoleId !== candidate.characterId
      || !isNativeNonEmptyString(action.kind)
      || !isNativeNonEmptyString(action.targetKey)
      || !isNativeNonEmptyString(action.targetRevision)
      || !action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)
      || !/^[a-f0-9]{64}$/.test(action.actionChecksum || '')
      || canonicalJson(canonicalActionProjection(exactAction))
        !== canonicalJson(canonicalActionProjection(action))) {
      reasons.push(`source action is not a closed confirmed canonical projection: ${sourceActionId}`);
    }
    authorities.push({
      actionId: sourceActionId,
      authorityGroupId: actionGroupId || null,
      authorityLineageKey: actionLineageKey || null,
      authorityCommitChecksum: actionCommitChecksum || null
    });
  }

  const quoteById = new Map();
  for (const quote of quotes) {
    const quoteId = typeof quote?.messageId === 'string' ? quote.messageId : '';
    if (quoteById.has(quoteId)) reasons.push(`exact quotes must have unique IDs: ${quoteId}`);
    quoteById.set(quoteId, quote);
  }
  for (const sourceId of sourceIds) {
    const message = byId.messages.get(sourceId);
    const quote = quoteById.get(sourceId);
    if (!message || !quote) continue;
    if (quote.speakerId !== message.speakerId || quote.text !== message.content) {
      reasons.push(`exact quote does not match source message: ${sourceId}`);
    }
  }
  if (quotes.some(quote => !isNativeNonEmptyString(quote?.messageId)
    || !sourceIds.includes(quote.messageId))) {
    reasons.push('quote references a message outside sourceMessageIds');
  }
  if (sourceIds.length !== quoteById.size
    || sourceIds.some(sourceId => !quoteById.has(sourceId))) {
    reasons.push('exactQuotes and sourceMessageIds must be a complete one-to-one mapping');
  }
  const allEvidence = [
    ...sourceIds.map(sourceId => byId.messages.get(sourceId)).filter(Boolean),
    ...sourceActionIds.map(actionId => byId.actions.get(actionId)).filter(Boolean)
  ];
  if (candidate.origin !== 'consolidation') {
    reasons.push('authority candidate origin must be the store-owned consolidation value');
  }
  if (candidate.authorityContractVersion !== 'v3') {
    reasons.push('authority candidate must declare the fixed v3 contract');
  }
  if (candidate.evidenceSource !== expectedEvidenceSource(allEvidence)) {
    reasons.push('candidate evidenceSource does not match its authoritative sources');
  }
  if (candidate.type === 'formal_commitment') {
    if (typeof candidate.promisedBy !== 'string' || !candidate.promisedBy.trim()) {
      reasons.push('formal commitment promisedBy is required');
    }
    for (const sourceId of sourceIds) {
      const message = byId.messages.get(sourceId);
      if (message && (!['user', 'character'].includes(message.speakerType)
        || message.speakerId !== candidate.promisedBy)) {
        reasons.push(`formal commitment speaker mismatch: ${sourceId}`);
      }
    }
    for (const sourceActionId of sourceActionIds) {
      const action = byId.actions.get(sourceActionId);
      if (typeof action?.payload?.promisedBy !== 'string'
        || action.payload.promisedBy !== candidate.promisedBy) {
        reasons.push(`formal commitment action proof promisedBy mismatch: ${sourceActionId}`);
      }
    }
  }
  if (candidate.type === 'user_fact') {
    if (!sourceIds.length) reasons.push('user fact requires user message evidence');
    for (const sourceId of sourceIds) {
      const message = byId.messages.get(sourceId);
      if (message && message.speakerType !== 'user') {
        reasons.push(`user fact requires user speaker evidence: ${sourceId}`);
      }
    }
  }
  if (candidate.type === 'delivered_yuqi_life_fact') {
    for (const sourceId of sourceIds) {
      const message = byId.messages.get(sourceId);
      if (message && (message.speakerType !== 'character' || message.speakerId !== candidate.characterId)) {
        reasons.push(`Yuqi life fact requires character evidence: ${sourceId}`);
      }
    }
    for (const sourceActionId of sourceActionIds) {
      const action = byId.actions.get(sourceActionId);
      if (!LIFE_EVIDENCE_ACTION_KINDS.has(action?.kind)
        || action.authorityRoleId !== candidate.characterId) {
        reasons.push(`action is not a directly attributable life-event proof: ${sourceActionId}`);
      }
    }
  }
  if (candidate.type === 'stable_preference') {
    if (sourceIds.length + sourceActionIds.length < 2) {
      reasons.push('stable preference needs two independent committed sources');
    } else {
      const groupIds = authorities.map(item => item.authorityGroupId);
      const lineageKeys = authorities.map(item => item.authorityLineageKey);
      if (groupIds.some(id => !id) || lineageKeys.some(key => !key)
        || new Set(groupIds).size !== groupIds.length
        || new Set(lineageKeys).size !== lineageKeys.length) {
        reasons.push('stable preference sources must be independent groups and lineages');
      }
    }
  }
  if (reasons.length) return rejectCandidate(candidate, reasons);

  return {
    status: 'verified',
    reasons: [],
    fact: normalizeCandidate({
      ...candidate,
      sourceMessageIds: sourceIds,
      sourceActionIds,
      exactActions: exactActions.map(action => ({ ...action })),
      evidenceAuthority: {
        authorityGroupIds: [...new Set(authorities.map(item => item.authorityGroupId).filter(Boolean))],
        lineageKeys: [...new Set(authorities.map(item => item.authorityLineageKey).filter(Boolean))],
        commitChecksums: [...new Set(authorities.map(item => item.authorityCommitChecksum).filter(Boolean))]
      }
    }, 'verified')
  };
}

function normalizeCandidate(candidate, status) {
  const sourceMessageIds = Array.isArray(candidate.sourceMessageIds)
    ? [...new Set(candidate.sourceMessageIds)]
    : [];
  const sourceActionIds = Array.isArray(candidate.sourceActionIds)
    ? [...new Set(candidate.sourceActionIds)]
    : [];
  return {
    ...candidate,
    sourceMessageIds,
    exactQuotes: (Array.isArray(candidate.exactQuotes) ? candidate.exactQuotes : [])
      .map(quote => ({ ...quote })),
    sourceActionIds,
    exactActions: (Array.isArray(candidate.exactActions) ? candidate.exactActions : [])
      .map(action => ({ ...action })),
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
  if (candidate.evidenceSource === 'legacy_provisional') {
    status = 'provisional';
    reasons.push('fallback or undelivered character text is provisional until delivery is confirmed');
  }
  if (candidate.type === 'commitment' || candidate.type === 'formal_commitment') {
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
    const useAuthorityValidator = candidate?.origin === 'consolidation'
      || candidate?.authorityContractVersion === 'v3';
    const validation = useAuthorityValidator
      ? validateConsolidationCandidate(candidate, rawMessages)
      : validateFactCandidate(candidate, rawMessages);
    if (validation.status === 'rejected') {
      result.rejected.push(validation);
      continue;
    }
    try {
      store.putFact(validation.fact);
      if (useAuthorityValidator) result.verified.push(validation);
      else result[validation.status].push(validation);
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
