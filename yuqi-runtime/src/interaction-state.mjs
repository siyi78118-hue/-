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

function conversationGapClass(milliseconds, crossedDay = false) {
  if (crossedDay || milliseconds >= 24 * 60 * 60_000) return 'new_day';
  if (milliseconds < 3 * 60_000) return 'continuous';
  if (milliseconds < 10 * 60_000) return 'brief_pause';
  if (milliseconds < 60 * 60_000) return 'interrupted';
  return 'long_interruption';
}

export function buildAuthoritativeInteractionState({ envelope, messages = [], currentStage = null, previousAutomaticResult = null, now = Date.now() }) {
  const sorted = [...messages].sort((a, b) => Number(a.sentAt || 0) - Number(b.sentAt || 0));
  const currentTime = Number(now || Date.now());
  const sourceOccurredAt = Number(envelope.message?.sentAt || envelope.trigger?.executedAt || envelope.trigger?.scheduledFor || envelope.createdAt || currentTime);
  const processingDelayMs = Math.max(0, currentTime - sourceOccurredAt);
  const suppliedBatchIds = Array.isArray(envelope.context?.currentBatch?.messageIds)
    ? envelope.context.currentBatch.messageIds.map(String).filter(Boolean)
    : [];
  const currentBatchMessageIds = [...new Set([
    ...suppliedBatchIds,
    ...(envelope.message?.messageId ? [String(envelope.message.messageId)] : [])
  ])];
  const currentBatchSet = new Set(currentBatchMessageIds);
  const historical = currentBatchSet.size
    ? sorted.filter(item => !currentBatchSet.has(String(item?.messageId || '')))
    : sorted;
  const lastMessage = historical.at(-1) || null;
  const lastUserMessage = [...historical].reverse().find(item => item.speakerId === 'user') || null;
  const lastYuqiMessage = [...historical].reverse().find(item => item.speakerId === envelope.characterId) || null;
  const since = item => item ? Math.max(0, currentTime - Number(item.sentAt || currentTime)) : null;
  const silenceMs = since(lastMessage);
  const unansweredOutgoingCount = lastUserMessage
    ? historical.filter(item => item.speakerId === envelope.characterId && Number(item.sentAt || 0) > Number(lastUserMessage.sentAt || 0)).length
    : historical.filter(item => item.speakerId === envelope.characterId).length;
  const batchStartedAt = Number(envelope.context?.currentBatch?.startedAt || sourceOccurredAt);
  const conversationGapMs = lastMessage
    ? Math.max(0, batchStartedAt - Number(lastMessage.sentAt || batchStartedAt))
    : null;
  const currentDay = new Date(currentTime).toISOString().slice(0, 10);
  const lastDay = lastMessage ? new Date(Number(lastMessage.sentAt)).toISOString().slice(0, 10) : currentDay;
  const crossedDay = currentDay !== lastDay;
  return {
    computedAt: currentTime, computedAtIso: new Date(currentTime).toISOString(),
    sourceOccurredAt, sourceOccurredAtIso: new Date(sourceOccurredAt).toISOString(),
    processingDelayMs, processingDelayText: elapsedText(processingDelayMs), processingDelayClass: delayClass(processingDelayMs), replyFromPresent: true,
    currentBatchMessageIds,
    conversationGapMs,
    conversationGapText: conversationGapMs === null ? null : elapsedText(conversationGapMs),
    conversationGapClass: conversationGapMs === null ? 'no_history' : conversationGapClass(conversationGapMs, crossedDay),
    previousMessageId: lastMessage?.messageId || null,
    previousSpeakerId: lastMessage?.speakerId || null,
    previousMessageContent: String(lastMessage?.content || ''),
    lastMessageId: lastMessage?.messageId || null, lastSpeakerId: lastMessage?.speakerId || null, lastMessageContent: String(lastMessage?.content || ''),
    lastUserMessageId: lastUserMessage?.messageId || null, lastUserMessageContent: String(lastUserMessage?.content || ''),
    lastYuqiMessageId: lastYuqiMessage?.messageId || null, lastYuqiMessageContent: String(lastYuqiMessage?.content || ''),
    silenceMsSinceLastMessage: silenceMs, silenceMsSinceLastUserMessage: since(lastUserMessage), silenceMsSinceLastYuqiMessage: since(lastYuqiMessage),
    elapsedThresholds: {
      tenMinutes: silenceMs !== null && silenceMs >= 10 * 60_000,
      fifteenMinutes: silenceMs !== null && silenceMs >= 15 * 60_000,
      oneHour: silenceMs !== null && silenceMs >= 60 * 60_000,
      sixHours: silenceMs !== null && silenceMs >= 6 * 60 * 60_000,
      oneDay: silenceMs !== null && silenceMs >= 24 * 60 * 60_000
    },
    crossedDay,
    unansweredOutgoingCount, waitingForUserReply: unansweredOutgoingCount > 0,
    previousAutomaticResult, relationshipStage: currentStage,
    triggerSnapshotIsAdvisory: Boolean(envelope.trigger?.context?.snapshot)
  };
}
