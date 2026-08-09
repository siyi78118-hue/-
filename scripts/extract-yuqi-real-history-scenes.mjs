import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';

const REQUIRED_STRUCTURES = Object.freeze([
  'social_bid',
  'temporary_stance',
  'stage_leak',
  'proactive_collision',
  'payment',
  'repair',
  'time_gap',
  'multi_bubble',
  'media_or_quote'
]);
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_TURN_COLUMNS = Object.freeze([
  'turn_id', 'character_id', 'device_id', 'device_seq', 'source_message_id',
  'state', 'origin', 'envelope_json', 'envelope_checksum', 'created_at',
  'updated_at', 'rollout_key', 'lane_key', 'authority_lineage_key',
  'retry_of_turn_id', 'result_authority_version', 'authority_redacted_at',
  'input_visibility_sequence', 'input_clear_epoch'
]);
const REQUIRED_MESSAGE_COLUMNS = Object.freeze([
  'message_id', 'turn_id', 'character_id', 'speaker_id', 'speaker_type',
  'recipient_id', 'content', 'sent_at', 'origin', 'device_id', 'device_seq', 'checksum'
]);
const REQUIRED_LINEAGE_COLUMNS = Object.freeze([
  'lineage_key', 'role_id', 'lane_key', 'root_source_id', 'latest_turn_id', 'revision',
  'state', 'committed_group_id', 'redacted_at'
]);
const CLOSED_TURN_KEYS = new Set(['at', 'speaker', 'batch', 'event']);
const CLOSED_SPEAKERS = new Set(['user', 'assistant', 'character', 'system']);
const CLOSED_PART_KEYS = new Set([
  'messageId', 'type', 'text', 'amount', 'attachments', 'note', 'status', 'kind',
  'quote', 'quoteRef', 'transcript', 'voiceTranscript'
]);
const CLOSED_PART_TYPES = new Set(['text', 'image', 'quote', 'voice', 'emoji', 'payment']);
const CLOSED_SEVERITIES = new Set(['critical', 'high', 'medium']);
const CLOSED_SYSTEM_EVENTS = new Set(['candidate_response']);
const CLOSED_ATTACHMENT_KEYS = new Set([
  'attachmentId', 'messageId', 'kind', 'mime', 'name', 'width', 'height', 'bytes', 'dataUrl'
]);
const CLOSED_FACT_OBJECT_KEYS = new Set(['place', 'value', 'kind', 'label', 'status']);
const CLOSED_ENVELOPE_KEYS = new Set([
  'rolloutKey', 'initialState', 'turns', 'mustNotice', 'allowedDecisionRange',
  'forbiddenFailurePatterns', 'requiredActionIntegrity', 'allowedPersonalityVariation',
  'expectedStateTransitions', 'forbiddenStateTransitions', 'sourceAnnotation', 'severity',
  'turnId', 'sourceMessageId', 'deviceId', 'deviceSeq', 'characterId', 'authorityLineageKey'
]);

function argumentMap(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    values.set(argv[index].slice(2), argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true);
  }
  return values;
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

function sourceSha256(databasePath) {
  // SQLite's -shm file contains process-local WAL lock bytes. A read-only
  // connection can legitimately mutate those bytes without changing the
  // database contents, so it is deliberately excluded from the source
  // identity. The rollback journal remains part of the source identity.
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-journal`];
  const hash = createHash('sha256');
  for (const file of files) {
    if (!existsSync(file) || readFileSync(file).length === 0) {
      // SQLite may materialize an empty WAL/journal when a read-only handle is
      // opened. Empty and absent sidecars carry no database content and are
      // the same source identity; non-empty sidecars remain fully hashed.
      hash.update(`${file}\0empty\0`, 'utf8');
      continue;
    }
    hash.update(`${file}\0`, 'utf8');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

function tableColumns(database, table) {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all();
  return new Set(rows.map(row => String(row.name)));
}

function assertReadonlyV10Schema(database) {
  const version = Number(database.prepare('PRAGMA user_version').get().user_version);
  if (version !== 10) throw new Error(`source database must remain v10; got ${version}`);
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const [table, columns] of [
    ['turns', REQUIRED_TURN_COLUMNS],
    ['messages', REQUIRED_MESSAGE_COLUMNS],
    ['turn_authority_lineages', REQUIRED_LINEAGE_COLUMNS]
  ]) {
    if (!tables.has(table)) throw new Error(`authority schema missing table ${table}`);
    const actual = tableColumns(database, table);
    for (const column of columns) if (!actual.has(column)) throw new Error(`authority schema missing ${table}.${column}`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function redactIdentifiers(value, sceneOrdinal, mapping = new Map(), key = '') {
  if (Array.isArray(value)) return value.map(item => redactIdentifiers(item, sceneOrdinal, mapping, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactIdentifiers(childValue, sceneOrdinal, mapping, childKey)
    ]));
  }
  if (typeof value !== 'string' || !/(?:id|key)$/i.test(key)) return value;
  if (!mapping.has(value)) mapping.set(value, `anon_${sceneOrdinal}_${mapping.size + 1}`);
  return mapping.get(value);
}

function classifyStructure(value) {
  const annotated = value?.sourceAnnotation?.heading;
  if (typeof annotated !== 'string' || !REQUIRED_STRUCTURES.includes(annotated)) {
    throw new Error('scene structure must use a persisted closed sourceAnnotation.heading');
  }
  return annotated;
}

function normalizeTurns(turns, sceneOrdinal) {
  if (!Array.isArray(turns) || turns.length < 4 || turns.length > 12) throw new Error('scene turns must contain 4..12 turns');
  let messageOrdinal = 0;
  const idMap = new Map();
  const projectedTurns = turns.map((turn, turnIndex) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new Error(`scene turn ${turnIndex} is malformed`);
    for (const key of Object.keys(turn)) if (!CLOSED_TURN_KEYS.has(key)) {
      throw new Error(`scene turn ${turnIndex} has unknown field ${key}`);
    }
    if (!Number.isSafeInteger(turn.at) || typeof turn.speaker !== 'string' || !CLOSED_SPEAKERS.has(turn.speaker)) {
      throw new Error(`scene turn ${turnIndex} is malformed`);
    }
    if (turn.speaker === 'system') {
      if (typeof turn.event !== 'string' || !CLOSED_SYSTEM_EVENTS.has(turn.event)
        || (turn.batch !== undefined && !Array.isArray(turn.batch))) {
        throw new Error(`scene turn ${turnIndex} system event is malformed`);
      }
    } else if (!Array.isArray(turn.batch) || turn.batch.length === 0) {
      throw new Error(`scene turn ${turnIndex} batch is malformed`);
    }
    const batch = turn.batch || [];
    return {
      at: turn.at,
      speaker: turn.speaker === 'character' ? 'assistant' : turn.speaker,
      ...(turn.event !== undefined ? { event: turn.event } : {}),
      batch: batch.map(part => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('scene message part is malformed');
        for (const key of Object.keys(part)) if (!CLOSED_PART_KEYS.has(key)) {
          throw new Error(`scene message part has unknown field ${key}`);
        }
        if (typeof part.type !== 'string' || !CLOSED_PART_TYPES.has(part.type)
          || typeof part.messageId !== 'string' || part.messageId.length === 0
          || (part.text !== undefined && typeof part.text !== 'string')) {
          throw new Error('scene message part is malformed');
        }
        if (part.type === 'text' && typeof part.text !== 'string') throw new Error('scene text part is malformed');
        if (part.attachments !== undefined && !Array.isArray(part.attachments)) throw new Error('scene attachments are malformed');
        for (const attachment of part.attachments || []) {
          assertClosedKeys(attachment, [...CLOSED_ATTACHMENT_KEYS], 'scene attachment');
          if (typeof attachment.kind !== 'string' || attachment.kind !== 'image'
            || typeof attachment.mime !== 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(attachment.mime)
            || !Number.isSafeInteger(attachment.width) || !Number.isSafeInteger(attachment.height)
            || !Number.isSafeInteger(attachment.bytes) || attachment.width < 1 || attachment.height < 1 || attachment.bytes < 1
            || typeof attachment.dataUrl !== 'string') throw new Error('scene attachment types are malformed');
        }
        if (part.amount !== undefined && (typeof part.amount !== 'number' || !Number.isFinite(part.amount) || part.amount <= 0)) {
          throw new Error('scene payment amount is malformed');
        }
        if (part.note !== undefined && typeof part.note !== 'string') throw new Error('scene payment note is malformed');
        if (part.status !== undefined && (typeof part.status !== 'string' || !['pending', 'received', 'refused'].includes(part.status))) {
          throw new Error('scene payment status is malformed');
        }
        if (part.kind !== undefined && (typeof part.kind !== 'string' || !['redpacket', 'transfer'].includes(part.kind))) {
          throw new Error('scene payment kind is malformed');
        }
        for (const key of ['quote', 'quoteRef']) if (part[key] !== undefined) {
          assertClosedKeys(part[key], ['messageId', 'speakerId', 'speakerType', 'text'], `scene ${key}`);
          if (typeof part[key].messageId !== 'string' || typeof part[key].speakerId !== 'string'
            || !['user', 'character'].includes(part[key].speakerType) || typeof part[key].text !== 'string') {
            throw new Error(`scene ${key} is malformed`);
          }
        }
        messageOrdinal += 1;
        const projectedMessageId = `history_${sceneOrdinal}_${messageOrdinal}`;
        if (idMap.has(part.messageId)) throw new Error(`duplicate scene messageId ${part.messageId}`);
        idMap.set(part.messageId, projectedMessageId);
        const projected = { messageId: projectedMessageId, type: part.type };
        for (const key of ['text', 'amount', 'attachments', 'note', 'status', 'kind', 'quote', 'quoteRef', 'transcript', 'voiceTranscript']) {
          if (Object.hasOwn(part, key)) projected[key] = clone(part[key]);
        }
        return projected;
      })
    };
  });
  return { turns: projectedTurns, idMap };
}

function replaceReferences(value, idMap) {
  if (Array.isArray(value)) return value.map(item => replaceReferences(item, idMap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceReferences(child, idMap)]));
  }
  return typeof value === 'string' && idMap.has(value) ? idMap.get(value) : value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const [key, child] of Object.entries(value)) {
    if (typeof key !== 'string' || child === undefined || typeof child === 'function') throw new Error(`${label} contains invalid field`);
  }
  return value;
}

function assertClosedKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
}

function assertNativeStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be a string array`);
}

function validateSceneState(value) {
  assertClosedKeys(value, ['relationship', 'lifeSignals', 'currentStances', 'verifiedFacts'], 'scene initialState');
  assertClosedKeys(value.relationship, ['base', 'phase'], 'scene relationship');
  for (const key of ['base', 'phase']) if (typeof value.relationship[key] !== 'string') throw new Error(`scene relationship.${key} must be a string`);
  if (!Array.isArray(value.lifeSignals) || !Array.isArray(value.currentStances) || !Array.isArray(value.verifiedFacts)) throw new Error('scene state arrays are malformed');
  for (const item of value.lifeSignals) {
    assertClosedKeys(item, ['id', 'kind', 'value'], 'scene lifeSignal');
    if (typeof item.id !== 'string' || typeof item.kind !== 'string' || typeof item.value !== 'string') throw new Error('scene lifeSignal types are malformed');
  }
  for (const item of value.currentStances) {
    assertClosedKeys(item, ['subject', 'value'], 'scene currentStance');
    if (typeof item.subject !== 'string' || typeof item.value !== 'string') throw new Error('scene currentStance types are malformed');
  }
  for (const item of value.verifiedFacts) {
    assertClosedKeys(item, ['id', 'predicate', 'object'], 'scene verifiedFact');
    if (typeof item.id !== 'string' || typeof item.predicate !== 'string') throw new Error('scene verifiedFact types are malformed');
    assertClosedKeys(item.object, [...CLOSED_FACT_OBJECT_KEYS], 'scene verifiedFact.object');
    for (const [key, child] of Object.entries(item.object)) if (typeof child !== 'string') throw new Error(`scene verifiedFact.object.${key} must be a string`);
  }
}

function validateActionIntegrity(value) {
  assertClosedKeys(value, ['required', 'allowedKinds', 'paymentTargetMustMatch', 'momentTargetMustMatch', 'rolePlanTargetMustMatch'], 'scene requiredActionIntegrity');
  if (Object.hasOwn(value, 'required') && typeof value.required !== 'boolean') throw new Error('scene action required must be boolean');
  if (Object.hasOwn(value, 'allowedKinds')) assertNativeStringArray(value.allowedKinds, 'scene action allowedKinds');
  for (const key of ['paymentTargetMustMatch', 'momentTargetMustMatch', 'rolePlanTargetMustMatch']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string') throw new Error(`scene action ${key} must be a string`);
  }
}

function validateTransition(value, label) {
  assertClosedKeys(value, ['allow', 'hardConstraintFromYuqiPreference'], label);
  if (Object.hasOwn(value, 'allow')) assertNativeStringArray(value.allow, `${label}.allow`);
  if (Object.hasOwn(value, 'hardConstraintFromYuqiPreference') && typeof value.hardConstraintFromYuqiPreference !== 'boolean') {
    throw new Error(`${label}.hardConstraintFromYuqiPreference must be boolean`);
  }
}

function projectScene(rawEnvelope, sceneOrdinal) {
  if (!rawEnvelope || typeof rawEnvelope !== 'object') throw new Error('turn envelope must be an object');
  for (const key of Object.keys(rawEnvelope)) if (!CLOSED_ENVELOPE_KEYS.has(key)) {
    throw new Error(`turn envelope has unknown field ${key}`);
  }
  if (rawEnvelope.sourceAnnotation !== undefined) {
    assertClosedKeys(rawEnvelope.sourceAnnotation, ['file', 'heading'], 'scene sourceAnnotation');
    if (typeof rawEnvelope.sourceAnnotation.heading !== 'string' || typeof rawEnvelope.sourceAnnotation.file !== 'string') {
      throw new Error('scene sourceAnnotation types are malformed');
    }
  }
  const structure = classifyStructure(rawEnvelope);
  if (!structure) throw new Error('scene structure is not in the required closed set');
  if (rawEnvelope.rolloutKey !== 'DIRECT_REPLY') throw new Error('history scene rolloutKey must be DIRECT_REPLY');
  const initialState = redactIdentifiers(clone(rawEnvelope.initialState), sceneOrdinal);
  if (!initialState || typeof initialState !== 'object' || Array.isArray(initialState)) throw new Error('scene initialState is missing');
  validateSceneState(initialState);
  const normalizedTurns = normalizeTurns(rawEnvelope.turns, sceneOrdinal);
  const turns = normalizedTurns.turns;
  const references = value => replaceReferences(clone(value), normalizedTurns.idMap);
  for (const key of ['mustNotice', 'allowedDecisionRange', 'forbiddenFailurePatterns', 'allowedPersonalityVariation']) {
    if (!Array.isArray(rawEnvelope[key])) throw new Error(`scene ${key} is missing or malformed`);
  }
  if (!rawEnvelope.requiredActionIntegrity || typeof rawEnvelope.requiredActionIntegrity !== 'object' || Array.isArray(rawEnvelope.requiredActionIntegrity)) {
    throw new Error('scene requiredActionIntegrity is missing or malformed');
  }
  validateActionIntegrity(rawEnvelope.requiredActionIntegrity);
  for (const key of ['expectedStateTransitions', 'forbiddenStateTransitions']) {
    if (!rawEnvelope[key] || typeof rawEnvelope[key] !== 'object' || Array.isArray(rawEnvelope[key])) {
      throw new Error(`scene ${key} is missing or malformed`);
    }
  }
  validateTransition(rawEnvelope.expectedStateTransitions, 'scene expectedStateTransitions');
  validateTransition(rawEnvelope.forbiddenStateTransitions, 'scene forbiddenStateTransitions');
  for (const key of ['mustNotice', 'allowedDecisionRange', 'forbiddenFailurePatterns', 'allowedPersonalityVariation']) {
    assertNativeStringArray(rawEnvelope[key], `scene ${key}`);
  }
  if (typeof rawEnvelope.severity !== 'string' || !CLOSED_SEVERITIES.has(rawEnvelope.severity)) {
    throw new Error('scene severity is not in the required closed set');
  }
  const required = {
    sceneId: `local_history_${String(sceneOrdinal).padStart(2, '0')}`,
    rolloutKey: 'DIRECT_REPLY',
    initialState,
    turns,
    mustNotice: references(rawEnvelope.mustNotice),
    allowedDecisionRange: redactIdentifiers(clone(rawEnvelope.allowedDecisionRange), sceneOrdinal),
    forbiddenFailurePatterns: references(rawEnvelope.forbiddenFailurePatterns),
    requiredActionIntegrity: redactIdentifiers(clone(rawEnvelope.requiredActionIntegrity), sceneOrdinal),
    allowedPersonalityVariation: redactIdentifiers(clone(rawEnvelope.allowedPersonalityVariation), sceneOrdinal),
    expectedStateTransitions: redactIdentifiers(clone(rawEnvelope.expectedStateTransitions), sceneOrdinal),
    forbiddenStateTransitions: redactIdentifiers(clone(rawEnvelope.forbiddenStateTransitions), sceneOrdinal),
    sourceAnnotation: { file: 'local_history', heading: structure },
    severity: rawEnvelope.severity
  };
  return { scene: required, structure };
}

function parseAndValidateRows(database) {
  assertReadonlyV10Schema(database);
  const rows = database.prepare(`
    SELECT * FROM turns
    WHERE rollout_key = 'DIRECT_REPLY'
      AND state IN ('completed', 'delivered', 'committed')
      AND result_authority_version = 1
      AND authority_redacted_at IS NULL
    ORDER BY authority_lineage_key, updated_at, turn_id
  `).all();
  const lineages = new Map(database.prepare('SELECT * FROM turn_authority_lineages').all().map(row => [String(row.lineage_key), row]));
  const grouped = new Map();
  for (const row of rows) {
    assertString(row.turn_id, 'turn_id');
    assertString(row.character_id, 'character_id');
    assertString(row.device_id, 'device_id');
    assertString(row.source_message_id, 'source_message_id');
    assertString(row.authority_lineage_key, 'authority_lineage_key');
    if (!Number.isSafeInteger(Number(row.device_seq)) || Number(row.device_seq) < 0
      || !Number.isSafeInteger(Number(row.created_at)) || !Number.isSafeInteger(Number(row.updated_at))) {
      throw new Error(`turn ${row.turn_id} has invalid native timestamp/sequence`);
    }
    if (row.lane_key !== 'private_chat' || row.origin === 'synthetic' || row.origin === 'legacy_provisional') continue;
    if (row.origin !== 'canonical') throw new Error(`turn ${row.turn_id} origin is not canonical`);
    if (!HEX64.test(String(row.envelope_checksum))) throw new Error(`invalid envelope checksum for ${row.turn_id}`);
    let envelope;
    try { envelope = JSON.parse(row.envelope_json); } catch { throw new Error(`invalid envelope JSON for ${row.turn_id}`); }
    if (contentHash(envelope) !== row.envelope_checksum) throw new Error(`envelope checksum mismatch for ${row.turn_id}`);
    for (const [key, expected] of [
      ['turnId', row.turn_id], ['sourceMessageId', row.source_message_id], ['deviceId', row.device_id],
      ['deviceSeq', Number(row.device_seq)], ['characterId', row.character_id],
      ['authorityLineageKey', row.authority_lineage_key]
    ]) {
      if (Object.hasOwn(envelope, key) && envelope[key] !== expected) throw new Error(`turn ${row.turn_id} envelope ${key} identity mismatch`);
    }
    const lineage = lineages.get(row.authority_lineage_key);
    const lineageRoleId = lineage?.role_id ?? lineage?.character_id;
    if (!lineage || (lineage.redacted_at !== undefined && lineage.redacted_at !== null)
      || lineage.lane_key !== row.lane_key || lineageRoleId !== row.character_id
      || (lineage.state !== undefined && lineage.state !== 'committed')
      || (lineage.committed_group_id !== undefined && lineage.committed_group_id === null)
      || (lineage.root_source_id !== undefined && lineage.root_source_id !== row.source_message_id)) {
      throw new Error(`lineage authority mismatch for ${row.turn_id}`);
    }
    if (lineage.redacted_at !== null && !Number.isSafeInteger(lineage.redacted_at)) {
      throw new Error(`lineage ${row.authority_lineage_key} has invalid redaction timestamp`);
    }
    if (!Number.isSafeInteger(Number(lineage.revision)) || Number(lineage.revision) < 0) throw new Error(`invalid lineage revision for ${row.turn_id}`);
    if (!grouped.has(row.authority_lineage_key)) grouped.set(row.authority_lineage_key, []);
    grouped.get(row.authority_lineage_key).push({ row, envelope });
  }

  const records = [];
  if (grouped.size === 0 && rows.length > 0) throw new Error(`no closed authority lineages accepted; rows=${rows.length}, lineages=${lineages.size}`);
  for (const [lineageKey, entries] of grouped) {
    const lineage = lineages.get(lineageKey);
    const selected = entries.find(entry => entry.row.turn_id === lineage.latest_turn_id);
    if (!selected) throw new Error(`lineage ${lineageKey} latest turn is not eligible`);
    const turnIds = new Set(entries.map(entry => entry.row.turn_id));
    const roots = entries.filter(entry => entry.row.retry_of_turn_id === null);
    if (roots.length !== 1) throw new Error(`retry lineage ${lineageKey} must have exactly one root attempt`);
    const rootTurnId = roots[0].row.turn_id;
    if (lineage.root_source_id !== roots[0].row.source_message_id) throw new Error(`retry lineage ${lineageKey} root source mismatch`);
    if (entries.some(entry => entry.row.character_id !== roots[0].row.character_id
      || entry.row.device_id !== roots[0].row.device_id
      || entry.row.source_message_id !== roots[0].row.source_message_id)) {
      throw new Error(`retry lineage ${lineageKey} owner/device identity mismatch`);
    }
    const latestByTimestamp = [...entries].sort((left, right) =>
      Number(right.row.updated_at) - Number(left.row.updated_at) || String(right.row.turn_id).localeCompare(String(left.row.turn_id))
    )[0];
    if (latestByTimestamp.row.turn_id !== lineage.latest_turn_id) throw new Error(`lineage ${lineageKey} latest turn pointer mismatch`);
    for (const entry of entries) {
      if (entry.row.retry_of_turn_id !== null && !turnIds.has(entry.row.retry_of_turn_id)) {
        throw new Error(`retry lineage is not closed for ${entry.row.turn_id}`);
      }
      const visited = new Set([entry.row.turn_id]);
      let parentId = entry.row.retry_of_turn_id;
      while (parentId !== null) {
        if (visited.has(parentId)) throw new Error(`retry lineage cycle for ${entry.row.turn_id}`);
        visited.add(parentId);
        const parent = entries.find(candidate => candidate.row.turn_id === parentId);
        if (!parent) throw new Error(`retry lineage parent missing for ${entry.row.turn_id}`);
        parentId = parent.row.retry_of_turn_id;
      }
      const message = database.prepare(`SELECT * FROM messages WHERE message_id = ?`).get(entry.row.source_message_id);
      if (!message || message.character_id !== entry.row.character_id || message.speaker_type !== 'user' ||
          message.speaker_id !== 'user' || message.recipient_id !== entry.row.character_id ||
          message.origin !== 'canonical' || message.turn_id !== rootTurnId ||
          message.device_id !== roots[0].row.device_id ||
          (message.device_seq !== null && (!Number.isSafeInteger(message.device_seq)
            || Number(message.device_seq) !== Number(roots[0].row.device_seq))) ||
          typeof message.content !== 'string' ||
          !Number.isSafeInteger(Number(message.sent_at)) || !HEX64.test(String(message.checksum)) ||
          contentHash({
            messageId: message.message_id,
            turnId: message.turn_id,
            characterId: message.character_id,
            speakerId: message.speaker_id,
            speakerType: message.speaker_type,
            recipientId: message.recipient_id,
            content: message.content,
            sentAt: Number(message.sent_at),
            origin: message.origin,
            deviceId: message.device_id ?? null,
            deviceSeq: message.device_seq == null ? null : Number(message.device_seq)
          }) !== message.checksum) {
        throw new Error(`source message authority mismatch for ${entry.row.turn_id}`);
      }
    }
    const projected = projectScene(selected.envelope, records.length);
    const semanticFingerprint = contentHash({ ...projected.scene, sceneId: undefined });
    for (const entry of entries) {
      const retryProjection = projectScene(entry.envelope, records.length);
      if (contentHash({ ...retryProjection.scene, sceneId: undefined }) !== semanticFingerprint) {
        throw new Error(`retry semantic mismatch for ${lineageKey}`);
      }
    }
    records.push({ lineageKey, scene: projected.scene, structure: projected.structure, updatedAt: Number(selected.row.updated_at) });
  }
  return records;
}

export function selectRealHistoryScenes(records, limit = 30) {
  if (!Number.isSafeInteger(limit) || limit !== 30) throw new Error('real history extraction requires exactly 30 scenes');
  const byStructure = new Map();
  for (const record of records) if (!byStructure.has(record.structure)) byStructure.set(record.structure, record);
  const selected = [];
  for (const structure of REQUIRED_STRUCTURES) {
    const record = byStructure.get(structure);
    if (!record) throw new Error(`insufficient required history structure: ${structure}; available=${JSON.stringify([...byStructure.keys()])}`);
    selected.push(record);
  }
  const selectedKeys = new Set(selected.map(record => record.lineageKey));
  for (const record of records) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(record.lineageKey)) continue;
    selected.push(record);
    selectedKeys.add(record.lineageKey);
  }
  if (selected.length !== limit) throw new Error(`need exactly ${limit} eligible real history scenes; got ${selected.length}`);
  return selected.map((record, index) => ({
    ...clone(record.scene),
    sceneId: `local_history_${String(index).padStart(2, '0')}`,
    sourceAnnotation: { file: 'local_history', heading: record.structure }
  }));
}

function privatePath(root, optionValue, defaultRelative) {
  const privateRoot = resolve(root, 'artifacts/yuqi-lived-agency-v3/private');
  const outputPath = resolve(root, optionValue || defaultRelative);
  const rel = relative(privateRoot, outputPath);
  if (rel.startsWith('..') || isAbsolute(rel) || outputPath === privateRoot) {
    throw new Error('output must remain under artifacts/yuqi-lived-agency-v3/private');
  }
  return outputPath;
}

function atomicWritePair(output, outputText, manifest, manifestText) {
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(manifest), { recursive: true });
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const outputTemporary = `${output}${suffix}`;
  const manifestTemporary = `${manifest}${suffix}`;
  const outputBackup = `${output}.bak-${process.pid}-${Date.now()}`;
  const manifestBackup = `${manifest}.bak-${process.pid}-${Date.now()}`;
  const committed = [];
  const hadOutput = existsSync(output);
  const hadManifest = existsSync(manifest);
  try {
    writeFileSync(outputTemporary, outputText, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(manifestTemporary, manifestText, { encoding: 'utf8', flag: 'wx' });
    // Validate the staged generation before either public path changes. The
    // manifest's scenesChecksum is the immutable generation token consumed by
    // every reader; manifest is published last, so a crash leaves either the
    // previous matching pair or a checksum-mismatched pair that readers reject.
    const stagedScenes = outputText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const stagedManifest = JSON.parse(manifestText);
    if (stagedScenes.length !== 30 || stagedManifest.scenesChecksum !== contentHash(stagedScenes)
      || JSON.stringify(stagedManifest.sceneIds) !== JSON.stringify(stagedScenes.map(scene => scene.sceneId))) {
      throw new Error('staged history generation is internally inconsistent');
    }
    if (hadOutput) renameSync(output, outputBackup);
    if (hadManifest) renameSync(manifest, manifestBackup);
    renameSync(outputTemporary, output);
    committed.push(output);
    renameSync(manifestTemporary, manifest);
    committed.push(manifest);
    rmSync(outputBackup, { force: true });
    rmSync(manifestBackup, { force: true });
    return committed;
  } catch (error) {
    for (const temporary of [outputTemporary, manifestTemporary]) rmSync(temporary, { force: true });
    for (const path of committed) if (existsSync(path)) rmSync(path, { force: true });
    if (existsSync(outputBackup)) renameSync(outputBackup, output);
    if (existsSync(manifestBackup)) renameSync(manifestBackup, manifest);
    throw error;
  }
}

export function extractRealHistoryScenes({ databasePath, outputPath, manifestPath, limit = 30, root = process.cwd() }) {
  if (!databasePath || !isAbsolute(databasePath)) throw new Error('databasePath must be an absolute path');
  const output = privatePath(root, outputPath, 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl');
  const manifest = privatePath(root, manifestPath, 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.manifest.json');
  const before = sourceSha256(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let committedPaths = [];
  try {
    const records = parseAndValidateRows(database);
    const scenes = selectRealHistoryScenes(records, limit);
    const jsonl = `${scenes.map(scene => JSON.stringify(scene)).join('\n')}\n`;
    const manifestValue = { schemaVersion: 1, sceneIds: scenes.map(scene => scene.sceneId), scenesChecksum: contentHash(scenes) };
    const afterValidation = sourceSha256(databasePath);
    if (afterValidation !== before) throw new Error('source database changed during readonly extraction');
    committedPaths = atomicWritePair(output, jsonl, manifest, `${JSON.stringify(manifestValue)}\n`);
    const rereadScenes = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const rereadManifest = JSON.parse(readFileSync(manifest, 'utf8'));
    if (rereadScenes.length !== 30 || contentHash(rereadScenes) !== manifestValue.scenesChecksum ||
        JSON.stringify(rereadManifest) !== JSON.stringify(manifestValue)) throw new Error('written history output verification failed');
    const after = sourceSha256(databasePath);
    if (after !== before) throw new Error('source database changed during readonly extraction');
    return { count: scenes.length, checksum: manifestValue.scenesChecksum, output, manifest };
  } catch (error) {
    // Validation failures happen before the pair is committed. Once a pair is
    // committed, a source-change failure removes only this invocation's files.
    for (const path of committedPaths) if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    database.close();
  }
}

if (isMain()) {
  const args = argumentMap();
  const databasePath = args.get('database');
  if (typeof databasePath !== 'string' || databasePath.length === 0) throw new Error('--database is required; production config is never read');
  const root = resolve(typeof args.get('root') === 'string' ? args.get('root') : process.cwd());
  const result = extractRealHistoryScenes({
    databasePath: resolve(databasePath),
    root,
    outputPath: args.get('out'),
    manifestPath: args.get('manifest'),
    limit: Number(args.get('limit') || 30)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
