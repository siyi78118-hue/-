import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.argv[2] || join(root, 'yuqi-runtime', 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const databasePath = resolve(config.databasePath);
const vaultDir = dirname(dirname(databasePath));

async function fetchJson(url, timeoutMs = 10_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const local = await fetchJson(`http://127.0.0.1:${config.port}/v1/health`).catch(error => ({ status: 0, body: { error: error.message } }));
const database = new DatabaseSync(databasePath, { readOnly: true });
const sessions = database.prepare('SELECT role, thread_id FROM sessions ORDER BY role').all();
const preset = database.prepare('SELECT version FROM preset_versions ORDER BY published_at DESC LIMIT 1').get();
database.close();
const snapshotsDir = join(vaultDir, 'snapshots');
const snapshots = existsSync(snapshotsDir) ? readdirSync(snapshotsDir).filter(name => name.endsWith('.sqlite')) : [];
const pairingCodePath = join(vaultDir, '手机一键配对码.txt');
const pairingReady = existsSync(pairingCodePath) && readFileSync(pairingCodePath, 'utf8').startsWith('YUQI1:');
const apkPath = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

let cloud = { status: 0, body: { ok: false, disabled: !config.cloudRelay.enabled } };
if (config.cloudRelay.enabled && config.cloudRelay.url) {
  cloud = await fetchJson(`${config.cloudRelay.url.replace(/\/+$/, '')}/bridge/health`).catch(error => ({ status: 0, body: { error: error.message } }));
}

const result = {
  ok: local.status === 200 && local.body.ok === true && sessions.length === 3 && snapshots.length > 0 && pairingReady && existsSync(apkPath),
  localRuntime: local.status === 200 && local.body.ok === true,
  roles: sessions.map(row => row.role),
  isolatedRoles: sessions.length === 3 && new Set(sessions.map(row => row.thread_id)).size === 3,
  presetVersion: preset?.version || '',
  contextLimit: local.body.contextLimit || 0,
  memoryDatabase: existsSync(databasePath),
  snapshotCount: snapshots.length,
  phonePairingReady: pairingReady,
  apk: existsSync(apkPath) ? { exists: true, bytes: statSync(apkPath).size } : { exists: false, bytes: 0 },
  cloudRelayEnabled: Boolean(config.cloudRelay.enabled),
  cloudRelayReady: cloud.status === 200 && cloud.body.ok === true
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
