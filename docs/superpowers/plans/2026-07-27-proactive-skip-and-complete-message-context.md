# Proactive Skip and Complete Message Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one skip at most in every four completed proactive chats without user-message resets, and provide brain/supervisor with the latest 20 complete message groups.

**Architecture:** Keep the proactive quota in the runtime store and remove its user-message time boundary. Build complete-message groups inside the existing conversation-context helper using speaker plus turn identity, then flatten the selected groups to preserve the current request schema.

**Tech Stack:** Node.js ESM, SQLite, `node:test`, Android WebView/Java integration tests.

## Global Constraints

- A user send-finished batch is one complete message.
- One Yuqi generation is one complete message even when rendered as multiple bubbles.
- User and Yuqi groups count separately.
- The generation window is 20 complete messages.
- The memory evidence window remains 200 raw messages.
- User messages never reset proactive skip history.
- The latest four completed proactive chats contain at most one skip.
- Do not modify fourth-round annotation training files.

---

### Task 1: Make proactive skip quota independent of user messages

**Files:**
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/src/store.mjs`

**Interfaces:**
- Consumes: committed/delivered/completed `PROACTIVE_CHAT` turn rows.
- Produces: `getProactiveChatDeliveryPolicy(characterId, options)` with `resetAfterTurnId: null`.

- [ ] **Step 1: Replace the reset expectation with a failing persistence test**

Create a skipped proactive turn, submit a later direct user turn, then assert:

```js
const policy = store.getProactiveChatDeliveryPolicy('yuqi');
assert.equal(policy.usedSkips, 1);
assert.equal(policy.skipAllowed, false);
assert.deepEqual(policy.inspectedTurnIds, ['turn_policy_proactive_chat_2']);
assert.equal(policy.resetAfterTurnId, null);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs
```

Expected: the persistence test fails because the current SQL filters rows before the latest user turn.

- [ ] **Step 3: Remove the user reset boundary**

Replace the reset lookup and `created_at > ?` predicate with a query over the latest completed proactive chats:

```js
const rows = this.db.prepare(`
  SELECT turn_id, reply_json
  FROM turns
  WHERE character_id = ?
    AND state IN ('committed', 'delivered', 'completed')
    AND json_extract(envelope_json, '$.kind') = 'PROACTIVE_CHAT'
  ORDER BY created_at DESC
  LIMIT ?
`).all(characterId, safeWindowSize);
```

Return `resetAfterTurnId: null`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command. Expected: all protocol-store tests pass.

### Task 2: Count complete message groups instead of rows

**Files:**
- Modify: `yuqi-runtime/test/conversation-context.test.mjs`
- Modify: `yuqi-runtime/src/conversation-context.mjs`

**Interfaces:**
- Consumes: message rows containing `messageId`, `turnId`, `speakerType`, and `sentAt`.
- Produces: `buildGenerationWindow(messages, { currentMessageId, limit })`, returning a chronological flat array selected by group count.

- [ ] **Step 1: Add failing grouping tests**

Add one test where 21 complete groups exist and the oldest retained Yuqi group contains two rows sharing a turn ID. Assert both rows survive and exactly 20 unique group keys remain. Add a second test proving user and character rows sharing a turn ID count as separate groups.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/conversation-context.test.mjs
```

Expected: the current row-based `slice(-limit)` either cuts a multi-row generation or keeps only 20 rows rather than 20 groups.

- [ ] **Step 3: Implement grouping and flattening**

After dedupe and sorting, derive:

```js
const groupKey = message?.turnId
  ? `${message.speakerType || message.speakerId || 'unknown'}:${message.turnId}`
  : `message:${message.messageId}`;
```

Collect messages in ordered groups, select `groups.slice(-safeLimit)`, and return `selected.flatMap(group => group.messages)`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command. Expected: all conversation-context tests pass.

### Task 3: Set the production generation limit to 20 and verify integration

**Files:**
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/main.mjs`

**Interfaces:**
- Consumes: `buildGenerationWindow` from Task 2.
- Produces: brain and supervisor requests using 20 complete-message groups while memory retains 200 raw rows.

- [ ] **Step 1: Change the integration test to fail on the old default**

Construct more than20 grouped history items, including a multi-row assistant turn, then assert:

```js
assert.equal(memoryInput.recentMessages.length, 200);
assert.equal(uniqueCompleteGroups(brainInput.recentMessages), 20);
assert.equal(uniqueCompleteGroups(supervisorInput.recentMessages), 20);
```

- [ ] **Step 2: Run the orchestrator test and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs
```

Expected: the generation request still uses the default limit of24.

- [ ] **Step 3: Change both runtime defaults**

Set `generationContextLimit = 20` in the orchestrator constructor and `generationContextLimit: 20` in `main.mjs`.

- [ ] **Step 4: Run runtime regression tests**

Run:

```powershell
npm test
```

from `yuqi-runtime`. Expected: all tests pass without warnings.

### Task 4: Build and validate the update APK

**Files:**
- Modify only version/build metadata required by the established Android release workflow.
- Create: `artifacts/AL-<version>-release.apk`

**Interfaces:**
- Consumes: validated runtime source and the fixed GitHub Actions signing identity.
- Produces: a formally signed, overwrite-installable APK.

- [ ] **Step 1: Run Android contract and unit tests**

Run the project’s existing Android test and unsigned-release contract commands. Expected: all pass.

- [ ] **Step 2: Increment version metadata without touching unrelated work**

Use the next available `versionCode` and corresponding `versionName`, updating only the established version files and contract expectations.

- [ ] **Step 3: Trigger the fixed-certificate build**

Follow `docs/AL-android-signing-runbook.md` using the local Git Credential Manager token only in memory and the GitHub REST API.

- [ ] **Step 4: Download and verify**

Verify package name, version, APK Signature Scheme v2 validity, certificate SHA-256
`5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`,
and file SHA-256 before delivery.
