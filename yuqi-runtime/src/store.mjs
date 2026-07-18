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
    workerId: row.worker_id || '',
    origin: row.origin,
    memoryPacketJson: row.memory_packet_json,
    brainDraftJson: row.brain_draft_json,
    supervisorJson: row.supervisor_json,
    replyJson: row.reply_json,
    errorJson: row.error_json,
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
    `);

    const factColumns = new Set(this.db.prepare('PRAGMA table_info(facts)').all().map(row => row.name));
    if (!factColumns.has('fact_json')) this.db.exec('ALTER TABLE facts ADD COLUMN fact_json TEXT;');
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
    const existing = this.getTurn(envelope.turnId);
    if (existing) {
      if (existing.envelopeChecksum !== envelopeChecksum) throw new Error('turn checksum conflict');
      return existing;
    }

    const sequenceOwner = this.db.prepare(
      'SELECT turn_id, source_message_id FROM turns WHERE device_id = ? AND device_seq = ?'
    ).get(envelope.deviceId, envelope.deviceSeq);
    if (sequenceOwner && sequenceOwner.source_message_id !== envelope.message.messageId) {
      throw new Error('device sequence conflict');
    }

    return this.transaction(() => {
      this.putMessageInternal({
        ...envelope.message,
        turnId: envelope.turnId,
        characterId: envelope.characterId,
        origin: 'phone',
        deviceId: envelope.deviceId,
        deviceSeq: envelope.deviceSeq
      });

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
        envelope.message.messageId,
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
        SELECT * FROM messages WHERE character_id = ? ORDER BY sent_at DESC, message_id DESC LIMIT ?
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
