function parseStoredJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function immersiveStage(stage, terminal) {
  if (terminal) return '';
  if (String(stage).startsWith('memory')) return '正在翻一下我们以前说过的话…';
  if (String(stage).startsWith('brain')) return '正在认真想…';
  if (String(stage).startsWith('supervisor') || stage === 'approved') return '快好了…';
  return '正在认真想…';
}

export function publicTurnStatus(turn, { stages = [], clock = Date.now } = {}) {
  if (!turn) return null;
  const committed = ['committed', 'delivered', 'completed'].includes(turn.state);
  const failed = ['failed', 'fallback'].includes(turn.state);
  const result = parseStoredJson(turn.replyJson);
  const error = parseStoredJson(turn.errorJson);
  const latestStage = [...stages].sort((a, b) => Number(a.ordinal || 0) - Number(b.ordinal || 0)).at(-1) || null;
  const currentTime = Number(clock());
  const stageElapsedMs = latestStage
    ? Number(latestStage.durationMs ?? Math.max(0, currentTime - Number(latestStage.startedAt || currentTime)))
    : 0;
  const totalEnd = committed || failed ? Number(turn.updatedAt || currentTime) : currentTime;
  return {
    turnId: turn.turnId,
    state: turn.state,
    terminal: committed || failed,
    allowFallback: failed,
    action: committed ? String(result?.action || (result?.reply ? 'send' : 'skip')) : '',
    reply: committed ? result?.reply || null : null,
    errorCode: failed ? String(error?.code || error?.name || 'YUQI_ROLE_FAILED') : '',
    origin: committed ? String(result?.reply?.origin || turn.origin || 'codex') : String(turn.origin || 'codex'),
    route: String(turn.route || 'deep'),
    routeReasons: Array.isArray(turn.routeReasons) ? turn.routeReasons : [],
    displayStage: immersiveStage(latestStage?.stage || turn.state, committed || failed),
    technicalStage: String(latestStage?.stage || turn.state),
    stageModel: String(latestStage?.model || ''),
    stageEffort: String(latestStage?.effort || ''),
    stageElapsedMs,
    totalElapsedMs: Math.max(0, totalEnd - Number(turn.createdAt || totalEnd)),
    updatedAt: Number(turn.updatedAt || 0),
    retryAfterMs: committed || failed ? 0 : 1500
  };
}
