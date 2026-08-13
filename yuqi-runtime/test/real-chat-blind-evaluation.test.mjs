import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHumanReviewMarkdown,
  buildSealedBlindPair,
  classifyAnswerPair,
  deidentifyRealChatWindow,
  selectDiscriminatingPairs,
  validateRealChatCandidatePool,
} from '../src/real-chat-blind-evaluation.mjs';

const CATEGORY_COUNTS = Object.freeze({
  daily_chat: 6,
  emotional_closeness: 6,
  disagreement_repair: 4,
  subtext_coquetry: 4,
  interruption_memory_time: 4,
});

function candidatePool() {
  const items = [];
  for (const [category, count] of Object.entries(CATEGORY_COUNTS)) {
    for (let index = 0; index < count; index += 1) {
      items.push({
        candidateId: `${category}_${index + 1}`,
        windowId: `window_${category}_${index + 1}`,
        sourceWindowChecksum: String(index + 1).padStart(64, 'a'),
        sceneId: `real_chat_${category}_${index + 1}`,
        category,
        categoryOrdinal: index,
        multiBubble: (category === 'daily_chat' && index <= 1)
          || (category === 'emotional_closeness' && index <= 1),
      });
    }
  }
  return { version: 1, items };
}

test('candidate pool freezes 24 items with exact category quotas and two multi-bubble inputs', () => {
  const pool = validateRealChatCandidatePool(candidatePool());
  assert.equal(pool.items.length, 24);
  assert.equal(pool.items.filter(item => item.multiBubble).length >= 2, true);
  assert.deepEqual(Object.fromEntries(Object.keys(CATEGORY_COUNTS).map(category => [
    category,
    pool.items.filter(item => item.category === category).length,
  ])), CATEGORY_COUNTS);

  const duplicate = structuredClone(candidatePool());
  duplicate.items[1].windowId = duplicate.items[0].windowId;
  assert.throws(() => validateRealChatCandidatePool(duplicate), /candidate pool identity conflict/);
  const wrongQuota = structuredClone(candidatePool());
  wrongQuota.items.pop();
  assert.throws(() => validateRealChatCandidatePool(wrongQuota), /candidate pool category quota conflict/);
});

test('de-identification replaces configured names and common direct identifiers without changing bubble order', () => {
  const window = {
    windowId: 'history_window_001',
    sourceWindowChecksum: 'a'.repeat(64),
    turns: [
      { speaker: 'user', batch: [
        { messageId: 'm1', type: 'text', text: '小周，我手机号是 13812345678' },
        { messageId: 'm2', type: 'text', text: '邮箱 a.person@example.com，网址 https://example.com/a' },
      ] },
      { speaker: 'assistant', batch: [
        { messageId: 'm3', type: 'text', text: '知道了，小周。' },
      ] },
    ],
  };
  const redacted = deidentifyRealChatWindow(window, {
    replacements: [{ value: '小周', placeholder: '[称呼1]' }],
  });
  assert.deepEqual(redacted.turns.map(turn => turn.batch.map(item => item.messageId)), [['m1', 'm2'], ['m3']]);
  assert.match(redacted.turns[0].batch[0].text, /^\[称呼1\]，我手机号是 \[手机号1\]$/);
  assert.equal(redacted.turns[0].batch[1].text, '邮箱 [邮箱1]，网址 [链接1]');
  assert.equal(redacted.turns[1].batch[0].text, '知道了，[称呼1]。');
  assert.equal(JSON.stringify(redacted).includes('13812345678'), false);
  assert.equal(JSON.stringify(redacted).includes('example.com'), false);
});

test('answer discriminability replaces exact and substantively identical pairs but keeps one felt difference', () => {
  assert.equal(classifyAnswerPair({
    answerA: '嗯。\n我知道了',
    answerB: ' 嗯。  我知道了 ',
  }).outcome, 'replace_exact');

  assert.equal(classifyAnswerPair({
    answerA: '我在。你慢慢说。',
    answerB: '你慢慢说，我在呢。',
    checks: {
      semanticStanceDiffers: false,
      concreteContentOrActionDiffers: false,
      feltStyleOrEmotionDiffers: false,
    },
  }).outcome, 'replace_substantive');

  assert.equal(classifyAnswerPair({
    answerA: '我在。',
    answerB: '先别说了，我现在不想聊。',
    checks: {
      semanticStanceDiffers: true,
      concreteContentOrActionDiffers: false,
      feltStyleOrEmotionDiffers: true,
    },
  }).outcome, 'keep');
  assert.throws(() => classifyAnswerPair({ answerA: '甲', answerB: '乙' }), /discriminability checks required/);
});

test('selection follows frozen same-category order and records replacements outside the twelve-item denominator', () => {
  const pool = candidatePool();
  const pairsByCandidateId = {};
  for (const item of pool.items) {
    pairsByCandidateId[item.candidateId] = {
      answerA: `A-${item.candidateId}`,
      answerB: `B-${item.candidateId}`,
      checks: {
        semanticStanceDiffers: true,
        concreteContentOrActionDiffers: false,
        feltStyleOrEmotionDiffers: false,
      },
    };
  }
  pairsByCandidateId.daily_chat_1 = { answerA: '一样', answerB: ' 一样 ' };
  pairsByCandidateId.emotional_closeness_1 = {
    answerA: '我在。', answerB: '我在呢。',
    checks: {
      semanticStanceDiffers: false,
      concreteContentOrActionDiffers: false,
      feltStyleOrEmotionDiffers: false,
    },
  };
  const selected = selectDiscriminatingPairs({ pool, pairsByCandidateId });
  assert.equal(selected.selected.length, 12);
  assert.deepEqual(selected.replacements.map(item => item.candidateId), [
    'daily_chat_1', 'emotional_closeness_1',
  ]);
  assert.equal(selected.selected.some(item => item.candidateId === 'daily_chat_4'), true);
  assert.equal(selected.selected.some(item => item.candidateId === 'emotional_closeness_4'), true);
  assert.equal(selected.selected.filter(item => item.multiBubble).length >= 2, true);
  assert.equal(selected.discriminabilityRate.denominator, 14);
  assert.equal(selected.discriminabilityRate.indistinguishable, 2);
});

test('sealed mapping is deterministic while the human review exposes only anonymous A and B', () => {
  const pair = {
    candidateId: 'daily_chat_2', sceneId: 'real_chat_daily_chat_2', category: 'daily_chat',
    contextTurns: [{ speaker: 'user', batch: [{ type: 'text', text: '你在干嘛' }] }],
    stableOutput: { terminalDisposition: 'visible', reply: '刚忙完。' },
    candidateOutput: { terminalDisposition: 'visible', reply: '刚把手头那点事收完，你呢。' },
  };
  const first = buildSealedBlindPair({ pair, seed: 'frozen-seed' });
  const second = buildSealedBlindPair({ pair, seed: 'frozen-seed' });
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.publicPair), [
    'version', 'candidateId', 'sceneId', 'category', 'contextTurns', 'outputs',
  ]);
  assert.deepEqual(Object.keys(first.sealedMapping).sort(), [
    'candidateId', 'mappingChecksum', 'outputChecksums', 'sides', 'version',
  ]);

  const markdown = buildHumanReviewMarkdown({ pairs: [first.publicPair] });
  assert.match(markdown, /总体更喜欢哪一个/);
  assert.match(markdown, /哪个更像真人在微信里会回的话/);
  assert.match(markdown, /答非所问.*编造事实.*客服\/心理咨询腔/);
  assert.doesNotMatch(markdown, /stable|candidate|gpt-5|测试重点|社会理解|主体性/i);
});
