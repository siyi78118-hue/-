CREATE TABLE IF NOT EXISTS timer_devices (
  device_id TEXT PRIMARY KEY,
  transport TEXT NOT NULL,
  target_json TEXT NOT NULL,
  background_ack INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS timer_jobs (
  job_id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  char_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  plan_id TEXT,
  occurrence_id TEXT,
  source TEXT,
  due_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  awaiting_ack INTEGER NOT NULL DEFAULT 0,
  test INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timer_jobs_due_at ON timer_jobs(due_at);
CREATE INDEX IF NOT EXISTS idx_timer_jobs_device_id ON timer_jobs(device_id);

CREATE TABLE IF NOT EXISTS timer_meta (
  meta_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
