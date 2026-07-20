# Yuqi VPN Cloud Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Yuqi's PC cloud-mailbox traffic through the user's local VPN HTTP proxy, expose failures, suppress stale proactive tasks, and recover the two queued encrypted envelopes without losing or misattributing memory.

**Architecture:** The Windows launcher injects a process-local HTTP/HTTPS proxy and starts Node 24 with `--use-env-proxy`. The runtime selects native `fetch` only when explicit proxy mode is enabled, while the cloud pump owns connection status, idempotent stale-task suppression, and diagnostics. The local health endpoint exposes non-sensitive relay status; live verification consumes the backlog, confirms the recovery cursor and exact speaker provenance, then creates a new memory snapshot.

**Tech Stack:** PowerShell 5.1, Node.js 24 built-in `fetch`, Node test runner, SQLite, existing Yuqi encrypted Cloudflare relay.

## Global Constraints

- Do not modify Windows global proxy, WinHTTP proxy, VPN client settings, LAN address, firewall, phone pairing secrets, or Cloudflare credentials.
- Use `http://127.0.0.1:10809` for Yuqi cloud HTTP/HTTPS traffic and `127.0.0.1,localhost,::1` for `NO_PROXY`.
- Keep AUTO/LAN traffic direct and preserve existing local port `17891`.
- Never log device tokens, encryption keys, pairing secrets, decrypted chat content, or full recovery payloads.
- A failed poll must not ACK the envelope or advance the recovery cursor.
- A `PROACTIVE_CHAT` older than 30 minutes must reconcile recovery data but must not create a visible reply.
- Do not upload GitHub; commits are local only and must include only files named by each task.

---

### Task 1: Process-local VPN proxy startup and transport selection

**Files:**
- Modify: `tests/yuqi-deployment-contract.test.mjs`
- Modify: `scripts/start-yuqi-background.ps1`
- Modify: `yuqi-runtime/src/main.mjs`
- Modify: `yuqi-runtime/config.json`
- Modify: `yuqi-runtime/config.example.json`

**Interfaces:**
- Consumes: `cloudRelay.proxy = { enabled, url, noProxy }` from runtime config.
- Produces: a child Node process launched with `--use-env-proxy` and inherited `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`; `main.mjs` chooses `globalThis.fetch` for proxy mode and `createSystemCloudFetch()` otherwise.

- [ ] **Step 1: Write failing deployment-contract tests**

Add tests that require the launcher to set the three proxy variables, include `--use-env-proxy`, and require `main.mjs` to select native fetch when `cloudRelay.proxy.enabled` is true:

```js
test('Yuqi launcher gives only the runtime process the configured VPN proxy', () => {
  const launcher = readFileSync('scripts/start-yuqi-background.ps1', 'utf8');
  assert.match(launcher, /HTTP_PROXY/);
  assert.match(launcher, /HTTPS_PROXY/);
  assert.match(launcher, /NO_PROXY/);
  assert.match(launcher, /--use-env-proxy/);
});

test('runtime uses native proxy-aware fetch only for explicit proxy mode', () => {
  const main = readFileSync('yuqi-runtime/src/main.mjs', 'utf8');
  assert.match(main, /config\.cloudRelay\?\.proxy\?\.enabled\s*\?\s*globalThis\.fetch/);
});
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `node --test tests/yuqi-deployment-contract.test.mjs`  
Expected: FAIL because the launcher has no proxy environment setup or Node proxy flag, and `main.mjs` always uses `createSystemCloudFetch()`.

- [ ] **Step 3: Implement minimal process-local proxy startup**

In the launcher, validate that the configured URL is an HTTP/HTTPS loopback URL, temporarily set proxy environment variables before `Start-Process`, pass `--use-env-proxy` before the main module, and restore the launcher's own environment after process creation. The child inherits the proxy values; the rest of Windows does not.

In `main.mjs`, use:

```js
const explicitProxy = config.cloudRelay?.proxy?.enabled === true;
const cloudFetch = config.cloudRelay?.enabled
  ? (explicitProxy ? globalThis.fetch : createSystemCloudFetch())
  : null;
```

Set the real config proxy URL to `http://127.0.0.1:10809`; add the same non-secret schema to the example config.

- [ ] **Step 4: Run the deployment tests and live read-only proxy probe**

Run: `node --test tests/yuqi-deployment-contract.test.mjs`  
Expected: PASS.

Run with process-local proxy: `node --use-env-proxy -e "fetch('https://al-cloud-timer.siyi78118.workers.dev/bridge/health').then(async r=>console.log(r.status,await r.text()))"`  
Expected: HTTP 200 and `"service":"yuqi-relay"`.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- tests/yuqi-deployment-contract.test.mjs scripts/start-yuqi-background.ps1 yuqi-runtime/src/main.mjs yuqi-runtime/config.json yuqi-runtime/config.example.json
git commit -m "fix: route Yuqi cloud relay through local VPN"
```

### Task 2: Cloud relay status, diagnostics, and stale proactive suppression

**Files:**
- Modify: `yuqi-runtime/test/cloud-relay-pump.test.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`

**Interfaces:**
- Consumes: constructor options `clock`, `store`, `reconciler`, `dispatcher`, `outbox`, `proxyEnabled`, and encrypted relay envelopes.
- Produces: `pump.status()` returning `{ enabled, proxyEnabled, connected, lastSuccessAt, lastErrorAt, lastError, pendingProcessed }`; stale proactive envelopes are ACKed after recovery reconciliation and recorded as `stale_proactive_suppressed` without dispatch.

- [ ] **Step 1: Write failing pump tests**

Add one test where poll throws and assert that `pump.status().connected === false`, no ACK occurs, and one redacted diagnostic is written. Add a second test with a two-hour-old `PROACTIVE_CHAT` envelope and assert that reconciliation and ACK occur but dispatcher and outbox delivery registration do not.

```js
test('poll failure remains unacknowledged and becomes visible in relay status', async () => {
  const diagnostics = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64,
    fetchImpl: async () => { throw new Error('connect timeout'); },
    orchestrator: { async process() {} },
    store: { putDiagnostic(value) { diagnostics.push(value); } },
    proxyEnabled: true,
    clock: () => 1784512000000
  });
  await assert.rejects(pump.pumpOnce(), /connect timeout/);
  assert.equal(pump.status().connected, false);
  assert.equal(pump.status().proxyEnabled, true);
  assert.equal(diagnostics[0].stage, 'cloud_relay_poll');
});
```

- [ ] **Step 2: Run pump tests and verify RED**

Run: `node --test yuqi-runtime/test/cloud-relay-pump.test.mjs`  
Expected: FAIL because `status()` and stale suppression do not exist.

- [ ] **Step 3: Implement minimal status and stale suppression**

Maintain only non-sensitive state in memory. On outer poll failure, set failure state, write a rate-limited diagnostic, and rethrow so the start loop can retry. On poll success, set success state and processed count.

Before normal v2 dispatch:

```js
const staleProactive = envelope.kind === 'PROACTIVE_CHAT'
  && this.clock() - Number(envelope.createdAt || 0) > 30 * 60 * 1000;
if (staleProactive) {
  if (this.reconciler && envelope.recovery?.entries) {
    await this.reconciler.reconcileFrom(envelope.recovery);
  }
  this.store?.putDiagnostic?.({
    turnId: envelope.turnId,
    stage: 'stale_proactive_suppressed',
    level: 'info',
    detail: { ageMs: this.clock() - Number(envelope.createdAt || 0) }
  });
  await acknowledgeRelayMessage(message.messageId);
  summary.processed += 1;
  summary.suppressed += 1;
  continue;
}
```

Do not include plaintext content in the diagnostic.

- [ ] **Step 4: Run pump and reconciliation tests**

Run: `node --test yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/reconcile.test.mjs`  
Expected: PASS, including existing ACK and idempotency behavior.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/src/cloud-relay-pump.mjs
git commit -m "fix: expose relay failures and suppress stale proactive turns"
```

### Task 3: Non-sensitive relay health surface

**Files:**
- Modify: `yuqi-runtime/test/local-server.test.mjs`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Modify: `yuqi-runtime/src/main.mjs`

**Interfaces:**
- Consumes: optional `getCloudRelayStatus(): RelayStatus` callback supplied by `main.mjs`.
- Produces: `/v1/health.cloudRelay` with only the seven non-sensitive fields defined in the design.

- [ ] **Step 1: Write failing health test**

Create a server with `getCloudRelayStatus: () => ({ enabled:true, proxyEnabled:true, connected:false, lastSuccessAt:0, lastErrorAt:1784512000000, lastError:'connect timeout', pendingProcessed:0 })`, request `/v1/health`, and assert exact equality of `body.cloudRelay`.

- [ ] **Step 2: Run the local-server test and verify RED**

Run: `node --test yuqi-runtime/test/local-server.test.mjs`  
Expected: FAIL because the health response omits `cloudRelay`.

- [ ] **Step 3: Add the health callback**

Extend `createYuqiServer` with `getCloudRelayStatus = null`. Add:

```js
cloudRelay: typeof getCloudRelayStatus === 'function'
  ? getCloudRelayStatus()
  : { enabled: false, proxyEnabled: false, connected: false,
      lastSuccessAt: 0, lastErrorAt: 0, lastError: '', pendingProcessed: 0 }
```

Pass `getCloudRelayStatus: () => cloudPump?.status() || disabledRelayStatus` from `main.mjs`. Do not expose config or credentials.

- [ ] **Step 4: Run server and complete runtime tests**

Run: `node --test yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs`  
Expected: PASS.

Run: `node --test yuqi-runtime/test/*.test.mjs`  
Expected: all runtime tests PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- yuqi-runtime/test/local-server.test.mjs yuqi-runtime/src/local-server.mjs yuqi-runtime/src/main.mjs
git commit -m "feat: expose Yuqi cloud relay health"
```

### Task 4: Restart, consume backlog, verify memory, and back up

**Files:**
- Read: `C:/Users/PC/Documents/虞栖AL记忆库备份/database/yuqi-runtime.sqlite`
- Create: a timestamped SQLite snapshot under `C:/Users/PC/Documents/虞栖AL记忆库备份/snapshots/`
- Read: `C:/Users/PC/Documents/虞栖AL记忆库备份/logs/yuqi-runtime.stdout.log`
- Read: `C:/Users/PC/Documents/虞栖AL记忆库备份/logs/yuqi-runtime.stderr.log`

**Interfaces:**
- Consumes: the completed proxy-aware runtime and two existing cloud envelopes.
- Produces: empty `phone_to_pc` mailbox, committed 09:45 turn, recovery cursor at least 16, correctly attributed 02:41 messages, queued/delivered phone reply, and a post-recovery snapshot.

- [ ] **Step 1: Run all targeted tests before touching the live service**

Run: `node --test tests/yuqi-deployment-contract.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/reconcile.test.mjs`  
Expected: PASS.

- [ ] **Step 2: Create a pre-restart backup and restart the runtime**

Run the existing backup script, then stop and start through `scripts/stop-yuqi-background.ps1` and `scripts/start-yuqi-background.ps1`.  
Expected: startup reports a new PID and `/v1/health` reports `proxyEnabled:true`.

- [ ] **Step 3: Wait on observable state, not a fixed long sleep**

Poll `/v1/health` and the database for up to five minutes. Stop waiting when the 09:45 turn is committed or failed. During the wait, report progress at least once per minute.

- [ ] **Step 4: Verify exact recovery evidence**

Read the database in SQLite read-only mode and assert:

```text
content="猜错了也没关系，就是突然好奇"
speaker_id="yuqi"
speaker_type="character"
origin="legacy_fallback"

content="你不说话，是被我问住了？"
speaker_id="yuqi"
speaker_type="character"
origin="legacy_fallback"
```

Assert that `sync_cursors.ack_seq >= 16`, the 07:06 task has a `stale_proactive_suppressed` diagnostic, and the 09:45 direct turn exists without attribution errors.

- [ ] **Step 5: Verify cloud directions and quota**

Authenticated read-only poll must show zero `phone_to_pc` envelopes. The `pc_to_phone` direction must contain the 09:45 reply or the phone must already have acknowledged it. Quota warning level must remain zero.

- [ ] **Step 6: Create post-recovery memory snapshot**

Run: `node scripts/backup-yuqi-memory.mjs yuqi-runtime/config.json`  
Expected: a new readable SQLite snapshot whose message ledger includes both 02:41 rows.

- [ ] **Step 7: Run regression suite and record final state**

Run: `node --test tests/yuqi-deployment-contract.test.mjs yuqi-runtime/test/*.test.mjs`  
Expected: all tests PASS with no new errors beyond Node's existing SQLite experimental warning.

No GitHub push is performed.
