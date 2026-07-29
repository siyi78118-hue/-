import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COGNITION_CONTEXT_LIMITS,
  CognitionContextOverflowError,
  buildCognitionContext
} from '../src/cognition-context.mjs';

function message(messageId, content, sentAt, extra = {}) {
  return {
    messageId,
    speakerId: extra.speakerId || (extra.speakerType === 'character' ? 'yuqi' : 'user'),
    speakerType: extra.speakerType || 'user',
    recipientId: extra.speakerType === 'character' ? 'user' : 'yuqi',
    content,
    sentAt,
    ...extra
  };
}

function fakeStore() {
  const messages = [
    ...Array.from({ length: 22 }, (_, index) => message(
      `msg_history_${index}`,
      `历史 ${index}`,
      index + 1,
      {
        turnId: `turn_history_${index}`,
        speakerType: index % 2 ? 'character' : 'user'
      }
    )),
    message('msg_evidence', '用户以前说喜欢乌龙茶', 30)
  ];
  const byId = new Map(messages.map((item) => [item.messageId, item]));
  return {
    listMessages() {
      return messages;
    },
    listRetrievableFacts() {
      return [
        {
          factId: 'fact_verified',
          status: 'verified',
          type: 'preference',
          subjectId: 'user',
          predicate: 'likes',
          object: { summary: '用户喜欢乌龙茶' },
          sourceMessageIds: ['msg_evidence'],
          exactQuotes: [{ text: '喜欢乌龙茶' }],
          confidence: 0.9
        }
      ];
    },
    getMessage(messageId) {
      return byId.get(messageId) || null;
    },
    getMessageContext() {
      return [];
    }
  };
}

function baseInput() {
  const currentMessages = [
    message('msg_batch_1', '第一条完整气泡', 100, {
      batchId: 'batch_current',
      attachments: [{
        attachmentId: 'att_1',
        messageId: 'msg_batch_1',
        kind: 'image',
        mime: 'image/jpeg',
        dataUrl: 'data:image/jpeg;base64,SECRET_IMAGE_BYTES'
      }]
    }),
    message('msg_batch_2', '第二条完整气泡', 101, { batchId: 'batch_current' })
  ];
  return {
    store: fakeStore(),
    envelope: {
      kind: 'DIRECT_REPLY',
      characterId: 'yuqi',
      context: {
        payment: {
          messageId: 'msg_pay_1',
          kind: 'redpacket',
          amount: 20,
          status: 'pending'
        }
      }
    },
    scene: {
      relationshipStage: {
        id: 'familiar',
        content: '已经形成稳定聊天习惯。',
        base: { id: 'familiar', content: '长期熟悉。' },
        phase: { id: 'repairing', content: '正在修复刚才的小矛盾。' }
      }
    },
    localMemoryHints: [
      {
        recordId: 'manual_1',
        sourceType: 'manual',
        text: '用户手工记录：不喜欢被连续追问',
        createdAt: 90,
        importance: 5,
        score: 0.5
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        recordId: `vector_${index}`,
        sourceType: 'vector',
        text: `自动提示 ${index}`,
        createdAt: 50 + index,
        importance: 1,
        score: index / 10
      }))
    ],
    currentBatch: {
      batchId: 'batch_current',
      messageIds: ['msg_batch_1', 'msg_batch_2'],
      messages: currentMessages,
      startedAt: 100,
      committedAt: 101
    },
    interactionState: {
      conversationFrame: {
        explicitBoundaries: [
          {
            type: 'no_repeated_questions',
            active: true,
            reason: '用户刚明确说明',
            evidenceMessageIds: ['msg_batch_2']
          }
        ]
      }
    },
    cognitiveState: {
      openThreads: [
        { id: 'thread_1', summary: '旧话题 1' },
        { id: 'thread_2', summary: '旧话题 2' },
        { id: 'thread_3', summary: '旧话题 3' },
        { id: 'thread_4', summary: '旧话题 4' }
      ]
    },
    lifeContext: { currentActivity: '午休' },
    catalog: {
      schemaVersion: 1,
      lessons: Array.from({ length: 7 }, (_, index) => ({
        lessonId: `lesson_${index}`,
        status: 'approved',
        priority: 100 - index,
        scenes: ['direct_chat'],
        relationshipStages: ['all'],
        appliesWhen: ['完整气泡'],
        principle: `原则 ${index}`,
        counterSignals: [],
        forbiddenInference: [`禁止 ${index}`]
      }))
    }
  };
}

test('builds a bounded cognition context without losing protected ownership', async () => {
  assert.deepEqual(COGNITION_CONTEXT_LIMITS, {
    recentMessages: 20,
    combinedMemoryItems: 8,
    openThreads: 3,
    socialLessons: 5
  });
  const context = await buildCognitionContext(baseInput());
  assert.deepEqual(
    context.currentBatch.messages.map((item) => item.messageId),
    ['msg_batch_1', 'msg_batch_2']
  );
  assert.equal(JSON.stringify(context).includes('SECRET_IMAGE_BYTES'), false);
  assert.equal(context.currentBatch.messages[0].attachments[0].messageId, 'msg_batch_1');
  assert.equal(context.currentBatch.messages[0].attachments[0].attachmentId, 'att_1');
  assert.equal(context.recentMessages.length, 20);
  assert.equal(context.memoryItems.length, 8);
  assert.equal(context.memoryItems[0].provenance.sourceType, 'manual');
  assert.equal(context.memoryItems.some((item) => item.kind === 'pc_verified_fact'), true);
  assert.equal(context.openThreads.length, 3);
  assert.equal(context.socialLessons.length, 5);
  assert.equal(context.activeExplicitBoundaries.length, 1);
  assert.equal(context.relationshipStage.base.id, 'familiar');
  assert.equal(context.relationshipStage.phase.id, 'repairing');
  assert.equal(context.payment.messageId, 'msg_pay_1');
});

test('trims low-score regions in the required order and reports diagnostics', async () => {
  const input = baseInput();
  input.localMemoryHints = input.localMemoryHints.map((hint) => ({
    ...hint,
    text: `${hint.text} ${'x'.repeat(300)}`
  }));
  input.catalog.lessons = input.catalog.lessons.map((item) => ({
    ...item,
    principle: `${item.principle} ${'y'.repeat(300)}`
  }));
  const context = await buildCognitionContext({ ...input, maxCharacters: 3_500 });
  assert.deepEqual(
    context.trimmedRegions.slice(0, 2),
    ['socialLessons', 'automaticLocalMemoryHints']
  );
  assert.deepEqual(context.currentBatch.messageIds, ['msg_batch_1', 'msg_batch_2']);
  assert.equal(context.activeExplicitBoundaries.length, 1);
});

test('throws with region sizes when protected content alone exceeds the model limit', async () => {
  const input = baseInput();
  input.currentBatch.messages[0].content = '不可裁剪'.repeat(2_000);
  await assert.rejects(
    buildCognitionContext({ ...input, maxCharacters: 1_000 }),
    (error) => {
      assert.ok(error instanceof CognitionContextOverflowError);
      assert.ok(error.regionCharacters.currentBatch > 1_000);
      assert.match(error.message, /protected cognition context exceeds/);
      return true;
    }
  );
});
