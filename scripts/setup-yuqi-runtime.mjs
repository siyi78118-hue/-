import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function randomAesKey() {
  return randomBytes(32).toString('base64');
}

function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function secureWriteFile(path, content) {
  const options = process.platform === 'win32'
    ? { encoding: 'utf8' }
    : { encoding: 'utf8', mode: 0o600 };
  writeFileSync(path, content, options);
}

export function findLanAddress(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal || address.address.startsWith('169.254.')) continue;
      const octets = address.address.split('.').map(Number);
      const privateSubnet = octets[0] === 10
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168);
      const virtual = /vpn|virtual|radmin|tailscale|zerotier|vmware|hyper-v|wsl/i.test(name);
      candidates.push({ address: address.address, score: (privateSubnet ? 100 : 0) - (virtual ? 50 : 0) });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.address || '127.0.0.1';
}

export function buildPairingBundle(config) {
  return {
    schemaVersion: 1,
    enabled: config.enabled !== false,
    mode: config.mode || 'AUTO',
    lanUrl: String(config.lanUrl || ''),
    cloudUrl: String(config.cloudUrl || ''),
    deviceId: String(config.deviceId || ''),
    pairingSecret: String(config.pairingSecret || ''),
    deviceToken: String(config.deviceToken || ''),
    encryptionKeyBase64: String(config.encryptionKeyBase64 || '')
  };
}

export function encodePairingBundle(bundle) {
  return `YUQI1:${Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64url')}`;
}

export function setupYuqiRuntime(options = {}) {
  const runtimeDir = resolve(options.runtimeDir || join(dirname(fileURLToPath(import.meta.url)), '..', 'yuqi-runtime'));
  const vaultDir = resolve(options.vaultDir || join(homedir(), 'Documents', '虞栖AL记忆库备份'));
  const configPath = join(runtimeDir, 'config.json');
  const prior = readJson(configPath);
  const priorCloud = prior.cloudRelay || {};
  const lanAddress = options.lanAddress || findLanAddress();
  const cloudUrl = options.cloudUrl ?? priorCloud.url ?? '';
  const cloudEnabled = options.cloudEnabled ?? priorCloud.enabled ?? false;

  for (const path of [runtimeDir, vaultDir, join(vaultDir, 'database'), join(vaultDir, 'snapshots'), join(vaultDir, 'exports'), join(vaultDir, 'logs')]) {
    mkdirSync(path, { recursive: true });
  }

  const config = {
    host: '0.0.0.0',
    port: Number(options.port || prior.port || 17891),
    pairingSecret: prior.pairingSecret || randomToken(36),
    databasePath: join(vaultDir, 'database', 'yuqi-runtime.sqlite'),
    codexCommand: options.codexCommand || prior.codexCommand || 'codex',
    codexArgs: Array.isArray(options.codexArgs) && options.codexArgs.length
      ? options.codexArgs.map(String)
      : Array.isArray(prior.codexArgs) && prior.codexArgs.length
        ? prior.codexArgs.map(String)
        : ['app-server'],
    codexRuntimeDirectory: options.codexRuntimeDirectory || prior.codexRuntimeDirectory || dirname(runtimeDir),
    cloudRelay: {
      enabled: Boolean(cloudEnabled),
      url: String(cloudUrl).replace(/\/+$/, ''),
      deviceId: priorCloud.deviceId || `yuqi-${randomUUID()}`,
      deviceToken: priorCloud.deviceToken || randomToken(36),
      encryptionKeyBase64: priorCloud.encryptionKeyBase64 || randomAesKey(),
      pollIntervalMs: 1500
    }
  };
  secureWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const bundle = buildPairingBundle({
    enabled: true,
    mode: 'AUTO',
    lanUrl: `http://${lanAddress}:${config.port}`,
    cloudUrl: config.cloudRelay.url,
    deviceId: config.cloudRelay.deviceId,
    pairingSecret: config.pairingSecret,
    deviceToken: config.cloudRelay.deviceToken,
    encryptionKeyBase64: config.cloudRelay.encryptionKeyBase64
  });
  const pairingJsonPath = join(vaultDir, '手机配对配置.json');
  const pairingCodePath = join(vaultDir, '手机一键配对码.txt');
  const readmePath = join(vaultDir, '使用说明.txt');
  secureWriteFile(pairingJsonPath, `${JSON.stringify(bundle, null, 2)}\n`);
  secureWriteFile(pairingCodePath, `${encodePairingBundle(bundle)}\n`);
  secureWriteFile(readmePath, [
    '虞栖 AL 记忆保险库', '',
    'database：电脑端权威记忆库。',
    'snapshots：自动生成的可恢复历史快照。',
    'exports：人工导出的长期留档。',
    'logs：运行日志，不作为事实记忆。', '',
    '手机首次连接：打开“设置 → 虞栖专属运行”，把“手机一键配对码.txt”的整行内容粘贴到一键配对框并导入。',
    '配对文件含私密密钥，只保留在自己的电脑和手机上，不要发给他人。'
  ].join('\r\n'));

  return { configPath, vaultDir, pairingJsonPath, pairingCodePath, readmePath, config, bundle };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = setupYuqiRuntime({
    vaultDir: process.argv[2],
    codexCommand: process.env.YUQI_CODEX_COMMAND,
    cloudUrl: process.env.YUQI_CLOUD_URL,
    cloudEnabled: process.env.YUQI_CLOUD_ENABLED === '1'
  });
  process.stdout.write(`${JSON.stringify({ ok: true, vaultDir: result.vaultDir, configPath: result.configPath })}\n`);
}
