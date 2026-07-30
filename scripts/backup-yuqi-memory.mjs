import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
}

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function createMemorySnapshot(options = {}) {
  const databasePath = resolve(options.databasePath || '');
  if (!databasePath || !existsSync(databasePath)) throw new Error('Yuqi memory database does not exist');
  const snapshotsDir = resolve(options.snapshotsDir || join(dirname(databasePath), '..', 'snapshots'));
  const retain = Math.max(1, Number(options.retain) || 30);
  mkdirSync(snapshotsDir, { recursive: true });
  const snapshotPath = join(snapshotsDir, `yuqi-memory-${stamp(options.now)}.sqlite`);
  if (existsSync(snapshotPath)) rmSync(snapshotPath);

  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA wal_checkpoint(FULL);');
    database.exec(`VACUUM INTO ${sqliteString(snapshotPath)};`);
  } finally {
    database.close();
  }

  const snapshots = readdirSync(snapshotsDir)
    .filter(name => /^yuqi-memory-.*\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const name of snapshots.slice(retain)) rmSync(join(snapshotsDir, name));
  return snapshotPath;
}

export function inspectMemorySnapshot(snapshotPath) {
  const resolved = resolve(snapshotPath || '');
  if (!resolved || !existsSync(resolved)) throw new Error('Yuqi memory snapshot does not exist');
  const sha256 = createHash('sha256').update(readFileSync(resolved)).digest('hex');
  const database = new DatabaseSync(resolved, { readOnly: true });
  try {
    const schemaVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();
    const tableCounts = Object.fromEntries(tables.map(({ name }) => [
      name,
      Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count)
    ]));
    return { snapshotPath: resolved, sha256, schemaVersion, tableCounts };
  } finally {
    database.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'yuqi-runtime');
  const configPath = resolve(process.argv[2] || join(runtimeDir, 'config.json'));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const databasePath = resolve(config.databasePath);
  const result = createMemorySnapshot({ databasePath, retain: Number(process.argv[3]) || 30 });
  const inspection = inspectMemorySnapshot(result);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ...inspection,
    preMigrationDatabaseSha256: inspection.sha256
  })}\n`);
}
