function elapsedText(milliseconds) {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return '不到1分钟';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `${hours}小时${rest ? `${rest}分钟` : ''}`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `${days}天${restHours ? `${restHours}小时` : ''}`;
}

function delayClass(milliseconds) {
  if (milliseconds < 5 * 60_000) return 'immediate';
  if (milliseconds < 60 * 60_000) return 'minutes';
  if (milliseconds < 6 * 60 * 60_000) return 'hours';
  if (milliseconds < 24 * 60 * 60_000) return 'same_day_long_gap';
  return 'day_or_more';
}

export function buildAuthoritativeInteractionState({ envelope, messages = [], currentStage = null, previousAutomaticResult = null, now = Date.now() }) {
  const sorted = [...messages].sort((a, b) => Number(a.sentAt || 0) - Number(b.sentAt || 0));
  const currentTime = Number(now || Date.now());
  const sourceOccurredAt = Number(envelope.message?.sentAt || envelope.trigger?.executedAt || envelope.trigger?.scheduledFor || envelope.createdAt || currentTime);
  const processingDelayMs = Math.max(0, currentTime - sourceOccurredAt);
  const lastMessage = sorted.at(-1) || null;
  const lastUserMessage = [...sorted].reverse().find(item => item.speakerId === 'user') || null;
  const lastYuqiMessage = [...sorted].reverse().find(item => item.speakerId === envelope.characterId) || null;
  const since = item => item ? Math.max(0, currentTime - Number(item.sentAt || currentTime)) : null;
  const silenceMs = since(lastMessage);
  const unansweredOutgoingCount = lastUserMessage
    ? sorted.filter(item => item.speakerId === envelope.characterId && Number(item.sentAt || 0) > Number(lastUserMessage.sentAt || 0)).length
    : sorted.filter(item => item.speakerId === envelope.characterId).length;
  const currentDay = new Date(currentTime).toISOString().slice(0, 10);
  const lastDay = lastMessage ? new Date(Number(lastMessage.sentAt)).toISOString().slice(0, 10) : currentDay;
  return {
    computedAt: currentTime, computedAtIso: new Date(currentTime).toISOString(),
    sourceOccurredAt, sourceOccurredAtIso: new Date(sourceOccurredAt).toISOString(),
    processingDelayMs, processingDelayText: elapsedText(processingDelayMs), processingDelayClass: delayClass(processingDelayMs), replyFromPresent: true,
    lastMessageId: lastMessage?.messageId || null, lastSpeakerId: lastMessage?.speakerId || null, lastMessageContent: String(lastMessage?.content || ''),
    lastUserMessageId: lastUserMessage?.messageId || null, lastUserMessageContent: String(lastUserMessage?.content || ''),
    lastYuqiMessageId: lastYuqiMessage?.messageId || null, lastYuqiMessageContent: String(lastYuqiMessage?.content || ''),
    silenceMsSinceLastMessage: silenceMs, silenceMsSinceLastUserMessage: since(lastUserMessage), silenceMsSinceLastYuqiMessage: since(lastYuqiMessage),
    elapsedThresholds: {
      fifteenMinutes: silenceMs !== null && silenceMs >= 15 * 60_000,
      oneHour: silenceMs !== null && silenceMs >= 60 * 60_000,
      sixHours: silenceMs !== null && silenceMs >= 6 * 60 * 60_000,
      oneDay: silenceMs !== null && silenceMs >= 24 * 60 * 60_000
    },
    crossedDay: currentDay !== lastDay,
    unansweredOutgoingCount, waitingForUserReply: unansweredOutgoingCount > 0,
    previousAutomaticResult, relationshipStage: currentStage,
    triggerSnapshotIsAdvisory: Boolean(envelope.trigger?.context?.snapshot)
  };
}
