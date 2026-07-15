# Cloud Timer KV Quota Recovery Implementation Plan

> **For agentic workers:** Execute inline in this session. Follow TDD for every behavior change.

**Goal:** Make cloud scheduling survive and clearly report Cloudflare KV daily write exhaustion while sharply reducing routine KV writes.

**Architecture:** The Worker classifies storage quota failures at the HTTP boundary and throttles nonessential persistence. The app treats the classified error as a deferred cloud sync: it keeps the local/native task snapshot and suppresses retries until the quota reset time.

**Tech Stack:** Cloudflare Worker ES modules, Workers KV, browser JavaScript, Node.js tests, Capacitor Android.

## Global Constraints

- Preserve the existing KV namespace, push subscription and every-minute Cron trigger.
- Do not touch unrelated dirty-worktree files.
- Do not expose API keys, push tokens or full device identifiers in logs.
- Publish through the existing in-app Android update channel.

---

### Task 1: Worker quota classification and write reduction

**Files:**
- Modify: `cloud-timer-worker.js`
- Create: `test-cloud-quota-recovery.mjs`
- Modify: `package.json`

- [ ] Write tests that force `KV put() limit exceeded for the day.` and expect HTTP 429, `KV_DAILY_WRITE_LIMIT`, and a future reset time.
- [ ] Run the focused test and verify the current generic HTTP 400 behavior fails.
- [ ] Add quota-error classification and structured logging at the Worker boundary.
- [ ] Change idle heartbeat persistence to once per 60 minutes and stop persisting routine schedule/register success events.
- [ ] Run focused and full tests.

### Task 2: App-side local preservation and backoff

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `test-cloud-quota-recovery.mjs`

- [ ] Add failing assertions for response-body parsing, quota-specific Chinese text, local-job preservation and retry suppression.
- [ ] Parse the Worker JSON error and attach `code`/`retryAt` to the thrown error.
- [ ] Preserve the local job for quota errors, save the backoff deadline, and avoid cloud calls before that deadline.
- [ ] Clear the backoff after a successful cloud schedule or when its deadline passes.
- [ ] Run focused and full tests.

### Task 3: Version, build, deployment and update publication

**Files:**
- Modify the existing app/Worker version constants and Android update manifest inputs used by the repository.

- [ ] Bump cache/app/Android versions consistently.
- [ ] Run Worker dry-run and Android build verification.
- [ ] Deploy the Worker while keeping the existing KV and Cron configuration.
- [ ] Commit and push only this fix, then publish the APK through the existing GitHub update channel.
- [ ] Verify `/health`, the update manifest and a controlled quota response.
