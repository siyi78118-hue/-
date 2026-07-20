import { encryptRelayPayload, stableId } from './cloud-relay-pump.mjs';
import { publicTurnStatus } from './turn-status.mjs';

export class ResultOutbox {
  constructor({
    relayUrl,
    deviceId,
    deviceToken,
    encryptionKeyBase64,
    store,
    fetchImpl = globalThis.fetch,
    clock = Date.now
  }) {
    if (!String(relayUrl || '').startsWith('https://')) throw new Error('relayUrl must use HTTPS');
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(deviceId || ''))) throw new Error('invalid cloud deviceId');
    if (String(deviceToken || '').length < 16) throw new Error('invalid cloud device token');
    if (Buffer.from(String(encryptionKeyBase64 || ''), 'base64').length !== 32) {
      throw new Error('cloud encryption key must be 256-bit');
    }
    if (!store || typeof store.listPendingCloudDeliveries !== 'function') throw new Error('store is required');
    this.relayUrl = String(relayUrl).replace(/\/+$/, '');
    this.deviceId = String(deviceId);
    this.deviceToken = String(deviceToken);
    this.encryptionKeyBase64 = String(encryptionKeyBase64);
    this.store = store;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.running = false;
  }

  async flushOnce(limit = 50) {
    if (this.running) return { delivered: 0, failed: 0, waiting: 0, skipped: true };
    this.running = true;
    const summary = { delivered: 0, failed: 0, waiting: 0 };
    try {
      for (const target of this.store.listPendingCloudDeliveries(limit)) {
        const turn = this.store.getTurn(target.turnId);
        const status = publicTurnStatus(turn);
        if (!status?.terminal) {
          summary.waiting += 1;
          continue;
        }
        try {
          const publicPayload = { ok: true, ...status, recoveryAckSeq: target.recoveryAckSeq };
          const delivery = this.store.prepareCloudDelivery(target.turnId, target.peerId, publicPayload);
          this.store.markCloudDeliveryAttempt(target.turnId, target.peerId);
          const encrypted = encryptRelayPayload(publicPayload, this.encryptionKeyBase64);
          const identity = `${target.turnId}:${target.peerId}:${delivery.checksum}`;
          const output = {
            deviceId: this.deviceId,
            messageId: stableId('relay_pc', identity),
            idempotencyKey: stableId('reply', identity),
            direction: 'pc_to_phone',
            ...encrypted,
            expiresAt: this.clock() + 24 * 60 * 60 * 1000
          };
          const response = await this.fetch(`${this.relayUrl}/bridge/enqueue`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.deviceToken}`,
              accept: 'application/json',
              'content-type': 'application/json'
            },
            body: JSON.stringify(output)
          });
          if (!response.ok) throw new Error(`cloud relay enqueue HTTP ${response.status}`);
          this.store.markCloudDeliveryMailboxed(target.turnId, target.peerId, delivery.checksum);
          summary.delivered += 1;
        } catch {
          summary.failed += 1;
        }
      }
      return summary;
    } finally {
      this.running = false;
    }
  }
}
