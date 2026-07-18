CREATE TABLE IF NOT EXISTS relay_devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_messages (
  message_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('phone_to_pc', 'pc_to_phone')),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  acked_at INTEGER,
  UNIQUE(device_id, idempotency_key),
  FOREIGN KEY(device_id) REFERENCES relay_devices(device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_relay_poll
  ON relay_messages(device_id, direction, expires_at, created_at);

CREATE TABLE IF NOT EXISTS relay_usage (
  usage_day TEXT NOT NULL,
  device_id TEXT NOT NULL,
  byte_count INTEGER NOT NULL DEFAULT 0,
  write_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(usage_day, device_id),
  FOREIGN KEY(device_id) REFERENCES relay_devices(device_id) ON DELETE CASCADE
);
