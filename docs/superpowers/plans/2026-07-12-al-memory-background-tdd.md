# AL Memory And Background Delivery Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with strict red-green-refactor TDD. Do not deploy until every local test and Android build check passes.

**Goal:** Prevent memory requests from falling back to the AL HTML page and make Android proactive chat/moment delivery remain pending until the phone has actually generated and acknowledged the result.

**Architecture:** Use one shared API-base normalization contract in foreground and headless runner code, with invalid or app-local endpoints rejected before `fetch`. Treat FCM acceptance as transport delivery only: the Worker retains and reschedules a job until the Android runner acknowledges `generated`, `stale`, or a terminal failure; the native queue drains deterministically and preserves unprocessed payloads.

**Tech Stack:** Vanilla JavaScript, Node.js `node:test`/`assert`, Cloudflare Workers KV, Capacitor 8, Android WorkManager, Firebase Cloud Messaging, Gradle/JUnit.

## Global Constraints

- Keep the most recent 30 original chat messages available to the chat model.
- Chat and memory API addresses and keys remain independently configurable.
- Cloud chat and moment schedules remain independent.
- Do not push `main` and do not publish an APK without a new explicit confirmation.
- Deploy `al-cloud-timer` only after all TDD checks pass.
- Do not stage or alter unrelated existing worktree changes.

---

### Task 1: Memory API endpoint contract

**Files:**
- Create: `tests/api-endpoint.test.mjs`
- Create: `tavern-app/lib/api-endpoint.js`
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/runners/al-background.js`
- Modify: `test-basic.mjs`

**Interfaces:**
- Produces `normalizeApiBaseUrl(value, options)` and `buildApiEndpoint(value, route, options)`.
- Rejects empty, relative, AL-hosted, and HTML-document endpoints before network I/O.
- Preserves provider roots such as `/v1`, while removing terminal `/models`, `/messages`, or `/chat/completions` exactly once.

- [ ] Write table-driven tests for valid OpenAI-compatible and Claude roots, full endpoint inputs, empty input, relative input, GitHub Pages AL URLs, Capacitor-local URLs, and HTML responses.
- [ ] Run `node --test tests/api-endpoint.test.mjs` and confirm the new contract fails before implementation.
- [ ] Implement the smallest shared endpoint helper and use the same rules in foreground and headless runner paths.
- [ ] Run the focused test and confirm it passes.
- [ ] Run `npm test` to preserve existing behavior.

### Task 2: Worker acknowledgement state machine

**Files:**
- Create: `tests/cloud-timer-worker.test.mjs`
- Modify: `cloud-timer-worker.js`
- Modify: `scripts/check-cloud-timer.mjs`
- Modify: `test-basic.mjs`

**Interfaces:**
- FCM delivery with `backgroundAck >= 1` produces `awaitingAck: true` and retains the KV job.
- A missing acknowledgement moves the job to one future bucket only and increments a bounded attempt counter.
- `/ack` validates the device and removes the job from both job storage and its due bucket.
- Terminal stale/generated outcomes are observable in `/logs` without exposing secrets.

- [ ] Write executable KV-backed tests for schedule, due delivery, awaiting acknowledgement, bucket migration, duplicate cron safety, wrong-device acknowledgement, valid acknowledgement, and bounded timeout.
- [ ] Run `node --test tests/cloud-timer-worker.test.mjs` and confirm at least one state-machine assertion fails.
- [ ] Implement the minimum state transitions and structured log fields needed by those tests.
- [ ] Run the focused Worker tests and confirm they pass.
- [ ] Run `node --check cloud-timer-worker.js` and `npm test`.

### Task 3: Android queue and headless generation contract

**Files:**
- Create: `tests/background-runner.test.mjs`
- Modify: `tavern-app/runners/al-background.js`
- Modify: `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`
- Modify: `android/app/src/test/java/com/siyi/al/ExampleUnitTest.java`
- Modify: `.github/workflows/android-apk.yml`

**Interfaces:**
- Native FCM persistence deduplicates by `jobId` without overwriting other queued work.
- One runner invocation drains all currently queued payloads in order, acknowledging each only after persisted state is written.
- Failed payloads remain queued and unacknowledged so the Worker can retry.
- Background memory retrieval uses the memory endpoint; chat generation uses the chat endpoint.

- [ ] Write a VM test with mocked `CapacitorKV`, model fetches, notifications, and cloud acknowledgement.
- [ ] Verify the current one-item event handler fails the multi-item drain and failure-preservation tests.
- [ ] Implement queue draining and explicit per-payload outcomes with state written before acknowledgement.
- [ ] Add/adjust JVM tests for native queue deduplication and WorkManager enqueue policy.
- [ ] Run `node --test tests/background-runner.test.mjs` and Android unit tests.

### Task 4: Full verification, review, deployment, and test branch

**Files:**
- Modify: `.github/workflows/android-apk.yml` only if needed so `codex/al-tdd` triggers tests and artifacts but release steps remain `main`-only.
- Modify: documentation/version constants only when required by verified behavior.

- [ ] Run `npm test`.
- [ ] Run all focused `node --test tests/*.test.mjs` tests.
- [ ] Run `node --check cloud-timer-worker.js`, `node --check tavern-app/runners/al-background.js`, and `node --check tavern-app/sw-v11.js`.
- [ ] Run `npm.cmd run android:sync` and `android\gradlew.bat test assembleDebug --no-daemon`.
- [ ] Review the complete diff for P0-P3 correctness, security, secret leakage, race conditions, and unrelated files.
- [ ] Deploy with the existing Cloudflare token via `C:\Users\Administrator\Tools\bin\wrangler.cmd`.
- [ ] Read `/health`, `/logs`, and a Wrangler tail sample; require the deployed version and cron state to match.
- [ ] Commit only scoped files, push `codex/al-tdd`, and inspect the GitHub Actions test build.
- [ ] Stop without pushing `main` or publishing any APK.
