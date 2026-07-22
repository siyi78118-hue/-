export function buildGenerationWindow(messages, { currentMessageId = '', limit = 24 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 24));
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageId = String(message?.messageId || '');
    if (!messageId || messageId === String(currentMessageId || '')) continue;
    const previous = byId.get(messageId);
    if (!previous || Number(message?.sentAt || 0) >= Number(previous?.sentAt || 0)) {
      byId.set(messageId, message);
    }
  }
  return [...byId.values()]
    .sort((left, right) => Number(left?.sentAt || 0) - Number(right?.sentAt || 0))
    .slice(-safeLimit);
}
