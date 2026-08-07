import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  commitVerifiedFacts,
  validateFactCandidate
} from '../src/evidence-memory.mjs';
import { buildEvidencePack } from '../src/retrieval.mjs';
import { YuqiStore } from '../src/store.mjs';

const messages = [
  {
    messageId: 'msg_1',
    turnId: 'turn_1',
    characterId: 'yuqi',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '你明天会回来找我吗',
    sentAt: 1784400000000,
    origin: 'phone'
  },
  {
    messageId: 'msg_2',
    turnId: 'turn_1',
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '我答应你，明天晚上会回来找你',
    sentAt: 1784400001000,
    origin: 'codex',
    committed: true,
    resultAuthorityVersion: 1,
    turnState: 'committed',
    authorityGroupId: 'grp_turn_1',
    authorityLineageKey: 'lin_turn_1',
    authorityCommitChecksum: 'a'.repeat(64),
    deliveryState: 'confirmed'
  },
  {
    messageId: 'msg_3',
    turnId: 'turn_2',
    characterId: 'yuqi',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '你之前答应过我不能忘',
    sentAt: 1784400002000,
    origin: 'phone'
  }
];

function promiseCandidate(overrides = {}) {
  return {
    factId: 'fact_promise_1',
    characterId: 'yuqi',
    type: 'formal_commitment',
    subjectId: 'yuqi',
    predicate: 'promised_to_return',
    object: { when: 'tomorrow_evening' },
    promisedBy: 'yuqi',
    promisedTo: 'user',
    evidenceMode: 'direct',
    sourceMessageIds: ['msg_2'],
    exactQuotes: [{
      messageId: 'msg_2',
      speakerId: 'yuqi',
      text: '我答应你，明天晚上会回来找你'
    }],
    confidence: 0.98,
    ...overrides
  };
}

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-evidence-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    messages.forEach(message => store.putMessage(message));
    return run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('verifies a direct character promise with an exact quote', () => {
  const result = validateFactCandidate(promiseCandidate(), messages);
  assert.equal(result.status, 'verified');
  assert.equal(result.fact.promisedBy, 'yuqi');
  assert.deepEqual(result.fact.sourceMessageIds, ['msg_2']);
});

test('never promotes a character promise as a user promise', () => {
  const result = validateFactCandidate(promiseCandidate({
    subjectId: 'user',
    promisedBy: 'user',
    promisedTo: 'yuqi'
  }), messages);
  assert.equal(result.status, 'provisional');
  assert.match(result.reasons.join(' '), /promisedBy.*speaker/i);
});

test('a reported promise is not direct evidence', () => {
  const result = validateFactCandidate(promiseCandidate({
    sourceMessageIds: ['msg_3'],
    exactQuotes: [{ messageId: 'msg_3', speakerId: 'user', text: '你之前答应过我不能忘' }]
  }), messages);
  assert.equal(result.status, 'provisional');
  assert.match(result.reasons.join(' '), /reported claim|direct commitment/i);
});

test('rejects a quote whose speaker label or text does not match raw chat', () => {
  const wrongSpeaker = validateFactCandidate(promiseCandidate({
    exactQuotes: [{ messageId: 'msg_2', speakerId: 'user', text: '我答应你，明天晚上会回来找你' }]
  }), messages);
  assert.equal(wrongSpeaker.status, 'rejected');

  const wrongText = validateFactCandidate(promiseCandidate({
    exactQuotes: [{ messageId: 'msg_2', speakerId: 'yuqi', text: '我答应你永远不会离开' }]
  }), messages);
  assert.equal(wrongText.status, 'rejected');
});

test('negative and joking statements cannot become direct commitments', () => {
  const localMessages = [{
    ...messages[1],
    content: '我才不答应你，开玩笑呢'
  }];
  const result = validateFactCandidate(promiseCandidate({
    sourceMessageIds: ['msg_2'],
    exactQuotes: [{ messageId: 'msg_2', speakerId: 'yuqi', text: '我才不答应你，开玩笑呢' }]
  }), localMessages);
  assert.equal(result.status, 'provisional');
});

test('same words by both sides remain attributable by message ID', () => {
  const localMessages = [
    { ...messages[0], messageId: 'msg_user_same', content: '我会回来找你' },
    { ...messages[1], messageId: 'msg_yuqi_same', content: '我会回来找你' }
  ];
  const result = validateFactCandidate(promiseCandidate({
    sourceMessageIds: ['msg_yuqi_same'],
    exactQuotes: [{ messageId: 'msg_yuqi_same', speakerId: 'yuqi', text: '我会回来找你' }]
  }), localMessages);
  assert.equal(result.status, 'verified');
  assert.equal(result.fact.exactQuotes[0].messageId, 'msg_yuqi_same');
});

test('legacy explicit facts keep their provisional compatibility path', () => withStore(store => {
  const ambiguous = promiseCandidate({
    factId: 'fact_reported',
    sourceMessageIds: ['msg_3'],
    exactQuotes: [{ messageId: 'msg_3', speakerId: 'user', text: '你之前答应过我不能忘' }]
  });
  const result = commitVerifiedFacts(store, [promiseCandidate(), ambiguous], messages);
  assert.equal(result.verified.length, 1);
  assert.equal(result.provisional.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(store.listFacts('yuqi', { status: 'verified' }).length, 1);
  assert.equal(store.listFacts('yuqi', { status: 'provisional' }).length, 1);
}));

test('a repeated model fact ID cannot fail the whole reply turn', () => withStore(store => {
  commitVerifiedFacts(store, [promiseCandidate()], messages);

  const result = commitVerifiedFacts(store, [promiseCandidate({ confidence: 0.77 })], messages);

  assert.equal(result.verified.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reasons.join(' '), /identity conflict/i);
  assert.equal(store.listFacts('yuqi').length, 1);
}));

test('retrieval pack includes speaker, exact quote, and neighboring context', () => withStore(store => {
  commitVerifiedFacts(store, [promiseCandidate()], messages);
  const pack = buildEvidencePack(store, {
    characterId: 'yuqi',
    query: '明天 回来 约定',
    keywords: ['回来', '约定'],
    limit: 5
  });
  assert.equal(pack.facts.length, 1);
  assert.equal(pack.facts[0].evidence[0].speakerId, 'yuqi');
  assert.equal(pack.facts[0].evidence[0].text, '我答应你，明天晚上会回来找你');
  assert.deepEqual(pack.facts[0].evidence[0].context.map(item => item.messageId), ['msg_1', 'msg_2', 'msg_3']);
}));
