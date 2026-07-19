import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createMemorySnapshot } from '../scripts/backup-yuqi-memory.mjs';
import { createSystemCloudFetch, requestCloudJson } from '../scripts/cloud-http.mjs';
import { buildPairingBundle, findLanAddress, setupYuqiRuntime } from '../scripts/setup-yuqi-runtime.mjs';
import { resolveWranglerInvocation } from '../scripts/wrangler-invocation.mjs';

test('pairing bundle contains only the phone bridge fields', () => {
  const bundle = buildPairingBundle({
    enabled: true,
    mode: 'AUTO',
    lanUrl: 'http://192.168.1.8:17891',
    cloudUrl: 'https://example.workers.dev',
    deviceId: 'yuqi-phone-a',
    pairingSecret: 'p'.repeat(32),
    deviceToken: 't'.repeat(32),
    encryptionKeyBase64: Buffer.alloc(32, 7).toString('base64')
  });
  assert.deepEqual(Object.keys(bundle).sort(), [
    'cloudUrl', 'deviceId', 'deviceToken', 'enabled', 'encryptionKeyBase64',
    'lanUrl', 'mode', 'pairingSecret', 'schemaVersion'
  ].sort());
  assert.equal(bundle.schemaVersion, 1);
});

test('LAN discovery prefers a real private subnet over a virtual public-range adapter', () => {
  const address = findLanAddress({
    'Radmin VPN': [{ family: 'IPv4', internal: false, address: '26.229.60.5' }],
    WLAN: [{ family: 'IPv4', internal: false, address: '192.168.1.9' }]
  });
  assert.equal(address, '192.168.1.9');
});

test('memory backup is a readable SQLite snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-snapshot-'));
  const databasePath = join(root, 'database', 'yuqi-runtime.sqlite');
  const snapshotsDir = join(root, 'snapshots');
  try {
    mkdirSync(join(root, 'database'), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT); INSERT INTO memories VALUES (\'m1\', \'remember me\');');
    db.close();
    const snapshotPath = createMemorySnapshot({ databasePath, snapshotsDir, retain: 3 });
    const copy = new DatabaseSync(snapshotPath, { readOnly: true });
    assert.equal(copy.prepare('SELECT content FROM memories WHERE id = ?').get('m1').content, 'remember me');
    copy.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup creates a durable vault, runtime config and one-tap pairing code', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-deploy-'));
  const runtimeDir = join(root, 'runtime');
  const vaultDir = join(root, 'vault');
  try {
    const result = setupYuqiRuntime({
      runtimeDir,
      vaultDir,
      codexCommand: join(root, 'codex.exe'),
      lanAddress: '192.168.1.8',
      cloudUrl: 'https://example.workers.dev',
      cloudEnabled: false
    });
    const config = JSON.parse(readFileSync(result.configPath, 'utf8'));
    assert.equal(config.databasePath, join(vaultDir, 'database', 'yuqi-runtime.sqlite'));
    assert.equal(config.cloudRelay.enabled, false);
    assert.match(readFileSync(result.pairingCodePath, 'utf8'), /^YUQI1:/);
    assert.ok(readFileSync(result.readmePath, 'utf8').includes('手机一键配对码'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows launcher quotes project paths containing spaces', () => {
  const launcher = readFileSync('scripts/start-yuqi-background.ps1', 'utf8');
  assert.match(launcher, /function Quote-ProcessArgument/);
  assert.match(launcher, /Quote-ProcessArgument \(Join-Path \$projectRoot 'yuqi-runtime\\src\\main\.mjs'\)/);
  assert.match(launcher, /Quote-ProcessArgument \$configPath/);
});

test('Android build disables the Gradle problems-report collision on Windows', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(packageJson.scripts['android:debug'], /--no-problems-report/);
});

test('secret files use inherited ACLs instead of Unix mode flags on Windows', () => {
  const setup = readFileSync('scripts/setup-yuqi-runtime.mjs', 'utf8');
  assert.match(setup, /process\.platform === 'win32'/);
  assert.match(setup, /function secureWriteFile/);
});

test('cloud deploy applies D1, sets registration secret, deploys both workers and registers the device', () => {
  const deploy = readFileSync('scripts/deploy-yuqi-cloud.mjs', 'utf8');
  for (const fragment of ['d1', 'migrations', 'RELAY_REGISTRATION_SECRET', 'wrangler.yuqi-relay.toml', 'wrangler.toml', '/bridge/register']) {
    assert.ok(deploy.includes(fragment), `missing ${fragment}`);
  }
  assert.doesNotMatch(deploy, /console\.log\([^\n]*(registrationSecret|deviceToken)/);
});

test('Wrangler uses its JavaScript CLI without a shell when the project path contains spaces', () => {
  const invocation = resolveWranglerInvocation({
    cwd: 'C:\\Users\\PC\\Documents\\Codex\\New project',
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    fileExists: path => path.endsWith('node_modules\\wrangler\\bin\\wrangler.js'),
    env: {}
  });
  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.prefixArgs, [
    'C:\\Users\\PC\\Documents\\Codex\\New project\\node_modules\\wrangler\\bin\\wrangler.js'
  ]);
});

test('Wrangler runner allows the official OAuth session to authenticate deploys', () => {
  const runner = readFileSync('scripts/run-wrangler.mjs', 'utf8');
  assert.doesNotMatch(runner, /Missing CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(runner, /args\[0\] === 'deploy' && !process\.env\.CLOUDFLARE_API_TOKEN/);
});

test('Windows cloud requests keep registration secrets out of process arguments', async () => {
  let captured;
  const result = await requestCloudJson('https://example.workers.dev/bridge/register', {
    method: 'POST',
    headers: { 'x-yuqi-registration': 'top-secret' },
    body: { deviceId: 'device-a', deviceToken: 'token-a' }
  }, {
    platform: 'win32',
    spawnSync: (command, args, options) => {
      captured = { command, args, input: options.input };
      return { status: 0, stdout: '{"ok":true}', stderr: '' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(captured.command, 'powershell.exe');
  assert.doesNotMatch(captured.args.join(' '), /top-secret|token-a/);
  assert.match(captured.input, /top-secret/);
});

test('runtime verifier uses the system cloud transport and requires cloud health when enabled', () => {
  const verifier = readFileSync('scripts/verify-yuqi-runtime.mjs', 'utf8');
  assert.match(verifier, /requestCloudJson/);
  assert.match(verifier, /!config\.cloudRelay\.enabled \|\| cloudRelayReady/);
});

test('cloud round-trip verifier encrypts a non-chat probe and acknowledges it', () => {
  const verifier = readFileSync('scripts/verify-yuqi-cloud-roundtrip.mjs', 'utf8');
  assert.match(verifier, /encryptRelayPayload/);
  assert.match(verifier, /createSystemCloudFetch/);
  assert.match(verifier, /direction: 'pc_to_phone'/);
  assert.match(verifier, /\/bridge\/ack/);
  assert.match(verifier, /plaintextFieldsStored: false/);
});

test('runtime cloud pump receives the Windows system-network fetch adapter', async () => {
  let capturedInput = '';
  const fetchImpl = createSystemCloudFetch({
    platform: 'win32',
    spawnSync: (_command, _args, options) => {
      capturedInput = options.input;
      return { status: 0, stdout: '{"ok":true}', stderr: '' };
    }
  });
  const response = await fetchImpl('https://example.workers.dev/bridge/enqueue', {
    method: 'POST',
    headers: { authorization: 'Bearer device-token' },
    body: JSON.stringify({ deviceId: 'device-a' })
  });
  assert.equal(response.ok, true);
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(JSON.parse(JSON.parse(capturedInput).body), { deviceId: 'device-a' });
  const main = readFileSync('yuqi-runtime/src/main.mjs', 'utf8');
  assert.match(main, /fetchImpl: createSystemCloudFetch\(\)/);
});

test('Android permits cleartext only for the generated private LAN host', () => {
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  const policy = readFileSync('android/app/src/main/res/xml/network_security_config.xml', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.match(policy, /<base-config cleartextTrafficPermitted="false"/);
  assert.match(policy, /<domain-config cleartextTrafficPermitted="true"/);
  assert.match(policy, />192\.168\.1\.9<\/domain>/);
  assert.match(packageJson.scripts['android:debug'], /generate-yuqi-network-policy/);
});

test('firewall helper is restricted to TCP 17891 on private local subnets', () => {
  const helper = readFileSync('scripts/enable-yuqi-lan-firewall.ps1', 'utf8');
  assert.match(helper, /^[\x00-\x7F]*$/, 'Windows PowerShell 5 must be able to read this BOM-less script');
  assert.match(helper, /-Protocol TCP/);
  assert.match(helper, /-LocalPort 17891/);
  assert.match(helper, /-Profile Private/);
  assert.match(helper, /-RemoteAddress LocalSubnet/);
  assert.doesNotMatch(helper, /-Profile Any|-RemoteAddress Any/);
});
