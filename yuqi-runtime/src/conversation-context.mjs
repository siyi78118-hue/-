export function completeMessageGroupKey(message) {
  const turnId = String(message?.turnId || '');
  const batchId = String(message?.batchId || '');
  const speaker = String(message?.speakerType || message?.speakerId || 'unknown');
  return batchId
    ? `${speaker}:batch:${batchId}`
    : turnId
      ? `${speaker}:turn:${turnId}`
      : `message:${String(message?.messageId || '')}`;
}

export function takeCompleteMessageGroups(messages, limit = 20) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const groups = [];
  const byGroupKey = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const groupKey = completeMessageGroupKey(message);
    let group = byGroupKey.get(groupKey);
    if (!group) {
      group = [];
      byGroupKey.set(groupKey, group);
      groups.push(group);
    }
    group.push(message);
  }
  return groups.slice(-safeLimit).flat();
}

export function buildGenerationWindow(messages, {
  currentMessageId = '',
  currentMessageIds = [],
  limit = 20
} = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const excludedIds = new Set([
    String(currentMessageId || ''),
    ...(Array.isArray(currentMessageIds) ? currentMessageIds.map(String) : [])
  ].filter(Boolean));
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageId = String(message?.messageId || '');
    if (!messageId || excludedIds.has(messageId)) continue;
    const previous = byId.get(messageId);
    if (!previous || Number(message?.sentAt || 0) >= Number(previous?.sentAt || 0)) {
      byId.set(messageId, message);
    }
  }
  const ordered = [...byId.values()]
    .sort((left, right) => Number(left?.sentAt || 0) - Number(right?.sentAt || 0));
  return takeCompleteMessageGroups(ordered, safeLimit);
}
