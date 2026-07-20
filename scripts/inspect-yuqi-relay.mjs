import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { requestCloudJson } from './cloud-http.mjs';
import { decryptRelayPayload } from '../yuqi-runtime/src/cloud-relay-pump.mjs';

const root = resolve(import.meta.dirname, '..');
const configPath = resolve(process.argv[2] || `${root}/yuqi-runtime/config.json`);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const relay = config.cloudRelay || {};
const baseUrl = String(relay.url || '').replace(/\/+$/, '');
const headers = {
  authorization: `Bearer ${relay.deviceToken}`,
  accept: 'application/json'
};

const output = {};
for (const direction of ['phone_to_pc', 'pc_to_phone']) {
  const payload = await requestCloudJson(
    `${baseUrl}/bridge/poll?deviceId=${encodeURIComponent(relay.deviceId)}&direction=${direction}&limit=50`,
    { headers }
  );
  output[direction] = (payload.messages || []).map(message => {
    let decoded = {};
    let decryptError = '';
    try { decoded = decryptRelayPayload(message, relay.encryptionKeyBase64); }
    catch (error) { decryptError = String(error?.message || error); }
    return {
      messageId: message.messageId,
      createdAt: message.createdAt,
      expiresAt: message.expiresAt,
      decryptError,
      turnId: decoded.turnId || '',
      kind: decoded.kind || '',
      state: decoded.state || '',
      terminal: decoded.terminal === true,
      committed: decoded.committed === true,
      errorCode: decoded.errorCode || '',
      allowFallback: decoded.allowFallback === true,
      replyParts: Array.isArray(decoded.replyParts) ? decoded.replyParts.length : 0
    };
  });
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
