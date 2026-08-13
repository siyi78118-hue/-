import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { sourceSha256 } from '../scripts/extract-yuqi-real-history-scenes.mjs';
import { prepareRealChatBlindEvaluation } from '../scripts/prepare-yuqi-real-chat-blind-evaluation.mjs';
import { exportRealChatHumanReview } from '../scripts/build-yuqi-real-chat-human-review.mjs';

const CATEGORIES = [
  ['daily_chat', 6],
  ['emotional_closeness', 6],
  ['disagreement_repair', 4],
  ['subtext_coquetry', 4],
  ['interruption_memory_time', 4],
];

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function fixtureWindows() {
  return Array.from({ length: 30 }, (_, index) => {
    const base = 1_800_000_000_000 + index * 10_000;
    const targetBatch = index < 5
      ? [
        { messageId: `target-${index}-1`, type: 'text', text: `姜隽倚补充 ${index}` },
        { messageId: `target-${index}-2`, type: 'text', text: `电话 13800138000 第 ${index} 题` },
      ]
      : [{ messageId: `target-${index}`, type: 'text', text: `姜隽倚说第 ${index} 句话` }];
    return {
      windowId: `history_window_${String(index).padStart(3, '0')}`,
      sourceWindowChecksum: contentHash({ index, source: 'fixture' }),
      roleId: 'anon_role_1', laneKey: 'anon_private_chat', startedAt: base, endedAt: base + 3_000,
      turns: [
        { at: base, speaker: 'user', batch: [{ messageId: `prior-u-${index}`, type: 'text', text: `前文 ${index}` }] },
        { at: base + 1_000, speaker: 'assistant', batch: [{ messageId: `prior-a-${index}`, type: 'text', text: `旧回答 ${index}` }] },
        { at: base + 2_000, speaker: 'user', batch: targetBatch },
        { at: base + 3_000, speaker: 'assistant', batch: [{ messageId: `historical-answer-${index}`, type: 'text', text: `必须移除的历史答案 ${index}` }] },
      ],
      sourceAuthority: 'legacy_ra0_confirmed', qualityOnly: true,
      authorityEvidenceEligible: false, promotionEvidenceEligible: false,
    };
  });
}

function fixtureSelection(windows, sourceDatabaseChecksum) {
  let index = 0;
  const items = [];
  for (const [category, count] of CATEGORIES) {
    for (let categoryOrdinal = 0; categoryOrdinal < count; categoryOrdinal += 1) {
      const window = windows[index++];
      items.push({
        windowId: window.windowId,
        sourceWindowChecksum: window.sourceWindowChecksum,
        category,
        categoryOrdinal,
      });
    }
  }
  return {
    version: 1,
    sourceDatabaseChecksum,
    replacements: [{ value: '姜隽倚', placeholder: '[用户]' }],
    items,
  };
}

function insertSucceededPair(db, runId, finalKey, index) {
  const exact = index === 0;
  const substantive = index === 1;
  const stableReply = exact ? '一样的回答' : substantive ? '好的' : `稳定回答 ${index}`;
  const candidateReply = exact ? '  一样的回答  ' : substantive ? '好呀' : `候选回答 ${index}`;
  const stable = { stable: { draft: { action: 'send', reply: stableReply, paymentAction: null, momentAction: null, lifePlan: null, lifeAdjustment: null, relationshipStageAction: null, rolePlanOperations: [] } } };
  const candidate = { candidate: { draft: { action: 'send', reply: candidateReply, paymentAction: null, momentAction: null, lifePlan: null, lifeAdjustment: null, relationshipStageAction: null, rolePlanOperations: [] } } };
  const statement = db.prepare('INSERT INTO quality_phases(run_id,final_key,phase,state,output_json) VALUES (?,?,?,?,?)');
  statement.run(runId, finalKey, 'stable_execution', 'succeeded', JSON.stringify(stable));
  statement.run(runId, finalKey, 'candidate_execution', 'succeeded', JSON.stringify(candidate));
}

test('private preparation removes historical answers, de-identifies text, and freezes the 24-item pool', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-real-chat-prepare-'));
  try {
    const database = join(root, 'source.sqlite');
    writeFileSync(database, 'read-only-source-fixture', 'utf8');
    const windows = fixtureWindows();
    const candidates = join(root, 'candidates.jsonl');
    writeFileSync(candidates, `${windows.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8');
    const selection = join(root, 'selection.json');
    writeJson(selection, fixtureSelection(windows, sourceSha256(database)));
    const outputDir = join(root, 'private-output');

    const result = prepareRealChatBlindEvaluation({
      root, databasePath: database, candidatesPath: candidates, selectionPath: selection, outputDir,
    });

    assert.equal(result.sceneCount, 30);
    assert.equal(result.poolCount, 24);
    assert.equal(result.sourceDatabaseChecksum, sourceSha256(database));
    const scenes = readFileSync(result.historyScenesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(scenes.every(scene => scene.turns.filter(turn => turn.event === 'candidate_response').length === 1), true);
    assert.equal(scenes.every(scene => !JSON.stringify(scene).includes('必须移除的历史答案')), true);
    assert.equal(scenes.every(scene => !JSON.stringify(scene).includes('姜隽倚') && !JSON.stringify(scene).includes('13800138000')), true);
    assert.equal(scenes[0].turns.at(-2).batch.length, 2);
    assert.equal(scenes[0].requiredActionIntegrity.responseMustTarget, scenes[0].turns.at(-2).batch.at(-1).messageId);
    const pool = JSON.parse(readFileSync(result.poolPath, 'utf8'));
    assert.deepEqual(Object.fromEntries(CATEGORIES.map(([category]) => [
      category, pool.items.filter(item => item.category === category).length,
    ])), { daily_chat: 6, emotional_closeness: 6, disagreement_repair: 4, subtext_coquetry: 4, interruption_memory_time: 4 });
    assert.equal(JSON.stringify(pool).includes('姜隽倚'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only ledger export replaces exact and substantive pairs before producing a sealed 12-item human review', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-real-chat-export-'));
  try {
    const database = join(root, 'source.sqlite');
    writeFileSync(database, 'read-only-source-fixture', 'utf8');
    const windows = fixtureWindows();
    const candidates = join(root, 'candidates.jsonl');
    writeFileSync(candidates, `${windows.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8');
    const selection = join(root, 'selection.json');
    writeJson(selection, fixtureSelection(windows, sourceSha256(database)));
    const outputDir = join(root, 'private-output');
    const prepared = prepareRealChatBlindEvaluation({ root, databasePath: database, candidatesPath: candidates, selectionPath: selection, outputDir });
    const pool = JSON.parse(readFileSync(prepared.poolPath, 'utf8'));

    const ledgerPath = join(root, 'ledger.sqlite');
    const db = new DatabaseSync(ledgerPath);
    db.exec(`CREATE TABLE quality_phases(
      run_id TEXT NOT NULL, final_key TEXT NOT NULL, phase TEXT NOT NULL,
      state TEXT NOT NULL, output_json TEXT, PRIMARY KEY(run_id,final_key,phase)
    )`);
    pool.items.forEach((item, index) => insertSucceededPair(db, 'run-1', `history:${item.sceneId}:0`, index));
    db.close();
    const decisionsPath = join(root, 'decisions.json');
    writeJson(decisionsPath, {
      version: 1,
      items: Object.fromEntries(pool.items.map((item, index) => [item.candidateId, index === 1
        ? { semanticStanceDiffers: false, concreteContentOrActionDiffers: false, feltStyleOrEmotionDiffers: false }
        : { semanticStanceDiffers: true, concreteContentOrActionDiffers: false, feltStyleOrEmotionDiffers: false }])),
    });

    const result = exportRealChatHumanReview({
      root, ledgerPath, runId: 'run-1', poolPath: prepared.poolPath,
      historyScenesPath: prepared.historyScenesPath,
      decisionsPath, outputDir, seed: 'sealed-fixture-seed',
    });

    assert.equal(result.scoredCount, 12);
    assert.equal(result.replacementCount, 2);
    assert.equal(result.exactReplacementCount, 1);
    assert.equal(result.substantiveReplacementCount, 1);
    const human = readFileSync(result.humanReviewPath, 'utf8');
    assert.equal((human.match(/^## 第 /gmu) || []).length, 12);
    assert.equal(/stable|candidate|releaseId|mappingChecksum/iu.test(human), false);
    assert.equal(human.includes('历史答案'), false);
    const mapping = JSON.parse(readFileSync(result.sealedMappingPath, 'utf8'));
    assert.equal(mapping.items.length, 12);
    assert.equal(mapping.items.every(item => item.sides.A !== item.sides.B), true);
    const audit = JSON.parse(readFileSync(result.discriminabilityAuditPath, 'utf8'));
    assert.deepEqual(audit.replacements.map(item => item.classification.outcome), ['replace_exact', 'replace_substantive']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('human review combines non-overlapping successful pairs from audited supplemental runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-real-chat-supplement-'));
  try {
    const database = join(root, 'source.sqlite');
    writeFileSync(database, 'read-only-source-fixture', 'utf8');
    const windows = fixtureWindows();
    const candidates = join(root, 'candidates.jsonl');
    writeFileSync(candidates, `${windows.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8');
    const selection = join(root, 'selection.json');
    writeJson(selection, fixtureSelection(windows, sourceSha256(database)));
    const outputDir = join(root, 'private-output');
    const prepared = prepareRealChatBlindEvaluation({ root, databasePath: database, candidatesPath: candidates, selectionPath: selection, outputDir });
    const pool = JSON.parse(readFileSync(prepared.poolPath, 'utf8'));
    const sources = [
      { ledgerPath: join(root, 'main.sqlite'), runId: 'run-main' },
      { ledgerPath: join(root, 'supplement.sqlite'), runId: 'run-supplement' },
    ];
    for (const source of sources) {
      const db = new DatabaseSync(source.ledgerPath);
      db.exec(`CREATE TABLE quality_phases(
        run_id TEXT NOT NULL, final_key TEXT NOT NULL, phase TEXT NOT NULL,
        state TEXT NOT NULL, output_json TEXT, PRIMARY KEY(run_id,final_key,phase)
      )`);
      db.close();
    }
    const main = new DatabaseSync(sources[0].ledgerPath);
    const supplement = new DatabaseSync(sources[1].ledgerPath);
    pool.items.slice(0, -1).forEach((item, index) => insertSucceededPair(
      index === 2 ? supplement : main,
      index === 2 ? sources[1].runId : sources[0].runId,
      `history:${item.sceneId}:0`, index + 10,
    ));
    main.close();
    supplement.close();
    const decisionsPath = join(root, 'decisions.json');
    writeJson(decisionsPath, {
      version: 1,
      items: Object.fromEntries(pool.items.map(item => [item.candidateId,
        { semanticStanceDiffers: true, concreteContentOrActionDiffers: false, feltStyleOrEmotionDiffers: false }])),
    });

    const result = exportRealChatHumanReview({
      root, executionSources: sources, poolPath: prepared.poolPath,
      historyScenesPath: prepared.historyScenesPath,
      decisionsPath, outputDir, seed: 'supplement-fixture-seed',
    });

    assert.equal(result.scoredCount, 12);
    assert.equal(result.technicalFailureCount, 0);
    assert.equal(result.notExecutedCandidateCount, 1);
    const audit = JSON.parse(readFileSync(result.discriminabilityAuditPath, 'utf8'));
    assert.deepEqual(audit.sourceRuns, ['run-main', 'run-supplement']);
    assert.equal(audit.selected.some(item => item.sourceRunId === 'run-supplement'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
