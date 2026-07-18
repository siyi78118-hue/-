import { commitVerifiedFacts } from './evidence-memory.mjs';
import { contentHash } from './protocol.mjs';
import { buildEvidencePack } from './retrieval.mjs';

const BACKSTAGE_LEAK = /\bAI\b|人工智能|语言模型|大模型|提示词|记忆库|系统指令|内部思考|作为.{0,8}模型/i;

function parseRoleJson(text, role) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(source); } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${role} returned invalid object`);
  return value;
}

export function hardValidateReply(reply) {
  const issues = [];
  const text = String(reply || '').trim();
  if (!text) issues.push({ code: 'EMPTY_REPLY', message: 'reply is empty' });
  if (text.length > 20_000) issues.push({ code: 'REPLY_TOO_LARGE', message: 'reply is too large' });
  if (BACKSTAGE_LEAK.test(text)) issues.push({ code: 'BACKSTAGE_LEAK', message: 'reply exposes backstage concepts' });
  return { ok: issues.length === 0, issues };
}

export class YuqiOrchestrator {
  constructor({ store, presets, codex, workerId = 'yuqi-worker', clock = Date.now, contextLimit = 200 }) {
    if (!store || !presets || !codex) throw new Error('store, presets, and codex are required');
    this.store = store;
    this.presets = presets;
    this.codex = codex;
    this.workerId = workerId;
    this.clock = clock;
    this.contextLimit = Math.max(1, Math.min(5000, Number(contextLimit) || 200));
  }

  async process(envelope) {
    const submitted = this.store.submitTurn(envelope);
    if (submitted.state === 'committed' && submitted.replyJson) return JSON.parse(submitted.replyJson);
    if (submitted.state !== 'queued') throw new Error(`turn is already ${submitted.state}`);
    const claimed = this.store.claimTurnById(submitted.turnId, this.workerId);
    if (!claimed) throw new Error('turn could not be claimed');

    try {
      const recentMessages = this.store.listMessages(envelope.characterId, this.contextLimit);
      const memoryRequest = {
        task: 'retrieve_and_extract_evidence',
        preset: this.presets.compileFor('memory', { stage: 'initial' }),
        currentMessageId: envelope.message.messageId,
        recentMessages
      };
      const memoryResult = parseRoleJson((await this.codex.runTurn('memory', JSON.stringify(memoryRequest), {
        clientUserMessageId: `${envelope.turnId}_memory`
      })).text, 'memory');
      const candidates = Array.isArray(memoryResult.candidates) ? memoryResult.candidates : [];
      const committedFacts = commitVerifiedFacts(this.store, candidates, recentMessages);
      const memoryPacket = {
        query: String(memoryResult.query || envelope.message.content),
        keywords: Array.isArray(memoryResult.keywords) ? memoryResult.keywords.map(String) : [],
        committedFacts: {
          verified: committedFacts.verified.map(item => item.fact.factId),
          provisional: committedFacts.provisional.map(item => item.fact.factId),
          rejected: committedFacts.rejected.map(item => item.fact?.factId || null).filter(Boolean)
        }
      };
      this.store.advanceTurn(envelope.turnId, 'memory_running', 'memory_done', {
        memoryPacketJson: JSON.stringify(memoryPacket)
      });

      const evidencePack = buildEvidencePack(this.store, {
        characterId: envelope.characterId,
        query: memoryPacket.query,
        keywords: memoryPacket.keywords,
        limit: 12
      });
      let brainRequest = {
        task: 'reply_as_yuqi',
        preset: this.presets.compileFor('brain', {
          stage: 'initial',
          revealedFactIds: evidencePack.facts.map(fact => fact.factId)
        }),
        currentUserMessage: envelope.message,
        recentMessages,
        evidencePack
      };
      this.store.advanceTurn(envelope.turnId, 'memory_done', 'brain_running');
      let draft = await this.runBrain(envelope.turnId, brainRequest);
      this.store.advanceTurn(envelope.turnId, 'brain_running', 'brain_done', {
        brainDraftJson: JSON.stringify(draft)
      });

      let supervisorResult;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const hard = hardValidateReply(draft.reply);
        if (!hard.ok) throw new Error(`hard validation failed: ${hard.issues.map(issue => issue.code).join(', ')}`);
        this.store.advanceTurn(envelope.turnId, 'brain_done', 'supervisor_running');
        const supervisorRequest = {
          task: 'review_yuqi_reply',
          preset: this.presets.compileFor('supervisor', { stage: 'initial' }),
          currentUserMessage: envelope.message,
          evidencePack,
          draft
        };
        supervisorResult = parseRoleJson((await this.codex.runTurn('supervisor', JSON.stringify(supervisorRequest), {
          clientUserMessageId: `${envelope.turnId}_supervisor_${attempt + 1}`
        })).text, 'supervisor');
        if (supervisorResult.approved === true) break;
        if (attempt === 1) throw new Error('supervisor rejected reply twice');
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'brain_running', {
          supervisorJson: JSON.stringify(supervisorResult)
        });
        brainRequest = {
          ...brainRequest,
          task: 'rewrite_as_yuqi',
          rejectedDraft: draft,
          supervisorIssues: Array.isArray(supervisorResult.issues) ? supervisorResult.issues : []
        };
        draft = await this.runBrain(envelope.turnId, brainRequest, 2);
        this.store.advanceTurn(envelope.turnId, 'brain_running', 'brain_done', {
          brainDraftJson: JSON.stringify(draft)
        });
      }

      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify(supervisorResult)
      });
      const reply = {
        messageId: `msg_yuqi_${contentHash(envelope.turnId).slice(0, 24)}`,
        turnId: envelope.turnId,
        characterId: envelope.characterId,
        speakerId: envelope.characterId,
        speakerType: 'character',
        recipientId: 'user',
        content: draft.reply.trim(),
        sentAt: this.clock(),
        origin: 'codex'
      };
      this.store.putMessage(reply);
      const result = {
        turnId: envelope.turnId,
        presetVersion: this.presets.current().version,
        reply,
        usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : []
      };
      this.store.advanceTurn(envelope.turnId, 'approved', 'committed', {
        replyJson: JSON.stringify(result)
      });
      return result;
    } catch (error) {
      const current = this.store.getTurn(envelope.turnId);
      if (current && !['committed', 'delivered', 'completed', 'failed'].includes(current.state)) {
        try {
          this.store.advanceTurn(envelope.turnId, current.state, 'failed', {
            errorJson: JSON.stringify({ name: error.name, message: error.message })
          });
        } catch {}
      }
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: current?.state || 'unknown',
        level: 'error',
        detail: { name: error.name, message: error.message }
      });
      throw error;
    }
  }

  cancel(turnId) {
    const current = this.store.getTurn(turnId);
    if (!current || ['committed', 'delivered', 'completed', 'failed'].includes(current.state)) return false;
    this.store.advanceTurn(turnId, current.state, 'failed', {
      errorJson: JSON.stringify({ name: 'CancelledError', message: 'turn cancelled by device' })
    });
    return true;
  }

  async runBrain(turnId, request, attempt = 1) {
    const result = parseRoleJson((await this.codex.runTurn('brain', JSON.stringify(request), {
      clientUserMessageId: `${turnId}_brain_${attempt}`
    })).text, 'brain');
    if (typeof result.reply !== 'string') throw new Error('brain reply is missing');
    return result;
  }
}
