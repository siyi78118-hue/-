import { createHash } from 'node:crypto';

import { canonicalJson, contentHash } from './protocol.mjs';

const CATEGORY_QUOTAS = Object.freeze({
  daily_chat: Object.freeze({ pool: 6, scored: 3 }),
  emotional_closeness: Object.freeze({ pool: 6, scored: 3 }),
  disagreement_repair: Object.freeze({ pool: 4, scored: 2 }),
  subtext_coquetry: Object.freeze({ pool: 4, scored: 2 }),
  interruption_memory_time: Object.freeze({ pool: 4, scored: 2 }),
});
const HEX64 = /^[0-9a-f]{64}$/;
const POOL_ITEM_KEYS = Object.freeze([
  'candidateId', 'windowId', 'sourceWindowChecksum', 'sceneId',
  'category', 'categoryOrdinal', 'multiBubble',
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} shape conflict`);
  }
}

function frozenClone(value) {
  const clone = structuredClone(value);
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      Object.values(current).forEach(freeze);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(clone);
}

export function validateRealChatCandidatePool(value) {
  exactKeys(value, ['version', 'items'], 'candidate pool');
  if (value.version !== 1 || !Array.isArray(value.items) || value.items.length !== 24) {
    throw new Error('candidate pool category quota conflict');
  }
  const seenCandidateIds = new Set();
  const seenWindowIds = new Set();
  const seenSceneIds = new Set();
  const counts = Object.fromEntries(Object.keys(CATEGORY_QUOTAS).map(key => [key, 0]));
  for (const item of value.items) {
    exactKeys(item, POOL_ITEM_KEYS, 'candidate pool item');
    if (typeof item.candidateId !== 'string' || !item.candidateId
      || typeof item.windowId !== 'string' || !item.windowId
      || typeof item.sceneId !== 'string' || !item.sceneId
      || typeof item.sourceWindowChecksum !== 'string' || !HEX64.test(item.sourceWindowChecksum)
      || !Object.hasOwn(CATEGORY_QUOTAS, item.category)
      || !Number.isSafeInteger(item.categoryOrdinal) || item.categoryOrdinal < 0
      || item.categoryOrdinal >= CATEGORY_QUOTAS[item.category].pool
      || typeof item.multiBubble !== 'boolean') {
      throw new Error('candidate pool item conflict');
    }
    if (seenCandidateIds.has(item.candidateId) || seenWindowIds.has(item.windowId)
      || seenSceneIds.has(item.sceneId)) {
      throw new Error('candidate pool identity conflict');
    }
    seenCandidateIds.add(item.candidateId);
    seenWindowIds.add(item.windowId);
    seenSceneIds.add(item.sceneId);
    counts[item.category] += 1;
  }
  for (const [category, quota] of Object.entries(CATEGORY_QUOTAS)) {
    const ordinals = value.items.filter(item => item.category === category)
      .map(item => item.categoryOrdinal).sort((a, b) => a - b);
    if (counts[category] !== quota.pool
      || ordinals.some((ordinal, index) => ordinal !== index)) {
      throw new Error('candidate pool category quota conflict');
    }
  }
  if (value.items.filter(item => item.multiBubble).length < 2) {
    throw new Error('candidate pool multi-bubble conflict');
  }
  return frozenClone(value);
}

function replacementPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deidentifyRealChatWindow(window, options = {}) {
  if (!window || typeof window !== 'object' || Array.isArray(window)
    || typeof window.windowId !== 'string' || !window.windowId
    || typeof window.sourceWindowChecksum !== 'string' || !HEX64.test(window.sourceWindowChecksum)
    || !Array.isArray(window.turns)) {
    throw new Error('real chat window conflict');
  }
  const replacements = options.replacements || [];
  if (!Array.isArray(replacements) || replacements.some(item => !item
    || typeof item.value !== 'string' || !item.value
    || typeof item.placeholder !== 'string' || !item.placeholder)) {
    throw new Error('de-identification replacements conflict');
  }
  const counters = { phone: 0, email: 0, link: 0 };
  const identities = { phone: new Map(), email: new Map(), link: new Map() };
  const stableReplace = (text, kind, pattern) => text.replace(pattern, raw => {
    if (!identities[kind].has(raw)) {
      counters[kind] += 1;
      identities[kind].set(raw, `[${kind === 'phone' ? '手机号' : kind === 'email' ? '邮箱' : '链接'}${counters[kind]}]`);
    }
    return identities[kind].get(raw);
  });
  const redact = raw => {
    let text = String(raw);
    for (const item of replacements) {
      text = text.replace(new RegExp(replacementPattern(item.value), 'gu'), item.placeholder);
    }
    text = stableReplace(text, 'email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu);
    text = stableReplace(text, 'link', /https?:\/\/[^\s]+/giu);
    text = stableReplace(text, 'phone', /(?<!\d)1[3-9]\d{9}(?!\d)/gu);
    return text;
  };
  const turns = window.turns.map(turn => {
    if (!turn || typeof turn !== 'object' || !Array.isArray(turn.batch)) {
      throw new Error('real chat turn conflict');
    }
    return {
      ...structuredClone(turn),
      batch: turn.batch.map(item => ({
        ...structuredClone(item),
        ...(Object.hasOwn(item, 'text') ? { text: redact(item.text) } : {}),
        ...(Object.hasOwn(item, 'content') ? { content: redact(item.content) } : {}),
      })),
    };
  });
  return frozenClone({ ...structuredClone(window), turns });
}

function normalizeAnswerText(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

function answerHash(value) {
  return createHash('sha256').update(normalizeAnswerText(value), 'utf8').digest('hex');
}

export function classifyAnswerPair(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.answerA !== 'string' || typeof value.answerB !== 'string'
    || !value.answerA.trim() || !value.answerB.trim()) {
    throw new Error('answer pair conflict');
  }
  const normalizedAnswerHashes = { A: answerHash(value.answerA), B: answerHash(value.answerB) };
  if (normalizeAnswerText(value.answerA) === normalizeAnswerText(value.answerB)) {
    return frozenClone({
      version: 1,
      outcome: 'replace_exact',
      checks: {
        semanticStanceDiffers: false,
        concreteContentOrActionDiffers: false,
        feltStyleOrEmotionDiffers: false,
      },
      normalizedAnswerHashes,
    });
  }
  if (!value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) {
    throw new Error('discriminability checks required');
  }
  exactKeys(value.checks, [
    'semanticStanceDiffers', 'concreteContentOrActionDiffers', 'feltStyleOrEmotionDiffers',
  ], 'discriminability checks');
  if (Object.values(value.checks).some(item => typeof item !== 'boolean')) {
    throw new Error('discriminability checks required');
  }
  const outcome = Object.values(value.checks).some(Boolean) ? 'keep' : 'replace_substantive';
  return frozenClone({ version: 1, outcome, checks: value.checks, normalizedAnswerHashes });
}

function replyText(output) {
  if (typeof output === 'string') return output;
  if (typeof output?.reply === 'string') return output.reply;
  if (Array.isArray(output?.replyParts)) {
    return output.replyParts.map(part => String(part?.text || '')).filter(Boolean).join('\n');
  }
  return '';
}

export function selectDiscriminatingPairs({ pool, pairsByCandidateId } = {}) {
  const verified = validateRealChatCandidatePool(pool);
  if (!pairsByCandidateId || typeof pairsByCandidateId !== 'object' || Array.isArray(pairsByCandidateId)) {
    throw new Error('candidate answer pairs required');
  }
  const selected = [];
  const replacements = [];
  for (const [category, quota] of Object.entries(CATEGORY_QUOTAS)) {
    const candidates = verified.items.filter(item => item.category === category)
      .sort((a, b) => a.categoryOrdinal - b.categoryOrdinal);
    let accepted = 0;
    for (const candidate of candidates) {
      if (accepted >= quota.scored) break;
      const pair = pairsByCandidateId[candidate.candidateId];
      if (!pair) continue;
      const classification = classifyAnswerPair(pair);
      if (classification.outcome === 'keep') {
        selected.push(frozenClone({ ...candidate, pair: structuredClone(pair), classification }));
        accepted += 1;
      } else {
        replacements.push(frozenClone({ ...candidate, classification }));
      }
    }
    if (accepted !== quota.scored) throw new Error(`insufficient discriminating pairs for ${category}`);
  }
  if (selected.filter(item => item.multiBubble).length < 2) {
    throw new Error('selected pairs multi-bubble conflict');
  }
  const denominator = selected.length + replacements.length;
  return frozenClone({
    version: 1,
    selected,
    replacements,
    discriminabilityRate: {
      denominator,
      indistinguishable: replacements.length,
      rate: denominator === 0 ? 0 : replacements.length / denominator,
    },
  });
}

function deterministicSwap(seed, candidateId) {
  const hash = createHash('sha256').update(`${seed}\u0000${candidateId}`, 'utf8').digest();
  return (hash[0] & 1) === 1;
}

export function buildSealedBlindPair({ pair, seed } = {}) {
  if (!pair || typeof pair !== 'object' || Array.isArray(pair)
    || typeof pair.candidateId !== 'string' || !pair.candidateId
    || typeof pair.sceneId !== 'string' || !pair.sceneId
    || !Object.hasOwn(CATEGORY_QUOTAS, pair.category)
    || !Array.isArray(pair.contextTurns)
    || !pair.stableOutput || !pair.candidateOutput
    || typeof seed !== 'string' || !seed) {
    throw new Error('sealed blind pair input conflict');
  }
  const swapped = deterministicSwap(seed, pair.candidateId);
  const sides = swapped ? { A: 'candidate', B: 'stable' } : { A: 'stable', B: 'candidate' };
  const sideOutputs = { stable: pair.stableOutput, candidate: pair.candidateOutput };
  const outputChecksums = {
    stable: contentHash(pair.stableOutput),
    candidate: contentHash(pair.candidateOutput),
  };
  const publicPair = {
    version: 1,
    candidateId: pair.candidateId,
    sceneId: pair.sceneId,
    category: pair.category,
    contextTurns: structuredClone(pair.contextTurns),
    outputs: {
      A: structuredClone(sideOutputs[sides.A]),
      B: structuredClone(sideOutputs[sides.B]),
    },
  };
  const mappingBasis = { version: 1, candidateId: pair.candidateId, sides, outputChecksums };
  return frozenClone({
    publicPair,
    sealedMapping: { ...mappingBasis, mappingChecksum: contentHash(mappingBasis) },
  });
}

function renderTurns(turns) {
  return turns.flatMap(turn => (turn.batch || []).map(item => {
    const speaker = turn.speaker === 'assistant' ? '虞栖' : turn.speaker === 'user' ? '用户' : '系统';
    return `- ${speaker}：${String(item.text ?? item.content ?? '')}`;
  })).join('\n');
}

export function buildHumanReviewMarkdown({ pairs } = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error('human review pairs required');
  const sections = pairs.map((pair, index) => {
    exactKeys(pair, ['version', 'candidateId', 'sceneId', 'category', 'contextTurns', 'outputs'], 'public blind pair');
    const answerA = replyText(pair.outputs.A);
    const answerB = replyText(pair.outputs.B);
    if (!answerA || !answerB) throw new Error('human review answer text required');
    return [
      `## 第 ${index + 1} 题`,
      '',
      '### 聊天上下文',
      '',
      renderTurns(pair.contextTurns),
      '',
      '### 回答 A',
      '',
      answerA,
      '',
      '### 回答 B',
      '',
      answerB,
      '',
      '1. 总体更喜欢哪一个：____（A / B / 差不多）',
      '2. 哪个更像真人在微信里会回的话：____（A / B / 差不多）',
      '3. 哪个更懂用户真正想表达的意思：____（A / B / 差不多）',
      '4. 哪个更像虞栖本人，而不是通用温柔 AI：____（A / B / 差不多）',
      '5. 哪个更让人想继续聊下去：____（A / B / 差不多）',
      '6. 明显问题（分别填写 A / B）：答非所问、编造事实、客服/心理咨询腔、分析过度、动作或对象弄错、没有明显问题。',
      '',
      '- A：____',
      '- B：____',
    ].join('\n');
  });
  return [
    '# 虞栖真实聊天盲评卷',
    '',
    '请只根据聊天体验填写。回答 A/B 的版本身份会在你完成全部题目后才揭晓。',
    '',
    ...sections,
    '',
  ].join('\n');
}

export { CATEGORY_QUOTAS };
