import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { publicTurnStatus } from './turn-status.mjs';
import {
  validateAuthorityDeliveryReceipt,
  validateConversationClearApplied,
  validateConversationClearControl,
  validateEnvelope,
  validateRoleDeleteApplied,
  validateRoleDeleteControl,
  validateRoleDeletePending,
  validateYuqiBackupReceipt,
  validateYuqiBackupRequest
} from './protocol.mjs';
import { normalizeRecoverySnapshot } from './reconcile.mjs';
import { isCanonicalAuthorityConflictError } from './bridge-result-projector.mjs';

function bodyHash(body) {
  return createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

export function signBridgeRequest({ secret, method, path, timestamp, nonce, body = '' }) {
  const canonical = `${timestamp}\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(body)}`;
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function preflightEnvelope(raw) {
  const envelope = validateEnvelope(raw);
  return {
    envelope,
    recovery: raw?.recovery === undefined
      ? null
      : normalizeRecoverySnapshot(raw.recovery, { expectedDeviceId: envelope.deviceId })
  };
}

const CONVERSATION_CLEAR_AUTHORITY_MESSAGES = new Set([
  'conversation clear appliedAt conflict',
  'conversation clear authority conflict',
  'conversation clear replay conflict',
  'conversation clear CAS conflict',
  'conversation clear lineage conflict',
  'conversation clear redaction conflict',
  'conversation clear persisted authority conflict',
  'conversation clear control replay conflict',
  'conversation clear role epoch collision',
  'conversation clear role lane conflict',
  'conversation clear epoch conflict',
  'conversation clear boundary conflict',
  'conversation clear control changed during transaction',
  'conversation clear replay lineage conflict',
  'conversation clear lane CAS conflict',
  'conversation clear lane revision conflict',
  'conversation clear lane clearEpoch conflict',
  'conversation clear lane clearedThroughSequence conflict',
  'conversation clear lane nativeCompletedSequence conflict',
  'conversation clear lane uiAppliedSequence conflict',
  'conversation clear control conflict',
  'canonical conversation clear boundary conflict',
  'canonical conversation clear committed group conflict',
  'canonical conversation clear attempt conflict',
  'canonical conversation clear group conflict',
  'canonical conversation clear delivery lineage conflict',
  'canonical conversation clear delivery CAS conflict',
  'legacy conversation clear delivery authority conflict',
  'legacy conversation clear waiting attempts conflict',
  'legacy conversation clear delivery timestamp conflict',
  'legacy conversation clear waiting delivery conflict',
  'legacy conversation clear delivery payload conflict',
  'legacy conversation clear pending relay conflict',
  'legacy conversation clear pending delivery conflict',
  'legacy conversation clear relay identity conflict',
  'legacy conversation clear mailbox receipt conflict',
  'legacy conversation clear confirmed receipt conflict',
  'legacy conversation clear delivered receipt conflict'
]);

const CONVERSATION_CLEAR_AUTHORITY_PREFIXES = Object.freeze([
  'conversation clear applied proof conflict: ',
  'conversation clear persisted semantic conflict: ',
  'conversation clear role lane conflict: ',
  'canonical conversation clear lineage conflict: ',
  'canonical conversation clear lineage lane conflict: ',
  'canonical conversation clear redacted lineage conflict: ',
  'canonical conversation clear envelope conflict: ',
  'canonical conversation clear protocol conflict: ',
  'canonical conversation clear envelope checksum conflict: ',
  'canonical conversation clear lane conflict: ',
  'canonical conversation clear sequence conflict: ',
  'canonical conversation clear attempt commitment conflict: ',
  'canonical conversation clear open group conflict: ',
  'canonical conversation clear lineage terminal conflict: ',
  'canonical conversation clear input batch conflict: ',
  'canonical conversation clear input batch projection conflict: ',
  'canonical conversation clear input batch source conflict: ',
  'canonical conversation clear input batch parent conflict: ',
  'canonical conversation clear input batch item conflict: ',
  'canonical conversation clear input batch tombstone conflict: ',
  'canonical conversation clear canonical reference conflict: ',
  'canonical conversation clear canonical projection conflict: ',
  'canonical conversation clear delivery CAS conflict: ',
  'legacy conversation clear envelope identity conflict: ',
  'legacy conversation clear envelope conflict: ',
  'legacy conversation clear envelope checksum conflict: ',
  'legacy conversation clear outer source conflict: ',
  'legacy conversation clear outer source closure conflict: ',
  'legacy conversation clear v1 batch conflict: ',
  'legacy conversation clear batch protocol conflict: ',
  'legacy conversation clear input batch conflict: ',
  'legacy conversation clear input batch projection conflict: ',
  'legacy conversation clear input batch source conflict: ',
  'legacy conversation clear input batch parent conflict: ',
  'legacy conversation clear input batch item conflict: ',
  'legacy conversation clear input batch tombstone conflict: ',
  'legacy conversation clear canonical reference conflict: ',
  'legacy conversation clear canonical projection conflict: ',
  'legacy conversation clear protocol conflict: ',
  'legacy conversation clear lane conflict: ',
  'legacy conversation clear sequence conflict: '
]);

function isConversationClearAuthorityConflict(error) {
  if (error instanceof TypeError) return false;
  if (error?.code === 'CONVERSATION_CLEAR_AUTHORITY_CONFLICT') return true;
  const message = String(error?.message || '');
  if (CONVERSATION_CLEAR_AUTHORITY_MESSAGES.has(message)) return true;
  return CONVERSATION_CLEAR_AUTHORITY_PREFIXES.some(prefix => (
    message.startsWith(prefix) && message.length > prefix.length
  ));
}

const ROLE_DELETE_AUTHORITY_MESSAGES = new Set([
  'role delete appliedAt conflict',
  'role delete backup receipt audit conflict',
  'role delete control changed during transaction',
  'role delete delivery retraction conflict',
  'role deletion applied audit conflict',
  'role deletion applied replay conflict',
  'role deletion canonical lineage conflict',
  'role deletion canonical lineage state conflict',
  'role deletion lane CAS conflict',
  'role deletion request audit conflict',
  'role deletion request replay conflict',
  'role deletion role authority conflict'
]);

const ROLE_DELETE_AUTHORITY_PREFIXES = Object.freeze([
  'role deletion legacy envelope conflict: ',
  'role deletion legacy authority conflict: ',
  'role deletion legacy projection conflict: ',
  'role deletion retained '
]);

function isRoleDeleteAuthorityConflict(error) {
  if (error instanceof TypeError) return false;
  if (error?.code === 'ROLE_DELETE_AUTHORITY_CONFLICT') return true;
  const message = String(error?.message || '');
  if (ROLE_DELETE_AUTHORITY_MESSAGES.has(message)) return true;
  return ROLE_DELETE_AUTHORITY_PREFIXES.some(prefix => (
    message.startsWith(prefix) && message.length > prefix.length
  ));
}

export function createYuqiServer({
  secret,
  store,
  orchestrator,
  dispatcher = null,
  reconciler = null,
  createVerifiedBackup = null,
  getCloudRelayStatus = null,
  clock = Date.now,
  maxBodyBytes = 256 * 1024,
  maxClockSkewMs = 5 * 60 * 1000
}) {
  if (!secret || String(secret).length < 12) throw new Error('pairing secret must contain at least 12 characters');
  if (!store || !orchestrator) throw new Error('store and orchestrator are required');
  const nonces = new Map();

  function purgeNonces(now) {
    for (const [nonce, expiresAt] of nonces) if (expiresAt <= now) nonces.delete(nonce);
  }

  function authenticate(request, rawBody) {
    const timestamp = Number(request.headers['x-yuqi-timestamp']);
    const nonce = String(request.headers['x-yuqi-nonce'] || '');
    const supplied = String(request.headers['x-yuqi-signature'] || '');
    const now = clock();
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maxClockSkewMs) {
      return { ok: false, status: 401, error: 'stale request' };
    }
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(nonce)) return { ok: false, status: 401, error: 'invalid nonce' };
    purgeNonces(now);
    if (nonces.has(nonce)) return { ok: false, status: 409, error: 'replayed request' };
    const expected = signBridgeRequest({
      secret,
      method: request.method,
      path: request.url,
      timestamp,
      nonce,
      body: rawBody
    });
    if (!safeEqual(supplied, expected)) return { ok: false, status: 401, error: 'invalid signature' };
    nonces.set(nonce, now + maxClockSkewMs);
    return { ok: true };
  }

  function bridgeStatus(turn) {
    const authoritativeVersion = Number(turn?.resultAuthorityVersion) === 1;
    const committed = ['committed', 'delivered', 'completed'].includes(turn?.state);
    const canonicalResult = authoritativeVersion && committed
      ? store.loadCanonicalBridgeResultInternal(turn.turnId)
      : null;
    const canonicalFailure = authoritativeVersion
      && Number(turn?.protocolVersion) === 3 && turn.state === 'failed'
      ? store.loadCanonicalFailureForBridgeInternal(turn.turnId)
      : null;
    return publicTurnStatus(turn, {
      stages: turn && typeof store.getTurnStages === 'function' ? store.getTurnStages(turn.turnId) : [],
      canonicalResult,
      canonicalFailure,
      wireVersion: turn.protocolVersion
    });
  }

  function resolveCanonicalTerminalStatus(turn) {
    // Legacy RA0 redactions have no canonical result payload to project.  The
    // store-owned status token is the only authority that may expose their
    // terminal state; an envelope/status shell alone is never sufficient.
    let legacyShell = false;
    if (Number(turn?.resultAuthorityVersion) === 0) {
      try {
        legacyShell = (typeof store.hasLegacyRedactionMarkerInternal === 'function'
          && store.hasLegacyRedactionMarkerInternal(turn.turnId))
          || turn?.authorityRedactedAt != null
          || (turn?.envelopeJson && JSON.parse(turn.envelopeJson)?.redacted === true);
      } catch {
        legacyShell = true;
      }
    }
    if (Number(turn?.resultAuthorityVersion) === 0
      && typeof store.publicLegacyRedactedTurnStatusInternal !== 'function') {
      if (legacyShell) return { error: 'LEGACY_AUTHORITY_CONFLICT' };
    } else if (Number(turn?.resultAuthorityVersion) === 0) {
      try {
        const legacyStatus = store.publicLegacyRedactedTurnStatusInternal(turn.turnId);
        if (legacyStatus?.status === 'redacted'
          && legacyStatus.deliverable === false
          && legacyStatus.terminal === true) {
          return { error: 'LEGACY_RESULT_REDACTED' };
        }
      } catch {
        if (legacyShell) return { error: 'LEGACY_AUTHORITY_CONFLICT' };
        // A live/non-redacted legacy turn continues through the byte-compatible
        // status path. Validation failures on a redacted shell never do.
      }
    }
    const authoritativeVersion = Number(turn?.resultAuthorityVersion) === 1;
    const committed = ['committed', 'delivered', 'completed'].includes(turn?.state);
    const canonicalFailure = authoritativeVersion
      && Number(turn?.protocolVersion) === 3 && turn.state === 'failed';
    const canonicalCommitted = authoritativeVersion && committed;
    if (!canonicalCommitted && !canonicalFailure) return { status: bridgeStatus(turn) };
    try {
      if (canonicalCommitted) {
        const canonicalResult = store.loadCanonicalBridgeResultInternal(turn.turnId);
        if (canonicalResult?.status === 'redacted') {
          return { error: 'CANONICAL_RESULT_REDACTED' };
        }
        return {
          status: publicTurnStatus(turn, {
            stages: typeof store.getTurnStages === 'function' ? store.getTurnStages(turn.turnId) : [],
            canonicalResult,
            wireVersion: turn.protocolVersion
          })
        };
      }
      const failure = store.loadCanonicalFailureForBridgeInternal(turn.turnId);
      if (failure?.status === 'redacted') {
        return { error: 'CANONICAL_RESULT_REDACTED' };
      }
      return {
        status: publicTurnStatus(turn, {
          stages: typeof store.getTurnStages === 'function' ? store.getTurnStages(turn.turnId) : [],
          canonicalFailure: failure,
          wireVersion: turn.protocolVersion
        })
      };
    } catch (error) {
      if (isCanonicalAuthorityConflictError(error)) {
        return { error: 'CANONICAL_AUTHORITY_CONFLICT' };
      }
      throw error;
    }
  }

  async function handle(request, response, rawBody) {
    if (request.method === 'GET' && request.url === '/v1/health') {
      const roleThreads = Object.fromEntries(['memory', 'brain', 'supervisor'].map(role => [
        role,
        typeof store.getSession === 'function' ? !!store.getSession(role) : false
      ]));
      return json(response, 200, {
        ok: true,
        service: 'yuqi-runtime',
        version: 1,
        roleThreads,
        presetVersion: typeof store.getCurrentPresetVersion === 'function' ? store.getCurrentPresetVersion() : '',
        contextLimit: 200,
        cloudRelay: typeof getCloudRelayStatus === 'function'
          ? getCloudRelayStatus()
          : {
              enabled: false,
              proxyEnabled: false,
              connected: false,
              lastSuccessAt: 0,
              lastErrorAt: 0,
              lastError: '',
              pendingProcessed: 0
            }
      });
    }
    const auth = authenticate(request, rawBody);
    if (!auth.ok) return json(response, auth.status, { ok: false, error: auth.error });

    const url = new URL(request.url, 'http://localhost');
    let body = null;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { return json(response, 400, { ok: false, error: 'invalid JSON' }); }
    }

    if (request.method === 'POST' && url.pathname === '/v3/backups/yuqi') {
      let backupRequest;
      try {
        backupRequest = validateYuqiBackupRequest(body);
        if (Math.abs(clock() - backupRequest.requestedAt) > maxClockSkewMs) {
          throw new Error('Yuqi backup request time conflict');
        }
      } catch (error) {
        return json(response, 400, { ok: false, error: error.message });
      }
      if (typeof createVerifiedBackup !== 'function') {
        return json(response, 503, { ok: false, error: 'verified backup service is unavailable' });
      }
      const result = await createVerifiedBackup({
        roleId: backupRequest.roleId,
        peerId: backupRequest.peerId,
        requestedAt: backupRequest.requestedAt,
        androidRoomHead: backupRequest.androidRoomHead
      });
      const receipt = validateYuqiBackupReceipt(result?.receipt);
      if (receipt.roleId !== backupRequest.roleId || receipt.createdAt !== backupRequest.requestedAt) {
        throw new Error('Yuqi backup receipt authority conflict');
      }
      return json(response, 200, receipt);
    }

    if (request.method === 'POST' && url.pathname === '/v3/controls/role-delete') {
      let control;
      try {
        control = validateRoleDeleteControl(body);
      } catch (error) {
        return json(response, 400, { ok: false, error: error.message });
      }
      if (typeof store.applyRoleDeleteInternal !== 'function') {
        return json(response, 503, { ok: false, error: 'role delete store is unavailable' });
      }
      try {
        const proof = await store.applyRoleDeleteInternal(control, { appliedAt: clock() });
        if (proof?.type === 'ROLE_DELETE_PENDING') {
          return json(response, 202, validateRoleDeletePending(proof));
        }
        return json(response, 200, validateRoleDeleteApplied(proof));
      } catch (error) {
        if (isRoleDeleteAuthorityConflict(error)) {
          return json(response, 409, { ok: false, error: 'ROLE_DELETE_AUTHORITY_CONFLICT' });
        }
        throw error;
      }
    }

    if (request.method === 'POST' && url.pathname === '/v3/controls/conversation-clear') {
      let control;
      try {
        control = validateConversationClearControl(body);
      } catch (error) {
        return json(response, 400, { ok: false, error: error.message });
      }
      try {
        const appliedAt = clock();
        const proof = await store.applyConversationClearInternal(control, { appliedAt });
        return json(response, 200, validateConversationClearApplied(proof));
      } catch (error) {
        if (isConversationClearAuthorityConflict(error)) {
          return json(response, 409, {
            ok: false,
            error: 'CONVERSATION_CLEAR_AUTHORITY_CONFLICT'
          });
        }
        throw error;
      }
    }

    if (request.method === 'POST' && url.pathname === '/v1/turns') {
      let preflight;
      try { preflight = preflightEnvelope(body); } catch (error) {
        return json(response, 400, { ok: false, error: error.message });
      }
      const { envelope, recovery: recoveryInput } = preflight;
      let recoveryAckSeq = 0;
      if (reconciler && recoveryInput) {
        const recovery = await reconciler.reconcileFrom(recoveryInput);
        recoveryAckSeq = recovery.ackSeq;
      }
      const result = await orchestrator.process(envelope);
      return json(response, 201, { ok: true, ...result, recoveryAckSeq });
    }
    if (request.method === 'POST' && url.pathname === '/v2/turns') {
      if (!dispatcher || typeof dispatcher.accept !== 'function') {
        return json(response, 503, { ok: false, error: 'turn dispatcher is unavailable' });
      }
      let preflight;
      try { preflight = preflightEnvelope(body); } catch (error) {
        return json(response, 400, { ok: false, error: error.message });
      }
      const { envelope, recovery: recoveryInput } = preflight;
      let recoveryAckSeq = 0;
      if (reconciler && recoveryInput) {
        const recovery = await reconciler.reconcileFrom(recoveryInput);
        recoveryAckSeq = Number(recovery.ackSeq || 0);
      }
      // A redacted turn is terminal before dispatch.  In particular, do not
      // let a replayed RA0 POST recreate/parse semantic input before returning
      // the semantic-free 410.
      const existingTurn = typeof store.getTurn === 'function'
        ? store.getTurn(envelope.turnId)
        : null;
      if (existingTurn) {
        const existingResolved = resolveCanonicalTerminalStatus(existingTurn);
        if (existingResolved.error) {
          return json(response,
        ['CANONICAL_RESULT_REDACTED', 'LEGACY_RESULT_REDACTED'].includes(existingResolved.error)
              ? 410 : 409,
            { ok: false, error: existingResolved.error });
        }
      }
      const turn = dispatcher.accept(envelope);
      const resolved = resolveCanonicalTerminalStatus(turn);
      if (resolved.error) return json(response,
        ['CANONICAL_RESULT_REDACTED', 'LEGACY_RESULT_REDACTED'].includes(resolved.error) ? 410 : 409, {
        ok: false,
        error: resolved.error
      });
      const status = resolved.status;
      const terminal = ['committed', 'delivered', 'completed', 'failed', 'fallback'].includes(turn?.state);
      return json(response, terminal ? 200 : 202, {
        ok: true,
        accepted: true,
        ...status,
        terminal,
        recoveryAckSeq
      });
    }
    const v2TurnMatch = /^\/v2\/turns\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && v2TurnMatch) {
      const turn = store.getTurn(decodeURIComponent(v2TurnMatch[1]));
      if (!turn) return json(response, 404, { ok: false, error: 'turn not found' });
      const resolved = resolveCanonicalTerminalStatus(turn);
      if (resolved.error) return json(response,
        ['CANONICAL_RESULT_REDACTED', 'LEGACY_RESULT_REDACTED'].includes(resolved.error) ? 410 : 409, {
        ok: false,
        error: resolved.error
      });
      const status = resolved.status;
      return status
        ? json(response, 200, {
          ok: true,
          ...status,
          terminal: ['committed', 'delivered', 'completed', 'failed', 'fallback'].includes(turn?.state)
        })
        : json(response, 404, { ok: false, error: 'turn not found' });
    }
    const receiptMatch = /^\/v2\/turns\/([^/]+)\/delivery-receipt$/.exec(url.pathname);
    if (request.method === 'POST' && receiptMatch) {
      const turnId = decodeURIComponent(receiptMatch[1]);
      if (String(body?.turnId || '') !== turnId) {
        return json(response, 400, { ok: false, error: 'delivery receipt turn mismatch' });
      }
      try {
        const targetTurn = store.getTurn?.(turnId);
        const canonicalV2 = Number(targetTurn?.resultAuthorityVersion || 0) === 1
          && Number(targetTurn?.protocolVersion || 0) === 2;
        const delivery = canonicalV2
          ? (Array.isArray(body?.items)
            ? store.confirmCanonicalV2DeliveryInternal(turnId, String(body?.peerId || targetTurn.deviceId), body)
            : store.confirmCanonicalV2SimpleDeliveryInternal(turnId, String(body?.peerId || targetTurn.deviceId), body))
          : store.recordDeliveryReceipt(body);
        return json(response, 200, { ok: true, delivery });
      } catch (error) {
        return json(response, 409, { ok: false, error: error.message });
      }
    }
    const authorityReceiptMatch = /^\/v3\/groups\/([^/]+)\/delivery-receipt$/.exec(url.pathname);
    if (request.method === 'POST' && authorityReceiptMatch) {
      const groupId = decodeURIComponent(authorityReceiptMatch[1]);
      try {
        if (String(body?.visibleGroupId || '') !== groupId) {
          return json(response, 400, { ok: false, error: 'authority delivery receipt group mismatch' });
        }
        const receipt = validateAuthorityDeliveryReceipt(body);
        const delivery = store.confirmAuthorityCloudDeliveryInternal(receipt);
        return json(response, 200, { ok: true, delivery });
      } catch (error) {
        return json(response, 409, { ok: false, error: error.message });
      }
    }
    const turnMatch = /^\/v1\/turns\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && turnMatch) {
      const turn = store.getTurn(decodeURIComponent(turnMatch[1]));
      return turn ? json(response, 200, { ok: true, turn }) : json(response, 404, { ok: false, error: 'turn not found' });
    }
    const cancelMatch = /^\/v1\/turns\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === 'POST' && cancelMatch) {
      const turnId = decodeURIComponent(cancelMatch[1]);
      const cancelled = orchestrator.cancel?.(turnId) === true;
      return cancelled
        ? json(response, 200, { ok: true, turnId, cancelled: true })
        : json(response, 409, { ok: false, error: 'turn cannot be cancelled' });
    }
    if (request.method === 'GET' && url.pathname === '/v1/sync') {
      const after = Number(url.searchParams.get('after') || 0);
      const limit = Number(url.searchParams.get('limit') || 500);
      return json(response, 200, { ok: true, entries: store.getSyncDelta(after, limit) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/sync/ack') {
      if (!body?.peerId || !Number.isSafeInteger(Number(body.seq))) return json(response, 400, { ok: false, error: 'invalid ack' });
      return json(response, 200, { ok: true, ackSeq: store.ackSync(String(body.peerId), Number(body.seq)) });
    }
    return json(response, 404, { ok: false, error: 'not found' });
  }

  const httpServer = createServer((request, response) => {
    const declaredLength = Number(request.headers['content-length'] || 0);
    if (declaredLength > maxBodyBytes) {
      request.resume();
      return json(response, 413, { ok: false, error: 'request body too large' });
    }
    let rawBody = '';
    let received = 0;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      received += Buffer.byteLength(chunk);
      if (received <= maxBodyBytes) rawBody += chunk;
    });
    request.on('end', () => {
      if (received > maxBodyBytes) return json(response, 413, { ok: false, error: 'request body too large' });
      Promise.resolve(handle(request, response, rawBody)).catch(error => {
        if (!response.headersSent) json(response, 500, { ok: false, error: error.message });
        else response.destroy();
      });
    });
  });

  return {
    listen({ host = '127.0.0.1', port = 17891 } = {}) {
      return new Promise((resolve, reject) => {
        const onError = error => { httpServer.off('listening', onListening); reject(error); };
        const onListening = () => { httpServer.off('error', onError); resolve(this); };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });
    },
    address: () => httpServer.address(),
    close() {
      return new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
    },
    raw: httpServer
  };
}
