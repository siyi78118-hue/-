function messageIdOf(message) {
  return String(message?.messageId || '');
}

function orderedUnique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '');
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function safeAttachmentReference(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const { dataUrl, base64, bytes, localPath, absolutePath, ...reference } = attachment;
  return reference;
}

function interactionMessage(message) {
  const type = String(message?.messageType || message?.type || message?.kind || 'text');
  const content = String(message?.content || message?.text || '');
  const transcript = String(message?.transcript || message?.voiceTranscript || '');
  return {
    messageId: messageIdOf(message),
    type,
    text: content,
    transcript,
    quote: message?.quote || message?.quoteRef || null,
    payment: message?.payment || null,
    attachments: (Array.isArray(message?.attachments) ? message.attachments : [])
      .map(safeAttachmentReference)
      .filter(Boolean)
  };
}

export function resolveCurrentUserBatch(envelope, availableMessages = []) {
  if (!envelope?.message) return null;

  const sourceMessage = envelope.message;
  const sourceMessageId = messageIdOf(sourceMessage);
  const supplied = envelope.context?.currentBatch;
  const suppliedIds = Array.isArray(supplied?.messageIds) ? supplied.messageIds : [];
  const messageIds = orderedUnique([
    ...suppliedIds,
    ...(sourceMessageId ? [sourceMessageId] : [])
  ]);
  const suppliedMessages = Array.isArray(supplied?.messages) ? supplied.messages : [];
  const byId = new Map();
  for (const message of Array.isArray(availableMessages) ? availableMessages : []) {
    const messageId = messageIdOf(message);
    if (messageId) byId.set(messageId, message);
  }
  if (sourceMessageId) byId.set(sourceMessageId, sourceMessage);
  for (const message of suppliedMessages) {
    const messageId = messageIdOf(message);
    if (messageId) byId.set(messageId, message);
  }

  const messages = messageIds.map(messageId => byId.get(messageId)).filter(Boolean);
  const resolvedIds = new Set(messages.map(messageIdOf));
  const missingMessageIds = messageIds.filter(messageId => !resolvedIds.has(messageId));
  const startedAt = Number(supplied?.startedAt || messages[0]?.sentAt || sourceMessage.sentAt || envelope.createdAt);
  const committedAt = Number(supplied?.committedAt || envelope.createdAt || sourceMessage.sentAt);

  return {
    batchId: String(supplied?.batchId || `batch_${sourceMessageId}`),
    sourceMessageId,
    messageIds,
    startedAt,
    committedAt,
    messages,
    combinedText: messages.map(message => String(message?.content || '').trim()).filter(Boolean).join('\n'),
    complete: missingMessageIds.length === 0,
    missingMessageIds
  };
}

export function currentUserBatchForRole(batch) {
  if (!batch) return null;
  return {
    batchId: batch.batchId,
    sourceMessageId: batch.sourceMessageId,
    startedAt: batch.startedAt,
    committedAt: batch.committedAt,
    messages: batch.messages
  };
}

export function currentUserInteractionForCognition(batch) {
  if (!batch) return { batchId: '', sourceMessageId: '', messages: [] };
  return {
    batchId: String(batch.batchId || ''),
    sourceMessageId: String(batch.sourceMessageId || ''),
    startedAt: Number(batch.startedAt || 0),
    committedAt: Number(batch.committedAt || 0),
    complete: batch.complete !== false,
    missingMessageIds: [...(batch.missingMessageIds || [])],
    messages: (batch.messages || []).map(interactionMessage)
  };
}
