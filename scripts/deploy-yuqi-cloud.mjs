import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { setupYuqiRuntime } from './setup-yuqi-runtime.mjs';
import { requestCloudJson } from './cloud-http.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(root, 'yuqi-runtime');
const configPath = join(runtimeDir, 'config.json');
const relayConfig = join(root, 'wrangler.yuqi-relay.toml');
const timerConfig = join(root, 'wrangler.toml');
const runWrangler = join(root, 'scripts', 'run-wrangler.mjs');
const cloudUrl = String(process.argv[2] || 'https://al-cloud-timer.siyi78118.workers.dev').replace(/\/+$/, '');
const current = JSON.parse(readFileSync(configPath, 'utf8'));
const vaultDir = dirname(dirname(resolve(current.databasePath)));
const registrationSecret = randomBytes(36).toString('base64url');

function wrangler(args, input = undefined) {
  const result = spawnSync(process.execPath, [runWrangler, ...args], {
    cwd: root,
    env: process.env,
    input,
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit']
  });
  if (result.status !== 0) throw new Error(`Wrangler command failed: ${args.slice(0, 3).join(' ')}`);
}

wrangler(['d1', 'migrations', 'apply', 'al-cloud-timer', '--remote', '--config', relayConfig]);
wrangler(['secret', 'put', 'RELAY_REGISTRATION_SECRET', '--config', relayConfig], `${registrationSecret}\n`);
wrangler(['deploy', '--config', relayConfig]);
wrangler(['deploy', '--config', timerConfig]);

const registrationBody = await requestCloudJson(`${cloudUrl}/bridge/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-yuqi-registration': registrationSecret },
  body: {
    deviceId: current.cloudRelay.deviceId,
    deviceToken: current.cloudRelay.deviceToken
  }
});
if (registrationBody.ok !== true) throw new Error('Device registration failed');

const healthBody = await requestCloudJson(`${cloudUrl}/bridge/health`);
if (healthBody.ok !== true || healthBody.storage !== 'ciphertext-only') {
  throw new Error('Relay health check failed');
}

setupYuqiRuntime({ runtimeDir, vaultDir, cloudUrl, cloudEnabled: true });
process.stdout.write(`${JSON.stringify({
  ok: true,
  cloudUrl,
  deviceRegistered: true,
  relayVersion: healthBody.version || '',
  storage: healthBody.storage
})}\n`);
