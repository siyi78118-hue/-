export function buildGenerationWindow(messages, { currentMessageId = '', limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageId = String(message?.messageId || '');
    if (!messageId || messageId === String(currentMessageId || '')) continue;
    const previous = byId.get(messageId);
    if (!previous || Number(message?.sentAt || 0) >= Number(previous?.sentAt || 0)) {
      byId.set(messageId, message);
    }
  }
  const ordered = [...byId.values()]
    .sort((left, right) => Number(left?.sentAt || 0) - Number(right?.sentAt || 0));
  const groups = [];
  const byGroupKey = new Map();
  for (const message of ordered) {
    const turnId = String(message?.turnId || '');
    const speaker = String(message?.speakerType || message?.speakerId || 'unknown');
    const groupKey = turnId ? `${speaker}:${turnId}` : `message:${message.messageId}`;
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
