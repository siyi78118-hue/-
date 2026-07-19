import { commitVerifiedFacts } from './evidence-memory.mjs';
import { contentHash } from './protocol.mjs';

function parseRoleJson(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('memory recovery returned invalid JSON');
  return value;
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
    if (entry.checksum !== contentHash(entry.payload)) throw new Error(`sync checksum mismatch at ${entry.seq}`);
  }
}

export class YuqiReconciler {
  constructor({ store, codex }) {
    if (!store || !codex) throw new Error('store and codex are required');
    this.store = store;
    this.codex = codex;
  }

  async reconcileFrom({ peerId, lastCommonSeq = 0, entries = [] }) {
    if (!/^[A-Za-z0-9:_-]{3,128}$/.test(String(peerId || ''))) throw new Error('invalid peerId');
    const declaredCommon = Math.max(0, Number(lastCommonSeq) || 0);
    if (declaredCommon > this.store.getSyncCursor(peerId)) this.store.ackSync(peerId, declaredCommon);
    const ordered = [...entries].sort((left, right) => Number(left.seq) - Number(right.seq));
    validateEntries(ordered);
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

    try {
      if (fallbackTurns.length) {
        const exactRawMessages = pending
          .filter(entry => entry.entityType === 'message' && fallbackTurns.includes(entry.payload?.turnId))
          .map(entry => this.store.getMessage(entry.entityId))
          .filter(Boolean);
        const response = await this.codex.runTurn('memory', JSON.stringify({
          task: 'reconcile_fallback_memory_only',
          rule: 'Read exact raw messages, preserve speaker attribution, and propose evidence-backed facts. Do not draft or resend a chat reply.',
          fallbackTurnIds: fallbackTurns,
          exactRawMessages
        }), {
          clientUserMessageId: `reconcile_${peerId}_${pending.at(-1).seq}`,
          model: 'gpt-5.6-sol',
          effort: 'medium'
        });
        const parsed = parseRoleJson(response.text);
        commitVerifiedFacts(this.store, Array.isArray(parsed.candidates) ? parsed.candidates : [], exactRawMessages);
      }
    } catch (error) {
      this.store.putDiagnostic({
        stage: 'fallback_reconciliation',
        level: 'error',
        detail: { peerId, fromSeq: acknowledged + 1, toSeq: pending.at(-1).seq, message: error.message }
      });
      throw error;
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
