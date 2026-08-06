import { createHash } from 'node:crypto';

import { canonicalJson, contentHash } from './protocol.mjs';

function legacyAndroidContentHash(value) {
  return createHash('sha256')
    .update(canonicalJson(value).replaceAll('/', '\\/'), 'utf8')
    .digest('hex');
}

function validateEntries(entries) {
  const seen = new Set();
  let previous = -1;
  for (const entry of entries) {
    if (!Number.isSafeInteger(Number(entry?.seq)) || Number(entry.seq) < 1) throw new Error('invalid sync sequence');
    if (Number(entry.seq) <= previous) throw new Error('sync entries must be strictly ordered');
    previous = Number(entry.seq);
    if (seen.has(entry.seq)) throw new Error('duplicate sync sequence');
    seen.add(entry.seq);
    if (!['message', 'annotation'].includes(entry.entityType)) continue;
    const checksum = String(entry.checksum || '');
    if (checksum !== contentHash(entry.payload) && checksum !== legacyAndroidContentHash(entry.payload)) {
      throw new Error(`sync checksum mismatch at ${entry.seq}`);
    }
  }
}

export function normalizeRecoverySnapshot(value, { expectedDeviceId = null } = {}) {
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',')
    : '';
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['entries,lastCommonSeq,peerId', 'entries,lastCommonSeq,lastSeq,peerId'].includes(keys)
    || typeof value.peerId !== 'string'
    || !/^[A-Za-z0-9:_-]{3,128}$/.test(value.peerId)
    || !Number.isSafeInteger(value.lastCommonSeq) || value.lastCommonSeq < 0
    || !Array.isArray(value.entries)) {
    throw new Error('invalid recovery snapshot');
  }
  if (expectedDeviceId !== null && value.peerId !== expectedDeviceId) {
    throw new Error('recovery peer must match envelope device');
  }
  const entries = structuredClone(value.entries)
    .sort((left, right) => Number(left.seq) - Number(right.seq));
  validateEntries(entries);
  if (Object.hasOwn(value, 'lastSeq')) {
    const expectedLastSeq = Math.max(value.lastCommonSeq, ...entries.map(entry => Number(entry.seq)));
    if (!Number.isSafeInteger(value.lastSeq) || value.lastSeq < 0 || value.lastSeq !== expectedLastSeq) {
      throw new Error('invalid recovery snapshot');
    }
  }
  return {
    peerId: value.peerId,
    lastCommonSeq: value.lastCommonSeq,
    entries
  };
}

export class YuqiReconciler {
  constructor({ store, codex }) {
    if (!store || !codex) throw new Error('store and codex are required');
    this.store = store;
    this.codex = codex;
  }

  async importExternalVisibleReceiptInternal(receipt) {
    const result = this.store.importExternalVisibleReceiptInternal(receipt);
    const semantic = receipt?.semantic;
    const peerId = String(semantic?.deviceId || '');
    const ackSeq = Number(semantic?.journalSyncSeq);
    if (!peerId || !Number.isSafeInteger(ackSeq) || ackSeq < 1) {
      throw new Error('external authority receipt sync identity conflict');
    }
    this.store.ackSync(peerId, ackSeq);
    return { ...result, peerId, ackSeq: this.store.getSyncCursor(peerId) };
  }

  async reconcileFrom(rawRecovery) {
    const { peerId, lastCommonSeq: declaredCommon, entries: ordered } = normalizeRecoverySnapshot(rawRecovery);
    if (declaredCommon > this.store.getSyncCursor(peerId)) this.store.ackSync(peerId, declaredCommon);
    const acknowledged = this.store.getSyncCursor(peerId);
    const pending = ordered.filter(entry => Number(entry.seq) > acknowledged);
    if (!pending.length) {
      return {
        peerId,
        ackSeq: acknowledged,
        importedMessages: 0,
        importedAnnotations: 0,
        reconciledFallbackTurns: [],
        suppressedReplies: 0,
        deliverReplies: []
      };
    }

    const imported = [];
    const importedAnnotations = [];
    for (const entry of pending) {
      if (entry.entityType === 'annotation' && entry.operation !== 'delete') {
        const existing = this.store.getAnnotation(entry.entityId);
        const saved = this.store.putAnnotation(entry.payload);
        if (!existing) importedAnnotations.push(saved);
        continue;
      }
      if (entry.entityType !== 'message' || entry.operation === 'delete') continue;
      const before = this.store.getMessage(entry.entityId);
      const saved = this.store.putMessage(entry.payload);
      if (!before) imported.push(saved);
    }

    const fallbackReplies = imported.filter(message =>
      message.speakerType === 'character'
      && ['fallback', 'legacy_fallback'].includes(message.origin)
    );
    const fallbackTurns = [...new Set(fallbackReplies.map(message => message.turnId))];
    let suppressedReplies = 0;
    for (const reply of fallbackReplies) {
      suppressedReplies += this.store.suppressCompetingReplies(reply.turnId, reply.messageId);
    }

    for (const fallbackTurnId of fallbackTurns) {
      const messageIds = pending
        .filter(entry => entry.entityType === 'message' && entry.payload?.turnId === fallbackTurnId)
        .map(entry => String(entry.entityId));
      this.store.createConsolidationJobInternal({
        subjectType: 'turn',
        subjectId: fallbackTurnId,
        turnId: fallbackTurnId,
        roleId: 'yuqi',
        jobType: 'turn_consolidation',
        dueAt: Date.now(),
        payload: {
          turnId: fallbackTurnId,
          messageIds,
          evidenceSource: 'fallback_provisional',
          reconcilePeerId: peerId
        }
      });
    }

    const ackSeq = Number(pending.at(-1).seq);
    this.store.ackSync(peerId, ackSeq);
    return {
      peerId,
      ackSeq,
      importedMessages: imported.length,
      importedAnnotations: importedAnnotations.length,
      reconciledFallbackTurns: fallbackTurns,
      suppressedReplies,
      deliverReplies: []
    };
  }
}
