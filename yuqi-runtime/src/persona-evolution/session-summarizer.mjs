import { createHash } from 'node:crypto';

import { validateSessionSummaryOutput } from './session-summary-generator.mjs';
import { SESSION_SUMMARIZER_VERSION, SESSION_SUMMARY_PROMPT_VERSION } from './session-summary-prompt.mjs';

function canonicalSource(messages) {
  return messages.map(item => ({
    id: item.id,
    speaker: item.speaker,
    content: item.content,
    createdAt: item.createdAt
  }));
}

export function createSessionSourceDigest(messages) {
  return createHash('sha256').update(JSON.stringify(canonicalSource(messages)), 'utf8').digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function chunkMessages(messages, maxInputBytes) {
  const chunks = [];
  let current = [];
  for (const message of messages) {
    if (current.length && byteLength([...current, message]) > maxInputBytes) {
      chunks.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export class SessionSummarizer {
  constructor({ repository, generator, maxInputBytes = 64 * 1024, logger = null } = {}) {
    if (!repository?.putSessionSummaryForSession || !repository?.getSessionSummaryBySourceSessionId) {
      throw new Error('session summary repository is required');
    }
    if (!generator?.generate) throw new Error('session summary generator is required');
    if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 256) throw new Error('maxInputBytes is invalid');
    this.repository = repository;
    this.generator = generator;
    this.maxInputBytes = maxInputBytes;
    this.logger = logger;
    this.inFlight = new Map();
  }

  log(event, fields) {
    this.logger?.({ event, ...fields });
  }

  finalizeSession(session) {
    return this.summarizeSession(session);
  }

  summarizeSession(session) {
    const key = `${session?.roleId || ''}\0${session?.sessionId || ''}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.#summarize(session).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  async #summarize(session) {
    const started = Date.now();
    const messages = canonicalSource(session.messages || []);
    if (!session?.roleId || !session.conversationId || !session.sessionId || !messages.length) {
      throw new Error('session summary input is invalid');
    }
    const sourceDigest = createSessionSourceDigest(messages);
    const fields = { roleId: session.roleId, sessionId: session.sessionId, messageCount: messages.length };
    const existing = await this.repository.getSessionSummaryBySourceSessionId(session.roleId, session.sessionId);
    if (existing?.sourceDigest === sourceDigest) {
      this.log('skipped_existing', { ...fields, durationMs: Date.now() - started });
      return { status: 'unchanged', summaryId: existing.id, revision: existing.revision };
    }
    this.log('started', { ...fields, durationMs: 0 });
    try {
      const base = {
        sessionId: session.sessionId,
        roleId: session.roleId,
        startedAt: session.startedAt,
        endedAt: session.endedAt
      };
      const chunks = chunkMessages(messages, this.maxInputBytes);
      let generated;
      if (chunks.length === 1) {
        generated = validateSessionSummaryOutput(await this.generator.generate({ ...base, messages }));
      } else {
        const chunkSummaries = [];
        for (let index = 0; index < chunks.length; index += 1) {
          chunkSummaries.push(validateSessionSummaryOutput(await this.generator.generate({
            ...base, mode: 'chunk', chunkIndex: index, chunkCount: chunks.length, messages: chunks[index]
          })));
        }
        generated = validateSessionSummaryOutput(await this.generator.generate({
          ...base, mode: 'merge', sourceMessageIds: messages.map(item => item.id), chunkSummaries
        }));
      }
      const stored = await this.repository.putSessionSummaryForSession(session.roleId, {
        sourceSessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        sourceMessageIds: messages.map(item => item.id),
        sourceDigest,
        ...generated,
        generation: {
          summarizerVersion: SESSION_SUMMARIZER_VERSION,
          promptVersion: SESSION_SUMMARY_PROMPT_VERSION,
          model: String(this.generator.model || 'unknown')
        }
      });
      this.log(stored.status === 'updated' ? 'regenerated' : 'completed', {
        ...fields, durationMs: Date.now() - started
      });
      return { status: stored.status, summaryId: stored.entity.id, revision: stored.entity.revision };
    } catch (error) {
      this.log('failed', { ...fields, durationMs: Date.now() - started, error: error?.name || 'Error' });
      throw error;
    }
  }
}
