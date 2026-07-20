import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { TURN_STATES, canonicalJson, contentHash, validateEnvelope } from './protocol.mjs';

const TURN_PATCH_COLUMNS = new Map([
  ['memoryPacketJson', 'memory_packet_json'],
  ['brainDraftJson', 'brain_draft_json'],
  ['supervisorJson', 'supervisor_json'],
  ['replyJson', 'reply_json'],
  ['errorJson', 'error_json'],
  ['origin', 'origin']
]);

function now() {
  return Date.now();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapTurn(row) {
  if (!row) return null;
  return {
    turnId: row.turn_id,
    characterId: row.character_id,
    deviceId: row.device_id,
    deviceSeq: row.device_seq,
    sourceMessageId: row.source_message_id,
    state: row.state,
    route: row.route || 'deep',
    routeReasons: parseJson(row.route_reasons_json, []),
    workerId: row.worker_id || '',
    origin: row.origin,
    memoryPacketJson: row.memory_packet_json,
    brainDraftJson: row.brain_draft_json,
    supervisorJson: row.supervisor_json,
    replyJson: row.reply_json,
    errorJson: row.error_json,
    envelopeJson: row.envelope_json,
    envelopeChecksum: row.envelope_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    messageId: row.message_id,
    turnId: row.turn_id,
    characterId: row.character_id,
    speakerId: row.speaker_id,
    speakerType: row.speaker_type,
    recipientId: row.recipient_id,
    content: row.content,
    sentAt: row.sent_at,
    origin: row.origin,
    deviceId: row.device_id || '',
    deviceSeq: row.device_seq ?? null,
    checksum: row.checksum
  };
}

function mapTurnStage(row) {
  if (!row) return null;
  return {
    stage: row.stage,
    ordinal: row.ordinal,
    model: row.model || '',
    effort: row.effort || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms ?? null
  };
}

function mapFact(row) {
  if (!row) return null;
  const stored = parseJson(row.fact_json, null);
  if (stored) return stored;
  return {
    factId: row.fact_id,
    characterId: row.character_id,
    subjectId: row.subject_id,
    predicate: row.predicate,
    object: parseJson(row.object_json, null),
    evidenceMode: row.evidence_mode,
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    exactQuotes: parseJson(row.exact_quotes_json, []),
    status: row.status,
    confidence: row.confidence,
    supersedes: row.supersedes || null,
    origin: row.origin,
    createdAt: row.created_at,
    verifiedAt: row.verified_at
  };
}

function mapPresetVersion(row) {
  if (!row) return null;
  return parseJson(row.manifest_json, null);
}

function mapAnnotation(row) {
  if (!row) return null;
  return {
    ...parseJson(row.annotation_json, {}),
    annotationId: row.annotation_id,
    turnId: row.turn_id,
    sourceMessageId: row.source_message_id || null,
    presetVersion: row.preset_version,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapCloudDelivery(row) {
  if (!row) return null;
  return {
    turnId: row.turn_id,
    peerId: row.peer_id,
    recoveryAckSeq: row.recovery_ack_seq,
    state: row.state,
    payloadJson: row.payload_json,
    checksum: row.checksum || '',
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    confirmedAt: row.confirmed_at ?? null
  };
}

export class YuqiStore {
  constructor(filename) {
    if (!filename) throw new Error('database filename is required');
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.closed = false;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  open() {
    if (this.closed) throw new Error('store is closed');
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_seq INTEGER NOT NULL,
        source_message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        worker_id TEXT,
        origin TEXT NOT NULL DEFAULT 'codex',
        memory_packet_json TEXT,
        brain_draft_json TEXT,
        supervisor_json TEXT,
        reply_json TEXT,
        error_json TEXT,
        envelope_json TEXT NOT NULL,
        envelope_checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(device_id, device_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_state_created ON turns(state, created_at);

      CREATE TABLE IF NOT EXISTS turn_stages (
        turn_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        model TEXT,
        effort TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        PRIMARY KEY(turn_id, stage, ordinal),
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_stages_turn_ordinal
        ON turn_stages(turn_id, ordinal);

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        speaker_type TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        origin TEXT NOT NULL DEFAULT 'codex',
        device_id TEXT,
        device_seq INTEGER,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_character_time ON messages(character_id, sent_at DESC);

      CREATE TABLE IF NOT EXISTS facts (
        fact_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_json TEXT NOT NULL,
        evidence_mode TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        exact_quotes_json TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        supersedes TEXT,
        origin TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        verified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_facts_character_status ON facts(character_id, status);

      CREATE TABLE IF NOT EXISTS sync_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_cursors (
        peer_id TEXT PRIMARY KEY,
        ack_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cloud_deliveries (
        turn_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        recovery_ack_seq INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'waiting',
        payload_json TEXT,
        checksum TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        PRIMARY KEY(turn_id, peer_id),
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_deliveries_state_updated
        ON cloud_deliveries(state, updated_at);

      CREATE TABLE IF NOT EXISTS sessions (
        role TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preset_versions (
        version TEXT PRIMARY KEY,
        parent_version TEXT,
        manifest_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        published_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS annotations (
        annotation_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        source_message_id TEXT,
        preset_version TEXT NOT NULL,
        annotation_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagnostics (
        diagnostic_id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT,
        stage TEXT NOT NULL,
        level TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suppressed_messages (
        message_id TEXT PRIMARY KEY,
        authoritative_message_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(message_id)
      );
    `);

    const factColumns = new Set(this.db.prepare('PRAGMA table_info(facts)').all().map(row => row.name));
    if (!factColumns.has('fact_json')) this.db.exec('ALTER TABLE facts ADD COLUMN fact_json TEXT;');
    const turnColumns = new Set(this.db.prepare('PRAGMA table_info(turns)').all().map(row => row.name));
    if (!turnColumns.has('route')) this.db.exec("ALTER TABLE turns ADD COLUMN route TEXT NOT NULL DEFAULT 'deep';");
    if (!turnColumns.has('route_reasons_json')) this.db.exec("ALTER TABLE turns ADD COLUMN route_reasons_json TEXT NOT NULL DEFAULT '[]';");
    const deliveryColumns = new Set(this.db.prepare('PRAGMA table_info(cloud_deliveries)').all().map(row => row.name));
    if (!deliveryColumns.has('confirmed_at')) this.db.exec('ALTER TABLE cloud_deliveries ADD COLUMN confirmed_at INTEGER;');
    this.db.exec(`
      UPDATE cloud_deliveries
      SET state = 'mailboxed'
      WHERE state = 'delivered' AND confirmed_at IS NULL;

      INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
      SELECT m.message_id, m.message_id, 'pending_phone_receipt', CAST(strftime('%s','now') AS INTEGER) * 1000
      FROM messages m
      JOIN turns t ON t.turn_id = m.turn_id
      JOIN cloud_deliveries d ON d.turn_id = t.turn_id
      WHERE m.speaker_type = 'character'
        AND json_extract(t.envelope_json, '$.kind') IN ('PROACTIVE_CHAT', 'PROACTIVE_MOMENT')
        AND d.state != 'confirmed';
    `);
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  appendSync(entityType, entityId, operation, payload) {
    const payloadJson = canonicalJson(payload);
    const checksum = contentHash(payload);
    const result = this.db.prepare(`
      INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entityType, entityId, operation, payloadJson, checksum, now());
    return Number(result.lastInsertRowid);
  }

  submitTurn(input) {
    const envelope = validateEnvelope(input);
    const envelopeChecksum = contentHash(envelope);
    const sourceMessageId = envelope.message?.messageId || envelope.trigger?.triggerId || '';
    const existing = this.getTurn(envelope.turnId);
    if (existing) {
      if (existing.envelopeChecksum !== envelopeChecksum) throw new Error('turn checksum conflict');
      return existing;
    }

    const sequenceOwner = this.db.prepare(
      'SELECT turn_id, source_message_id FROM turns WHERE device_id = ? AND device_seq = ?'
    ).get(envelope.deviceId, envelope.deviceSeq);
    if (sequenceOwner && sequenceOwner.source_message_id !== sourceMessageId) {
      throw new Error('device sequence conflict');
    }

    return this.transaction(() => {
      if (envelope.message) {
        this.putMessageInternal({
          ...envelope.message,
          turnId: envelope.turnId,
          characterId: envelope.characterId,
          origin: 'phone',
          deviceId: envelope.deviceId,
          deviceSeq: envelope.deviceSeq
        });
      }

      this.db.prepare(`
        INSERT INTO turns(
          turn_id, character_id, device_id, device_seq, source_message_id,
          state, origin, envelope_json, envelope_checksum, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 'codex', ?, ?, ?, ?)
      `).run(
        envelope.turnId,
        envelope.characterId,
        envelope.deviceId,
        envelope.deviceSeq,
        sourceMessageId,
        canonicalJson(envelope),
        envelopeChecksum,
        envelope.createdAt,
        now()
      );
      const turn = this.getTurn(envelope.turnId);
      this.appendSync('turn', envelope.turnId, 'insert', turn);
      return turn;
    });
  }

  getTurn(turnId) {
    return mapTurn(this.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId));
  }

  setTurnRoute(turnId, route, reasons = []) {
    if (!['fast', 'deep', 'fast_to_deep'].includes(route)) throw new Error('invalid turn route');
    const result = this.db.prepare(`
      UPDATE turns SET route = ?, route_reasons_json = ?, updated_at = ? WHERE turn_id = ?
    `).run(route, canonicalJson([...new Set(reasons.map(String))]), now(), turnId);
    if (Number(result.changes) !== 1) throw new Error('turn not found');
    return this.getTurn(turnId);
  }

  beginStage(turnId, stage, model = null, effort = null, startedAt = now()) {
    if (!String(stage || '').trim()) throw new Error('stage is required');
    if (!this.getTurn(turnId)) throw new Error('turn not found');
    const active = this.db.prepare(`
      SELECT * FROM turn_stages
      WHERE turn_id = ? AND stage = ? AND finished_at IS NULL
      ORDER BY ordinal DESC LIMIT 1
    `).get(turnId, stage);
    if (active) return mapTurnStage(active);
    const ordinal = Number(this.db.prepare(
      'SELECT COALESCE(MAX(ordinal), 0) AS value FROM turn_stages WHERE turn_id = ?'
    ).get(turnId)?.value || 0) + 1;
    this.db.prepare(`
      INSERT INTO turn_stages(turn_id, stage, ordinal, model, effort, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(turnId, stage, ordinal, model, effort, Number(startedAt));
    return mapTurnStage(this.db.prepare(
      'SELECT * FROM turn_stages WHERE turn_id = ? AND stage = ? AND ordinal = ?'
    ).get(turnId, stage, ordinal));
  }

  finishStage(turnId, stage, finishedAt = now()) {
    const active = this.db.prepare(`
      SELECT * FROM turn_stages
      WHERE turn_id = ? AND stage = ? AND finished_at IS NULL
      ORDER BY ordinal DESC LIMIT 1
    `).get(turnId, stage);
    if (!active) return null;
    const durationMs = Math.max(0, Number(finishedAt) - Number(active.started_at));
    this.db.prepare(`
      UPDATE turn_stages SET finished_at = ?, duration_ms = ?
      WHERE turn_id = ? AND stage = ? AND ordinal = ?
    `).run(Number(finishedAt), durationMs, turnId, stage, active.ordinal);
    return mapTurnStage(this.db.prepare(
      'SELECT * FROM turn_stages WHERE turn_id = ? AND stage = ? AND ordinal = ?'
    ).get(turnId, stage, active.ordinal));
  }

  getTurnStages(turnId) {
    return this.db.prepare(`
      SELECT * FROM turn_stages WHERE turn_id = ? ORDER BY ordinal ASC
    `).all(turnId).map(mapTurnStage);
  }

  listRecoverableTurns() {
    return this.db.prepare(`
      SELECT * FROM turns
      WHERE state IN (
        'queued', 'memory_running', 'memory_done', 'brain_running',
        'brain_done', 'supervisor_running', 'approved'
      )
      ORDER BY created_at ASC, turn_id ASC
    `).all().map(mapTurn);
  }

  registerCloudDelivery(turnId, peerId, recoveryAckSeq = 0) {
    if (!this.getTurn(turnId)) throw new Error('turn not found');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(peerId || ''))) throw new Error('invalid cloud peer');
    const ackSeq = Math.max(0, Number(recoveryAckSeq) || 0);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO cloud_deliveries(
        turn_id, peer_id, recovery_ack_seq, state, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'waiting', 0, ?, ?)
      ON CONFLICT(turn_id, peer_id) DO UPDATE SET
        recovery_ack_seq = MAX(cloud_deliveries.recovery_ack_seq, excluded.recovery_ack_seq),
        updated_at = excluded.updated_at
    `).run(turnId, String(peerId), ackSeq, timestamp, timestamp);
    return mapCloudDelivery(this.db.prepare(
      'SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?'
    ).get(turnId, String(peerId)));
  }

  listCloudDeliveries(turnId) {
    return this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? ORDER BY peer_id ASC
    `).all(turnId).map(mapCloudDelivery);
  }

  listPendingCloudDeliveries(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(`
      SELECT * FROM cloud_deliveries
      WHERE state IN ('waiting', 'pending')
      ORDER BY updated_at ASC, turn_id ASC, peer_id ASC LIMIT ?
    `).all(safeLimit).map(mapCloudDelivery);
  }

  prepareCloudDelivery(turnId, peerId, payload) {
    const payloadJson = canonicalJson(payload);
    const checksum = contentHash(payload);
    const existing = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, peerId);
    if (!existing) throw new Error('cloud delivery not found');
    if (existing.checksum && existing.checksum !== checksum) throw new Error('cloud delivery checksum conflict');
    if (existing.state !== 'delivered') {
      this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'pending', payload_json = ?, checksum = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ?
      `).run(payloadJson, checksum, now(), turnId, peerId);
    }
    return mapCloudDelivery(this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, peerId));
  }

  markCloudDeliveryAttempt(turnId, peerId) {
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET attempts = attempts + 1, updated_at = ?
      WHERE turn_id = ? AND peer_id = ? AND state = 'pending'
    `).run(now(), turnId, peerId);
    if (Number(result.changes) !== 1) throw new Error('pending cloud delivery not found');
  }

  markCloudDeliveryDelivered(turnId, peerId, checksum) {
    return this.markCloudDeliveryMailboxed(turnId, peerId, checksum);
  }

  markCloudDeliveryMailboxed(turnId, peerId, checksum) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = ?, updated_at = ?
      WHERE turn_id = ? AND peer_id = ? AND state = 'pending' AND checksum = ?
    `).run(timestamp, timestamp, turnId, peerId, checksum);
    if (Number(result.changes) !== 1) throw new Error('cloud delivery acknowledgement conflict');
    return mapCloudDelivery(this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, peerId));
  }

  confirmCloudDelivery(turnId, peerId, receipt) {
    const message = this.getMessage(String(receipt?.messageId || ''));
    if (!message || message.turnId !== turnId || message.speakerType !== 'character') {
      throw new Error('delivery receipt message mismatch');
    }
    const expectedHash = createHash('sha256').update(message.content, 'utf8').digest('hex');
    if (String(receipt?.contentSha256 || '') !== expectedHash) {
      throw new Error('delivery receipt content checksum mismatch');
    }
    const delivery = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, String(peerId));
    if (!delivery) throw new Error('cloud delivery not found');
    if (delivery.state === 'confirmed') return mapCloudDelivery(delivery);
    if (!['mailboxed', 'delivered'].includes(delivery.state)) {
      throw new Error('cloud delivery is not awaiting a phone receipt');
    }
    const confirmedAt = Math.max(1, Number(receipt?.receivedAt) || now());
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'confirmed', confirmed_at = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND state IN ('mailboxed', 'delivered')
      `).run(confirmedAt, now(), turnId, String(peerId));
      if (Number(result.changes) !== 1) throw new Error('cloud delivery confirmation conflict');
      this.db.prepare(`
        DELETE FROM suppressed_messages
        WHERE message_id = ? AND reason = 'pending_phone_receipt'
      `).run(message.messageId);
      return mapCloudDelivery(this.db.prepare(`
        SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
      `).get(turnId, String(peerId)));
    });
  }

  claimTurn(workerId) {
    if (!workerId) throw new Error('workerId is required');
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT turn_id FROM turns WHERE state = 'queued' ORDER BY created_at, turn_id LIMIT 1"
      ).get();
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE turns SET state = 'memory_running', worker_id = ?, updated_at = ?
        WHERE turn_id = ? AND state = 'queued'
      `).run(workerId, now(), row.turn_id);
      if (Number(result.changes) !== 1) return null;
      const turn = this.getTurn(row.turn_id);
      this.appendSync('turn', row.turn_id, 'state', turn);
      return turn;
    });
  }

  claimTurnById(turnId, workerId) {
    if (!workerId) throw new Error('workerId is required');
    const result = this.db.prepare(`
      UPDATE turns SET state = 'memory_running', worker_id = ?, updated_at = ?
      WHERE turn_id = ? AND state = 'queued'
    `).run(workerId, now(), turnId);
    if (Number(result.changes) !== 1) return null;
    const turn = this.getTurn(turnId);
    this.appendSync('turn', turnId, 'state', turn);
    return turn;
  }

  advanceTurn(turnId, expectedState, nextState, patch = {}) {
    if (!TURN_STATES.includes(expectedState) || !TURN_STATES.includes(nextState)) {
      throw new Error('unknown turn state');
    }
    const current = this.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state !== expectedState) throw new Error('stale turn state');

    const assignments = ['state = ?', 'updated_at = ?'];
    const values = [nextState, now()];
    for (const [key, value] of Object.entries(patch || {})) {
      const column = TURN_PATCH_COLUMNS.get(key);
      if (!column) throw new Error(`unsupported turn patch: ${key}`);
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    values.push(turnId, expectedState);

    const result = this.db.prepare(`
      UPDATE turns SET ${assignments.join(', ')} WHERE turn_id = ? AND state = ?
    `).run(...values);
    if (Number(result.changes) !== 1) throw new Error('stale turn state');
    const saved = this.getTurn(turnId);
    this.appendSync('turn', turnId, 'state', saved);
    return saved;
  }

  putMessageInternal(message) {
    const normalized = {
      messageId: String(message.messageId || ''),
      turnId: String(message.turnId || ''),
      characterId: String(message.characterId || ''),
      speakerId: String(message.speakerId || ''),
      speakerType: String(message.speakerType || ''),
      recipientId: String(message.recipientId || ''),
      content: String(message.content || ''),
      sentAt: Number(message.sentAt),
      origin: String(message.origin || 'codex'),
      deviceId: message.deviceId ? String(message.deviceId) : null,
      deviceSeq: Number.isSafeInteger(message.deviceSeq) ? message.deviceSeq : null
    };
    if (!normalized.messageId || !normalized.turnId || !normalized.characterId) throw new Error('invalid message identity');
    if (!['user', 'character'].includes(normalized.speakerType)) throw new Error('invalid message speaker type');
    if (normalized.speakerType === 'user' && normalized.speakerId !== 'user') throw new Error('speaker mismatch');
    if (normalized.speakerType === 'character' && normalized.speakerId !== normalized.characterId) throw new Error('speaker mismatch');
    if (!normalized.content.trim() || !Number.isSafeInteger(normalized.sentAt)) throw new Error('invalid message content');

    const checksum = contentHash(normalized);
    const existing = this.db.prepare('SELECT checksum FROM messages WHERE message_id = ?').get(normalized.messageId);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error('message checksum conflict');
      return mapMessage(this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(normalized.messageId));
    }
    this.db.prepare(`
      INSERT INTO messages(
        message_id, turn_id, character_id, speaker_id, speaker_type, recipient_id,
        content, sent_at, origin, device_id, device_seq, checksum, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.messageId, normalized.turnId, normalized.characterId, normalized.speakerId,
      normalized.speakerType, normalized.recipientId, normalized.content, normalized.sentAt,
      normalized.origin, normalized.deviceId, normalized.deviceSeq, checksum, now()
    );
    const saved = mapMessage(this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(normalized.messageId));
    this.appendSync('message', normalized.messageId, 'insert', saved);
    return saved;
  }

  putMessage(message) {
    return this.transaction(() => this.putMessageInternal(message));
  }

  listMessages(characterId, limit = 200) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 200));
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE character_id = ?
          AND message_id NOT IN (SELECT message_id FROM suppressed_messages)
        ORDER BY sent_at DESC, message_id DESC LIMIT ?
      ) ORDER BY sent_at ASC, message_id ASC
    `).all(characterId, safeLimit).map(mapMessage);
  }

  getMessage(messageId) {
    return mapMessage(this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId));
  }

  getMessageContext(messageId, radius = 1) {
    const message = this.getMessage(messageId);
    if (!message) return [];
    const safeRadius = Math.max(0, Math.min(20, Number(radius) || 0));
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE character_id = ?
        AND message_id NOT IN (SELECT message_id FROM suppressed_messages)
      ORDER BY sent_at ASC, message_id ASC
    `).all(message.characterId).map(mapMessage);
    const index = rows.findIndex(item => item.messageId === messageId);
    if (index < 0) return [];
    return rows.slice(Math.max(0, index - safeRadius), index + safeRadius + 1);
  }

  putFact(fact) {
    if (!fact?.factId || !fact.characterId || !fact.subjectId || !fact.predicate) throw new Error('invalid fact');
    const normalized = {
      ...fact,
      status: fact.status || 'provisional',
      confidence: Number(fact.confidence) || 0,
      origin: fact.origin || 'memory',
      sourceMessageIds: [...new Set(fact.sourceMessageIds || [])],
      exactQuotes: fact.exactQuotes || []
    };
    const checksum = contentHash(normalized);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT checksum FROM facts WHERE fact_id = ?').get(normalized.factId);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error('fact checksum conflict');
        return normalized;
      }
      this.db.prepare(`
        INSERT INTO facts(
          fact_id, character_id, subject_id, predicate, object_json, evidence_mode,
          source_message_ids_json, exact_quotes_json, status, confidence, supersedes,
          origin, checksum, created_at, verified_at, fact_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.factId, normalized.characterId, normalized.subjectId, normalized.predicate,
        canonicalJson(normalized.object ?? null), normalized.evidenceMode || 'uncertain',
        canonicalJson(normalized.sourceMessageIds), canonicalJson(normalized.exactQuotes),
        normalized.status, normalized.confidence, normalized.supersedes || null,
        normalized.origin, checksum, normalized.createdAt || now(), normalized.verifiedAt || null,
        canonicalJson(normalized)
      );
      this.appendSync('fact', normalized.factId, 'insert', normalized);
      return normalized;
    });
  }


  listFacts(characterId, { status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM facts WHERE character_id = ? AND status = ? ORDER BY created_at ASC, fact_id ASC').all(characterId, status)
      : this.db.prepare('SELECT * FROM facts WHERE character_id = ? ORDER BY created_at ASC, fact_id ASC').all(characterId);
    return rows.map(mapFact);
  }

  listRetrievableFacts(characterId, options = {}) {
    const suppressed = new Set(this.db.prepare(
      'SELECT message_id FROM suppressed_messages'
    ).all().map(row => row.message_id));
    return this.listFacts(characterId, options).filter(fact =>
      !(fact.sourceMessageIds || []).some(messageId => suppressed.has(messageId))
    );
  }

  getSyncDelta(afterSeq = 0, limit = 500) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
    return this.db.prepare(`
      SELECT seq, entity_type, entity_id, operation, payload_json, checksum, created_at
      FROM sync_log WHERE seq > ? ORDER BY seq ASC LIMIT ?
    `).all(Number(afterSeq) || 0, safeLimit).map(row => ({
      seq: row.seq,
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      payload: parseJson(row.payload_json, {}),
      checksum: row.checksum,
      createdAt: row.created_at
    }));
  }

  ackSync(peerId, seq) {
    const normalizedSeq = Math.max(0, Number(seq) || 0);
    this.db.prepare(`
      INSERT INTO sync_cursors(peer_id, ack_seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        ack_seq = MAX(sync_cursors.ack_seq, excluded.ack_seq),
        updated_at = excluded.updated_at
    `).run(peerId, normalizedSeq, now());
    return this.getSyncCursor(peerId);
  }

  getSyncCursor(peerId) {
    return Number(this.db.prepare('SELECT ack_seq FROM sync_cursors WHERE peer_id = ?').get(peerId)?.ack_seq || 0);
  }

  suppressCompetingReplies(turnId, authoritativeMessageId) {
    const authoritative = this.getMessage(authoritativeMessageId);
    if (!authoritative || authoritative.turnId !== turnId || authoritative.speakerType !== 'character') {
      throw new Error('authoritative reply not found');
    }
    const candidates = this.db.prepare(`
      SELECT message_id FROM messages
      WHERE turn_id = ? AND speaker_type = 'character' AND message_id != ?
        AND origin != 'fallback'
    `).all(turnId, authoritativeMessageId);
    let suppressed = 0;
    for (const row of candidates) {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
        VALUES (?, ?, 'fallback_reply_was_delivered', ?)
      `).run(row.message_id, authoritativeMessageId, now());
      suppressed += Number(result.changes || 0);
    }
    return suppressed;
  }

  isMessageSuppressed(messageId) {
    return !!this.db.prepare('SELECT 1 AS found FROM suppressed_messages WHERE message_id = ?').get(messageId);
  }

  quarantinePendingReply(messageId) {
    const message = this.getMessage(messageId);
    if (!message || message.speakerType !== 'character') throw new Error('pending reply not found');
    this.db.prepare(`
      INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
      VALUES (?, ?, 'pending_phone_receipt', ?)
    `).run(message.messageId, message.messageId, now());
    return message;
  }

  setSession(role, threadId) {
    if (!['memory', 'brain', 'supervisor'].includes(role)) throw new Error('invalid session role');
    if (!String(threadId || '').trim()) throw new Error('invalid thread id');
    this.db.prepare(`
      INSERT INTO sessions(role, thread_id, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at
    `).run(role, String(threadId), now());
    return String(threadId);
  }

  getSession(role) {
    return String(this.db.prepare('SELECT thread_id FROM sessions WHERE role = ?').get(role)?.thread_id || '');
  }

  putPresetVersion(version) {
    if (!version?.version || !version.checksum) throw new Error('invalid preset version');
    const manifestJson = canonicalJson(version);
    const existing = this.db.prepare('SELECT manifest_json FROM preset_versions WHERE version = ?').get(version.version);
    if (existing) {
      if (existing.manifest_json !== manifestJson) throw new Error('preset version conflict');
      return version;
    }
    this.db.prepare(`
      INSERT INTO preset_versions(version, parent_version, manifest_json, checksum, published_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(version.version, version.parentVersion || null, manifestJson, version.checksum, version.publishedAt || now());
    return version;
  }

  getPresetVersion(version) {
    return mapPresetVersion(this.db.prepare('SELECT * FROM preset_versions WHERE version = ?').get(version));
  }

  listPresetVersions() {
    return this.db.prepare('SELECT * FROM preset_versions ORDER BY published_at ASC, version ASC').all().map(mapPresetVersion);
  }

  setCurrentPresetVersion(version) {
    if (!this.getPresetVersion(version)) throw new Error('preset version not found');
    this.db.prepare(`
      INSERT INTO runtime_state(key, value, updated_at) VALUES ('current_preset_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(version, now());
    return version;
  }

  getCurrentPresetVersion() {
    return String(this.db.prepare("SELECT value FROM runtime_state WHERE key = 'current_preset_version'").get()?.value || '');
  }

  putAnnotation(annotation) {
    if (!annotation?.annotationId || !annotation.turnId || !annotation.presetVersion) throw new Error('invalid annotation');
    const payload = canonicalJson(annotation);
    const existing = this.db.prepare('SELECT annotation_json FROM annotations WHERE annotation_id = ?').get(annotation.annotationId);
    if (existing) {
      if (existing.annotation_json !== payload) throw new Error('annotation conflict');
      return annotation;
    }
    this.db.prepare(`
      INSERT INTO annotations(
        annotation_id, turn_id, source_message_id, preset_version,
        annotation_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      annotation.annotationId, annotation.turnId, annotation.sourceMessageId || null,
      annotation.presetVersion, payload, annotation.status || 'proposed', annotation.createdAt || now()
    );
    return annotation;
  }

  getAnnotation(annotationId) {
    return mapAnnotation(this.db.prepare('SELECT * FROM annotations WHERE annotation_id = ?').get(annotationId));
  }

  updateAnnotationStatus(annotationId, status) {
    const result = this.db.prepare('UPDATE annotations SET status = ? WHERE annotation_id = ?').run(status, annotationId);
    if (Number(result.changes) !== 1) throw new Error('annotation not found');
    return this.getAnnotation(annotationId);
  }

  putDiagnostic({ turnId = null, stage, level = 'info', detail = {} }) {
    if (!stage) throw new Error('diagnostic stage is required');
    const result = this.db.prepare(`
      INSERT INTO diagnostics(turn_id, stage, level, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(turnId, stage, level, canonicalJson(detail), now());
    return Number(result.lastInsertRowid);
  }
}
