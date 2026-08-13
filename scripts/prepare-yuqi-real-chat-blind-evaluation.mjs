import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import {
  deidentifyRealChatWindow,
  validateRealChatCandidatePool,
} from '../yuqi-runtime/src/real-chat-blind-evaluation.mjs';
import { sourceSha256 } from './extract-yuqi-real-history-scenes.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const CATEGORY_KEYS = new Set([
  'daily_chat', 'emotional_closeness', 'disagreement_repair',
  'subtext_coquetry', 'interruption_memory_time',
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} shape conflict`);
  }
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} JSON conflict`); }
}

function readJsonl(path, label) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean);
  try { return lines.map(line => JSON.parse(line)); }
  catch { throw new Error(`${label} JSONL conflict`); }
}

function privateOutputPath(root, outputDir) {
  const rootPath = resolve(root);
  const value = resolve(outputDir || join(rootPath,
    'artifacts/yuqi-lived-agency-v3/private/real-chat-blind-evaluation'));
  if (value !== rootPath && !value.startsWith(`${rootPath}${sep}`)) {
    throw new Error('real-chat blind output must remain below root');
  }
  return value;
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
  rmSync(path, { force: true });
  renameSync(temporary, path);
}

function validateSelection(value, windows, sourceDatabaseChecksum) {
  exactKeys(value, ['version', 'sourceDatabaseChecksum', 'replacements', 'items'], 'real-chat selection');
  if (value.version !== 1 || value.sourceDatabaseChecksum !== sourceDatabaseChecksum
    || !Array.isArray(value.replacements) || !Array.isArray(value.items) || value.items.length !== 24) {
    throw new Error('real-chat selection authority conflict');
  }
  const windowMap = new Map(windows.map(window => [window.windowId, window]));
  if (windowMap.size !== 30) throw new Error('real-chat candidates require exactly 30 unique windows');
  const seen = new Set();
  for (const [index, item] of value.items.entries()) {
    exactKeys(item, ['windowId', 'sourceWindowChecksum', 'category', 'categoryOrdinal'], `selection item ${index}`);
    const window = windowMap.get(item.windowId);
    if (!window || window.sourceWindowChecksum !== item.sourceWindowChecksum || seen.has(item.windowId)
      || !CATEGORY_KEYS.has(item.category) || !Number.isSafeInteger(item.categoryOrdinal)) {
      throw new Error(`selection item ${index} authority conflict`);
    }
    seen.add(item.windowId);
  }
  return { windowMap, selection: structuredClone(value) };
}

function isoTime(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`${label} timestamp conflict`);
  return new Date(numeric).toISOString();
}

function sceneMessageId(sceneId, turnIndex, itemIndex) {
  return `${sceneId}:turn${turnIndex}:item${itemIndex}`;
}

function buildScene(window, index, category = 'unscored_reserve') {
  if (window.turns.length < 4 || window.turns.length > 12
    || window.turns.at(-1)?.speaker !== 'assistant'
    || window.turns.at(-2)?.speaker !== 'user') {
    throw new Error(`real-chat window ${window.windowId} terminal shape conflict`);
  }
  const sceneId = `real_history_${String(index).padStart(2, '0')}`;
  const contextTurns = window.turns.slice(0, -1).map((turn, turnIndex) => ({
    at: isoTime(turn.at, `real-chat window ${window.windowId}`),
    speaker: turn.speaker,
    batch: turn.batch.map((item, itemIndex) => ({
      messageId: sceneMessageId(sceneId, turnIndex, itemIndex),
      type: String(item.type || 'text'),
      text: String(item.text ?? item.content ?? ''),
    })),
  }));
  const targetTurn = contextTurns.at(-1);
  if (!targetTurn?.batch?.length || targetTurn.batch.some(item => !item.text)) {
    throw new Error(`real-chat window ${window.windowId} target batch conflict`);
  }
  const anchorAt = Math.max(Number(window.turns.at(-1).at), Number(window.turns.at(-2).at)) + 1;
  const focus = '承接真实微信上下文和用户本轮完整表达；直接回应，不写分析报告，不编造未出现的事实。';
  return {
    sceneId,
    rolloutKey: 'DIRECT_REPLY',
    annotationVersion: 'real-chat-blind-v1',
    context: {},
    evidenceClass: 'real_history_quality_only',
    focus,
    initialState: {
      relationship: { base: 'familiar', phase: 'normal' },
      lifeSignals: [], currentStances: [], verifiedFacts: [],
    },
    turns: [...contextTurns, { at: isoTime(anchorAt, `real-chat window ${window.windowId} anchor`), event: 'candidate_response', speaker: 'system' }],
    mustNotice: ['用户最后一批气泡是一个整体', '承接前一轮语境和虞栖已经说过的话'],
    allowedDecisionRange: ['直接回应', '自然追问', '简短停顿', '具体自我表达'],
    forbiddenFailurePatterns: ['客服或心理咨询腔', '逐句分析用户', '编造记忆', '无视前文', '把多气泡只看最后一句'],
    requiredActionIntegrity: { responseMustTarget: targetTurn.batch.at(-1).messageId },
    allowedPersonalityVariation: ['自然', '温和', '嘴硬', '简短', '带情绪'],
    expectedStateTransitions: { allow: ['maintain', 'soften', 'pause', 'repair'] },
    forbiddenStateTransitions: { inventRelationshipOrMemory: true },
    sourceAnnotation: { file: 'private_real_chat_history', heading: category },
    sourceAuthority: 'legacy_ra0_confirmed',
    qualityOnly: true,
    liveShadowEvidenceEligible: false,
    realHistoryEvidence: true,
    authorityEvidenceEligible: false,
    promotionEvidenceEligible: false,
    severity: 'high',
  };
}

function assertNoDirectPii(value, replacements) {
  const text = JSON.stringify(value);
  const findings = [];
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/u.test(text)) findings.push('phone');
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text)) findings.push('email');
  if (/https?:\/\/[^\s"}]+/iu.test(text)) findings.push('link');
  for (const replacement of replacements) {
    if (text.includes(replacement.value)) findings.push(`replacement:${replacement.placeholder}`);
  }
  if (findings.length) throw new Error(`model-facing real chat contains PII findings: ${[...new Set(findings)].join(',')}`);
}

function contextPreflight(pool, scenesById) {
  return [
    '# 真实聊天候选池上下文预检',
    '',
    '以下片段已经去标识化；这里只展示上下文，不展示历史答案或本轮 A/B 回答。',
    '',
    ...pool.items.flatMap((item, index) => {
      const scene = scenesById.get(item.sceneId);
      const lines = scene.turns.filter(turn => turn.speaker !== 'system')
        .flatMap(turn => turn.batch.map(part => `- ${turn.speaker === 'assistant' ? '虞栖' : '用户'}：${part.text}`));
      return [`## 候选 ${index + 1}`, '', ...lines, ''];
    }),
  ].join('\n');
}

export function prepareRealChatBlindEvaluation({
  root = process.cwd(), databasePath, candidatesPath, selectionPath, outputDir,
} = {}) {
  if (!databasePath || !isAbsolute(databasePath) || !candidatesPath || !selectionPath) {
    throw new Error('real-chat preparation paths are required');
  }
  const before = sourceSha256(databasePath);
  const windows = readJsonl(candidatesPath, 'real-chat candidates');
  if (windows.length !== 30 || new Set(windows.map(window => window.windowId)).size !== 30) {
    throw new Error('real-chat candidates require exactly 30 unique windows');
  }
  const selectionValue = readJson(selectionPath, 'real-chat selection');
  const { selection } = validateSelection(selectionValue, windows, before);
  const categoryByWindow = new Map(selection.items.map(item => [item.windowId, item.category]));
  const deidentified = windows.map(window => deidentifyRealChatWindow(window, { replacements: selection.replacements }));
  const scenes = deidentified.map((window, index) => buildScene(window, index, categoryByWindow.get(window.windowId)));
  const sceneByWindow = new Map(windows.map((window, index) => [window.windowId, scenes[index]]));
  const pool = validateRealChatCandidatePool({
    version: 1,
    items: selection.items.map((item, index) => {
      const scene = sceneByWindow.get(item.windowId);
      const target = scene.turns.at(-2);
      return {
        candidateId: `real_candidate_${String(index).padStart(2, '0')}`,
        windowId: item.windowId,
        sourceWindowChecksum: item.sourceWindowChecksum,
        sceneId: scene.sceneId,
        category: item.category,
        categoryOrdinal: item.categoryOrdinal,
        multiBubble: target.batch.length > 1,
      };
    }),
  });
  assertNoDirectPii(scenes, selection.replacements);
  const manifest = {
    schemaVersion: 1,
    sceneIds: scenes.map(scene => scene.sceneId),
    scenesChecksum: contentHash(scenes),
  };
  const output = privateOutputPath(root, outputDir);
  const historyScenesPath = join(output, 'history-scenes.jsonl');
  const historyManifestPath = join(output, 'history-scenes.manifest.json');
  const poolPath = join(output, 'candidate-pool.json');
  const contextPreflightPath = join(output, 'context-preflight.md');
  atomicWrite(historyScenesPath, `${scenes.map(scene => canonicalJson(scene)).join('\n')}\n`);
  atomicWrite(historyManifestPath, `${canonicalJson(manifest)}\n`);
  atomicWrite(poolPath, `${canonicalJson(pool)}\n`);
  atomicWrite(contextPreflightPath, `${contextPreflight(pool, new Map(scenes.map(scene => [scene.sceneId, scene])))}\n`);
  const after = sourceSha256(databasePath);
  if (after !== before) throw new Error('source database changed during real-chat preparation');
  return {
    version: 1,
    sceneCount: scenes.length,
    poolCount: pool.items.length,
    sourceDatabaseChecksum: before,
    historyScenesPath,
    historyManifestPath,
    poolPath,
    contextPreflightPath,
  };
}

function cliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) {
      throw new Error('invalid real-chat preparation CLI arguments');
    }
    values.set(key, value);
  }
  return values;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = cliArgs(process.argv.slice(2));
  const result = prepareRealChatBlindEvaluation({
    root: resolve(args.get('--root') || process.cwd()),
    databasePath: resolve(args.get('--database') || ''),
    candidatesPath: resolve(args.get('--candidates') || ''),
    selectionPath: resolve(args.get('--selection') || ''),
    outputDir: args.get('--output-dir') ? resolve(args.get('--output-dir')) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
