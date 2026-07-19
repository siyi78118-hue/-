import { commitVerifiedFacts } from './evidence-memory.mjs';
import { contentHash } from './protocol.mjs';
import { buildEvidencePack } from './retrieval.mjs';
import { ROLE_OUTPUT_SCHEMAS } from './role-schemas.mjs';

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

  accept(envelope) {
    return this.store.submitTurn(envelope);
  }

  async process(envelope) {
    const submitted = this.accept(envelope);
    return this.run(submitted.turnId);
  }

  async run(turnId) {
    let current = this.store.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state === 'committed' && current.replyJson) return JSON.parse(current.replyJson);
    if (['delivered', 'completed'].includes(current.state) && current.replyJson) return JSON.parse(current.replyJson);
    if (['failed', 'fallback'].includes(current.state)) throw new Error(`turn is already ${current.state}`);
    const envelope = JSON.parse(current.envelopeJson);

    try {
      for (let step = 0; step < 12; step += 1) {
        current = this.store.getTurn(turnId);
        if (current.state === 'queued') {
          current = this.store.claimTurnById(turnId, this.workerId);
          if (!current) throw new Error('turn could not be claimed');
          continue;
        }
        if (current.state === 'memory_running') {
          await this.completeMemory(envelope);
          continue;
        }
        if (current.state === 'memory_done') {
          this.store.advanceTurn(turnId, 'memory_done', 'brain_running');
          continue;
        }
        if (current.state === 'brain_running') {
          await this.completeBrain(envelope, current);
          continue;
        }
        if (current.state === 'brain_done') {
          const draft = parseRoleJson(current.brainDraftJson, 'brain');
          const hard = hardValidateReply(draft.reply);
          if (!hard.ok) throw new Error(`hard validation failed: ${hard.issues.map(issue => issue.code).join(', ')}`);
          this.store.advanceTurn(turnId, 'brain_done', 'supervisor_running');
          continue;
        }
        if (current.state === 'supervisor_running') {
          await this.completeSupervisor(envelope, current);
          continue;
        }
        if (current.state === 'approved') return this.commitApproved(envelope, current);
        if (current.state === 'committed' && current.replyJson) return JSON.parse(current.replyJson);
        throw new Error(`turn cannot resume from ${current.state}`);
      }
      throw new Error('turn exceeded orchestration step limit');
    } catch (error) {
      current = this.store.getTurn(turnId);
      if (current && !['committed', 'delivered', 'completed', 'failed'].includes(current.state)) {
        try {
          this.store.advanceTurn(turnId, current.state, 'failed', {
            errorJson: JSON.stringify({ name: error.name, message: error.message })
          });
        } catch {}
      }
      this.store.putDiagnostic({
        turnId,
        stage: current?.state || 'unknown',
        level: 'error',
        detail: { name: error.name, message: error.message }
      });
      throw error;
    }
  }

  async completeMemory(envelope) {
    const recentMessages = this.store.listMessages(envelope.characterId, this.contextLimit);
    const memoryRequest = {
      task: envelope.message ? 'retrieve_and_extract_evidence' : 'retrieve_context_for_trigger',
      preset: this.presets.compileFor('memory', { stage: 'initial' }),
      ...(envelope.message
        ? { currentMessageId: envelope.message.messageId }
        : { currentTrigger: envelope.trigger, triggerIsNotUserEvidence: true }),
      recentMessages
    };
    const memoryResult = await this.runStructuredRole(
      'memory', memoryRequest, `${envelope.turnId}_memory`
    );
    const candidates = Array.isArray(memoryResult.candidates) ? memoryResult.candidates : [];
    const committedFacts = commitVerifiedFacts(this.store, candidates, recentMessages);
    const memoryPacket = {
      query: String(memoryResult.query || envelope.message?.content || envelope.trigger?.triggerType || ''),
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
  }

  async completeBrain(envelope, current) {
    const recentMessages = this.store.listMessages(envelope.characterId, this.contextLimit);
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    const evidencePack = buildEvidencePack(this.store, {
      characterId: envelope.characterId,
      query: memoryPacket.query,
      keywords: memoryPacket.keywords,
      limit: 12
    });
    const previousSupervisor = current.supervisorJson ? parseRoleJson(current.supervisorJson, 'supervisor') : null;
    const previousDraft = current.brainDraftJson ? parseRoleJson(current.brainDraftJson, 'brain') : null;
    const brainRequest = {
      task: previousSupervisor?.approved === false ? 'rewrite_as_yuqi' : 'reply_as_yuqi',
      preset: this.presets.compileFor('brain', {
        stage: 'initial',
        revealedFactIds: evidencePack.facts.map(fact => fact.factId)
      }),
      ...(envelope.message ? { currentUserMessage: envelope.message } : { currentTrigger: envelope.trigger }),
      recentMessages,
      evidencePack,
      ...(previousSupervisor?.approved === false ? {
        rejectedDraft: previousDraft,
        supervisorIssues: Array.isArray(previousSupervisor.issues) ? previousSupervisor.issues : []
      } : {})
    };
    const attempt = previousSupervisor?.approved === false ? 2 : 1;
    const draft = await this.runBrain(envelope.turnId, brainRequest, attempt);
    this.store.advanceTurn(envelope.turnId, 'brain_running', 'brain_done', {
      brainDraftJson: JSON.stringify(draft)
    });
  }

  async completeSupervisor(envelope, current) {
    const draft = parseRoleJson(current.brainDraftJson, 'brain');
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    const evidencePack = buildEvidencePack(this.store, {
      characterId: envelope.characterId,
      query: memoryPacket.query,
      keywords: memoryPacket.keywords,
      limit: 12
    });
    const previous = current.supervisorJson ? parseRoleJson(current.supervisorJson, 'supervisor') : null;
    const attempt = Number(previous?.attempt || 0) + 1;
    const supervisorRequest = {
      task: 'review_yuqi_reply',
      preset: this.presets.compileFor('supervisor', { stage: 'initial' }),
      ...(envelope.message ? { currentUserMessage: envelope.message } : { currentTrigger: envelope.trigger }),
      evidencePack,
      draft
    };
    const reviewed = await this.runStructuredRole(
      'supervisor', supervisorRequest, `${envelope.turnId}_supervisor_${attempt}`
    );
    const supervisorResult = { ...reviewed, attempt };
    if (supervisorResult.approved === true) {
      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify(supervisorResult)
      });
      return;
    }
    if (attempt >= 2) throw new Error('supervisor rejected reply twice');
    this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'brain_running', {
      supervisorJson: JSON.stringify(supervisorResult)
    });
  }

  commitApproved(envelope, current) {
    const draft = parseRoleJson(current.brainDraftJson, 'brain');
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
    const result = await this.runStructuredRole('brain', request, `${turnId}_brain_${attempt}`);
    if (typeof result.reply !== 'string') throw new Error('brain reply is missing');
    return result;
  }

  async runStructuredRole(role, request, clientUserMessageId) {
    let invalidOutput = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const payload = attempt === 1 ? request : {
        ...request,
        protocolRepair: {
          attempt,
          rule: 'Return exactly one JSON object that matches the supplied output schema.',
          invalidOutput: invalidOutput.slice(0, 2_000)
        }
      };
      const response = await this.codex.runTurn(role, JSON.stringify(payload), {
        clientUserMessageId: attempt === 1 ? clientUserMessageId : `${clientUserMessageId}_protocol_${attempt}`,
        outputSchema: ROLE_OUTPUT_SCHEMAS[role],
        model: 'gpt-5.6-sol',
        effort: 'high'
      });
      invalidOutput = String(response.text || '');
      try {
        return parseRoleJson(invalidOutput, role);
      } catch (error) {
        if (attempt === 2 || !String(error.message).startsWith(`${role} returned invalid`)) throw error;
      }
    }
    throw new Error(`${role} returned invalid structured output twice`);
  }
}
