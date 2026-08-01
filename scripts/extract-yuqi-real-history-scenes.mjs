import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function classifyStructure(turn) {
  const raw = JSON.stringify(turn);
  if (/red.?packet|红包|payment/i.test(raw)) return 'payment_social_action';
  if (/quote|引用|replyTo/i.test(raw)) return 'quoted_context';
  if (/image|voice|attachment|图片|语音/i.test(raw)) return 'attachment_context';
  if (/moment|朋友圈/i.test(raw)) return 'moment_context';
  if (/schedule|calendar|日程|安排/i.test(raw)) return 'schedule_context';
  return 'plain_chat';
}

export function selectRealHistoryScenes(turns, limit = 30) {
  const selected = [];
  const seen = new Set();
  for (const turn of turns) {
    const structure = classifyStructure(turn);
    if (seen.has(structure)) continue;
    selected.push({ ...turn, structure });
    seen.add(structure);
    if (selected.length >= limit) return selected;
  }
  for (const turn of turns) {
    if (selected.some(item => item.turnId === turn.turnId)) continue;
    selected.push({ ...turn, structure: classifyStructure(turn) });
    if (selected.length >= limit) break;
  }
  return selected;
}

const configPath = resolve(option('config', 'yuqi-runtime/config.json'));
const outputPath = resolve(option('out', 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl'));
const allowedPrivateRoot = resolve('artifacts/yuqi-lived-agency-v3/private');
if (relative(allowedPrivateRoot, outputPath).startsWith('..') || outputPath === allowedPrivateRoot) {
  throw new Error('--out must remain under artifacts/yuqi-lived-agency-v3/private');
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const databasePath = isAbsolute(config.databasePath || '')
  ? config.databasePath
  : resolve(dirname(configPath), config.databasePath || 'data/yuqi-runtime.sqlite');
const store = new YuqiStore(databasePath);
try {
  const limit = Math.max(1, Math.min(30, Number(option('limit', 30)) || 30));
  const turns = store.listReplayEligibleTurns?.({ rolloutKey: 'DIRECT_REPLY', limit: 300 }) || [];
  const scenes = selectRealHistoryScenes(turns, limit).map(turn => ({
    sceneId: `local_${turn.turnId}`,
    sourceType: 'local_history',
    sourceRef: turn.turnId,
    structure: turn.structure,
    createdAt: turn.createdAt,
    envelope: JSON.parse(turn.envelopeJson),
    expected: { mustNoticeMessageIds: turn.sourceMessageId ? [turn.sourceMessageId] : [] }
  }));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${scenes.map(scene => JSON.stringify(scene)).join('\n')}${scenes.length ? '\n' : ''}`, 'utf8');
  process.stdout.write(`${JSON.stringify({ count: scenes.length, checksum: contentHash(scenes), output: outputPath })}\n`);
} finally {
  store.close();
}
