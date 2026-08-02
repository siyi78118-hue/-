import { encryptRelayPayload, stableId } from './cloud-relay-pump.mjs';
import { isCanonicalAuthorityConflictError, projectBridgeResultForWire } from './bridge-result-projector.mjs';
import { publicTurnStatus } from './turn-status.mjs';

function consumeCanonicalQuarantineOutcome(result) {
  if (!result || ![
    'quarantined', 'already_quarantined', 'stale_redacted', 'stale_terminal'
  ].includes(result.quarantineOutcome)) {
    throw new Error('canonical delivery quarantine outcome conflict');
  }
  return result;
}

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
      const authorityTargets = typeof this.store.listPendingAuthorityCloudDeliveries === 'function'
        ? this.store.listPendingAuthorityCloudDeliveries(limit)
        : [];
      const failureTargets = typeof this.store.listPendingCanonicalFailureCloudDeliveries === 'function'
        ? this.store.listPendingCanonicalFailureCloudDeliveries(limit, this.clock())
        : [];
      const legacyTargets = this.store.listPendingCloudDeliveries(limit);
      const targets = [...authorityTargets, ...failureTargets, ...legacyTargets].sort((left, right) =>
        Number(left.updatedAt || 0) - Number(right.updatedAt || 0)
        || String(left.authorityGroupId || left.turnId).localeCompare(
          String(right.authorityGroupId || right.turnId)
        )
        || String(left.peerId).localeCompare(String(right.peerId))
      ).slice(0, limit);
      for (const target of targets) {
        if (target.deliveryType === 'canonical_failure') {
          const expected = {
            state: target.state,
            payloadJson: target.payloadJson ?? null,
            checksum: target.checksum || null,
            attempts: Number(target.attempts || 0),
            relayMessageId: target.relayMessageId ?? null,
            deliveredAt: target.deliveredAt ?? null,
            updatedAt: Number(target.updatedAt || 0)
          };
          let claim;
          try {
            claim = this.store.claimCanonicalFailureCloudDeliveryInternal({
              turnId: target.turnId,
              peerId: target.peerId,
              timestamp: this.clock()
            });
            if (!claim) continue;
          } catch (error) {
            if (isCanonicalAuthorityConflictError(error)
              && typeof this.store.quarantineCanonicalCloudDeliveryInternal === 'function') {
              consumeCanonicalQuarantineOutcome(this.store.quarantineCanonicalCloudDeliveryInternal({
                turnId: target.turnId,
                peerId: target.peerId,
                expected,
                reason: 'authority_validation_failed'
              }));
              summary.failed += 1;
              continue;
            }
            throw error;
          }
          const encrypted = encryptRelayPayload(claim.payload, this.encryptionKeyBase64);
          const output = {
            deviceId: this.deviceId,
            messageId: claim.relayMessageId,
            idempotencyKey: claim.relayMessageId,
            direction: 'pc_to_phone',
            ...encrypted,
            expiresAt: this.clock() + 24 * 60 * 60 * 1000
          };
          let response;
          try {
            response = await this.fetch(`${this.relayUrl}/bridge/enqueue`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${this.deviceToken}`,
                accept: 'application/json',
                'content-type': 'application/json'
              },
              body: JSON.stringify(output)
            });
          } catch {
            summary.failed += 1;
            continue;
          }
          if (!response.ok) {
            summary.failed += 1;
            continue;
          }
          try {
            this.store.markCanonicalFailureCloudDeliveryMailboxedInternal({
              turnId: target.turnId,
              peerId: target.peerId,
              rawStatusChecksum: claim.rawStatusChecksum,
              leaseId: claim.leaseId,
              leaseAttempt: claim.leaseAttempt,
              relayMessageId: output.messageId,
              timestamp: this.clock()
            });
            summary.delivered += 1;
          } catch (error) {
            throw error;
          }
          continue;
        }
        if (target.authorityGroupId) {
          const expected = {
            state: target.state,
            payloadJson: target.payloadJson ?? null,
            checksum: target.checksum || null,
            attempts: Number(target.attempts || 0),
            relayMessageId: target.relayMessageId ?? null,
            deliveredAt: target.deliveredAt ?? null,
            updatedAt: Number(target.updatedAt || 0)
          };
          let publicPayload;
          let delivery;
          try {
            const persistedTurn = this.store.getTurn(target.turnId);
            const canonicalResult = this.store.loadCanonicalBridgeResultInternal(target.turnId);
            if (canonicalResult?.status === 'redacted') {
              summary.failed += 1;
              continue;
            }
            publicPayload = {
              ok: true,
              ...projectBridgeResultForWire(canonicalResult,
                Number(persistedTurn?.protocolVersion) === 3 ? 3 : 2),
              recoveryAckSeq: Number(target.recoveryAckSeq || 0)
            };
            if (publicPayload.deliverable === false) {
              summary.failed += 1;
              continue;
            }
            delivery = this.store.prepareAuthorityCloudDelivery(
              target.authorityGroupId,
              target.peerId,
              publicPayload
            );
            this.store.markAuthorityCloudDeliveryAttempt(
              target.authorityGroupId,
              target.peerId
            );
          } catch (error) {
            if (isCanonicalAuthorityConflictError(error)
              && typeof this.store.quarantineCanonicalVisibleDeliveryInternal === 'function') {
              consumeCanonicalQuarantineOutcome(this.store.quarantineCanonicalVisibleDeliveryInternal({
                turnId: target.turnId,
                peerId: target.peerId,
                authorityGroupId: target.authorityGroupId,
                authorityCommitChecksum: target.authorityCommitChecksum,
                expected,
                reason: 'authority_validation_failed'
              }));
              summary.failed += 1;
              continue;
            }
            throw error;
          }
          const encrypted = encryptRelayPayload(publicPayload, this.encryptionKeyBase64);
          const identity = `${target.authorityGroupId}:${target.peerId}:${target.authorityCommitChecksum}`;
          const output = {
            deviceId: this.deviceId,
            messageId: stableId('relay_pc', identity),
            idempotencyKey: stableId('reply', identity),
            direction: 'pc_to_phone',
            ...encrypted,
            expiresAt: this.clock() + 24 * 60 * 60 * 1000
          };
          let response;
          try {
            response = await this.fetch(`${this.relayUrl}/bridge/enqueue`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${this.deviceToken}`,
                accept: 'application/json',
                'content-type': 'application/json'
              },
              body: JSON.stringify(output)
            });
          } catch {
            summary.failed += 1;
            continue;
          }
          if (!response.ok) {
            summary.failed += 1;
            continue;
          }
          try {
            this.store.markAuthorityCloudDeliveryMailboxed(
              target.authorityGroupId,
              target.peerId,
              delivery.checksum,
              output.messageId
            );
            summary.delivered += 1;
          } catch (error) {
            throw error;
          }
          continue;
        }
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
