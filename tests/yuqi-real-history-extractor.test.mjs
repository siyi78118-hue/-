import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';

const EXTRACTOR = join(process.cwd(), 'scripts', 'extract-yuqi-real-history-scenes.mjs');
const STRUCTURES = [
  'social_bid',
  'temporary_stance',
  'stage_leak',
  'proactive_collision',
  'payment',
  'repair',
  'time_gap',
  'multi_bubble',
  'media_or_quote'
];

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function makeScene(index, structure) {
  const at = 1_700_000_000_000 + (index * 60_000);
  return {
    rolloutKey: 'DIRECT_REPLY',
    initialState: {
      relationship: { base: 'steady', phase: 'familiar' },
      lifeSignals: [{ id: `life-${index}`, kind: 'routine', value: 'ordinary' }],
      currentStances: [{ subject: 'conversation', value: 'open' }],
      verifiedFacts: [{ id: `fact-${index}`, predicate: 'visited', object: { place: 'local' } }]
    },
    turns: [
      { at, speaker: 'user', batch: [{ messageId: `source-${index}`, type: 'text', text: `保留语义 ${structure} ${index}`, attachments: [] }] },
      { at: at + 1_000, speaker: 'assistant', batch: [{ messageId: `reply-${index}`, type: 'text', text: `虞栖回应 ${structure} ${index}`, attachments: [] }] },
      { at: at + 2_000, speaker: 'user', batch: [{ messageId: `follow-${index}`, type: 'text', text: `继续讨论 ${structure} ${index}`, attachments: [] }] },
      { at: at + 3_000, speaker: 'assistant', batch: [{ messageId: `close-${index}`, type: 'text', text: `完成闭合 ${structure} ${index}`, attachments: [] }] }
    ],
    mustNotice: [`notice-${structure}`],
    allowedDecisionRange: ['direct attitude', 'brief question', 'natural pause'],
    forbiddenFailurePatterns: ['invented_fact'],
    requiredActionIntegrity: { required: false, allowedKinds: ['none'] },
    allowedPersonalityVariation: ['warm', 'calm'],
    expectedStateTransitions: { allow: ['create', 'maintain'] },
    forbiddenStateTransitions: { hardConstraintFromYuqiPreference: true },
    sourceAnnotation: { file: 'local_history', heading: structure },
    severity: 'medium'
  };
}

function createFixture(path, {
  count = 30,
  missingAuthority = false,
  unknownTurnField = false,
  unknownSpeaker = false,
  messageOwnerRetry = false,
  retryCycle = false,
  messageIdentityMismatch = false,
  unknownStructure = false,
  unknownNestedField = false
} = {}) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA user_version = 10;
      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_seq INTEGER NOT NULL,
        source_message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        origin TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        rollout_key TEXT NOT NULL,
        lane_key TEXT NOT NULL,
        authority_lineage_key TEXT NOT NULL,
        retry_of_turn_id TEXT,
        result_authority_version INTEGER NOT NULL,
        authority_redacted_at INTEGER,
        input_visibility_sequence INTEGER,
        input_clear_epoch INTEGER
      );
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        speaker_type TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        origin TEXT NOT NULL,
        device_id TEXT,
        device_seq INTEGER,
        checksum TEXT NOT NULL
      );
    `);
    if (!missingAuthority) {
      db.exec(`
        CREATE TABLE turn_authority_lineages (
          lineage_key TEXT PRIMARY KEY,
          role_id TEXT NOT NULL,
          lane_key TEXT NOT NULL,
          root_source_id TEXT NOT NULL,
          latest_turn_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          state TEXT NOT NULL,
          committed_group_id TEXT,
          redacted_at INTEGER
        );
      `);
    }

    const insertTurn = db.prepare(`INSERT INTO turns
      (turn_id, character_id, device_id, device_seq, source_message_id, state, origin,
       envelope_json, envelope_checksum, created_at, updated_at, rollout_key, lane_key,
       authority_lineage_key, retry_of_turn_id, result_authority_version,
       authority_redacted_at, input_visibility_sequence, input_clear_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMessage = db.prepare(`INSERT INTO messages
      (message_id, turn_id, character_id, speaker_id, speaker_type, recipient_id,
       content, sent_at, origin, device_id, device_seq, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertLineage = !missingAuthority ? db.prepare(`INSERT INTO turn_authority_lineages
      (lineage_key, role_id, lane_key, root_source_id, latest_turn_id, revision, state, committed_group_id, redacted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`) : null;

    for (let index = 0; index < count; index += 1) {
      const structure = STRUCTURES[index % STRUCTURES.length];
      const scene = makeScene(index, structure);
      if (unknownStructure && index === 0) scene.sourceAnnotation.heading = 'payment_inferred_only';
      if (unknownNestedField && index === 0) scene.initialState.verifiedFacts[0].object.trackingId = 'SECRET-NESTED';
      if (unknownTurnField && index === 0) scene.turns[0].batch[0].trackingId = 'SECRET-ID';
      if (unknownSpeaker && index === 0) scene.turns[1].speaker = 'alien';
      const turnId = `turn-${index}`;
      const lineage = `lineage-${index}`;
      const sourceMessageId = `source-${index}`;
      const sourceText = scene.turns[0].batch[0].text;
      const sourceChecksum = contentHash({
        messageId: sourceMessageId,
        turnId: turnId,
        characterId: 'role-1',
        speakerId: 'user',
        speakerType: 'user',
        recipientId: 'role-1',
        content: sourceText,
        sentAt: scene.turns[0].at,
        origin: 'canonical',
        deviceId: 'device-1',
        deviceSeq: index + 1
      });
      const envelopeJson = JSON.stringify(scene);
      insertTurn.run(turnId, 'role-1', 'device-1', index + 1, sourceMessageId, 'completed', 'canonical', envelopeJson,
        contentHash(JSON.parse(envelopeJson)), scene.turns[0].at, scene.turns[3].at, 'DIRECT_REPLY', 'private_chat',
        lineage, null, 1, null, index + 1, 0);
      insertMessage.run(sourceMessageId, turnId, 'role-1', 'user', 'user', 'role-1', sourceText,
        scene.turns[0].at, 'canonical', 'device-1', index + 1, sourceChecksum);
      if (insertLineage) insertLineage.run(lineage, 'role-1', 'private_chat', sourceMessageId, turnId, 1, 'committed', `group-${index}`, null);
    }

    if (!missingAuthority && count >= 1) {
      const retryScene = makeScene(0, STRUCTURES[0]);
      if (unknownTurnField) retryScene.turns[0].batch[0].trackingId = 'SECRET-ID';
      if (unknownSpeaker) retryScene.turns[1].speaker = 'alien';
      if (unknownStructure) retryScene.sourceAnnotation.heading = 'payment_inferred_only';
      if (unknownNestedField) retryScene.initialState.verifiedFacts[0].object.trackingId = 'SECRET-NESTED';
      const retryEnvelope = JSON.stringify(retryScene);
      insertTurn.run('turn-0-retry', 'role-1', 'device-1', 10_001, 'source-0', 'completed', 'canonical', retryEnvelope,
        contentHash(JSON.parse(retryEnvelope)), retryScene.turns[0].at, retryScene.turns[3].at + 10_000, 'DIRECT_REPLY', 'private_chat',
        'lineage-0', 'turn-0', 1, null, 10_001, 0);
      db.prepare('UPDATE turn_authority_lineages SET revision = 2, latest_turn_id = ? WHERE lineage_key = ?').run('turn-0-retry', 'lineage-0');
      if (retryCycle) db.prepare('UPDATE turns SET retry_of_turn_id = ? WHERE turn_id = ?').run('turn-0-retry', 'turn-0-retry');
      if (messageOwnerRetry) {
        const sourceText = retryScene.turns[0].batch[0].text;
        const checksum = contentHash({
          messageId: 'source-0',
          turnId: 'turn-0-retry',
          characterId: 'role-1',
          speakerId: 'user',
          speakerType: 'user',
          recipientId: 'role-1',
          content: sourceText,
          sentAt: retryScene.turns[0].at,
          origin: 'canonical',
          deviceId: 'device-1',
          deviceSeq: 10_001
        });
        db.prepare('UPDATE messages SET turn_id = ?, device_seq = ?, checksum = ? WHERE message_id = ?')
          .run('turn-0-retry', 10_001, checksum, 'source-0');
      }
      if (messageIdentityMismatch) db.prepare('UPDATE messages SET recipient_id = ? WHERE message_id = ?').run('other-role', 'source-0');
    }

    // A redacted row, a failed row, and an exact retry are present but must not
    // inflate the 30 projected scenes or leak semantic data.
    if (!missingAuthority) {
      const scene = makeScene(0, STRUCTURES[0]);
      const envelopeJson = JSON.stringify(scene);
      insertTurn.run('turn-redacted', 'role-1', 'device-1', 900, 'source-0', 'completed', 'canonical', envelopeJson,
        contentHash(JSON.parse(envelopeJson)), scene.turns[0].at, scene.turns[3].at, 'DIRECT_REPLY', 'private_chat',
        'lineage-redacted', null, 1, 123, 900, 0);
      insertLineage.run('lineage-redacted', 'role-1', 'private_chat', 'source-0', 'turn-redacted', 1, 'committed', 'group-redacted', 123);
    }
  } finally {
    db.close();
  }
}

function runExtractor(database, root, extra = []) {
  return execFileSync(process.execPath, [EXTRACTOR, '--database', database, '--root', root, '--limit', '30', ...extra], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('extractor exports exactly 30 verified readonly scenes and manifest without changing v10 source', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-'));
  const database = join(root, 'validation.sqlite');
  try {
    createFixture(database);
    const before = sha256File(database);
    runExtractor(database, root);
    const output = join(root, 'artifacts', 'yuqi-lived-agency-v3', 'private', 'real-history-scenes.jsonl');
    const manifestPath = join(root, 'artifacts', 'yuqi-lived-agency-v3', 'private', 'real-history-scenes.manifest.json');
    assert.equal(existsSync(output), true);
    assert.equal(existsSync(manifestPath), true);
    const scenes = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(scenes.length, 30);
    assert.deepEqual(Object.keys(manifest).sort(), ['sceneIds', 'scenesChecksum', 'schemaVersion']);
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.sceneIds, scenes.map(scene => scene.sceneId));
    assert.equal(manifest.scenesChecksum, contentHash(scenes));
    for (const scene of scenes) {
      assert.equal(scene.rolloutKey, 'DIRECT_REPLY');
      assert.equal(Array.isArray(scene.turns), true);
      assert.equal(scene.turns.length >= 4 && scene.turns.length <= 12, true);
      assert.equal(typeof scene.initialState, 'object');
      assert.equal(typeof scene.sourceAnnotation, 'object');
      assert.equal(scene.sourceRef, undefined);
      assert.equal(scene.envelope, undefined);
    }
    assert.equal(sha256File(database), before);
    const sourceDb = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(Number(sourceDb.prepare('PRAGMA user_version').get().user_version), 10); } finally { sourceDb.close(); }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor fails closed without authority schema or with fewer than 30 eligible records and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-invalid-'));
  const database = join(root, 'validation.sqlite');
  try {
    createFixture(database, { count: 1, missingAuthority: true });
    assert.throws(() => runExtractor(database, root), /authority|schema|30|eligible/i);
    const privateDir = join(root, 'artifacts', 'yuqi-lived-agency-v3', 'private');
    assert.equal(existsSync(join(privateDir, 'real-history-scenes.jsonl')), false);
    assert.equal(existsSync(join(privateDir, 'real-history-scenes.manifest.json')), false);

    const completeDatabase = join(root, 'complete-but-short.sqlite');
    createFixture(completeDatabase, { count: 1 });
    assert.throws(() => runExtractor(completeDatabase, root), /30|eligible|structure/i);
    assert.equal(existsSync(join(privateDir, 'real-history-scenes.jsonl')), false);
    assert.equal(existsSync(join(privateDir, 'real-history-scenes.manifest.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor accepts an active WAL source without treating read locks as database mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-wal-'));
  const database = join(root, 'validation.sqlite');
  let writer;
  try {
    createFixture(database);
    writer = new DatabaseSync(database);
    writer.exec('PRAGMA journal_mode=WAL');
    assert.doesNotThrow(() => runExtractor(database, root));
    const output = join(root, 'artifacts', 'yuqi-lived-agency-v3', 'private', 'real-history-scenes.jsonl');
    assert.equal(readFileSync(output, 'utf8').trim().split('\n').length, 30);
  } finally {
    writer?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor rejects unknown turn fields instead of leaking identifiers', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-unknown-field-'));
  const database = join(root, 'validation.sqlite');
  try {
    createFixture(database, { unknownTurnField: true });
    assert.throws(() => runExtractor(database, root), /unknown|closed|field|identifier/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor rejects unknown speakers instead of emitting an open scene schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-speaker-'));
  const database = join(root, 'validation.sqlite');
  try {
    createFixture(database, { unknownSpeaker: true });
    assert.throws(() => runExtractor(database, root), /speaker|closed|scene/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor rejects a canonical user message owned by a retry instead of the root turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-owner-'));
  const database = join(root, 'validation.sqlite');
  try {
    createFixture(database, { messageOwnerRetry: true });
    assert.throws(() => runExtractor(database, root), /owner|root|message authority/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor rejects retry cycles and message identity mismatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-closure-'));
  try {
    const cycleDatabase = join(root, 'cycle.sqlite');
    createFixture(cycleDatabase, { retryCycle: true });
    assert.throws(() => runExtractor(cycleDatabase, root), /cycle|root|retry/i);
    const identityDatabase = join(root, 'identity.sqlite');
    createFixture(identityDatabase, { messageIdentityMismatch: true });
    assert.throws(() => runExtractor(identityDatabase, root), /identity|recipient|message authority/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor rejects keyword-only structure classification and preserves no semantic side channel', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-structure-'));
  const database = join(root, 'validation.sqlite');
  try {
    createFixture(database, { unknownStructure: true });
    assert.throws(() => runExtractor(database, root), /structure|heading|closed/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('extractor rejects unknown nested state and attachment fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-extractor-nested-'));
  const database = join(root, 'validation.sqlite');
  try {
    createFixture(database, { unknownNestedField: true });
    assert.throws(() => runExtractor(database, root), /unknown|closed|verifiedFact/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
