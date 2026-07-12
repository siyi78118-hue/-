# AL Durable Replies and Rich Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Android user-triggered AI reply run durably through WorkManager, add in-place retry, and let AI use Emoji or send payable红包/转账 cards.

**Architecture:** The WebView persists a user message plus a task-specific snapshot, then a native Capacitor plugin enqueues an immediate unique `RunnerWorker`. The headless runner owns memory retrieval, non-stream chat generation, idempotent result storage, notifications, and AI payment directives; the WebView only reconciles persisted results. Browser fallback uses the same non-stream response parser without WorkManager.

**Tech Stack:** Capacitor 8, Android WorkManager, Java, Background Runner JavaScript, localStorage/IndexedDB, Node `node:test`, Gradle.

## Global Constraints

- Android ordinary replies must not depend on a live WebView after the send action is accepted.
- Every reply must include the complete RP rules, current character/stage persona, exactly the latest 30 eligible messages, and memory-AI-selected local memory.
- API keys and local memory remain on the device; ordinary replies do not use Cloudflare.
- The user message ID is the reply task idempotency key.
- Android ordinary replies are non-streaming.
- AI may mix Emoji into text or send Emoji as a standalone assistant message.
- AI may send a红包 or transfer with an AI-chosen positive amount and note; the character has no balance, while claiming credits the player wallet exactly once.
- Existing unrelated worktree changes must not be staged or reverted.

---

### Task 1: Headless User Reply Contract

**Files:**
- Modify: `tests/background-runner.test.mjs`
- Modify: `tavern-app/runners/al-background.js`

**Interfaces:**
- Consumes: persisted `state.pendingUserReplies[]` rows containing `taskId`, `charId`, `userMessageId`, `createdAt`, and prepared prompt data.
- Produces: `runPendingUserReplies()`, `runUserReply(state, task)`, task states `pending|running|done|failed`, and assistant rows with `replyToMessageId`.

- [ ] **Step 1: Write failing runner tests**

Add tests proving `pendingUserReply` processes a normal reply, calls memory before chat, keeps the latest 30 messages, writes the result against the original message ID, and emits a normal-reply notification rather than a proactive notification.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/background-runner.test.mjs`

Expected: FAIL because `pendingUserReply` and `runUserReply` do not exist.

- [ ] **Step 3: Implement the minimal headless path**

Add a `pendingUserReply` event handler that claims one queued task, calls `retrieveMemory`, then calls the chat API non-streaming with the prepared ordinary-chat system prompt and 30-message history. Append reply chunks with `replyToMessageId`, clear `chat.pendingReply`, mark the task done, and persist state.

- [ ] **Step 4: Add idempotency and failure tests**

Prove duplicate Worker executions do not create duplicate assistant rows, failures retain the same task for explicit retry, and notifications say `回复生成失败，点此重试`.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `node --test tests/background-runner.test.mjs`

Expected: all runner tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add tests/background-runner.test.mjs tavern-app/runners/al-background.js
git commit -m "feat: generate user replies in background runner"
```

### Task 2: Native Durable Work Enqueue

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/AlReplyQueuePlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/MainActivity.java`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: `enqueue({ taskId, charId })` from the WebView after task state is durable.
- Produces: unique immediate WorkManager work named `com.siyi.al.background:user-reply:<taskId>` using event `pendingUserReply` and `NetworkType.CONNECTED`.

- [ ] **Step 1: Add failing structural tests**

Assert the native plugin is registered, validates non-empty task IDs, configures `RunnerWorker` with `pendingUserReply`, requires network, and uses unique work with `ExistingWorkPolicy.KEEP`.

- [ ] **Step 2: Run and verify RED**

Run: `node test-basic.mjs`

Expected: FAIL because `AlReplyQueuePlugin.java` is absent.

- [ ] **Step 3: Implement the Capacitor plugin**

Create `@CapacitorPlugin(name = "AlReplyQueue")` with `@PluginMethod enqueue`. Build `Data` with label `com.siyi.al.background`, source `runners/al-background.js`, and event `pendingUserReply`; enqueue an expedited one-time request with connected-network constraint and resolve immediately after WorkManager accepts it.

- [ ] **Step 4: Register the plugin and verify GREEN**

Run: `node test-basic.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/AlReplyQueuePlugin.java android/app/src/main/java/com/siyi/al/MainActivity.java test-basic.mjs
git commit -m "feat: enqueue durable Android reply work"
```

### Task 3: Frontend Task Preparation and Reconciliation

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Produces: `queueAndroidUserReply(charId, userMessageId, options)`, `prepareUserReplyTask(...)`, `reconcileNativeReplyState()`, and a single foreground polling loop.
- Consumes: `AlReplyQueue.enqueue`, Background Runner `syncState/readState`, existing prompt composer, MemoryDB rows, and `pendingReply` state.

- [ ] **Step 1: Add failing tests for Android routing**

Prove Android `sendMessage()` persists the user message, prepares an ordinary-chat prompt, queues one task, and never calls foreground `callAPI`. Prove the prepared history contains 30 eligible messages and excludes proactive trigger text.

- [ ] **Step 2: Run and verify RED**

Run: `node test-basic.mjs`

Expected: FAIL because Android routing still calls `continueAssistantTurn`.

- [ ] **Step 3: Implement task-specific snapshot and enqueue**

Store only the current character, current chat, current-character memory rows, settings needed by the two APIs, ordinary RP system prompt, and task metadata in native runner state. Enqueue only after `syncState` confirms persistence.

- [ ] **Step 4: Implement foreground reconciliation**

Poll `readState` while a pending Android reply exists and reconcile on app resume/focus. Merge by `replyToMessageId`, clear pending state, render once, and schedule post-turn memory extraction without duplicating messages.

- [ ] **Step 5: Make browser fallback non-streaming**

Call `callAPI` with `live:false`, preserve its existing error diagnostics, and render only the completed result.

- [ ] **Step 6: Run and verify GREEN**

Run: `node test-basic.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add test-basic.mjs tavern-app/index.html
git commit -m "feat: route Android replies through durable tasks"
```

### Task 4: In-place Failed Reply Retry

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Produces: `retryFailedReply(charId, userMessageId)`.
- Consumes: original message, stored `pendingReply.options`, and Android/browser routing from Task 3.

- [ ] **Step 1: Add failing retry tests**

Prove the failed row renders a `重新发送` button; retry preserves the original user message count and ID; deleted, retracted, already-answered, and currently-running messages are rejected.

- [ ] **Step 2: Run and verify RED**

Run: `node test-basic.mjs`

Expected: FAIL because the retry button and function are absent.

- [ ] **Step 3: Implement retry state transition**

Clear the old error, restore `pendingReply` with the original options, disable repeated taps, and route the same message through Task 3. Preserve payment metadata so player-originated payment retries never deduct twice.

- [ ] **Step 4: Run and verify GREEN**

Run: `node test-basic.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add test-basic.mjs tavern-app/index.html
git commit -m "feat: retry failed replies in place"
```

### Task 5: Emoji and AI Payment Directives

**Files:**
- Modify: `tests/background-runner.test.mjs`
- Modify: `test-basic.mjs`
- Modify: `tavern-app/runners/al-background.js`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Produces: hidden `<al_send_payment>{"type":"redpacket|transfer","amount":number,"note":"text"}</al_send_payment>` parsing and assistant payment messages.
- Consumes: existing payment card renderer, wallet helpers, memory events, and comprehensive RP prompt.

- [ ] **Step 1: Add failing directive and prompt tests**

Verify RP rules allow optional inline/standalone Emoji and optional AI payment actions, with positive finite amount validation and examples/negative examples. Verify directives never leak into chat text.

- [ ] **Step 2: Add failing payment lifecycle tests**

Prove AI payment cards begin pending, claiming credits the player wallet once, duplicate claims do nothing, refusal does not credit, and 24-hour expiry does not credit.

- [ ] **Step 3: Run and verify RED**

Run: `node --test tests/background-runner.test.mjs && node test-basic.mjs`

Expected: FAIL because AI-originated payment directives and claim handling are absent.

- [ ] **Step 4: Implement runner and browser parsing**

Parse and strip the hidden directive before splitting chat text. Append one assistant payment message with unique payment ID, source reply ID, amount, note, pending state, and expiry. Invalid directives are ignored without failing the textual reply.

- [ ] **Step 5: Implement player actions and idempotent wallet credit**

Make assistant payment cards actionable. Store `creditedAt` before saving wallet state, and require `payStatus === 'pending' && !creditedAt` before crediting.

- [ ] **Step 6: Run and verify GREEN**

Run: `node --test tests/background-runner.test.mjs && node test-basic.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add tests/background-runner.test.mjs test-basic.mjs tavern-app/runners/al-background.js tavern-app/index.html
git commit -m "feat: add AI emoji and payment actions"
```

### Task 6: Mirror Coalescing and Regression Verification

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/sw-v11.js`

**Interfaces:**
- Produces: non-overlapping, coalesced general state mirroring that is never awaited by ordinary chat generation.

- [ ] **Step 1: Add failing mirror tests**

Verify repeated `DB.set` calls create one delayed mirror, a running mirror cannot overlap, and user reply routing does not await a full-app snapshot.

- [ ] **Step 2: Run and verify RED**

Run: `node test-basic.mjs`

Expected: FAIL under the current mirror scheduler.

- [ ] **Step 3: Implement single-flight coalescing**

Track scheduled, running, and rerun-requested states. Keep general proactive snapshots out of the critical send path and update cache/build constants.

- [ ] **Step 4: Run all checks**

Run:

```powershell
npm.cmd test
node --test tests/background-runner.test.mjs
node --test tests/api-endpoint.test.mjs
node --test tests/cloud-timer-worker.test.mjs
node --check tavern-app/runners/al-background.js
node --check cloud-timer-worker.js
```

Expected: all PASS.

- [ ] **Step 5: Build Android debug APK**

Run:

```powershell
npm.cmd run android:sync
Set-Location android
.\gradlew.bat testDebugUnitTest assembleDebug --no-daemon
```

Expected: `BUILD SUCCESSFUL` and `android/app/build/outputs/apk/debug/app-debug.apk` exists.

- [ ] **Step 6: Commit**

```powershell
git add test-basic.mjs tavern-app/index.html tavern-app/sw-v11.js
git commit -m "fix: keep chat persistence off the response path"
```

### Task 7: Final Review and Test Handoff

**Files:**
- Review: all files changed by Tasks 1-6

- [ ] **Step 1: Review current branch diff**

Run: `git diff origin/main...HEAD --check` and inspect only AL-related changes.

- [ ] **Step 2: Re-run the complete test matrix**

Run the commands from Task 6 Step 4 and confirm no warnings or failures attributable to the changes.

- [ ] **Step 3: Report the APK path and exact manual scenarios**

Manual scenarios: send then immediately background; send then lock screen; reopen during generation; duplicate WorkManager wake; failed API then in-place retry; standalone Emoji; AI红包 claim twice; AI红包 expire; AI transfer refuse.

- [ ] **Step 4: Stop before public release**

Do not push `main` or publish a public APK until the user explicitly approves the tested build.
