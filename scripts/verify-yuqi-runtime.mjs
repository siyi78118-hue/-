import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

function record(name, run) {
  const startedAt = Date.now();
  try {
    const detail = run();
    checks.push({ name, ok: true, durationMs: Date.now() - startedAt, ...(detail || {}) });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error).slice(0, 4_000)
    });
  }
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    windowsHide: true,
    shell: options.shell === true,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    throw new Error(`${command} exited ${result.status}: ${output.slice(-4_000)}`);
  }
  return { exitCode: result.status, outputLines: String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).length };
}

function javaMajor(home) {
  if (!home) return 0;
  const executable = join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!existsSync(executable)) return 0;
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8', windowsHide: true });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = /version\s+"(\d+)/.exec(text);
  return match ? Number(match[1]) : 0;
}

function findJava21Home() {
  const candidates = [process.env.YUQI_JAVA_HOME, process.env.JAVA_HOME];
  if (process.platform === 'win32') {
    const tempRoot = 'C:\\tmp\\microsoft-jdk-21';
    if (existsSync(tempRoot)) {
      for (const name of readdirSync(tempRoot)) candidates.push(join(tempRoot, name));
    }
    const microsoftRoot = 'C:\\Program Files\\Microsoft';
    if (existsSync(microsoftRoot)) {
      for (const name of readdirSync(microsoftRoot).filter(value => value.startsWith('jdk-21'))) {
        candidates.push(join(microsoftRoot, name));
      }
    }
    candidates.push('C:\\Program Files\\Android\\Android Studio\\jbr');
  }
  for (const candidate of candidates.filter(Boolean)) if (javaMajor(candidate) === 21) return candidate;
  throw new Error('OpenJDK 21 was not found; set YUQI_JAVA_HOME');
}

record('node-runtime-tests', () => {
  const testDir = join(root, 'yuqi-runtime', 'test');
  const files = readdirSync(testDir).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(testDir, name));
  return { files: files.length, ...command(process.execPath, ['--test', ...files]) };
});

record('relay-tests', () => command(process.execPath, [
  '--test',
  join(root, 'tests', 'yuqi-relay-worker.test.mjs'),
  join(root, 'tests', 'yuqi-deployment-contract.test.mjs')
]));

record('android-jvm-tests', () => {
  const javaHome = findJava21Home();
  const gradle = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : './gradlew';
  const gradleArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'gradlew.bat', '-I', 'isolated-build.init.gradle', ':app:testDebugUnitTest', '--no-problems-report', '--no-daemon']
    : ['-I', 'isolated-build.init.gradle', ':app:testDebugUnitTest', '--no-problems-report', '--no-daemon'];
  return {
    javaMajor: 21,
    ...command(gradle, gradleArgs, {
      cwd: join(root, 'android'),
      env: { JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}` }
    })
  };
});

record('protocol-v2-contract', () => {
  const bridgeDir = join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'siyi', 'al', 'execution', 'bridge');
  const input = readFileSync(join(bridgeDir, 'BridgeInput.java'), 'utf8');
  const bridgeSources = readdirSync(bridgeDir)
    .filter(name => name.endsWith('.java'))
    .map(name => readFileSync(join(bridgeDir, name), 'utf8'))
    .join('\n');
  if (!input.includes('.put("protocolVersion", 2)')) throw new Error('Android envelope is not pinned to protocol v2');
  if (bridgeSources.includes('.put("protocolVersion", 1)')) throw new Error('new Android bridge submissions still contain protocol v1');
  return { protocolVersion: 2 };
});

record('no-empty-user-trigger', () => {
  const bridgeDir = join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'siyi', 'al', 'execution', 'bridge');
  const input = readFileSync(join(bridgeDir, 'BridgeInput.java'), 'utf8');
  const mirror = readFileSync(join(bridgeDir, 'RoomBridgeMirror.java'), 'utf8');
  if (!input.includes('submission.kind == com.siyi.al.execution.TurnKind.DIRECT_REPLY')) {
    throw new Error('message construction is not guarded by DIRECT_REPLY');
  }
  if (!input.includes('envelope.put("trigger"')) throw new Error('automatic turns do not build a trigger');
  if (!mirror.includes('submission.kind != TurnKind.DIRECT_REPLY) return')) {
    throw new Error('automatic turns can still be mirrored as user messages');
  }
  return { automaticUserRows: 0 };
});

record('version-contract', () => {
  const gradle = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf8');
  if (!gradle.includes('AL_VERSION_CODE') || !gradle.includes('AL_VERSION_NAME')) {
    throw new Error('Android delivery version is not externally pinnable');
  }
  const expectedCode = Number(process.env.AL_EXPECT_VERSION_CODE || 0);
  const expectedName = String(process.env.AL_EXPECT_VERSION_NAME || '');
  if (expectedCode && !gradle.includes(`"${expectedCode}"`)) {
    throw new Error(`default Android versionCode is not ${expectedCode}`);
  }
  if (expectedName && !gradle.includes(`"${expectedName}"`)) {
    throw new Error(`default Android versionName is not ${expectedName}`);
  }
  return { externallyPinned: true, expectedCode: expectedCode || null, expectedName: expectedName || null };
});

const result = {
  ok: checks.every(check => check.ok),
  checks,
  totals: {
    passed: checks.filter(check => check.ok).length,
    failed: checks.filter(check => !check.ok).length,
    count: checks.length
  }
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
