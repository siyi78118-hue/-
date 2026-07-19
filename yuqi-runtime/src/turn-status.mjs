function parseStoredJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

export function publicTurnStatus(turn) {
  if (!turn) return null;
  const committed = ['committed', 'delivered', 'completed'].includes(turn.state);
  const failed = ['failed', 'fallback'].includes(turn.state);
  const result = parseStoredJson(turn.replyJson);
  const error = parseStoredJson(turn.errorJson);
  return {
    turnId: turn.turnId,
    state: turn.state,
    terminal: committed || failed,
    allowFallback: failed,
    reply: committed ? result?.reply || null : null,
    errorCode: failed ? String(error?.code || error?.name || 'YUQI_ROLE_FAILED') : '',
    origin: committed ? String(result?.reply?.origin || turn.origin || 'codex') : String(turn.origin || 'codex'),
    updatedAt: Number(turn.updatedAt || 0),
    retryAfterMs: committed || failed ? 0 : 1500
  };
}
