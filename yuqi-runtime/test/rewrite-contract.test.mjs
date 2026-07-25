import assert from 'node:assert/strict';
import test from 'node:test';

import {
  characterFactCandidatesForReply,
  hasHighPriorityIssues,
  normalizeRewriteResolution,
  normalizeSupervisorResult,
  rewriteContractForBrain
} from '../src/rewrite-contract.mjs';
import { ROLE_OUTPUT_SCHEMAS } from '../src/role-schemas.mjs';

function executableIssue(overrides = {}) {
  return {
    code: 'CURRENT_INTERACTION_MISS',
    severity: 'soft',
    message: '没有正面承接追问',
    mustPreserve: ['不编造用户事实'],
    mustChange: ['给出正面回应'],
    allowedStrategies: ['补全虞栖自己的低风险生活细节'],
    acceptanceCriteria: ['正文回应当前追问'],
    ...overrides
  };
}

test('normalizes an executable supervisor issue into a stable brain rewrite contract', () => {
  const reviewed = normalizeSupervisorResult({
    decision: 'rewrite',
    reviewedIssueIds: [],
    resolvedIssueIds: [],
    issues: [executableIssue()]
  }, { attempt: 1, previous: null });

  assert.equal(reviewed.issues[0].issueId, 'CURRENT_INTERACTION_MISS:1');
  assert.equal(reviewed.issues[0].severity, 'soft');
  assert.deepEqual(
    rewriteContractForBrain(reviewed).issues[0].allowedStrategies,
    ['补全虞栖自己的低风险生活细节']
  );
  assert.equal(hasHighPriorityIssues(reviewed), false);
});

test('keeps issue identity across reviews and refuses a new soft goalpost after attempt one', () => {
  const first = normalizeSupervisorResult({
    decision: 'rewrite',
    reviewedIssueIds: [],
    resolvedIssueIds: [],
    issues: [executableIssue()]
  }, { attempt: 1, previous: null });
  const second = normalizeSupervisorResult({
    decision: 'rewrite',
    reviewedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
    resolvedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
    issues: [
      executableIssue({ message: '仍需要更直接一些' }),
      executableIssue({
        code: 'STYLE_PREFERENCE',
        message: '还可以更俏皮',
        mustChange: ['增加俏皮语气']
      })
    ]
  }, { attempt: 2, previous: first });

  assert.deepEqual(second.reviewedIssueIds, ['CURRENT_INTERACTION_MISS:1']);
  assert.deepEqual(second.resolvedIssueIds, ['CURRENT_INTERACTION_MISS:1']);
  assert.equal(second.issues[0].issueId, 'CURRENT_INTERACTION_MISS:1');
  assert.equal(second.issues.some(issue => issue.code === 'STYLE_PREFERENCE'), false);
});

test('upgrades a direct reject and legacy issues into an executable high-priority contract', () => {
  const reviewed = normalizeSupervisorResult({
    decision: 'reject',
    issues: [{ code: 'SPEAKER_ATTRIBUTION', message: '说话者归属错误' }]
  }, { attempt: 1, previous: null, direct: true });

  assert.equal(reviewed.decision, 'rewrite');
  assert.equal(reviewed.issues[0].severity, 'hard');
  assert.ok(reviewed.issues[0].allowedStrategies.length > 0);
  assert.ok(reviewed.issues[0].acceptanceCriteria.length > 0);
  assert.equal(hasHighPriorityIssues(reviewed), true);
});

test('forms durable Yuqi facts only from exact visible reply evidence', () => {
  const resolution = normalizeRewriteResolution({
    resolvedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
    resolutionNotes: [{
      issueId: 'CURRENT_INTERACTION_MISS:1',
      strategy: '补全虞栖自己的低风险生活细节',
      result: '已直接回答'
    }],
    formedCharacterFacts: [{
      predicate: 'currently_reading',
      summary: '虞栖正在读《长夜难明》',
      detailsJson: '{"title":"长夜难明"}',
      evidenceQuote: '我在看《长夜难明》'
    }, {
      predicate: 'user_secret',
      summary: '用户不愿公开的秘密',
      detailsJson: '{}',
      evidenceQuote: '我在看《长夜难明》'
    }, {
      predicate: 'invalid_detail',
      summary: '不在正文里的事实',
      detailsJson: '{}',
      evidenceQuote: '正文并没有这句话'
    }]
  });
  const reply = {
    messageId: 'msg_yuqi_fact_1',
    characterId: 'yuqi',
    speakerId: 'yuqi',
    content: '我在看《长夜难明》\n刚翻到一半',
    sentAt: 1784952805969
  };
  const candidates = characterFactCandidatesForReply(resolution, reply);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].subjectId, 'yuqi');
  assert.deepEqual(candidates[0].sourceMessageIds, ['msg_yuqi_fact_1']);
  assert.deepEqual(candidates[0].exactQuotes, [{
    messageId: 'msg_yuqi_fact_1',
    speakerId: 'yuqi',
    text: '我在看《长夜难明》'
  }]);
});

test('exposes the executable rewrite handshake in strict role schemas', () => {
  const brain = ROLE_OUTPUT_SCHEMAS.brain;
  const supervisor = ROLE_OUTPUT_SCHEMAS.supervisor;

  assert.ok(brain.required.includes('rewriteResolution'));
  const resolution = brain.properties.rewriteResolution.anyOf[0];
  assert.deepEqual(resolution.required, [
    'resolvedIssueIds',
    'resolutionNotes',
    'formedCharacterFacts'
  ]);

  assert.ok(supervisor.required.includes('reviewedIssueIds'));
  assert.ok(supervisor.required.includes('resolvedIssueIds'));
  assert.deepEqual(supervisor.properties.issues.items.required, [
    'issueId',
    'code',
    'severity',
    'message',
    'mustPreserve',
    'mustChange',
    'allowedStrategies',
    'acceptanceCriteria'
  ]);
});
