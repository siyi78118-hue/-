import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

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
  const cipher = createCipheriv('aes-256-gcm', keyBytes(encryptionKeyBase64), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64') };
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
      const url = `${this.relayUrl}/bridge/poll?deviceId=${encodeURIComponent(this.deviceId)}&direction=phone_to_pc&limit=50`;
      const response = await this.fetch(url, { headers: this.headers() });
      if (!response.ok) throw new Error(`cloud relay poll HTTP ${response.status}`);
      const payload = await response.json();
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      for (const message of messages) {
        let envelope = null;
        try {
          envelope = decryptRelayPayload(message, this.encryptionKeyBase64);
          let recoveryAckSeq = 0;
          if (this.reconciler && envelope.recovery && Array.isArray(envelope.recovery.entries)) {
            const recovery = await this.reconciler.reconcileFrom(envelope.recovery);
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
            const turn = this.dispatcher.accept(envelope);
            const peerId = String(envelope.recovery?.peerId || envelope.deviceId || this.deviceId);
            this.store.registerCloudDelivery(turn.turnId, peerId, recoveryAckSeq);
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
          const now = this.clock();
          const relayMessageId = String(message?.messageId || '').slice(0, 128);
          const previous = Number(this.messageDiagnosticTimes.get(relayMessageId) || 0);
          if (this.store?.putDiagnostic && (previous === 0 || now - previous >= 60_000)) {
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
      if (this.outbox && typeof this.outbox.flushOnce === 'function') await this.outbox.flushOnce();
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
