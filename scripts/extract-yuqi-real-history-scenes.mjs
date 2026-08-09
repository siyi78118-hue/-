import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  contentHash,
  validateConversationClearApplied,
  validateConversationClearControl,
  validateEnvelope
} from '../yuqi-runtime/src/protocol.mjs';

const REQUIRED_STRUCTURES = Object.freeze([
  'social_bid', 'temporary_stance', 'stage_leak', 'proactive_collision',
  'payment', 'repair', 'time_gap', 'multi_bubble', 'media_or_quote'
]);
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_AUTHORITY_TABLES = Object.freeze([
  'turns', 'messages', 'current_user_batches', 'current_user_batch_items',
  'turn_authority_lineages', 'visible_result_groups', 'visible_result_items',
  'visible_result_actions', 'visible_result_manifests', 'visible_commit_receipts',
  'cloud_deliveries', 'interaction_lanes', 'cognition_kind_rollouts',
  'pipeline_releases', 'cognitive_states', 'conversation_clear_controls'
]);
const REQUIRED_COLUMNS = Object.freeze({
  turns: ['turn_id', 'character_id', 'device_id', 'device_seq', 'source_message_id', 'state', 'origin', 'envelope_json', 'envelope_checksum', 'created_at', 'updated_at', 'rollout_key', 'lane_key', 'authority_lineage_key', 'retry_of_turn_id', 'lineage_revision_at_creation', 'result_authority_version', 'authority_redacted_at', 'input_user_batch_id', 'input_visibility_sequence', 'input_clear_epoch', 'authoritative_release_id', 'authoritative_pipeline_checksum'],
  messages: ['message_id', 'turn_id', 'character_id', 'speaker_id', 'speaker_type', 'recipient_id', 'content', 'sent_at', 'origin', 'device_id', 'device_seq', 'checksum', 'authority_group_id', 'group_ordinal'],
  turn_authority_lineages: ['lineage_key', 'role_id', 'lane_key', 'root_source_id', 'latest_turn_id', 'revision', 'state', 'committed_group_id', 'redacted_at', 'attempt_count', 'attempt_commitment'],
  current_user_batches: ['turn_id', 'batch_id', 'character_id', 'source_message_id', 'started_at', 'committed_at', 'checksum', 'item_count', 'tombstone_commitment'],
  current_user_batch_items: ['turn_id', 'batch_id', 'message_id', 'sequence', 'message_json', 'checksum', 'redacted_at'],
  visible_result_groups: ['group_id', 'lineage_key', 'authoritative_turn_id', 'role_id', 'lane_key', 'authority_origin', 'authoritative_release_id', 'generation_fingerprint', 'reply_checksum', 'redacted_at', 'created_at', 'item_count', 'action_count', 'tombstone_commitment', 'redaction_delivery_count', 'redaction_delivery_commitment'],
  visible_result_items: ['group_id', 'ordinal', 'message_id', 'item_json', 'item_checksum', 'redacted_at'],
  visible_result_actions: ['group_id', 'ordinal', 'action_id', 'action_kind', 'target_key', 'target_revision', 'action_json', 'action_checksum', 'redacted_at'],
  visible_result_manifests: ['group_id', 'authority_origin', 'payload_version', 'semantic_json', 'semantic_checksum', 'redacted_at'],
  visible_commit_receipts: ['lineage_key', 'group_id', 'authoritative_turn_id', 'authority_origin', 'commit_payload_version', 'turn_revision_before', 'turn_revision_after', 'lineage_revision_before', 'lineage_revision_after', 'lane_revision_before', 'lane_revision_after', 'cognitive_state_revision_before', 'cognitive_state_revision_after', 'commit_checksum', 'committed_at'],
  cloud_deliveries: ['turn_id', 'peer_id', 'authority_group_id', 'authority_commit_checksum', 'recovery_ack_seq', 'state', 'payload_json', 'checksum', 'relay_message_id', 'redaction_requested_at', 'redaction_acknowledged_at'],
  interaction_lanes: ['role_id', 'lane_key', 'revision', 'local_sequence', 'latest_user_batch_id', 'clear_epoch', 'cleared_through_sequence'],
  pipeline_releases: ['release_id', 'release_checksum'],
  cognitive_states: ['role_id', 'revision', 'last_turn_id', 'checksum'],
  conversation_clear_controls: [
    'control_id', 'role_id', 'peer_id', 'clear_epoch', 'cleared_through_sequence',
    'requested_at', 'applied_at', 'input_cursor_checksum', 'checksum', 'applied_checksum',
    'authority_version', 'semantic_json'
  ]
});
const LABEL_KEYS = new Set([
  'windowId', 'sourceWindowChecksum', 'annotatorVersion', 'initialState',
  'mustNotice', 'allowedDecisionRange', 'forbiddenFailurePatterns',
  'requiredActionIntegrity', 'allowedPersonalityVariation',
  'expectedStateTransitions', 'forbiddenStateTransitions', 'severity', 'structure'
]);
const FORBIDDEN_LABEL_KEYS = new Set(['turns', 'actions', 'persistedContextProjection', 'envelope', 'reply_json']);
const CLOSED_SPEAKERS = new Set(['user', 'assistant']);
const CLOSED_PART_TYPES = new Set(['text', 'image', 'quote', 'voice', 'emoji', 'payment']);
const CLOSED_ACTION_KINDS = new Set([
  'payment_accept', 'payment_decline', 'moment_create', 'moment_like', 'moment_comment', 'moment_reply',
  'role_plan_create', 'role_plan_update', 'role_plan_cancel', 'role_plan_pause',
  'role_plan_resume', 'role_plan_complete', 'life_episode_create', 'life_episode_update',
  'life_episode_cancel', 'relationship_transition'
]);
const AUTOMATIC_TURN_KINDS = new Set([
  'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION', 'MOMENT_REPLY',
  'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE'
]);
const CLOSED_TURN_KINDS = new Set(['DIRECT_REPLY', ...AUTOMATIC_TURN_KINDS]);
const SEMANTIC_ID_KEYS = new Set([
  'messageId', 'message_id', 'turnId', 'turn_id', 'batchId', 'batch_id', 'groupId', 'group_id',
  'actionId', 'action_id', 'sourceMessageId', 'source_message_id', 'targetKey', 'target_key',
  'recipientId', 'recipient_id', 'roleId', 'role_id', 'characterId', 'character_id',
  'deviceId', 'device_id', 'peerId', 'peer_id', 'planId', 'plan_id', 'momentId', 'moment_id',
  'paymentId', 'payment_id', 'commentId', 'comment_id', 'replyToCommentId', 'reply_to_comment_id',
  'lineageKey', 'lineage_key', 'rootSourceId', 'root_source_id', 'inputUserBatchId', 'input_user_batch_id'
]);
const CLOSED_SEVERITIES = new Set(['critical', 'high', 'medium']);

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
  const hash = createHash('sha256');
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-journal`]) {
    if (!existsSync(file) || readFileSync(file).length === 0) {
      hash.update(`${file}\0empty\0`, 'utf8');
      continue;
    }
    hash.update(`${file}\0`, 'utf8');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name)));
}

function assertReadonlyV15Schema(database) {
  const version = Number(database.prepare('PRAGMA user_version').get().user_version);
  if (version !== 15) throw new Error(`source database must be a frozen v15 authority snapshot; got ${version}`);
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  for (const table of REQUIRED_AUTHORITY_TABLES) if (!tables.has(table)) throw new Error(`frozen v15 authority snapshot missing table ${table}`);
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = tableColumns(database, table);
    for (const column of columns) if (!actual.has(column)) throw new Error(`frozen v15 authority schema missing ${table}.${column}`);
  }
}

function jsonValue(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new Error(`${label} JSON is malformed`);
  }
}

function assertHex(value, label) {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new Error(`${label} checksum is malformed`);
}

function rootAttempt(turn, byId) {
  const seen = new Set();
  let current = turn;
  while (current.retry_of_turn_id != null) {
    const id = String(current.turn_id);
    if (seen.has(id)) throw new Error(`v15 retry cycle detected for ${turn.turn_id}`);
    seen.add(id);
    current = byId.get(String(current.retry_of_turn_id));
    if (!current) throw new Error(`v15 retry parent missing for ${turn.turn_id}`);
  }
  return current;
}

function turnKind(turn, envelope, redacted = false) {
  if (redacted) {
    if (JSON.stringify(envelope) !== '{"redacted":true}' || !CLOSED_TURN_KINDS.has(String(turn.rollout_key))) {
      throw new Error(`v15 redacted turn kind anchor mismatch for ${turn.turn_id}`);
    }
    if (String(turn.rollout_key) === 'DIRECT_REPLY') {
      if (typeof turn.input_user_batch_id !== 'string' || turn.input_user_batch_id.length === 0) throw new Error(`v15 redacted direct batch anchor missing for ${turn.turn_id}`);
      return 'direct';
    }
    return 'automatic';
  }
  if (!envelope || typeof envelope.kind !== 'string' || !CLOSED_TURN_KINDS.has(envelope.kind)
    || envelope.kind !== String(turn.rollout_key)) {
    throw new Error(`v15 turn kind anchor mismatch for ${turn.turn_id}`);
  }
  if (envelope.kind === 'DIRECT_REPLY') {
    if (typeof turn.input_user_batch_id !== 'string' || turn.input_user_batch_id.length === 0) {
      throw new Error(`v15 direct turn batch anchor missing for ${turn.turn_id}`);
    }
    return 'direct';
  }
  const triggerId = envelope.trigger?.triggerId;
  if (typeof turn.input_user_batch_id !== 'string' || turn.input_user_batch_id.length === 0
    || (triggerId !== undefined && turn.input_user_batch_id !== triggerId)) {
    throw new Error(`v15 automatic turn input anchor mismatch for ${turn.turn_id}`);
  }
  return 'automatic';
}

function batchCanonicalChecksum(batch, items) {
  return contentHash({
    batchId: String(batch.batch_id),
    sourceMessageId: String(batch.source_message_id),
    messageIds: items.map(item => String(item.message_id)),
    startedAt: Number(batch.started_at),
    committedAt: Number(batch.committed_at)
  });
}

function batchTombstoneCommitment(batch, items) {
  const projected = items.map(item => ({
    sequence: Number(item.sequence), messageId: String(item.message_id), checksum: String(item.checksum)
  }));
  return contentHash({
    version: 'current-user-batch-tombstone-v1', turnId: String(batch.turn_id), batchId: String(batch.batch_id),
    itemCount: projected.length, items: projected
  });
}

function lineageAttemptCommitment(lineage, attempts, database) {
  const projected = attempts
    .slice()
    .sort((left, right) => Number(left.lineage_revision_at_creation) - Number(right.lineage_revision_at_creation)
      || String(left.turn_id).localeCompare(String(right.turn_id)))
    .map(turn => {
      const batch = database.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').get(turn.turn_id);
      const items = database.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence').all(turn.turn_id);
      return {
        lineageRevisionAtCreation: Number(turn.lineage_revision_at_creation), turnId: String(turn.turn_id),
        turnKind: String(turn.rollout_key), retryOfTurnId: turn.retry_of_turn_id == null ? null : String(turn.retry_of_turn_id),
        inputUserBatchId: turn.input_user_batch_id == null ? null : String(turn.input_user_batch_id),
        envelopeChecksum: String(turn.envelope_checksum),
        batchTombstoneCommitment: batch == null ? null : String(batch.tombstone_commitment || batchTombstoneCommitment(batch, items))
      };
    });
  return contentHash({
    version: 'authority-lineage-attempts-v1', lineageKey: String(lineage.lineage_key),
    attemptCount: projected.length, attempts: projected
  });
}

function visibleResultTombstoneCommitment(group, items, actions) {
  const itemProjection = items.map(item => ({
    ordinal: Number(item.ordinal), messageId: String(item.message_id), itemChecksum: String(item.item_checksum)
  }));
  const actionProjection = actions.map(action => ({
    ordinal: Number(action.ordinal), actionId: String(action.action_id), actionChecksum: String(action.action_checksum)
  }));
  return contentHash({
    version: 'visible-result-tombstone-v1', groupId: String(group.group_id), itemCount: itemProjection.length,
    actionCount: actionProjection.length, items: itemProjection, actions: actionProjection
  });
}

function authorityRedactionDeliveriesCommitment(group, deliveries) {
  const rows = deliveries.map(delivery => {
    if (!Object.hasOwn(delivery, 'peer_id') || !Object.hasOwn(delivery, 'relay_message_id')
      || !Object.hasOwn(delivery, 'recovery_ack_seq') || !Object.hasOwn(delivery, 'authority_commit_checksum')) {
      throw new Error(`v15 redaction delivery commitment fields missing for ${group.group_id}`);
    }
    const peerId = delivery.peer_id;
    const relayMessageId = delivery.relay_message_id == null ? null : delivery.relay_message_id;
    const recoveryAckSeq = delivery.recovery_ack_seq;
    const authorityCommitChecksum = delivery.authority_commit_checksum;
    if (typeof peerId !== 'string' || peerId.length === 0 || (relayMessageId !== null && typeof relayMessageId !== 'string')
      || !Number.isSafeInteger(recoveryAckSeq) || recoveryAckSeq < 0
      || typeof authorityCommitChecksum !== 'string' || !HEX64.test(authorityCommitChecksum)) {
      throw new Error(`v15 redaction delivery commitment identity invalid for ${group.group_id}`);
    }
    return { peerId, relayMessageId, recoveryAckSeq, authorityCommitChecksum };
  }).sort((left, right) => left.peerId.localeCompare(right.peerId));
  if (new Set(rows.map(row => row.peerId)).size !== rows.length) throw new Error(`v15 redaction delivery duplicate peer for ${group.group_id}`);
  return contentHash({
    version: 'authority-redaction-deliveries-v1', groupId: String(group.group_id),
    deliveryCount: rows.length, deliveries: rows
  });
}

function assertConversationClearAuthority(database) {
  const expectedColumns = REQUIRED_COLUMNS.conversation_clear_controls;
  const actualColumns = database.prepare('PRAGMA table_info(conversation_clear_controls)').all().map(row => row.name);
  if (canonicalJson(actualColumns) !== canonicalJson(expectedColumns)) throw new Error('v15 clear-control schema column conflict');
  const rows = database.prepare('SELECT * FROM conversation_clear_controls ORDER BY control_id').all();
  const seenRoleEpoch = new Set();
  for (const row of rows) {
    if (typeof row.control_id !== 'string' || !row.control_id
      || typeof row.role_id !== 'string' || !row.role_id
      || !Number.isInteger(row.authority_version) || ![0, 1].includes(row.authority_version)
      || !Number.isSafeInteger(row.clear_epoch) || row.clear_epoch <= 0
      || !Number.isSafeInteger(row.cleared_through_sequence) || row.cleared_through_sequence < 0
      || !Number.isSafeInteger(row.requested_at) || !Number.isSafeInteger(row.applied_at)
      || typeof row.checksum !== 'string' || row.checksum.length === 0) {
      throw new Error(`v15 clear-control row shape conflict: ${row.control_id}`);
    }
    const roleEpoch = `${row.role_id}\u0000${row.clear_epoch}`;
    if (seenRoleEpoch.has(roleEpoch)) throw new Error(`v15 clear-control duplicate role epoch: ${row.role_id}`);
    seenRoleEpoch.add(roleEpoch);
    if (row.authority_version === 0) {
      if (row.peer_id !== null || row.input_cursor_checksum !== null
        || row.applied_checksum !== null || row.semantic_json !== null) {
        throw new Error(`v15 clear-control v0 projection conflict: ${row.control_id}`);
      }
      continue;
    }
    if (typeof row.peer_id !== 'string' || row.peer_id.length === 0
      || typeof row.input_cursor_checksum !== 'string' || !HEX64.test(row.input_cursor_checksum)
      || typeof row.applied_checksum !== 'string' || !HEX64.test(row.applied_checksum)
      || !Number.isSafeInteger(row.applied_at) || row.applied_at <= 0
      || typeof row.semantic_json !== 'string') {
      throw new Error(`v15 clear-control v1 projection conflict: ${row.control_id}`);
    }
    let wire;
    try { wire = jsonValue(row.semantic_json, `clear control ${row.control_id}`); } catch { throw new Error(`v15 clear-control semantic conflict: ${row.control_id}`); }
    let control;
    try { control = validateConversationClearControl(wire); } catch { throw new Error(`v15 clear-control semantic conflict: ${row.control_id}`); }
    if (canonicalJson(control) !== row.semantic_json
      || control.controlId !== row.control_id || control.roleId !== row.role_id
      || control.peerId !== row.peer_id || control.clearEpoch !== row.clear_epoch
      || control.clearedThroughSequence !== row.cleared_through_sequence
      || control.requestedAt !== row.requested_at || control.inputCursorChecksum !== row.input_cursor_checksum
      || control.checksum !== row.checksum) {
      throw new Error(`v15 clear-control semantic projection conflict: ${row.control_id}`);
    }
    const appliedBody = {
      protocolVersion: 3, type: 'CONVERSATION_CLEAR_APPLIED', controlId: row.control_id,
      controlChecksum: row.checksum, roleId: row.role_id, peerId: row.peer_id,
      clearEpoch: row.clear_epoch, clearedThroughSequence: row.cleared_through_sequence,
      appliedAt: row.applied_at
    };
    let applied;
    try { applied = validateConversationClearApplied({ ...appliedBody, checksum: row.applied_checksum }); } catch { throw new Error(`v15 clear-control applied proof conflict: ${row.control_id}`); }
    if (applied.checksum !== row.applied_checksum) throw new Error(`v15 clear-control applied checksum conflict: ${row.control_id}`);
  }
}

function assertAuthorityClosure(database) {
  assertConversationClearAuthority(database);
  const allTurns = database.prepare('SELECT * FROM turns WHERE result_authority_version = 1').all();
  const allTurnIds = new Set(allTurns.map(row => String(row.turn_id)));
  const turnById = new Map(allTurns.map(row => [String(row.turn_id), row]));
  const lineages = new Map(database.prepare('SELECT * FROM turn_authority_lineages').all().map(row => [String(row.lineage_key), row]));
  for (const turn of allTurns) {
    if (!turn.authority_lineage_key || !lineages.has(String(turn.authority_lineage_key))) throw new Error(`v15 lineage missing for ${turn.turn_id}`);
    if (!['queued', 'running', 'failed', 'committed', 'delivered', 'completed', 'cancelled'].includes(String(turn.state))) throw new Error(`v15 turn state invalid for ${turn.turn_id}`);
    assertHex(turn.envelope_checksum, `${turn.turn_id} envelope`);
    const envelope = jsonValue(turn.envelope_json, `${turn.turn_id} envelope`);
    const redactedTurn = turn.authority_redacted_at != null;
    if (redactedTurn) {
      if (JSON.stringify(envelope) !== '{"redacted":true}') throw new Error(`v15 redacted envelope shell mismatch for ${turn.turn_id}`);
    } else {
      let normalizedEnvelope;
      try { normalizedEnvelope = validateEnvelope(envelope); } catch { throw new Error(`v15 envelope protocol closure mismatch for ${turn.turn_id}`); }
      if (canonicalJson(normalizedEnvelope) !== turn.envelope_json) throw new Error(`v15 envelope normalization mismatch for ${turn.turn_id}`);
      if (contentHash(normalizedEnvelope) !== turn.envelope_checksum) throw new Error(`v15 envelope checksum mismatch for ${turn.turn_id}`);
    }
    const inputMode = turnKind(turn, envelope, redactedTurn);
    const root = rootAttempt(turn, turnById);
    if (turn.retry_of_turn_id !== null) {
      if (!allTurnIds.has(String(turn.retry_of_turn_id))) throw new Error(`v15 retry parent missing for ${turn.turn_id}`);
      const parent = turnById.get(String(turn.retry_of_turn_id));
      if (!parent || parent.authority_lineage_key !== turn.authority_lineage_key
        || Number(turn.lineage_revision_at_creation) !== Number(parent.lineage_revision_at_creation) + 1) throw new Error(`v15 retry authority mismatch for ${turn.turn_id}`);
    }
    const lineage = lineages.get(String(turn.authority_lineage_key));
    if (lineage.role_id !== turn.character_id || lineage.lane_key !== turn.lane_key) throw new Error(`v15 lineage owner mismatch for ${turn.turn_id}`);
    if (!Number.isSafeInteger(Number(lineage.attempt_count)) || !HEX64.test(String(lineage.attempt_commitment))) throw new Error(`v15 lineage commitment missing for ${turn.authority_lineage_key}`);
    const batch = database.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').get(turn.turn_id);
    const items = database.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence').all(turn.turn_id);
    if (inputMode === 'automatic') {
      if (batch || items.length) throw new Error(`v15 automatic turn batch closure mismatch for ${turn.turn_id}`);
    } else {
      if (!batch || batch.character_id !== turn.character_id || batch.source_message_id !== turn.source_message_id
        || String(batch.batch_id) !== String(turn.input_user_batch_id)) throw new Error(`v15 current batch missing for ${turn.turn_id}`);
      assertHex(batch.checksum, `${turn.turn_id} batch`);
      if (typeof batch.tombstone_commitment !== 'string' || !HEX64.test(batch.tombstone_commitment)) throw new Error(`v15 batch tombstone commitment missing for ${turn.turn_id}`);
      if (items.length === 0 || Number(batch.item_count) !== items.length || items.some((item, index) => Number(item.sequence) !== index || item.batch_id !== batch.batch_id)) throw new Error(`v15 batch item closure mismatch for ${turn.turn_id}`);
      if (String(batch.checksum) !== batchCanonicalChecksum(batch, items)) throw new Error(`v15 batch header checksum mismatch for ${turn.turn_id}`);
      if (String(batch.tombstone_commitment) !== batchTombstoneCommitment(batch, items)) throw new Error(`v15 batch tombstone commitment mismatch for ${turn.turn_id}`);
    }
    for (const item of items) {
      assertHex(item.checksum, `batch item ${item.message_id}`);
      if (inputMode === 'direct' && turn.authority_redacted_at == null && item.message_json === null) throw new Error(`v15 live batch item is redacted for ${item.message_id}`);
      if (item.message_json !== null && contentHash(jsonValue(item.message_json, `batch item ${item.message_id}`)) !== item.checksum) throw new Error(`v15 batch item checksum mismatch for ${item.message_id}`);
      const message = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(item.message_id);
      if (!message || message.turn_id !== root.turn_id
        || message.character_id !== turn.character_id || message.speaker_id !== 'user' || message.speaker_type !== 'user'
        || message.recipient_id !== turn.character_id || message.authority_group_id !== null || message.group_ordinal !== null) throw new Error(`v15 source message closure mismatch for ${item.message_id}`);
      assertHex(message.checksum, `message ${item.message_id}`);
      const itemValue = item.message_json === null ? null : jsonValue(item.message_json, `batch item ${item.message_id}`);
      const messageChecksumBasis = {
        messageId: String(message.message_id), turnId: String(message.turn_id), characterId: String(message.character_id),
        speakerId: String(message.speaker_id), speakerType: String(message.speaker_type), recipientId: String(message.recipient_id),
        content: String(message.content), sentAt: Number(message.sent_at), origin: String(message.origin),
        deviceId: message.device_id == null ? null : String(message.device_id),
        deviceSeq: message.device_seq == null ? null : Number(message.device_seq)
      };
      if (!(item.message_json === null && turn.authority_redacted_at != null)
        && contentHash(messageChecksumBasis) !== message.checksum) throw new Error(`v15 source message checksum mismatch for ${item.message_id}`);
      if (itemValue !== null && (itemValue.messageId !== message.message_id || itemValue.content !== message.content
        || Number(itemValue.sentAt) !== Number(message.sent_at) || itemValue.speakerId !== message.speaker_id
        || itemValue.speakerType !== message.speaker_type || itemValue.recipientId !== message.recipient_id)) {
        throw new Error(`v15 source message projection mismatch for ${item.message_id}`);
      }
      if (item.message_json === null && (message.content !== '' || turn.authority_redacted_at == null)) throw new Error(`v15 redacted message closure mismatch for ${item.message_id}`);
    }
    const lane = database.prepare('SELECT * FROM interaction_lanes WHERE role_id = ? AND lane_key = ?').get(turn.character_id, turn.lane_key);
    if (!lane || Number(lane.local_sequence) < Number(turn.input_visibility_sequence)) throw new Error(`v15 lane closure mismatch for ${turn.turn_id}`);
    if (['committed', 'delivered', 'completed'].includes(String(turn.state))) {
      const groupId = lineage.committed_group_id;
      const group = groupId && database.prepare('SELECT * FROM visible_result_groups WHERE group_id = ?').get(groupId);
      const receipt = groupId && database.prepare('SELECT * FROM visible_commit_receipts WHERE group_id = ?').get(groupId);
      const manifest = groupId && database.prepare('SELECT * FROM visible_result_manifests WHERE group_id = ?').get(groupId);
      if (!group || group.lineage_key !== turn.authority_lineage_key || group.authoritative_turn_id !== turn.turn_id || !receipt || receipt.authoritative_turn_id !== turn.turn_id || !manifest) throw new Error(`v15 result closure missing for ${turn.turn_id}`);
      if (String(group.role_id) !== String(turn.character_id) || String(group.lane_key) !== String(turn.lane_key)
        || !['pc', 'android_fallback'].includes(String(group.authority_origin))
        || String(group.authoritative_release_id) !== String(turn.authoritative_release_id)) {
        throw new Error(`v15 result authority identity mismatch for ${groupId}`);
      }
      if (String(receipt.lineage_key) !== String(turn.authority_lineage_key)
        || String(receipt.group_id) !== String(groupId)
        || String(receipt.authoritative_turn_id) !== String(turn.turn_id)
        || typeof receipt.commit_payload_version !== 'string' || receipt.commit_payload_version.length === 0
        || typeof receipt.authority_origin !== 'string' || receipt.authority_origin !== group.authority_origin) {
        throw new Error(`v15 receipt authority closure mismatch for ${groupId}`);
      }
      const redactedValues = [turn.authority_redacted_at, lineage.redacted_at, group.redacted_at, manifest.redacted_at]
        .filter(value => value !== null && value !== undefined).map(Number);
      const isRedacted = redactedValues.length > 0;
      if (isRedacted && (redactedValues.some(value => !Number.isSafeInteger(value) || value <= 0 || value !== redactedValues[0])
        || group.redacted_at == null || manifest.redacted_at == null || lineage.redacted_at == null
        || turn.authority_redacted_at == null)) {
        throw new Error(`v15 redacted result closure mismatch for ${groupId}`);
      }
      assertHex(group.reply_checksum, `${group.group_id} reply`);
      assertHex(group.generation_fingerprint, `${group.group_id} generation fingerprint`);
      assertHex(receipt.commit_checksum, `${group.group_id} receipt`);
      assertHex(manifest.semantic_checksum, `${group.group_id} manifest`);
      if (String(manifest.group_id) !== String(groupId)
        || String(manifest.authority_origin) !== String(group.authority_origin)
        || String(manifest.payload_version) !== String(receipt.commit_payload_version)
        || String(manifest.semantic_checksum) !== String(receipt.commit_checksum)) throw new Error(`v15 manifest authority closure mismatch for ${groupId}`);
      if (manifest.semantic_json === null && group.redacted_at === null) throw new Error(`v15 live manifest is redacted for ${group.group_id}`);
      if (!isRedacted && manifest.semantic_json !== null
        && contentHash(jsonValue(manifest.semantic_json, `${groupId} manifest`)) !== manifest.semantic_checksum) {
        throw new Error(`v15 manifest semantic checksum mismatch for ${groupId}`);
      }
      const groupItems = database.prepare('SELECT * FROM visible_result_items WHERE group_id = ? ORDER BY ordinal').all(groupId);
      const groupActions = database.prepare('SELECT * FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal').all(groupId);
      if (Number(group.item_count) !== groupItems.length || Number(group.action_count) !== groupActions.length
        || groupItems.some((item, index) => Number(item.ordinal) !== index)
        || groupActions.some((action, index) => Number(action.ordinal) !== index)
        || String(group.tombstone_commitment) !== visibleResultTombstoneCommitment(group, groupItems, groupActions)) {
        throw new Error(`v15 result tombstone commitment mismatch for ${groupId}`);
      }
      const itemValues = [];
      for (const item of groupItems) {
        assertHex(item.item_checksum, `result item ${item.message_id}`);
        if (isRedacted && (item.item_json !== null || Number(item.redacted_at) !== redactedValues[0])) throw new Error(`v15 redacted result item closure mismatch for ${item.message_id}`);
        if (!isRedacted && item.redacted_at !== null) throw new Error(`v15 live result item redacted for ${item.message_id}`);
        if (item.item_json !== null) {
          const itemValue = jsonValue(item.item_json, `result item ${item.message_id}`);
          if (!isRedacted && contentHash(itemValue) !== item.item_checksum) throw new Error(`v15 result item checksum mismatch for ${item.message_id}`);
          itemValues.push(itemValue);
        } else itemValues.push(null);
        const resultMessage = database.prepare('SELECT * FROM messages WHERE message_id = ?').get(item.message_id);
        if (!resultMessage || resultMessage.authority_group_id !== groupId || Number(resultMessage.group_ordinal) !== Number(item.ordinal)
          || resultMessage.turn_id !== turn.turn_id || resultMessage.character_id !== turn.character_id
          || resultMessage.speaker_id !== turn.character_id || resultMessage.speaker_type !== 'character' || resultMessage.recipient_id !== 'user') {
          throw new Error(`v15 result message projection mismatch for ${item.message_id}`);
        }
        if (isRedacted && resultMessage.content !== '') throw new Error(`v15 redacted result message closure mismatch for ${item.message_id}`);
        if (!isRedacted && contentHash({ messageId: String(resultMessage.message_id), content: String(resultMessage.content), recipientId: String(resultMessage.recipient_id) }) !== resultMessage.checksum) {
          throw new Error(`v15 result message checksum mismatch for ${item.message_id}`);
        }
        if (item.item_json !== null) {
          const value = jsonValue(item.item_json, `result item ${item.message_id}`);
          if (value.content !== resultMessage.content || value.speakerId !== resultMessage.speaker_id
            || value.speakerType !== resultMessage.speaker_type || value.recipientId !== resultMessage.recipient_id) {
            throw new Error(`v15 result message semantic mismatch for ${item.message_id}`);
          }
        }
      }
      const actionValues = [];
      for (const action of groupActions) {
        assertHex(action.action_checksum, `result action ${action.action_id}`);
        if (isRedacted) {
          if (action.action_kind !== null || action.target_key !== null || action.target_revision !== null
            || action.action_json !== null || Number(action.redacted_at) !== redactedValues[0]) {
            throw new Error(`v15 redacted result action closure mismatch for ${action.action_id}`);
          }
          actionValues.push(null);
          continue;
        }
        if (action.redacted_at !== null) throw new Error(`v15 live result action redacted for ${action.action_id}`);
        const actionValue = action.action_json === null ? null : jsonValue(action.action_json, `result action ${action.action_id}`);
        if (!isRedacted && actionValue !== null && contentHash(actionValue) !== action.action_checksum) throw new Error(`v15 result action checksum mismatch for ${action.action_id}`);
        if (typeof action.action_kind !== 'string' || !CLOSED_ACTION_KINDS.has(action.action_kind)
          || typeof action.target_key !== 'string' || !action.target_key) throw new Error(`v15 result action authority mismatch for ${action.action_id}`);
        actionValues.push({ kind: action.action_kind, targetKey: action.target_key, targetRevision: action.target_revision == null ? null : String(action.target_revision), payload: actionValue });
      }
      if (!isRedacted && String(group.reply_checksum) !== contentHash({ items: itemValues, actions: actionValues })) {
        throw new Error(`v15 result reply checksum mismatch for ${groupId}`);
      }
      const release = database.prepare('SELECT * FROM pipeline_releases WHERE release_id = ?').get(turn.authoritative_release_id);
      if (!release || typeof turn.authoritative_pipeline_checksum !== 'string' || !HEX64.test(turn.authoritative_pipeline_checksum)
        || typeof release.release_checksum !== 'string' || !HEX64.test(release.release_checksum)
        || turn.authoritative_pipeline_checksum !== release.release_checksum) throw new Error(`v15 release pin mismatch for ${turn.turn_id}`);
      if (['pc', 'android_fallback'].includes(String(group.authority_origin))) {
        const deliveries = database.prepare('SELECT * FROM cloud_deliveries WHERE authority_group_id = ?').all(groupId);
        if (String(group.authority_origin) === 'android_fallback') {
          if (deliveries.length !== 0) throw new Error(`v15 android fallback delivery target closure mismatch for ${groupId}`);
          if (isRedacted && (typeof group.redaction_delivery_commitment !== 'string' || !HEX64.test(group.redaction_delivery_commitment)
            || Number(group.redaction_delivery_count) !== 0
            || authorityRedactionDeliveriesCommitment(group, deliveries) !== group.redaction_delivery_commitment)) {
            throw new Error(`v15 android fallback redaction delivery commitment mismatch for ${groupId}`);
          }
        } else if (deliveries.length !== 1 || String(deliveries[0].turn_id) !== String(turn.turn_id)
          || String(deliveries[0].peer_id) !== String(turn.device_id)
          || String(deliveries[0].authority_group_id) !== String(groupId)
          || String(deliveries[0].authority_commit_checksum) !== String(receipt.commit_checksum)
          || !['waiting', 'pending', 'mailboxed', 'confirmed', 'redaction_pending', 'redacted', 'quarantined'].includes(String(deliveries[0].state))) {
          throw new Error(`v15 delivery target closure mismatch for ${groupId}`);
        } else if (isRedacted) {
          if (typeof group.redaction_delivery_commitment !== 'string' || !HEX64.test(group.redaction_delivery_commitment)
            || Number(group.redaction_delivery_count) !== deliveries.length
            || authorityRedactionDeliveriesCommitment(group, deliveries) !== group.redaction_delivery_commitment
            || deliveries.some(delivery => {
              if (delivery.payload_json !== null || delivery.checksum !== null) return true;
              const request = delivery.redaction_requested_at == null ? null : Number(delivery.redaction_requested_at);
              const acknowledged = delivery.redaction_acknowledged_at == null ? null : Number(delivery.redaction_acknowledged_at);
              if (delivery.state === 'redaction_pending') {
                return typeof delivery.relay_message_id !== 'string' || delivery.relay_message_id.length === 0
                  || request !== redactedValues[0] || acknowledged !== null;
              }
              if (delivery.state === 'redacted') {
                if (delivery.relay_message_id == null) return request !== null || acknowledged !== redactedValues[0];
                return request !== redactedValues[0] || !Number.isSafeInteger(acknowledged) || acknowledged < request;
              }
              return true;
            })) {
            throw new Error(`v15 redacted delivery lifecycle mismatch for ${groupId}`);
          }
        }
      }
    }
  }
  for (const lineage of lineages.values()) {
    const attempts = allTurns.filter(turn => String(turn.authority_lineage_key) === String(lineage.lineage_key));
    if (!attempts.length) {
      if (Number(lineage.attempt_count) !== 0) throw new Error(`v15 orphan lineage ${lineage.lineage_key}`);
      continue;
    }
    const roots = attempts.filter(turn => turn.retry_of_turn_id == null);
    if (roots.length !== 1 || roots[0].source_message_id !== lineage.root_source_id) throw new Error(`v15 lineage root closure mismatch for ${lineage.lineage_key}`);
    const sorted = attempts.slice().sort((left, right) => Number(left.lineage_revision_at_creation) - Number(right.lineage_revision_at_creation));
    const revisions = sorted.map(turn => Number(turn.lineage_revision_at_creation));
    if (revisions.some((revision, index) => !Number.isSafeInteger(revision) || revision !== index + 1)) throw new Error(`v15 lineage revision closure mismatch for ${lineage.lineage_key}`);
    if (String(lineage.latest_turn_id) !== String(sorted.at(-1).turn_id)) throw new Error(`v15 lineage latest closure mismatch for ${lineage.lineage_key}`);
    const expectedRevision = ['committed', 'delivered', 'completed', 'cancelled'].includes(String(lineage.state)) ? revisions.at(-1) + 1 : revisions.at(-1);
    if (Number(lineage.revision) !== expectedRevision) throw new Error(`v15 lineage current revision mismatch for ${lineage.lineage_key}`);
    if (Number(lineage.attempt_count) !== attempts.length || String(lineage.attempt_commitment) !== lineageAttemptCommitment(lineage, attempts, database)) throw new Error(`v15 lineage commitment mismatch for ${lineage.lineage_key}`);
    if (lineage.state === 'committed' && !lineage.committed_group_id) throw new Error(`v15 committed lineage group missing for ${lineage.lineage_key}`);
    if (lineage.state === 'cancelled' && lineage.redacted_at != null) {
      const redactedAt = Number(lineage.redacted_at);
      if (!Number.isSafeInteger(redactedAt) || redactedAt <= 0
        || attempts.some(turn => Number(turn.authority_redacted_at) !== redactedAt)
        || database.prepare('SELECT 1 FROM visible_result_groups WHERE lineage_key = ? LIMIT 1').get(lineage.lineage_key)
        || database.prepare('SELECT 1 FROM visible_commit_receipts WHERE lineage_key = ? LIMIT 1').get(lineage.lineage_key)
        || database.prepare('SELECT 1 FROM diagnostics WHERE turn_id IN (SELECT turn_id FROM turns WHERE authority_lineage_key = ?) LIMIT 1').get(lineage.lineage_key)
        || database.prepare('SELECT 1 FROM cloud_deliveries WHERE turn_id IN (SELECT turn_id FROM turns WHERE authority_lineage_key = ?) LIMIT 1').get(lineage.lineage_key)) {
        throw new Error(`v15 cancelled redacted lineage closure mismatch for ${lineage.lineage_key}`);
      }
    }
  }
  return { allTurns, lineages };
}

function stableAnonId(value, mapping, prefix) {
  if (!mapping.has(value)) mapping.set(value, `${prefix}_${mapping.size + 1}`);
  return mapping.get(value);
}

export function anonymizeSemanticIdentifiers(value, mapping = new Map(), key = '') {
  if (Array.isArray(value)) return value.map(item => anonymizeSemanticIdentifiers(item, mapping, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey, anonymizeSemanticIdentifiers(child, mapping, childKey)
    ]));
  }
  if (typeof value !== 'string') return value;
  if ((key === 'targetKey' || key === 'target_key') && value.includes(':')) {
    const [namespace, ...rest] = value.split(':');
    return `${namespace}:${stableAnonId(rest.join(':'), mapping, 'target')}`;
  }
  if (SEMANTIC_ID_KEYS.has(key)) {
    return stableAnonId(value, mapping, 'id');
  }
  return value;
}

function buildCandidateTurn(database, row, mapping) {
  const batch = database.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').get(row.turn_id);
  const batchItems = database.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence').all(row.turn_id);
  const lineage = database.prepare('SELECT * FROM turn_authority_lineages WHERE lineage_key = ?').get(row.authority_lineage_key);
  const group = database.prepare('SELECT * FROM visible_result_groups WHERE group_id = ?').get(lineage.committed_group_id);
  const resultItems = database.prepare('SELECT * FROM visible_result_items WHERE group_id = ? ORDER BY ordinal').all(group.group_id);
  const resultActions = database.prepare('SELECT * FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal').all(group.group_id);
  const projectPart = (value, messageId, label) => {
    const type = typeof value.type === 'string' && value.type.length ? value.type : 'text';
    if (!CLOSED_PART_TYPES.has(type)) throw new Error(`${label} part type is not closed`);
    const part = { messageId: stableAnonId(String(messageId), mapping, 'message'), type, text: String(value.content || value.text || '') };
    if (value.attachments !== undefined) {
      if (!Array.isArray(value.attachments)) throw new Error(`${label} attachments are malformed`);
      part.attachments = value.attachments.map((attachment, index) => {
        if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) throw new Error(`${label} attachment ${index} is malformed`);
        const allowed = ['mimeType', 'bytes', 'sha256', 'alt'];
        if (Object.keys(attachment).some(key => !allowed.includes(key))) throw new Error(`${label} attachment ${index} has unknown fields`);
        return { ...attachment };
      });
    }
    return part;
  };
  const userParts = batchItems.map(item => {
    const message = jsonValue(item.message_json, `candidate message ${item.message_id}`);
    return projectPart(message, item.message_id, 'candidate user');
  });
  const assistantParts = resultItems.filter(item => item.item_json !== null).map(item => {
    const value = jsonValue(item.item_json, `candidate result ${item.message_id}`);
    return projectPart(value, item.message_id, 'candidate result');
  });
  const actions = resultActions.map(action => ({
    ordinal: Number(action.ordinal), actionId: stableAnonId(String(action.action_id), mapping, 'action'),
    kind: String(action.action_kind), targetKey: anonymizeSemanticIdentifiers(String(action.target_key), mapping, 'targetKey'),
    targetRevision: action.target_revision == null ? null : String(action.target_revision),
    payload: action.action_json == null ? null : anonymizeSemanticIdentifiers(jsonValue(action.action_json, `candidate action ${action.action_id}`), mapping)
  }));
  actions.forEach(action => {
    if (!CLOSED_ACTION_KINDS.has(action.kind) || !action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) {
      throw new Error(`candidate action ${action.actionId} is not closed`);
    }
  });
  return {
    sourceTurnId: row.turn_id,
    at: Number(batch.started_at),
    speaker: 'user',
    batch: userParts,
    assistant: { at: Number(group.created_at), speaker: 'assistant', batch: assistantParts },
    persisted: {
      batchId: stableAnonId(String(batch.batch_id), mapping, 'batch'),
      batchChecksum: batch.checksum,
      groupId: stableAnonId(String(group.group_id), mapping, 'group'),
      commitChecksum: database.prepare('SELECT commit_checksum FROM visible_commit_receipts WHERE group_id = ?').get(group.group_id).commit_checksum,
      actionIds: actions.map(action => action.actionId), actions
    }
  };
}

function eligibleRows(database) {
  return database.prepare(`SELECT * FROM turns WHERE result_authority_version = 1 AND rollout_key = 'DIRECT_REPLY' AND state IN ('committed','delivered','completed') AND authority_redacted_at IS NULL ORDER BY character_id, lane_key, created_at, turn_id`).all();
}

function authorityWindowProjection(database, rows) {
  return rows.map(row => {
    const lineage = database.prepare('SELECT * FROM turn_authority_lineages WHERE lineage_key = ?').get(row.authority_lineage_key);
    const batch = database.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').get(row.turn_id);
    const batchItems = database.prepare('SELECT sequence, message_id, checksum, message_json, redacted_at FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence').all(row.turn_id);
    const group = lineage?.committed_group_id ? database.prepare('SELECT * FROM visible_result_groups WHERE group_id = ?').get(lineage.committed_group_id) : null;
    const receipt = group ? database.prepare('SELECT * FROM visible_commit_receipts WHERE group_id = ?').get(group.group_id) : null;
    const manifest = group ? database.prepare('SELECT * FROM visible_result_manifests WHERE group_id = ?').get(group.group_id) : null;
    const items = group ? database.prepare('SELECT ordinal, message_id, item_checksum, redacted_at FROM visible_result_items WHERE group_id = ? ORDER BY ordinal').all(group.group_id) : [];
    const actions = group ? database.prepare('SELECT ordinal, action_id, action_kind, target_key, target_revision, action_checksum, redacted_at FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal').all(group.group_id) : [];
    const lane = database.prepare('SELECT revision, local_sequence, clear_epoch, cleared_through_sequence FROM interaction_lanes WHERE role_id = ? AND lane_key = ?').get(row.character_id, row.lane_key);
    const release = database.prepare('SELECT release_id, release_checksum FROM pipeline_releases WHERE release_id = ?').get(row.authoritative_release_id);
    const deliveries = group ? database.prepare('SELECT peer_id, authority_group_id, authority_commit_checksum, recovery_ack_seq, state, relay_message_id FROM cloud_deliveries WHERE authority_group_id = ? ORDER BY peer_id').all(group.group_id) : [];
    return {
      turnId: String(row.turn_id), envelopeChecksum: String(row.envelope_checksum), authorityLineageKey: String(row.authority_lineage_key),
      retryOfTurnId: row.retry_of_turn_id == null ? null : String(row.retry_of_turn_id), lineageRevisionAtCreation: Number(row.lineage_revision_at_creation),
      inputUserBatchId: row.input_user_batch_id == null ? null : String(row.input_user_batch_id), inputVisibilitySequence: Number(row.input_visibility_sequence), inputClearEpoch: Number(row.input_clear_epoch || 0),
      authoritativeReleaseId: String(row.authoritative_release_id), authoritativePipelineChecksum: String(row.authoritative_pipeline_checksum),
      batch: batch ? { batchId: String(batch.batch_id), checksum: String(batch.checksum), itemCount: Number(batch.item_count), tombstoneCommitment: String(batch.tombstone_commitment), items: batchItems.map(item => ({ sequence: Number(item.sequence), messageId: String(item.message_id), checksum: String(item.checksum), semanticChecksum: item.message_json == null ? null : contentHash(jsonValue(item.message_json, `window batch ${item.message_id}`)), redactedAt: item.redacted_at == null ? null : Number(item.redacted_at) })) } : null,
      lineage: lineage ? { lineageKey: String(lineage.lineage_key), revision: Number(lineage.revision), latestTurnId: String(lineage.latest_turn_id), attemptCount: Number(lineage.attempt_count), attemptCommitment: String(lineage.attempt_commitment), redactedAt: lineage.redacted_at == null ? null : Number(lineage.redacted_at) } : null,
      group: group ? { groupId: String(group.group_id), lineageKey: String(group.lineage_key), authoritativeTurnId: String(group.authoritative_turn_id), roleId: String(group.role_id), laneKey: String(group.lane_key), authorityOrigin: String(group.authority_origin), authoritativeReleaseId: String(group.authoritative_release_id), generationFingerprint: String(group.generation_fingerprint), replyChecksum: String(group.reply_checksum), itemCount: Number(group.item_count), actionCount: Number(group.action_count), tombstoneCommitment: String(group.tombstone_commitment), redactionDeliveryCount: group.redaction_delivery_count == null ? null : Number(group.redaction_delivery_count), redactionDeliveryCommitment: group.redaction_delivery_commitment == null ? null : String(group.redaction_delivery_commitment), redactedAt: group.redacted_at == null ? null : Number(group.redacted_at), items: items.map(item => ({ ordinal: Number(item.ordinal), messageId: String(item.message_id), itemChecksum: String(item.item_checksum), redactedAt: item.redacted_at == null ? null : Number(item.redacted_at) })), actions: actions.map(action => ({ ordinal: Number(action.ordinal), actionId: String(action.action_id), kind: action.action_kind, targetKey: action.target_key, targetRevision: action.target_revision, actionChecksum: String(action.action_checksum), redactedAt: action.redacted_at == null ? null : Number(action.redacted_at) })) } : null,
      receipt: receipt ? { lineageKey: String(receipt.lineage_key), groupId: String(receipt.group_id), authoritativeTurnId: String(receipt.authoritative_turn_id), authorityOrigin: String(receipt.authority_origin), commitPayloadVersion: String(receipt.commit_payload_version), commitChecksum: String(receipt.commit_checksum), committedAt: Number(receipt.committed_at) } : null,
      manifest: manifest ? { groupId: String(manifest.group_id), payloadVersion: String(manifest.payload_version), semanticChecksum: String(manifest.semantic_checksum), redactedAt: manifest.redacted_at == null ? null : Number(manifest.redacted_at) } : null,
      deliveries: deliveries.map(item => ({ peerId: String(item.peer_id), groupId: String(item.authority_group_id), commitChecksum: String(item.authority_commit_checksum), recoveryAckSeq: Number(item.recovery_ack_seq), state: String(item.state), relayMessageId: item.relay_message_id == null ? null : String(item.relay_message_id) })),
      lane: lane ? { revision: Number(lane.revision), localSequence: Number(lane.local_sequence), clearEpoch: Number(lane.clear_epoch || 0), clearedThroughSequence: Number(lane.cleared_through_sequence || 0) } : null,
      release: release ? { releaseId: String(release.release_id), releaseChecksum: String(release.release_checksum) } : null
    };
  });
}

function buildCandidates(database, rows) {
  const candidates = [];
  let current = null;
  for (const row of rows) {
    const batch = database.prepare('SELECT started_at, committed_at FROM current_user_batches WHERE turn_id = ?').get(row.turn_id);
    if (!batch) continue;
    const gap = current && (Number(batch.started_at) - current.endedAt);
    const sameStream = current && current.roleId === row.character_id && current.laneKey === row.lane_key && gap >= 0 && gap <= 15 * 60 * 1000;
    if (!sameStream || current.turnRows.length >= 6) {
      if (current && current.turnRows.length >= 2) candidates.push(current);
      current = { roleId: row.character_id, laneKey: row.lane_key, startedAt: Number(batch.started_at), endedAt: Number(batch.committed_at), turnRows: [] };
    }
    current.turnRows.push(row);
    current.endedAt = Number(batch.committed_at);
  }
  if (current && current.turnRows.length >= 2) candidates.push(current);
  return candidates.map((window, index) => {
    const raw = { roleId: window.roleId, laneKey: window.laneKey, startedAt: window.startedAt, endedAt: window.endedAt, turns: authorityWindowProjection(database, window.turnRows) };
    const sourceWindowChecksum = contentHash(raw);
    const mapping = new Map();
    const turns = window.turnRows.flatMap(row => {
      const candidate = buildCandidateTurn(database, row, mapping);
      return [
        { at: candidate.at, speaker: candidate.speaker, batch: candidate.batch },
        candidate.assistant
      ];
    });
    if (turns.length < 4 || turns.length > 12) throw new Error(`candidate window turn count is outside 4..12: ${window.turnRows.length}`);
    const persistedContextProjection = {
      roleId: 'anon_role_1', laneKey: 'anon_lane_1',
      turnCount: window.turnRows.length,
      turnIds: window.turnRows.map(row => stableAnonId(String(row.turn_id), mapping, 'turn')),
      inputVisibilitySequences: window.turnRows.map(row => Number(row.input_visibility_sequence)),
      clearEpochs: window.turnRows.map(row => Number(row.input_clear_epoch || 0)),
      releaseChecksums: [...new Set(window.turnRows.map(row => row.authoritative_pipeline_checksum).filter(Boolean))],
      groups: window.turnRows.map(row => buildCandidateTurn(database, row, mapping).persisted)
    };
    return {
      windowId: `history_window_${String(index).padStart(3, '0')}`,
      sourceWindowChecksum,
      roleId: 'anon_role_1',
      laneKey: 'anon_lane_1',
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      turns,
      persistedContextProjection
    };
  });
}

function assertNativeStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be a string array`);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function assertNativeJson(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} has invalid number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNativeJson(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`${label} key is malformed`);
      assertNativeJson(item, `${label}.${key}`);
    });
    return;
  }
  throw new Error(`${label} has invalid native type`);
}

function assertInitialState(value) {
  assertExactKeys(value, ['relationship', 'lifeSignals', 'currentStances', 'verifiedFacts'], 'history label initialState');
  assertExactKeys(value.relationship, ['base', 'phase'], 'history label relationship');
  if (typeof value.relationship.base !== 'string' || typeof value.relationship.phase !== 'string') {
    throw new Error('history label relationship type conflict');
  }
  if (!Array.isArray(value.lifeSignals) || !Array.isArray(value.currentStances) || !Array.isArray(value.verifiedFacts)) {
    throw new Error('history label initialState array conflict');
  }
  value.lifeSignals.forEach((item, index) => {
    assertExactKeys(item, ['id', 'kind', 'value'], `history label lifeSignals[${index}]`);
    assertNativeJson(item, `history label lifeSignals[${index}]`);
  });
  value.currentStances.forEach((item, index) => {
    assertExactKeys(item, ['subject', 'value'], `history label currentStances[${index}]`);
    assertNativeJson(item, `history label currentStances[${index}]`);
  });
  value.verifiedFacts.forEach((item, index) => {
    assertExactKeys(item, ['id', 'predicate', 'object'], `history label verifiedFacts[${index}]`);
    assertNativeJson(item, `history label verifiedFacts[${index}]`);
  });
}

function assertLabel(label) {
  if (!label || typeof label !== 'object' || Array.isArray(label)) throw new Error('history label must be an object');
  for (const key of Object.keys(label)) {
    if (FORBIDDEN_LABEL_KEYS.has(key)) throw new Error(`history label may not override ${key}`);
    if (!LABEL_KEYS.has(key)) throw new Error(`history label has unknown field ${key}`);
  }
  for (const key of ['windowId', 'sourceWindowChecksum', 'annotatorVersion', 'structure', 'severity']) if (typeof label[key] !== 'string' || label[key].length === 0) throw new Error(`history label ${key} must be a string`);
  assertHex(label.sourceWindowChecksum, 'history label sourceWindowChecksum');
  if (!REQUIRED_STRUCTURES.includes(label.structure) || !['critical', 'high', 'medium'].includes(label.severity)) throw new Error('history label closed enum conflict');
  assertInitialState(label.initialState);
  for (const key of ['mustNotice', 'allowedDecisionRange', 'forbiddenFailurePatterns', 'allowedPersonalityVariation']) assertNativeStringArray(label[key], `history label ${key}`);
  assertExactKeys(label.requiredActionIntegrity, ['required', 'allowedKinds'], 'history label action integrity');
  if (typeof label.requiredActionIntegrity.required !== 'boolean') throw new Error('history label action integrity is malformed');
  assertNativeStringArray(label.requiredActionIntegrity.allowedKinds, 'history label action integrity allowedKinds');
  assertExactKeys(label.expectedStateTransitions, ['allow'], 'history label expectedStateTransitions');
  assertNativeStringArray(label.expectedStateTransitions.allow, 'history label expectedStateTransitions.allow');
  assertExactKeys(label.forbiddenStateTransitions, ['hardConstraintFromYuqiPreference'], 'history label forbiddenStateTransitions');
  if (typeof label.forbiddenStateTransitions.hardConstraintFromYuqiPreference !== 'boolean') throw new Error('history label forbidden transition type conflict');
}

function readLabels(labelsPath) {
  if (!labelsPath) return null;
  if (!isAbsolute(labelsPath)) throw new Error('--labels must be an absolute private JSONL path');
  const labels = readFileSync(labelsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  labels.forEach(assertLabel);
  if (new Set(labels.map(label => label.windowId)).size !== labels.length) throw new Error('history labels contain duplicate windowId');
  return labels;
}

function privatePath(root, optionValue, defaultRelative) {
  const privateRoot = resolve(root, 'artifacts/yuqi-lived-agency-v3/private');
  const outputPath = resolve(root, optionValue || defaultRelative);
  const rel = relative(privateRoot, outputPath);
  if (rel.startsWith('..') || isAbsolute(rel) || outputPath === privateRoot) throw new Error('output must remain under artifacts/yuqi-lived-agency-v3/private');
  return outputPath;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

function atomicWritePair(output, outputText, manifest, manifestText, { faultAt = null } = {}) {
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(manifest), { recursive: true });
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const outputTemporary = `${output}${suffix}`;
  const manifestTemporary = `${manifest}${suffix}`;
  const outputBackup = `${output}.bak-${process.pid}-${Date.now()}`;
  const manifestBackup = `${manifest}.bak-${process.pid}-${Date.now()}`;
  let outputBackedUp = false;
  let manifestBackedUp = false;
  let outputPublished = false;
  let manifestPublished = false;
  let publicationComplete = false;
  try {
    writeFileSync(outputTemporary, outputText, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(manifestTemporary, manifestText, { encoding: 'utf8', flag: 'wx' });
    const stagedScenes = outputText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const stagedManifest = JSON.parse(manifestText);
    if (stagedScenes.length !== 30 || stagedManifest.scenesChecksum !== contentHash(stagedScenes)) {
      throw new Error('staged history generation is internally inconsistent');
    }
    if (existsSync(output)) { renameSync(output, outputBackup); outputBackedUp = true; }
    if (existsSync(manifest)) { renameSync(manifest, manifestBackup); manifestBackedUp = true; }
    renameSync(outputTemporary, output);
    outputPublished = true;
    if (faultAt === 'before_manifest_rename') throw new Error('forced pair publication fault: before_manifest_rename');
    renameSync(manifestTemporary, manifest);
    manifestPublished = true;
    publicationComplete = true;
    if (outputBackedUp) rmSync(outputBackup, { force: true });
    if (faultAt === 'after_output_backup_cleanup') throw new Error('forced pair cleanup fault: after_output_backup_cleanup');
    if (faultAt === 'before_manifest_backup_cleanup') throw new Error('forced pair cleanup fault: before_manifest_backup_cleanup');
    if (manifestBackedUp) rmSync(manifestBackup, { force: true });
  } catch (error) {
    rmSync(outputTemporary, { force: true });
    rmSync(manifestTemporary, { force: true });
    if (publicationComplete) throw error;
    if (outputPublished && existsSync(output)) rmSync(output, { force: true });
    if (manifestPublished && existsSync(manifest)) rmSync(manifest, { force: true });
    if (outputBackedUp && existsSync(outputBackup)) renameSync(outputBackup, output);
    if (manifestBackedUp && existsSync(manifestBackup)) renameSync(manifestBackup, manifest);
    throw error;
  }
}

export function extractRealHistoryScenes({ databasePath, outputPath, manifestPath, candidatesPath, labelsPath, limit = 30, root = process.cwd() }) {
  if (!databasePath || !isAbsolute(databasePath)) throw new Error('databasePath must be an absolute path');
  if (!Number.isSafeInteger(limit) || limit !== 30) throw new Error('real history extraction requires exactly 30 scenes');
  const candidateOutput = privatePath(root, candidatesPath, 'artifacts/yuqi-lived-agency-v3/private/real-history-candidates.jsonl');
  const output = privatePath(root, outputPath, 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl');
  const manifest = privatePath(root, manifestPath, 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.manifest.json');
  const before = sourceSha256(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertReadonlyV15Schema(database);
    assertAuthorityClosure(database);
    const candidates = buildCandidates(database, eligibleRows(database));
    if (candidates.length < limit) throw new Error(`need at least ${limit} eligible 4..12 turn windows; got ${candidates.length}`);
    const selectedCandidates = candidates.slice(0, limit);
    const candidateText = `${selectedCandidates.map(candidate => JSON.stringify(candidate)).join('\n')}\n`;
    writeAtomic(candidateOutput, candidateText);
    const labels = readLabels(labelsPath);
    const afterValidation = sourceSha256(databasePath);
    if (afterValidation !== before) throw new Error('source database changed during readonly extraction');
    if (!labels) return {
      count: selectedCandidates.length, candidatesPath: candidateOutput,
      candidatesChecksum: contentHash(selectedCandidates), sourceDatabaseChecksum: before, labeled: false
    };
    if (labels.length !== limit) throw new Error(`labels must contain exactly ${limit} windows; got ${labels.length}`);
    const candidateMap = new Map(selectedCandidates.map(candidate => [candidate.windowId, candidate]));
    const labelMap = new Map(labels.map(label => [label.windowId, label]));
    if (labelMap.size !== candidateMap.size || [...candidateMap.keys()].some(windowId => !labelMap.has(windowId))) throw new Error('labels must bind exactly the selected candidate windows');
    if (new Set(labels.map(label => label.structure)).size < REQUIRED_STRUCTURES.length) throw new Error('labels must cover all nine required structures');
    const scenes = selectedCandidates.map((candidate, index) => {
      const label = labelMap.get(candidate.windowId);
      if (label.sourceWindowChecksum !== candidate.sourceWindowChecksum) throw new Error(`stale history label for ${candidate.windowId}`);
      return {
        sceneId: `local_history_${String(index).padStart(2, '0')}`,
        rolloutKey: 'DIRECT_REPLY',
        initialState: label.initialState,
        turns: candidate.turns,
        mustNotice: label.mustNotice,
        allowedDecisionRange: label.allowedDecisionRange,
        forbiddenFailurePatterns: label.forbiddenFailurePatterns,
        requiredActionIntegrity: label.requiredActionIntegrity,
        allowedPersonalityVariation: label.allowedPersonalityVariation,
        expectedStateTransitions: label.expectedStateTransitions,
        forbiddenStateTransitions: label.forbiddenStateTransitions,
        sourceAnnotation: { file: 'private_history_labels', heading: label.structure },
        severity: label.severity
      };
    });
    const jsonl = `${scenes.map(scene => JSON.stringify(scene)).join('\n')}\n`;
    const scenesChecksum = contentHash(scenes);
    const manifestValue = { schemaVersion: 1, sceneIds: scenes.map(scene => scene.sceneId), scenesChecksum };
    atomicWritePair(output, jsonl, manifest, `${JSON.stringify(manifestValue)}\n`);
    const after = sourceSha256(databasePath);
    if (after !== before) throw new Error('source database changed during readonly extraction');
    return { count: scenes.length, checksum: manifestValue.scenesChecksum, output, manifest, candidatesPath: candidateOutput, labeled: true };
  } finally { database.close(); }
}

export { CLOSED_ACTION_KINDS, assertAuthorityClosure, rootAttempt, atomicWritePair };

if (isMain()) {
  const args = argumentMap();
  const databasePath = args.get('database');
  if (typeof databasePath !== 'string' || databasePath.length === 0) throw new Error('--database is required; production config is never read');
  const root = resolve(typeof args.get('root') === 'string' ? args.get('root') : process.cwd());
  const result = extractRealHistoryScenes({
    databasePath: resolve(databasePath), root, labelsPath: typeof args.get('labels') === 'string' ? resolve(args.get('labels')) : null,
    outputPath: args.get('out'), manifestPath: args.get('manifest'), candidatesPath: args.get('candidates'), limit: Number(args.get('limit') || 30)
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
