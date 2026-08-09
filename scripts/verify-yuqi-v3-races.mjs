import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export const PC_RACE_CASES = Object.freeze({
  proactive_generating_then_user_batch: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^proactive_generating_then_user_batch$' }),
  proactive_outbox_then_user_batch: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^proactive_outbox_then_user_batch$' }),
  runtime_restart_before_visible_commit: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^runtime_restart_before_visible_commit$' }),
  runtime_restart_after_visible_commit: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^runtime_restart_after_visible_commit$' }),
  original_retry_and_sibling_retry_compete: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^original_retry_and_sibling_retry_compete$' }),
  populated_v15_migrates_and_restarts: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^populated_v15_migrates_and_restarts$' }),
  canary_rollback_while_turn_in_flight: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^canary_rollback_while_turn_in_flight$' }),
  same_fingerprint_adjacent_revisions: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^same_fingerprint_adjacent_revisions$' }),
  cloud_waiting_does_not_block_next_local_turn: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^cloud_waiting_does_not_block_next_local_turn$' }),
  pc_android_receipt_conflict_is_quarantined: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^pc_android_receipt_conflict_is_quarantined$' }),
  conversation_clear_after_outbox_snapshot: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^conversation_clear_after_outbox_snapshot$' }),
  redacted_group_stale_outbox_snapshot_does_not_send: Object.freeze({ file: 'tests/yuqi-v3-races.test.mjs', pattern: '^redacted_group_stale_outbox_snapshot_does_not_send$' })
});
export const PC_RACE_IDS = Object.freeze(Object.keys(PC_RACE_CASES));

export const CONNECTED_ANDROID_CASES = Object.freeze([
  'native_completed_before_ui_open',
  'ui_open_before_notification',
  'event_and_poll_same_group',
  'event_lost_poll_recovers',
  'plugin_promise_hangs_then_replay',
  'page_reload_before_ui_ack',
  'ambiguous_remote_timeout_never_falls_back',
  'android_fallback_receipt_syncs_without_pc_redelivery',
  'conversation_clear_while_result_in_flight',
  'role_delete_pending_suppresses_late_lan_result',
  'role_delete_applied_acks_late_cloud_without_semantic_write'
]);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return createHash('sha256').update(value).digest('hex');
  }
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value), 'utf8').digest('hex');
}

function parseNodeTestOutput(stdout, stderr = '') {
  const text = `${stdout}\n${stderr}`;
  const passedNames = [...text.matchAll(/(?:^|\n)✔\s+(.+?)\s+\([^\n]*\)/g)].map(match => match[1].trim());
  const failedNames = [...text.matchAll(/(?:^|\n)✖\s+(.+?)\s+\([^\n]*\)/g)].map(match => match[1].trim());
  const summary = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)[\s\S]*?ℹ cancelled (\d+)[\s\S]*?ℹ skipped (\d+)/m.exec(text);
  return {
    passedNames,
    failedNames,
    tests: summary ? Number(summary[1]) : 0,
    pass: summary ? Number(summary[2]) : 0,
    fail: summary ? Number(summary[3]) : 0,
    cancelled: summary ? Number(summary[4]) : 0,
    skipped: summary ? Number(summary[5]) : 0
  };
}

async function executeDefault({ id, file, pattern }) {
  try {
    const result = await execFileAsync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file], {
      cwd: resolve(process.cwd()),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    return {
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
      exitCode: Number(error.code || 1)
    };
  }
}

export async function runPcRaceMatrix({ cases = PC_RACE_IDS, execute = executeDefault } = {}) {
  if (!Array.isArray(cases) || cases.length !== PC_RACE_IDS.length
    || new Set(cases).size !== cases.length
    || cases.some(name => !Object.hasOwn(PC_RACE_CASES, name))) {
    throw new Error('closed PC race registry conflict');
  }
  const outcomes = [];
  for (const name of cases) {
    const entry = PC_RACE_CASES[name];
    const outcome = await execute({ id: name, file: entry.file, pattern: entry.pattern });
    const parsed = parseNodeTestOutput(outcome.stdout, outcome.stderr);
    const passed = parsed.passedNames.filter(found => found === name).length;
    const unexpectedPassed = parsed.passedNames.filter(found => found !== name);
    const failed = parsed.failedNames.length;
    const expectedTests = cases.length;
    const selectedOnly = parsed.tests === 1 && parsed.skipped === 0;
    const fileWithNonmatchingSkipped = parsed.tests === expectedTests && parsed.skipped === expectedTests - 1;
    if (outcome.exitCode !== 0 || (!selectedOnly && !fileWithNonmatchingSkipped) || parsed.pass !== 1
      || parsed.fail !== 0 || parsed.cancelled !== 0
      || passed !== 1 || unexpectedPassed.length !== 0 || failed !== 0) {
      throw new Error(`PC race case did not execute cleanly: ${name}`);
    }
    outcomes.push({
      id: name, file: entry.file, pattern: entry.pattern, status: 'passed',
      passed, failed: 0, skipped: parsed.skipped,
      outcomeChecksum: sha256({
        id: name, file: entry.file, pattern: entry.pattern,
        exitCode: outcome.exitCode, tests: parsed.tests, pass: parsed.pass,
        fail: parsed.fail, cancelled: parsed.cancelled, skipped: parsed.skipped,
        passedNames: parsed.passedNames, failedNames: parsed.failedNames
      })
    });
  }
  const results = outcomes.map(({ outcomeChecksum, ...result }) => ({ ...result, skipped: 0, outcomeChecksum }));
  const pending = CONNECTED_ANDROID_CASES.map(id => ({
    id, status: 'pending_connected_android', passed: 0, failed: 0, skipped: 0
  }));
  return {
    pcCases: results,
    connectedAndroidCases: pending,
    counts: { passed: results.length, failed: 0, skipped: 0, pendingConnectedAndroid: pending.length },
    command: 'node --test --test-name-pattern=<anchored pattern> tests/yuqi-v3-races.test.mjs (12 commands)',
    commandOutcomeChecksum: sha256({
      outcomes
    })
  };
}

export async function writeRaceReport({ out, execute } = {}) {
  if (!out) throw new Error('race report output is required');
  const startedAt = Date.now();
  const result = await runPcRaceMatrix({ execute });
  const sourceFiles = [
    'scripts/verify-yuqi-v3-races.mjs',
    'tests/yuqi-v3-races.test.mjs',
    'yuqi-runtime/src/store.mjs',
    'yuqi-runtime/src/local-server.mjs',
    'yuqi-runtime/src/v3-diagnostics.mjs',
    'yuqi-runtime/src/orchestrator.mjs',
    'tests/yuqi-v3-race-runner.test.mjs',
    'package.json',
    'package-lock.json'
  ];
  const sourceChecksums = {};
  for (const file of sourceFiles) sourceChecksums[file] = sha256(await readFile(resolve(file)));
  const registry = { pc: PC_RACE_CASES, connectedAndroid: CONNECTED_ANDROID_CASES };
  const report = {
    schemaVersion: 'yuqi-v3-race-report-v1',
    registryChecksum: sha256(registry),
    sourceChecksums,
    command: result.command,
    commandOutcomeChecksum: result.commandOutcomeChecksum,
    pcCases: result.pcCases,
    connectedAndroidCases: result.connectedAndroidCases,
    counts: result.counts,
    startedAt,
    endedAt: Date.now(),
    releaseEligible: false
  };
  report.overallChecksum = sha256(report);
  await writeFile(resolve(out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (process.argv[1] && /verify-yuqi-v3-races\.mjs$/i.test(process.argv[1])) {
  const outputIndex = process.argv.indexOf('--out');
  const out = outputIndex >= 0 ? process.argv[outputIndex + 1] : 'artifacts/yuqi-lived-agency-v3/race-report.json';
  writeRaceReport({ out }).then(report => {
    console.log(JSON.stringify({ counts: report.counts, releaseEligible: report.releaseEligible, overallChecksum: report.overallChecksum }));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
