CREATE TABLE IF NOT EXISTS timer_stream_authorities (
  logical_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('chat', 'moment')),
  owner TEXT NOT NULL CHECK(owner IN ('android-v1', 'web-v1')),
  authority_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  state TEXT NOT NULL CHECK(state IN ('scheduled', 'paused', 'disabled', 'awaiting_ack')),
  active_job_id TEXT,
  due_at INTEGER,
  payload_json TEXT,
  expected_previous_job_id TEXT,
  schedule_checksum TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CHECK(length(authority_epoch) = 32),
  CHECK(length(schedule_checksum) = 64),
  CHECK(
    (state IN ('scheduled', 'awaiting_ack') AND active_job_id IS NOT NULL AND due_at IS NOT NULL AND payload_json IS NOT NULL)
    OR
    (state IN ('paused', 'disabled') AND active_job_id IS NULL AND due_at IS NULL AND payload_json IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_timer_stream_due
  ON timer_stream_authorities(state, due_at);
CREATE INDEX IF NOT EXISTS idx_timer_stream_device
  ON timer_stream_authorities(device_id, state, due_at);

CREATE TABLE IF NOT EXISTS timer_job_events (
  event_id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  authority_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('authority_created', 'authority_transitioned')),
  state TEXT NOT NULL,
  active_job_id TEXT,
  due_at INTEGER,
  schedule_checksum TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timer_job_events_stream
  ON timer_job_events(logical_key, generation, recorded_at);

CREATE TRIGGER IF NOT EXISTS timer_stream_authority_insert_event
AFTER INSERT ON timer_stream_authorities
BEGIN
  INSERT OR IGNORE INTO timer_job_events (
    event_id, logical_key, device_id, char_id, kind, owner, authority_epoch,
    generation, event_type, state, active_job_id, due_at, schedule_checksum, recorded_at
  ) VALUES (
    NEW.logical_key || ':' || NEW.generation || ':created',
    NEW.logical_key, NEW.device_id, NEW.char_id, NEW.kind, NEW.owner, NEW.authority_epoch,
    NEW.generation, 'authority_created', NEW.state, NEW.active_job_id, NEW.due_at,
    NEW.schedule_checksum, NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS timer_stream_authority_update_event
AFTER UPDATE ON timer_stream_authorities
BEGIN
  INSERT OR IGNORE INTO timer_job_events (
    event_id, logical_key, device_id, char_id, kind, owner, authority_epoch,
    generation, event_type, state, active_job_id, due_at, schedule_checksum, recorded_at
  ) VALUES (
    NEW.logical_key || ':' || NEW.generation || ':transitioned:' || NEW.state || ':'
      || COALESCE(NEW.active_job_id, 'none') || ':' || NEW.delivery_attempts || ':'
      || COALESCE(NEW.due_at, 0) || ':' || NEW.updated_at,
    NEW.logical_key, NEW.device_id, NEW.char_id, NEW.kind, NEW.owner, NEW.authority_epoch,
    NEW.generation, 'authority_transitioned', NEW.state, NEW.active_job_id, NEW.due_at,
    NEW.schedule_checksum, NEW.updated_at
  );
END;
