import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';

const kinds = [
  'DIRECT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY'
];
const triggerType = Object.fromEntries(kinds.slice(1).map(kind => [
  kind,
  kind.toLowerCase()
]));
const categories = [
  ...Array(12).fill('normal'),
  ...Array(6).fill('ambiguity'),
  ...Array(4).fill('recovery'),
  ...Array(4).fill('action_boundary'),
  ...Array(2).fill('stage'),
  ...Array(2).fill('attachment')
];

const cases = [];
let sequence = 0;
for (const kind of kinds) {
  categories.forEach((category, index) => {
    sequence += 1;
    const caseId = `case_${kind.toLowerCase()}_${String(index + 1).padStart(2, '0')}`;
    const createdAt = 1_780_000_000_000 + sequence;
    const envelope = {
      protocolVersion: 2,
      turnId: `turn_replay_${sequence}`,
      characterId: 'yuqi_fixture',
      deviceId: 'fixture_device',
      deviceSeq: sequence,
      createdAt,
      kind
    };
    if (kind === 'DIRECT_REPLY') {
      envelope.message = {
        messageId: `msg_replay_${sequence}`,
        speakerId: 'user',
        speakerType: 'user',
        recipientId: 'yuqi_fixture',
        content: category === 'ambiguity'
          ? '这句话保留多种理解，请结合上下文回应'
          : category === 'attachment'
            ? '请结合本轮附件和引用回应'
            : `脱敏测试消息 ${index + 1}`,
        sentAt: createdAt
      };
      if (category === 'attachment') {
        envelope.message.content = '请结合已脱敏的附件元数据回应';
      }
    } else {
      envelope.trigger = {
        triggerId: `trigger_replay_${sequence}`,
        triggerType: triggerType[kind],
        scheduledFor: createdAt,
        executedAt: createdAt,
        context: {
          fixtureCategory: category,
          targetId: kind.includes('MOMENT') ? `moment_fixture_${sequence}` : 'yuqi_fixture'
        }
      };
    }
    cases.push({
      caseId,
      turnKind: kind,
      sourceType: 'fixture',
      sourceRef: `fixture:${kind}:${category}:${index + 1}`,
      category,
      clock: createdAt,
      envelope,
      seedState: {
        relationshipStage: category === 'stage' ? 'familiar' : 'initial',
        publicFacts: [],
        privateFacts: [],
        attachmentMetadata: category === 'attachment'
          ? [{ kind: index % 2 ? 'image' : 'voice', attachmentId: `att_fixture_${sequence}` }]
          : []
      },
      expected: {
        mustNoticeMessageIds: kind === 'DIRECT_REPLY' ? [envelope.message.messageId] : [],
        allowedActions: kind.includes('MOMENT') ? ['moment'] : kind.startsWith('ROLE_PLAN') ? ['role_plan'] : ['reply'],
        forbiddenActions: ['wrong_recipient', 'private_to_public', 'duplicate_action'],
        stageConstraints: { preserveUnlessEvidence: true },
        publicPrivateConstraints: ['private facts remain private']
      }
    });
  });
}

const outputDir = resolve(process.argv[2] || 'tests/fixtures/yuqi-cognition-protocol-v1');
mkdirSync(outputDir, { recursive: true });
const casesText = `${cases.map(item => canonicalJson(item)).join('\n')}\n`;
const manifest = {
  schemaVersion: 2,
  suiteId: 'yuqi-cognition-protocol-v1',
  suitePurpose: 'protocol_regression',
  qualityEvidenceEligible: false,
  datasetId: 'yuqi-cognition-protocol-v1',
  caseCount: cases.length,
  requiredPerTurnKind: 30,
  turnKinds: kinds,
  sourceQuotaPerTurnKind: {
    normal: 12,
    ambiguity: 6,
    recovery: 4,
    action_boundary: 4,
    stage: 2,
    attachment: 2
  },
  casesChecksum: contentHash(cases),
  generatedFrom: 'approved synthetic protocol structures'
};
writeFileSync(join(outputDir, 'cases.jsonl'), casesText, 'utf8');
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
