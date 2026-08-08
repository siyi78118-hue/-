import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import {
  canonicalJson,
  contentHash,
  validateAuthorityDeliveryReceipt,
  validateConversationClearApplied,
  validateConversationClearControl,
  validateEnvelope,
  validateRoleDeleteApplied,
  validateRoleDeleteControl,
  validateRoleDeletePending
} from './protocol.mjs';
import { normalizeRecoverySnapshot } from './reconcile.mjs';

function keyBytes(value) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new Error('cloud encryption key must be 256-bit');
  return key;
}

export function stableId(prefix, value) {
  return `${prefix}_${createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24)}`;
}

export function encryptRelayPayload(value, encryptionKeyBase64, suppliedNonce = null) {
  const nonce = suppliedNonce ? Buffer.from(suppliedNonce) : randomBytes(12);
  if (nonce.length !== 12) throw new Error('AES-GCM nonce must contain 12 bytes');
  return encryptSerializedRelayPayload(JSON.stringify(value), encryptionKeyBase64, nonce);
}

function encryptSerializedRelayPayload(serialized, encryptionKeyBase64, nonce) {
  const cipher = createCipheriv('aes-256-gcm', keyBytes(encryptionKeyBase64), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(serialized, 'utf8'),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64') };
}

function isConversationClearCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (isRoleDeleteCandidate(value)) return false;
  if (value.type === 'CONVERSATION_CLEAR') return true;
  return ['controlVersion', 'controlId', 'inputCursorChecksum', 'clearEpoch', 'clearedThroughSequence']
    .some(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isRoleDeleteCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.type === 'ROLE_DELETE'
    || value.controlVersion === 'role_delete_v1'
    || Object.prototype.hasOwnProperty.call(value, 'backupReceipt');
}

function deriveConversationClearResponse(proof, encryptionKeyBase64, now) {
  const validated = validateConversationClearApplied(proof);
  const responseMessageId = stableId(
    'ctlack', `pc-lifecycle-response-message-id-v1\n${validated.controlId}\n${validated.checksum}`
  );
  const idempotencyKey = stableId(
    'ctlackidem', `pc-lifecycle-response-idempotency-v1\n${validated.controlId}\n${validated.checksum}`
  );
  const nonce = createHmac('sha256', keyBytes(encryptionKeyBase64))
    .update(`pc-lifecycle-response-gcm-nonce-v1\n${responseMessageId}`, 'utf8')
    .digest().subarray(0, 12);
  const expiresAt = validated.appliedAt + 7 * 24 * 60 * 60 * 1000;
  if (validated.appliedAt > now || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error('invalid conversation clear response expiry');
  }
  const encrypted = encryptSerializedRelayPayload(canonicalJson(validated), encryptionKeyBase64, nonce);
  return {
    deviceId: validated.peerId,
    messageId: responseMessageId,
    direction: 'pc_to_phone',
    ...encrypted,
    idempotencyKey,
    expiresAt
  };
}

function deriveRoleDeleteResponse(proof, encryptionKeyBase64, now) {
  const validated = validateRoleDeleteApplied(proof);
  const responseMessageId = stableId(
    'ctlack', `pc-lifecycle-response-message-id-v1\n${validated.controlId}\n${validated.checksum}`
  );
  const idempotencyKey = stableId(
    'ctlackidem', `pc-lifecycle-response-idempotency-v1\n${validated.controlId}\n${validated.checksum}`
  );
  const nonce = createHmac('sha256', keyBytes(encryptionKeyBase64))
    .update(`pc-lifecycle-response-gcm-nonce-v1\n${responseMessageId}`, 'utf8')
    .digest().subarray(0, 12);
  const expiresAt = validated.appliedAt + 7 * 24 * 60 * 60 * 1000;
  if (validated.appliedAt > now || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error('invalid role delete response expiry');
  }
  const encrypted = encryptSerializedRelayPayload(canonicalJson(validated), encryptionKeyBase64, nonce);
  return {
    deviceId: validated.peerId,
    messageId: responseMessageId,
    direction: 'pc_to_phone',
    ...encrypted,
    idempotencyKey,
    expiresAt
  };
}

export function decryptRelayPayload(value, encryptionKeyBase64) {
  const encrypted = Buffer.from(String(value?.ciphertext || ''), 'base64');
  const nonce = Buffer.from(String(value?.nonce || ''), 'base64');
  if (encrypted.length < 17 || nonce.length !== 12) throw new Error('invalid encrypted relay payload');
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(encryptionKeyBase64), nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const decoded = JSON.parse(plaintext);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid relay JSON');
  return decoded;
}

export class CloudRelayPump {
  constructor({
    relayUrl,
    deviceId,
    deviceToken,
    encryptionKeyBase64,
    orchestrator = null,
    dispatcher = null,
    store = null,
    outbox = null,
    reconciler = null,
    proxyEnabled = false,
    fetchImpl = globalThis.fetch,
    clock = Date.now
  }) {
    if (!String(relayUrl || '').startsWith('https://')) throw new Error('relayUrl must use HTTPS');
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(deviceId || ''))) throw new Error('invalid cloud deviceId');
    if (String(deviceToken || '').length < 16) throw new Error('invalid cloud device token');
    const hasLegacy = orchestrator && typeof orchestrator.process === 'function';
    const hasV2 = dispatcher && typeof dispatcher.accept === 'function'
      && store && typeof store.registerCloudDelivery === 'function';
    if (!hasLegacy && !hasV2) throw new Error('orchestrator or durable dispatcher is required');
    keyBytes(encryptionKeyBase64);
    this.relayUrl = String(relayUrl).replace(/\/+$/, '');
    this.deviceId = String(deviceId);
    this.deviceToken = String(deviceToken);
    this.encryptionKeyBase64 = String(encryptionKeyBase64);
    this.orchestrator = orchestrator;
    this.dispatcher = dispatcher;
    this.store = store;
    this.outbox = outbox;
    this.reconciler = reconciler;
    this.proxyEnabled = proxyEnabled === true;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.timer = null;
    this.running = false;
    this.lastDiagnosticAt = 0;
    this.messageDiagnosticTimes = new Map();
    this.relayStatus = {
      enabled: true,
      proxyEnabled: this.proxyEnabled,
      connected: false,
      lastSuccessAt: 0,
      lastErrorAt: 0,
      lastError: '',
      pendingProcessed: 0
    };
  }

  status() {
    return { ...this.relayStatus };
  }

  recordPollFailure(error) {
    const now = this.clock();
    const raw = String(error?.message || error || 'cloud relay poll failed');
    const safeMessage = raw.replaceAll(this.deviceToken, '[redacted]').slice(0, 160);
    this.relayStatus = {
      ...this.relayStatus,
      connected: false,
      lastErrorAt: now,
      lastError: safeMessage,
      pendingProcessed: 0
    };
    if (this.store?.putDiagnostic && (this.lastDiagnosticAt === 0 || now - this.lastDiagnosticAt >= 60_000)) {
      this.store.putDiagnostic({
        stage: 'cloud_relay_poll',
        level: 'error',
        detail: { message: safeMessage, proxyEnabled: this.proxyEnabled }
      });
      this.lastDiagnosticAt = now;
    }
  }

  headers(withJson = false) {
    return {
      authorization: `Bearer ${this.deviceToken}`,
      accept: 'application/json',
      ...(withJson ? { 'content-type': 'application/json' } : {})
    };
  }

  async pumpOnce() {
    if (this.running) return { processed: 0, failed: 0, suppressed: 0, skipped: true };
    this.running = true;
    const summary = { processed: 0, failed: 0, suppressed: 0, skipped: false };
    try {
      let blockedPeerIds = [];
      if (this.outbox && typeof this.outbox.flushRetractionsOnce === 'function') {
        const retractions = await this.outbox.flushRetractionsOnce(50);
        blockedPeerIds = Array.isArray(retractions?.blockedPeerIds)
          ? retractions.blockedPeerIds.map(value => String(value)) : [];
        summary.failed += Number(retractions?.failed || 0);
        if (Number(retractions?.pending || 0) > 0
          || Number(retractions?.failed || 0) > 0
          || Number(retractions?.waiting || 0) > 0
          || Number(retractions?.fatal || 0) > 0) {
          if (blockedPeerIds.length > 0) {
            // Independent peers may still drain ordinary work; the blocked
            // identity is passed to the outbox filter below.
          } else {
            return summary;
          }
        }
        if (Number(retractions?.pending || 0) > 0
          && blockedPeerIds.length === 0) {
          return summary;
        }
      }
      const url = `${this.relayUrl}/bridge/poll?deviceId=${encodeURIComponent(this.deviceId)}&direction=phone_to_pc&limit=50`;
      const response = await this.fetch(url, { headers: this.headers() });
      if (!response.ok) throw new Error(`cloud relay poll HTTP ${response.status}`);
      const payload = await response.json();
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      for (const message of messages) {
        let envelope = null;
        try {
          const rawEnvelope = decryptRelayPayload(message, this.encryptionKeyBase64);
          if (isRoleDeleteCandidate(rawEnvelope)) {
            let control;
            try {
              control = validateRoleDeleteControl(rawEnvelope);
              if (control.peerId !== this.deviceId) throw new Error('role delete peer mismatch');
            } catch (error) {
              error.suppressStoreDiagnostic = true;
              throw error;
            }
            if (!this.store || typeof this.store.applyRoleDeleteInternal !== 'function') {
              throw new Error('role delete store is unavailable');
            }
            const outcome = await this.store.applyRoleDeleteInternal(control, { appliedAt: this.clock() });
            if (outcome?.type === 'ROLE_DELETE_PENDING') {
              validateRoleDeletePending(outcome);
              continue;
            }
            const responseEnvelope = deriveRoleDeleteResponse(
              validateRoleDeleteApplied(outcome), this.encryptionKeyBase64, this.clock()
            );
            const exchanged = await this.fetch(`${this.relayUrl}/bridge/ack-with-response`, {
              method: 'POST', headers: this.headers(true),
              body: JSON.stringify({
                deviceId: this.deviceId,
                incomingMessageId: message.messageId,
                response: responseEnvelope
              })
            });
            if (!exchanged.ok) throw new Error(`cloud relay ack-with-response HTTP ${exchanged.status}`);
            const exchangeBody = await exchanged.json();
            const exchangeKeys = exchangeBody && typeof exchangeBody === 'object' && !Array.isArray(exchangeBody)
              ? Object.keys(exchangeBody).sort() : [];
            if (JSON.stringify(exchangeKeys) !== JSON.stringify(['idempotent', 'incomingMessageId', 'ok', 'responseMessageId'])
              || exchangeBody.ok !== true
              || exchangeBody.incomingMessageId !== message.messageId
              || exchangeBody.responseMessageId !== responseEnvelope.messageId
              || typeof exchangeBody.idempotent !== 'boolean') {
              throw new Error('invalid cloud role delete exchange response');
            }
            summary.processed += 1;
            continue;
          }
          if (isConversationClearCandidate(rawEnvelope)) {
            let control;
            try {
              control = validateConversationClearControl(rawEnvelope);
              if (control.peerId !== this.deviceId) throw new Error('conversation clear peer mismatch');
            } catch (error) {
              error.suppressStoreDiagnostic = true;
              throw error;
            }
            if (!this.store || typeof this.store.applyConversationClearInternal !== 'function') {
              throw new Error('conversation clear store is unavailable');
            }
            const applied = await this.store.applyConversationClearInternal(control, { appliedAt: this.clock() });
            const responseEnvelope = deriveConversationClearResponse(applied, this.encryptionKeyBase64, this.clock());
            const exchanged = await this.fetch(`${this.relayUrl}/bridge/ack-with-response`, {
              method: 'POST', headers: this.headers(true),
              body: JSON.stringify({
                deviceId: this.deviceId,
                incomingMessageId: message.messageId,
                response: responseEnvelope
              })
            });
            if (!exchanged.ok) throw new Error(`cloud relay ack-with-response HTTP ${exchanged.status}`);
            const exchangeBody = await exchanged.json();
            const exchangeKeys = exchangeBody && typeof exchangeBody === 'object' && !Array.isArray(exchangeBody)
              ? Object.keys(exchangeBody).sort() : [];
            if (JSON.stringify(exchangeKeys) !== JSON.stringify(['idempotent', 'incomingMessageId', 'ok', 'responseMessageId'])
              || exchangeBody.ok !== true
              || exchangeBody.incomingMessageId !== message.messageId
              || exchangeBody.responseMessageId !== responseEnvelope.messageId
              || typeof exchangeBody.idempotent !== 'boolean') {
              throw new Error('invalid cloud clear exchange response');
            }
            summary.processed += 1;
            continue;
          }
          if (rawEnvelope.type === 'AUTHORITY_DELIVERY_RECEIPT') {
            if (!this.store || typeof this.store.confirmAuthorityCloudDeliveryInternal !== 'function') {
              throw new Error('authority delivery receipt store is unavailable');
            }
            this.store.confirmAuthorityCloudDeliveryInternal(validateAuthorityDeliveryReceipt(rawEnvelope));
            const acked = await this.fetch(`${this.relayUrl}/bridge/ack`, {
              method: 'POST', headers: this.headers(true),
              body: JSON.stringify({ deviceId: this.deviceId, messageIds: [message.messageId] })
            });
            if (!acked.ok) throw new Error(`cloud relay ack HTTP ${acked.status}`);
            summary.processed += 1;
            continue;
          }
          if (rawEnvelope.type === 'DELIVERY_RECEIPT') {
            if (!this.store) throw new Error('delivery receipt store is unavailable');
            const deliveryTurn = this.store.getTurn?.(String(rawEnvelope.turnId || ''));
            const canonicalV2 = Number(deliveryTurn?.resultAuthorityVersion || 0) === 1
              && Number(deliveryTurn?.protocolVersion || 0) === 2;
            if (Array.isArray(rawEnvelope.items)) {
              if (canonicalV2) {
                if (typeof this.store.confirmCanonicalV2DeliveryInternal !== 'function') {
                  throw new Error('canonical v2 delivery receipt store is unavailable');
                }
                this.store.confirmCanonicalV2DeliveryInternal(
                  String(rawEnvelope.turnId || ''),
                  String(rawEnvelope.peerId || this.deviceId),
                  rawEnvelope
                );
              } else {
                if (typeof this.store.confirmCloudDeliveryItems !== 'function') {
                  throw new Error('delivery receipt store is unavailable');
                }
                this.store.confirmCloudDeliveryItems(
                  String(rawEnvelope.turnId || ''),
                  String(rawEnvelope.peerId || this.deviceId),
                  rawEnvelope
                );
              }
            } else {
              if (canonicalV2) {
                if (typeof this.store.confirmCanonicalV2SimpleDeliveryInternal !== 'function') {
                  throw new Error('canonical v2 delivery receipt store is unavailable');
                }
                this.store.confirmCanonicalV2SimpleDeliveryInternal(
                  String(rawEnvelope.turnId || ''),
                  String(rawEnvelope.peerId || this.deviceId),
                  rawEnvelope
                );
              } else {
                if (typeof this.store.confirmCloudDelivery !== 'function') {
                  throw new Error('delivery receipt store is unavailable');
                }
                this.store.confirmCloudDelivery(
                  String(rawEnvelope.turnId || ''),
                  String(rawEnvelope.peerId || this.deviceId),
                  rawEnvelope
                );
              }
            }
            const acked = await this.fetch(`${this.relayUrl}/bridge/ack`, {
              method: 'POST', headers: this.headers(true),
              body: JSON.stringify({ deviceId: this.deviceId, messageIds: [message.messageId] })
            });
            if (!acked.ok) throw new Error(`cloud relay ack HTTP ${acked.status}`);
            summary.processed += 1;
            continue;
          }
          let recoveryInput;
          try {
            envelope = validateEnvelope(rawEnvelope);
            recoveryInput = rawEnvelope.recovery === undefined
              ? null
              : normalizeRecoverySnapshot(rawEnvelope.recovery, { expectedDeviceId: envelope.deviceId });
          } catch (error) {
            error.suppressStoreDiagnostic = true;
            throw error;
          }
          let recoveryAckSeq = 0;
          if (this.reconciler && recoveryInput) {
            const recovery = await this.reconciler.reconcileFrom(recoveryInput);
            recoveryAckSeq = recovery.ackSeq;
          }
          const ageMs = this.clock() - Number(envelope.createdAt || 0);
          const staleProactive = envelope.kind === 'PROACTIVE_CHAT' && ageMs > 30 * 60 * 1000;
          if (staleProactive) {
            this.store?.putDiagnostic?.({
              turnId: envelope.turnId,
              stage: 'stale_proactive_suppressed',
              level: 'info',
              detail: { ageMs }
            });
            const acked = await this.fetch(`${this.relayUrl}/bridge/ack`, {
              method: 'POST', headers: this.headers(true),
              body: JSON.stringify({ deviceId: this.deviceId, messageIds: [message.messageId] })
            });
            if (!acked.ok) throw new Error(`cloud relay ack HTTP ${acked.status}`);
            summary.processed += 1;
            summary.suppressed += 1;
            continue;
          }
          if (Number(envelope.protocolVersion) >= 2) {
            if (!this.dispatcher || !this.store) throw new Error('durable dispatcher is unavailable');
            let turn;
            try {
              turn = this.dispatcher.accept(envelope);
            } catch (error) {
              const checksumConflict = /turn checksum conflict/i.test(String(error?.message || error));
              const authoritative = checksumConflict && typeof this.store.getTurn === 'function'
                ? this.store.getTurn(String(envelope.turnId || ''))
                : null;
              if (!authoritative) throw error;
              if (Number(envelope.protocolVersion) === 3
                && (String(authoritative.turnId || '') !== String(envelope.turnId)
                  || String(authoritative.envelopeChecksum || '') !== contentHash(envelope))) {
                const conflict = new Error('canonical duplicate envelope conflict');
                conflict.suppressStoreDiagnostic = true;
                throw conflict;
              }
              turn = authoritative;
              this.store.putDiagnostic?.({
                turnId: turn.turnId,
                stage: 'duplicate_turn_payload_ignored',
                level: 'info',
                detail: { state: String(turn.state || 'unknown') }
              });
            }
            const peerId = String(envelope.recovery?.peerId || envelope.deviceId || this.deviceId);
            if (Number(turn?.resultAuthorityVersion || 0) === 0) {
              this.store.registerCloudDelivery(turn.turnId, peerId, recoveryAckSeq);
            }
            const acked = await this.fetch(`${this.relayUrl}/bridge/ack`, {
              method: 'POST', headers: this.headers(true),
              body: JSON.stringify({ deviceId: this.deviceId, messageIds: [message.messageId] })
            });
            if (!acked.ok) throw new Error(`cloud relay ack HTTP ${acked.status}`);
            summary.processed += 1;
            continue;
          }
          if (!this.orchestrator) throw new Error('legacy orchestrator is unavailable');
          const result = await this.orchestrator.process(envelope);
          const replyPayload = { ok: true, ...result, recoveryAckSeq };
          const encrypted = encryptRelayPayload(replyPayload, this.encryptionKeyBase64);
          const output = {
            deviceId: this.deviceId,
            messageId: stableId('relay_pc', envelope.turnId),
            idempotencyKey: stableId('reply', envelope.turnId),
            direction: 'pc_to_phone',
            ...encrypted,
            expiresAt: this.clock() + 24 * 60 * 60 * 1000
          };
          const enqueued = await this.fetch(`${this.relayUrl}/bridge/enqueue`, {
            method: 'POST', headers: this.headers(true), body: JSON.stringify(output)
          });
          if (!enqueued.ok) throw new Error(`cloud relay enqueue HTTP ${enqueued.status}`);
          const acked = await this.fetch(`${this.relayUrl}/bridge/ack`, {
            method: 'POST', headers: this.headers(true),
            body: JSON.stringify({ deviceId: this.deviceId, messageIds: [message.messageId] })
          });
          if (!acked.ok) throw new Error(`cloud relay ack HTTP ${acked.status}`);
          summary.processed += 1;
        } catch (error) {
          summary.failed += 1;
          if (error?.code === 'INTERACTION_LANE_BUSY') {
            // Lane contention is retryable scheduling state.  It owns no
            // durable turn/delivery and must not be converted into a
            // diagnostic or an input ACK.
            continue;
          }
          const now = this.clock();
          const relayMessageId = String(message?.messageId || '').slice(0, 128);
          const previous = Number(this.messageDiagnosticTimes.get(relayMessageId) || 0);
          if (error?.suppressStoreDiagnostic !== true
            && this.store?.putDiagnostic && (previous === 0 || now - previous >= 60_000)) {
            const raw = String(error?.message || error || 'cloud relay message failed');
            const safeMessage = raw.replaceAll(this.deviceToken, '[redacted]').slice(0, 160);
            this.store.putDiagnostic({
              turnId: envelope?.turnId || null,
              stage: 'cloud_relay_message',
              level: 'error',
              detail: { relayMessageId, message: safeMessage }
            });
            this.messageDiagnosticTimes.set(relayMessageId, now);
          }
        }
      }
      if (this.outbox && typeof this.outbox.flushOnce === 'function') {
        const outbox = await this.outbox.flushOnce(50, { blockedPeerIds });
        summary.failed += Number(outbox?.failed || 0);
      }
      this.relayStatus = {
        ...this.relayStatus,
        connected: true,
        lastSuccessAt: this.clock(),
        lastError: '',
        pendingProcessed: summary.processed
      };
      return summary;
    } catch (error) {
      this.recordPollFailure(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 1500) {
    if (this.timer) return;
    const delay = Math.max(250, Math.min(60_000, Number(intervalMs) || 1500));
    const tick = () => this.pumpOnce().catch(() => {});
    this.timer = setInterval(tick, delay);
    tick();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
