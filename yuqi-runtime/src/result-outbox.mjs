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

  // Redaction races are checked at each semantic boundary.  The store owns
  // the authority proof; older/fake stores simply do not expose this optional
  // guard and retain their existing behavior.
  revalidateSendable(target, checksum = null) {
    if (typeof this.store.assertCloudDeliverySendableInternal !== 'function') return true;
    this.store.assertCloudDeliverySendableInternal({
      turnId: target.turnId,
      peerId: target.peerId,
      authorityGroupId: target.authorityGroupId || null,
      checksum
    });
    return true;
  }

  reserveRelay(target, checksum, relayMessageId) {
    if (typeof this.store.reserveCloudDeliveryRelayInternal !== 'function') {
      return { relayMessageId };
    }
    return this.store.reserveCloudDeliveryRelayInternal({
      turnId: target.turnId,
      peerId: target.peerId,
      authorityGroupId: target.authorityGroupId || null,
      checksum,
      relayMessageId,
      attemptAt: this.clock()
    });
  }

  readDelivery(target) {
    if (typeof this.store.readCloudDeliveryInternal === 'function') {
      return this.store.readCloudDeliveryInternal({
        turnId: target.turnId,
        peerId: target.peerId,
        authorityGroupId: target.authorityGroupId || null
      });
    }
    if (typeof this.store.listCloudDeliveries === 'function') {
      return this.store.listCloudDeliveries(target.turnId)
        .find(row => row.peerId === target.peerId
          && (target.authorityGroupId == null || row.authorityGroupId === target.authorityGroupId)) || null;
    }
    return null;
  }

  async compensateRedaction(target, output) {
    const response = await this.fetch(`${this.relayUrl}/bridge/ack`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.deviceToken}`,
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ deviceId: this.deviceId, messageIds: [output.messageId] })
    });
    if (!response.ok) throw new Error(`cloud relay redaction compensation HTTP ${response.status}`);
    const body = await response.json().catch(() => null);
    if (!body || body.ok !== true || ![0, 1].includes(body.deleted)) {
      throw new Error('cloud relay redaction compensation response conflict');
    }
    const current = this.readDelivery(target);
    if (current?.state === 'redaction_pending'
      && typeof this.store.completeRedactionDeliveryInternal === 'function') {
      this.store.completeRedactionDeliveryInternal({
        turnId: target.turnId,
        peerId: target.peerId,
        relayMessageId: output.messageId,
        requestAt: current.redactionRequestedAt,
        ackAt: this.clock()
      });
    }
  }

  async finalizeEnqueue(target, output, checksum) {
    const current = this.readDelivery(target);
    if (current && ['redaction_pending', 'redacted'].includes(current.state)) {
      await this.compensateRedaction(target, output);
      return false;
    }
    this.revalidateSendable(target, checksum);
    return true;
  }

  async flushRetractionsOnce(limit = 50) {
    if (typeof this.store.listPendingRedactionDeliveries !== 'function') {
      return { completed: 0, failed: 0, waiting: 0 };
    }
    const summary = { completed: 0, failed: 0, waiting: 0 };
    const blockedPeerIds = new Set();
    let fatal = 0;
    const block = target => {
      const peerId = String(target?.peerId || '');
      if (peerId) blockedPeerIds.add(peerId);
    };
    let targets;
    try {
      targets = this.store.listPendingRedactionDeliveries(limit);
    } catch (error) {
      const peerId = typeof error?.peerId === 'string' && error.peerId
        ? error.peerId : '';
      if (peerId && typeof this.store.quarantineRedactionDeliveryInternal === 'function') {
        try {
          this.store.quarantineRedactionDeliveryInternal({
            turnId: error.turnId,
            peerId,
            relayMessageId: error.relayMessageId,
            requestAt: error.requestAt,
            reasonCode: 'authority_conflict'
          });
        } catch {
          // A malformed target remains fatal and blocked; never send or
          // reinterpret it as an ordinary delivery.
        }
      }
      return {
        ...summary,
        failed: 1,
        fatal: 1,
        blockedPeerIds: peerId ? [peerId] : []
      };
    }
    for (const target of targets) {
      let claim;
      try {
        claim = this.store.claimRedactionDeliveryInternal({
          turnId: target.turnId,
          peerId: target.peerId,
          requestAt: this.clock()
        });
        if (!claim) {
          summary.waiting += 1;
          block(target);
          continue;
        }
      } catch {
        summary.failed += 1;
        fatal += 1;
        block(target);
        if (typeof this.store.quarantineRedactionDeliveryInternal === 'function') {
          try {
            this.store.quarantineRedactionDeliveryInternal({
              turnId: target.turnId,
              peerId: target.peerId,
              relayMessageId: target.relayMessageId,
              requestAt: target.redactionRequestedAt,
              reasonCode: 'authority_conflict'
            });
          } catch {
            // A malformed target cannot be safely rewritten; fatal remains
            // durable at the caller boundary and this peer stays blocked.
          }
        }
        continue;
      }
      try {
        const response = await this.fetch(`${this.relayUrl}/bridge/ack`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.deviceToken}`,
            accept: 'application/json',
            'content-type': 'application/json'
          },
          body: JSON.stringify({ deviceId: this.deviceId, messageIds: [claim.relayMessageId] })
        });
        if (!response.ok) throw new Error(`cloud relay redaction ack HTTP ${response.status}`);
        const body = await response.json().catch(() => null);
        if (!body || body.ok !== true || ![0, 1].includes(body.deleted)) {
          throw new Error('cloud relay redaction ack response conflict');
        }
        this.store.completeRedactionDeliveryInternal({
          turnId: claim.turnId,
          peerId: claim.peerId,
          relayMessageId: claim.relayMessageId,
          requestAt: claim.requestAt,
          ackAt: this.clock()
        });
        summary.completed += 1;
      } catch {
        summary.failed += 1;
        block(target);
      }
    }
    if (typeof this.store.listPendingRedactionPeerIdsInternal === 'function') {
      try {
        for (const peerId of this.store.listPendingRedactionPeerIdsInternal() || []) {
          const normalized = String(peerId || '');
          if (normalized) blockedPeerIds.add(normalized);
        }
      } catch {
        fatal += 1;
        summary.failed += 1;
        for (const target of targets) block(target);
      }
    }
    if (typeof this.store.listQuarantinedRedactionPeerIdsInternal === 'function') {
      try {
        for (const peerId of this.store.listQuarantinedRedactionPeerIdsInternal() || []) {
          const normalized = String(peerId || '');
          if (normalized) blockedPeerIds.add(normalized);
        }
      } catch {
        fatal += 1;
        summary.failed += 1;
      }
    }
    if (fatal || summary.failed || summary.waiting || blockedPeerIds.size) {
      return {
        ...summary,
        ...(fatal ? { fatal } : {}),
        blockedPeerIds: [...blockedPeerIds].sort()
      };
    }
    return summary;
  }

  async flushOnce(limit = 50, { blockedPeerIds = [] } = {}) {
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
      const blocked = new Set((blockedPeerIds || []).map(value => String(value)));
      const targets = [...authorityTargets, ...failureTargets, ...legacyTargets].filter(target =>
        !blocked.has(String(target.peerId || ''))
      ).sort((left, right) =>
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
          try {
            this.revalidateSendable(target, claim.rawStatusChecksum);
          } catch {
            summary.failed += 1;
            continue;
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
            if (!await this.finalizeEnqueue(target, output, claim.rawStatusChecksum)) {
              summary.failed += 1;
              continue;
            }
          } catch {
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
            this.revalidateSendable(target, target.checksum || null);
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
            this.revalidateSendable(target, delivery.checksum);
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
            if (error?.message === 'cloud delivery stale redaction conflict') {
              summary.failed += 1;
              continue;
            }
            throw error;
          }
          const identity = `${target.authorityGroupId}:${target.peerId}:${target.authorityCommitChecksum}`;
          let reserved;
          try {
            reserved = this.reserveRelay(
              target,
              delivery.checksum,
              stableId('relay_pc', identity)
            );
          } catch {
            summary.failed += 1;
            continue;
          }
          const encrypted = encryptRelayPayload(publicPayload, this.encryptionKeyBase64);
          const output = {
            deviceId: this.deviceId,
            messageId: reserved.relayMessageId,
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
            if (!await this.finalizeEnqueue(target, output, delivery.checksum)) {
              summary.failed += 1;
              continue;
            }
          } catch {
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
        try {
          this.revalidateSendable(target, target.checksum || null);
        } catch {
          summary.failed += 1;
          continue;
        }
        const status = publicTurnStatus(turn);
        if (!status?.terminal) {
          summary.waiting += 1;
          continue;
        }
        try {
          const publicPayload = { ok: true, ...status, recoveryAckSeq: target.recoveryAckSeq };
          const delivery = this.store.prepareCloudDelivery(target.turnId, target.peerId, publicPayload);
          this.store.markCloudDeliveryAttempt(target.turnId, target.peerId);
          this.revalidateSendable(target, delivery.checksum);
          const identity = `${target.turnId}:${target.peerId}:${delivery.checksum}`;
          const reserved = this.reserveRelay(
            target,
            delivery.checksum,
            stableId('relay_pc', identity)
          );
          const encrypted = encryptRelayPayload(publicPayload, this.encryptionKeyBase64);
          const output = {
            deviceId: this.deviceId,
            messageId: reserved.relayMessageId,
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
          if (!await this.finalizeEnqueue(target, output, delivery.checksum)) {
            summary.failed += 1;
            continue;
          }
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
