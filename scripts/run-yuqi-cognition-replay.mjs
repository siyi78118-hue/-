import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { ReplayRunner } from '../yuqi-runtime/src/replay-runner.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const configPath = resolve(option('config', 'yuqi-runtime/config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const databasePath = isAbsolute(config.databasePath || '')
  ? config.databasePath
  : resolve(dirname(configPath), config.databasePath || 'data/yuqi-runtime.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const store = new YuqiStore(databasePath);
const runId = option('run-id');
if (!runId) throw new Error('--run-id is required');
const source = option('source', 'fixture');
const structuralPipeline = label => ({
  async run({ envelope }) {
    return {
      schemaValid: true,
      usedMessageIds: envelope.message ? [envelope.message.messageId] : [],
      actions: [],
      executionMode: 'structural-dry-run',
      label
    };
  }
});
const runner = new ReplayRunner({
  store,
  legacyPipeline: structuralPipeline('legacy'),
  cognitivePipeline: structuralPipeline('cognition'),
  sandboxFactory: async ({ clock }) => ({
    dryRun: true,
    clock,
    actionSink: { send() { throw new Error('dry-run action attempted'); } },
    notificationSink: { send() { throw new Error('dry-run notification attempted'); } },
    cloudSink: { send() { throw new Error('dry-run cloud write attempted'); } }
  }),
  concurrency: Number(option('concurrency', 2))
});

try {
  const result = source === 'local-history'
    ? await runner.runLocalHistoryBatch({
      runId,
      rolloutKey: option('kind', 'DIRECT_REPLY'),
      limit: Number(option('limit', 30)),
      beforeTurnId: option('before-turn-id')
    })
    : await runner.runFixtureBatch({
      runId,
      datasetPath: option('dataset', 'tests/fixtures/yuqi-cognition-replay-v1'),
      presetVersion: config.cognitionRuntime?.presetVersion || '2.0.0',
      modelProfileChecksum: 'structural-only-not-promotion-evidence'
    });
  process.stdout.write(`${JSON.stringify({
    ...result.summary,
    promotionEvidence: false,
    note: 'Structural dry-run only; real model replay is required before promotion.'
  }, null, 2)}\n`);
} finally {
  store.close();
}

