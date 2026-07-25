import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { signBridgeRequest } from '../yuqi-runtime/src/local-server.mjs';

const [turnId, configArgument = 'yuqi-runtime/config.json'] = process.argv.slice(2);
if (!turnId) throw new Error('turnId is required');

const config = JSON.parse(readFileSync(resolve(configArgument), 'utf8'));
const path = `/v2/turns/${encodeURIComponent(turnId)}`;
const timestamp = Date.now();
const nonce = randomBytes(12).toString('base64url');
const signature = signBridgeRequest({
  secret: config.pairingSecret,
  method: 'GET',
  path,
  timestamp,
  nonce
});
const response = await fetch(`http://127.0.0.1:${Number(config.port || 17891)}${path}`, {
  headers: {
    'x-yuqi-timestamp': String(timestamp),
    'x-yuqi-nonce': nonce,
    'x-yuqi-signature': signature
  }
});
const body = await response.json();
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
if (!response.ok) process.exitCode = 1;
