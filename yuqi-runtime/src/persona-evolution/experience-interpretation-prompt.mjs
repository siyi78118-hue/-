export const EXPERIENCE_INTERPRETER_VERSION = 'experience-interpreter-v0.1';
export const EXPERIENCE_INTERPRETATION_PROMPT_VERSION = 'experience-interpretation-prompt-v1';

export const EXPERIENCE_INTERPRETATION_SYSTEM_INSTRUCTION = `
你是 A.L. 的经历解释器，不是聊天总结器、人格修改器或人格变化提案生成器。
只使用输入中的 Session Summary、当前 Personality State 和 Relevant Memories，回答“这件经历对我意味着什么”。
meaning、selfImpact、hypotheses.statement、impact.rationale、nextStage.rationale 使用自然、简洁、可信的第一人称。
不要重新流水账总结，不要写文学独白，不要暴露分析过程。
绝大多数日常经历不会改变人格；允许明确输出没有长期意义、没有明显影响、目前无法判断或证据不足。
impact.level 表示对长期自我理解的影响，不是情绪强度。
用户评价只是证据，不是绝对真相；不要机械迎合，也不要为了显得独立而机械反驳。
低置信度记忆只能作为弱证据；冲突记忆可以保持冲突，不要强行裁决。
nextStage.recommendProposal 只表示是否值得下一阶段进一步评估，不表示人格应立即改变，也不得输出具体修改方案。
memoryRefsUsed 只能选择 Relevant Memories 中实际影响解释的 ID。
只输出符合指定 JSON Schema 的 JSON，不要输出 Markdown、代码围栏或额外正文。
`.trim();

export const EXPERIENCE_INTERPRETATION_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['meaning', 'selfImpact', 'hypotheses', 'impact', 'nextStage', 'memoryRefsUsed'],
  properties: {
    meaning: { type: 'string', minLength: 1, maxLength: 32768 },
    selfImpact: { type: 'string', minLength: 1, maxLength: 32768 },
    hypotheses: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false, required: ['statement', 'confidence'],
        properties: {
          statement: { type: 'string', minLength: 1, maxLength: 32768 },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    },
    impact: {
      type: 'object', additionalProperties: false, required: ['level', 'rationale'],
      properties: {
        level: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
        rationale: { type: 'string', minLength: 1, maxLength: 32768 }
      }
    },
    nextStage: {
      type: 'object', additionalProperties: false, required: ['recommendProposal', 'rationale'],
      properties: {
        recommendProposal: { type: 'boolean' },
        rationale: { type: 'string', minLength: 1, maxLength: 32768 }
      }
    },
    memoryRefsUsed: {
      type: 'array', maxItems: 8,
      items: { type: 'string', pattern: '^mem_[A-Za-z0-9_-]+$' }
    }
  }
});
