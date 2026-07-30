import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditBaseline } from '../scripts/audit-yuqi-lived-v3-baseline.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('baseline names the real stable release, rollout rows, versions, and feature counts', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuqi-v3-baseline-'));
  const outPath = path.join(temporaryRoot, 'baseline.json');

  try {
    const report = await auditBaseline({
      rootDir: projectRoot,
      configPath: path.join(projectRoot, 'yuqi-runtime', 'config.json'),
      outPath
    });

    assert.equal(report.schemaVersion, 1);
    assert.ok(report.gitHead);
    assert.match(report.database.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.database.userVersion, 9);
    assert.ok(report.stableEvidence.releaseId);
    assert.match(report.stableEvidence.pipelineChecksum, /^[a-f0-9]{64}$/);
    assert.equal(report.versions.maximumOccupiedCode, 108);
    assert.equal(report.features.DIRECT_REPLY.enabled, true);
    assert.equal(report.rollouts.length, 10);
    assert.deepEqual(report.stopReasons, []);

    const materialized = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(materialized.database.sha256, report.database.sha256);
    assert.equal(JSON.stringify(materialized).includes('pairingSecret'), false);
    assert.equal(JSON.stringify(materialized).includes('deviceToken'), false);
    assert.equal(JSON.stringify(materialized).includes('encryptionKeyBase64'), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
