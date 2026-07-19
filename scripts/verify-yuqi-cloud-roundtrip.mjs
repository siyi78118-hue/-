import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSystemCloudFetch } from './cloud-http.mjs';
import { decryptRelayPayload, encryptRelayPayload } from '../yuqi-runtime/src/cloud-relay-pump.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.argv[2] || join(root, 'yuqi-runtime', 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const cloud = config.cloudRelay || {};
if (!cloud.enabled || !cloud.url || !cloud.deviceId || !cloud.deviceToken || !cloud.encryptionKeyBase64) {
  throw new Error('Yuqi cloud relay is not fully configured');
}

const stamp = Date.now();
const messageId = `probe_${stamp}`;
const plaintext = { probe: 'yuqi-cloud-roundtrip', stamp };
const encrypted = encryptRelayPayload(plaintext, cloud.encryptionKeyBase64);
const baseUrl = String(cloud.url).replace(/\/+$/, '');
const headers = {
  authorization: `Bearer ${cloud.deviceToken}`,
  accept: 'application/json',
  'content-type': 'application/json'
};
let enqueued = false;
let deleted = false;
const cloudFetch = createSystemCloudFetch();

async function requestCloudJson(url, options = {}) {
  const response = await cloudFetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  if (!response.ok) throw new Error(`cloud HTTP request failed (${response.status})`);
  return response.json();
}

async function acknowledge() {
  const result = await requestCloudJson(`${baseUrl}/bridge/ack`, {
    method: 'POST',
    headers,
    body: { deviceId: cloud.deviceId, messageIds: [messageId] }
  });
  deleted = Number(result.deleted || 0) >= 1;
  return result;
}

try {
  const queued = await requestCloudJson(`${baseUrl}/bridge/enqueue`, {
    method: 'POST',
    headers,
    body: {
      deviceId: cloud.deviceId,
      messageId,
      idempotencyKey: messageId,
      direction: 'pc_to_phone',
      ...encrypted,
      expiresAt: stamp + 10 * 60 * 1000
    }
  });
  enqueued = queued.ok === true;
  if (!enqueued) throw new Error('cloud probe enqueue failed');

  const polled = await requestCloudJson(
    `${baseUrl}/bridge/poll?deviceId=${encodeURIComponent(cloud.deviceId)}&direction=pc_to_phone&limit=50`,
    { headers }
  );
  const stored = (polled.messages || []).find(message => message.messageId === messageId);
  if (!stored) throw new Error('cloud probe was not returned');
  const forbidden = ['probe', 'content', 'prompt', 'memory', 'reply'].filter(key => Object.hasOwn(stored, key));
  if (forbidden.length) throw new Error('cloud relay exposed plaintext fields');

  const decoded = decryptRelayPayload(stored, cloud.encryptionKeyBase64);
  if (decoded.probe !== plaintext.probe || decoded.stamp !== plaintext.stamp) {
    throw new Error('cloud probe decryption mismatch');
  }

  await acknowledge();
  if (!deleted) throw new Error('cloud probe acknowledgement did not delete the message');
  const after = await requestCloudJson(
    `${baseUrl}/bridge/poll?deviceId=${encodeURIComponent(cloud.deviceId)}&direction=pc_to_phone&limit=50`,
    { headers }
  );
  if ((after.messages || []).some(message => message.messageId === messageId)) {
    throw new Error('cloud probe remained after acknowledgement');
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    enqueued: true,
    decrypted: true,
    plaintextFieldsStored: false,
    deleted: true
  })}\n`);
} finally {
  if (enqueued && !deleted) await acknowledge().catch(() => {});
}
