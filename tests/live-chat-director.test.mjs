import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tavern-app/lib/live-chat-director.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(source, sandbox, { filename: 'live-chat-director.js' });
const director = sandbox.globalThis.ALLiveChatDirector;

test('normalizeDirectorCard keeps only declared fields and valid evidence ids', () => {
  const result = director.normalizeDirectorCard({
    scene: 'proactive-chat',
    timeGap: 'hours',
    silenceCause: 'temporary_absence',
    previousContactPressure: 'low',
    relationshipStageId: 'familiar',
    playerIntent: '可能只是忙，不能断定在疏远',
    playerIntentConfidence: 0.42,
    currentMood: '有点惦记',
    moodCause: '三小时没回',
    stanceTowardPlayer: '关心但不继续催',
    ownLifeFocus: '刚下课准备吃饭',
    noticedPoint: '上次对话自然中断',
    replyImpulse: 'share',
    contactPressure: 'low',
    openingNeeded: true,
    recommendedDirection: '先自然开口，再分享刚发生的小事',
    avoid: ['重复催回复'],
    evidenceMessageIds: ['msg_valid', 'msg_missing'],
    confidence: 0.72,
    leakedField: 'drop me'
  }, {
    scene: 'proactive-chat',
    latestMessageIds: ['msg_valid'],
    relationshipStageId: 'familiar'
  });

  assert.equal(result.card.schemaVersion, 1);
  assert.equal(result.card.scene, 'proactive-chat');
  assert.deepEqual([...result.card.evidenceMessageIds], ['msg_valid']);
  assert.equal('leakedField' in result.card, false);
  assert.equal(result.source, 'memory-ai');
});

test('fallbackDirectorCard is conservative when intent evidence is absent', () => {
  const card = director.fallbackDirectorCard({
    scene: 'proactive-chat',
    nowMs: Date.parse('2026-07-28T18:00:00+08:00'),
    lastMessageAt: Date.parse('2026-07-28T14:30:00+08:00'),
    relationshipStageId: 'acquainted',
    previousContactPressure: 'medium'
  });

  assert.equal(card.timeGap, 'hours');
  assert.equal(card.silenceCause, 'uncertain');
  assert.equal(card.openingNeeded, true);
  assert.equal(card.contactPressure, 'low');
  assert.match(card.recommendedDirection, /重新开口|新触发|自然/);
});

test('formatDirectorCard states that the card is not dialogue', () => {
  const text = director.formatDirectorCard(director.fallbackDirectorCard({
    scene: 'chat',
    relationshipStageId: 'new'
  }), { playerName: '姜隽倚', characterName: '虞栖' });
  assert.match(text, /不是台词提纲/);
  assert.match(text, /不得复述/);
  assert.doesNotMatch(text, /undefined|null/);
});

test('hard leaks require one rewrite', () => {
  const report = director.validateLiveChatReply('行，晚点说\nend_turn', {
    scene: 'chat',
    nowMs: Date.now()
  });
  assert.equal(report.severity, 'hard');
  assert.ok(report.codes.includes('CONTROL_MARKER_LEAK'));
  assert.equal(director.shouldRewriteReply(report), true);
});

test('one soft issue does not rewrite but two soft issues do', () => {
  const one = director.validateLiveChatReply('你在干嘛？', {
    scene: 'chat',
    nowMs: Date.now()
  });
  assert.equal(director.shouldRewriteReply(one), false);

  const two = director.validateLiveChatReply('怎么不回？在吗？干嘛呢？', {
    scene: 'proactive-chat',
    nowMs: Date.parse('2026-07-28T18:00:00+08:00'),
    lastMessageAt: Date.parse('2026-07-28T14:00:00+08:00'),
    previousContactPressure: 'high',
    directorCard: { contactPressure: 'low', replyImpulse: 'share' }
  });
  assert.ok(two.softCodes.length >= 2);
  assert.equal(director.shouldRewriteReply(two), true);
});

test('payment scene never requests semantic rewrite', () => {
  const report = director.validateLiveChatReply('怎么又不回？在吗？', {
    scene: 'payment',
    nowMs: Date.now(),
    previousContactPressure: 'high'
  });
  assert.equal(director.shouldRewriteReply(report), false);
});

test('valid hidden directives are excluded from visible reply checks and preserved for rewrite', () => {
  const raw = '晚点说。\n<al_schedule>{"nextProactiveAt":"2026-07-28T19:00:00+08:00"}</al_schedule>';
  assert.equal(director.visibleReplyText(raw), '晚点说。');
  const instruction = director.buildRewriteInstruction(
    raw,
    { codes: ['QUESTION_OVERLOAD'] },
    '【本轮隐藏导演卡】低压力',
    { scene: 'chat', nowMs: Date.now() }
  );
  assert.match(instruction, /只输出修正后的可见聊天正文/);
  assert.doesNotMatch(instruction, /nextProactiveAt/);
});
