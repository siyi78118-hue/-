import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const configPath = resolve(option('--config', 'yuqi-runtime/config.json'));
const turnId = option('--turn');
const apply = process.argv.includes('--apply');
if (!turnId) throw new Error('--turn is required');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const databasePath = resolve(option('--database', config.databasePath));
const store = new YuqiStore(databasePath);
try {
  const turn = store.getTurn(turnId);
  if (!turn) throw new Error('turn not found');
  const draft = turn.brainDraftJson ? JSON.parse(turn.brainDraftJson) : null;
  const peerId = option('--peer', store.listCloudDeliveries(turnId)[0]?.peerId || turn.deviceId);
  if (!apply) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: true,
      turnId,
      state: turn.state,
      peerId,
      recoverable: turn.state === 'failed' && !!String(draft?.reply || '').trim(),
      reply: String(draft?.reply || ''),
      deliveries: store.listCloudDeliveries(turnId).map(delivery => ({
        peerId: delivery.peerId,
        state: delivery.state,
        attempts: delivery.attempts,
        deliveredAt: delivery.deliveredAt,
        confirmedAt: delivery.confirmedAt
      }))
    })}\n`);
  } else {
    const recovered = store.recoverFailedDraft(turnId, {
      peerId,
      sentAt: Number(turn.updatedAt) || Date.now()
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: false,
      turnId,
      peerId,
      recovered: recovered.recovered,
      messageId: recovered.result?.reply?.messageId || ''
    })}\n`);
  }
} finally {
  store.close();
}
