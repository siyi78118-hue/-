# Yuqi Persona 1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the approved Yuqi persona to both the Android-visible profile and the three-role desktop runtime, then verify one bridged first-acquaintance turn.

**Architecture:** Keep visible biography copy in `tavern-app/index.html` and behavioral/runtime instructions in `yuqi-runtime/presets/yuqi-core.md`. A versioned built-in-profile migration refreshes the existing `yuqi` contact without deleting its chat, while the preset manifest upgrade causes the desktop runtime to publish and load version `1.1.0` after restart.

**Tech Stack:** Vanilla HTML/JavaScript, Node.js test runner, Capacitor Android, Node.js runtime, SQLite-backed preset registry.

## Global Constraints

- World premise copy is “手机意外能够联系另一个平行世界”; never use “神奇手机”.
- Visible profile contains biography, speech style, relationship, and stage only; no user analysis, correction notes, or backstage instructions.
- Relationship begins at `初识`; Xu Mi memories remain isolated.
- Brain, memory, and supervisor remain separate Codex threads.
- Normal raw context remains 200 messages.

---

### Task 1: Lock the approved profile contract

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: `YUQI_FIRST_PROFILE`, `YUQI_FIRST_ACQUAINTANCE`, and the brain preset compiled by `PresetRegistry.compileFor(role, context)`.
- Produces: contract assertions for profile version `1.1.0`, approved biography phrases, the revised world premise, and removal of “神奇手机”.

- [ ] **Step 1: Write failing UI and runtime assertions**

```js
assert.match(html, /profileVersion:\s*'1\.1\.0'/);
assert.match(html, /24岁，生活在另一个平行世界的现代临江城市/);
assert.match(html, /目前双方处于初识阶段/);
assert.match(html, /唯一的爱人和心中最重要的人/);
assert.doesNotMatch(html, /神奇手机/);

assert.equal(current.version, '1.1.0');
assert.match(prompt, /手机意外.*联系.*平行世界/s);
assert.match(prompt, /24岁.*现代临江城市/s);
assert.doesNotMatch(prompt, /神奇的手机/);
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test tests/yuqi-ui-contract.test.mjs yuqi-runtime/test/preset-registry.test.mjs`

Expected: FAIL because the current profile and preset are still version `1.0.0` and contain “神奇手机”.

### Task 2: Publish the approved profile and migrate the built-in contact

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/manifest.json`
- Test: `tests/yuqi-ui-contract.test.mjs`
- Test: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: the exact approved copy from `docs/superpowers/specs/2026-07-19-yuqi-persona-1.1-design.md`.
- Produces: `YUQI_FIRST_PROFILE.profileVersion === '1.1.0'`, an idempotent `ensureYuqiFirstAcquaintance()` migration, and runtime preset version `1.1.0`.

- [ ] **Step 1: Replace the visible built-in profile and settings hint**

Set `YUQI_FIRST_ACQUAINTANCE` to `双方的手机意外建立了与另一个平行世界的联系。` and populate `description`, `personality`, and `scenario` from the approved spec. Add `profileVersion: '1.1.0'`. Change the settings hint to `初始关系：初识；双方的手机意外联系到另一个平行世界。`.

- [ ] **Step 2: Add an idempotent existing-contact migration**

```js
if (char && char.profileVersion !== YUQI_FIRST_PROFILE.profileVersion) {
  Object.assign(char, {
    name: YUQI_FIRST_PROFILE.name,
    avatar: YUQI_FIRST_PROFILE.avatar,
    description: YUQI_FIRST_PROFILE.description,
    personality: YUQI_FIRST_PROFILE.personality,
    scenario: YUQI_FIRST_PROFILE.scenario,
    tags: [...YUQI_FIRST_PROFILE.tags],
    profileVersion: YUQI_FIRST_PROFILE.profileVersion
  });
  const chat = allChats[char.id];
  if (chat) chat.charPrompt = buildCharPrompt(char);
  DB.set('characters', characters);
  DB.set('chats', allChats);
}
```

This preserves messages, schedules, annotations, and device binding while refreshing built-in profile copy.

- [ ] **Step 3: Replace the brain preset and bump the manifest**

Rewrite `yuqi-core.md` with the approved character, speaking, and relationship behavior plus the existing hidden knowledge boundary. Set `currentVersion` in `manifest.json` to `1.1.0`; keep memory and supervisor module mappings unchanged.

- [ ] **Step 4: Run focused tests and confirm success**

Run: `node --test tests/yuqi-ui-contract.test.mjs yuqi-runtime/test/preset-registry.test.mjs`

Expected: all focused tests PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`

Expected: exit code 0 and all suites PASS.

- [ ] **Step 6: Commit only persona implementation files**

```powershell
git add -- tavern-app/index.html yuqi-runtime/presets/yuqi-core.md yuqi-runtime/presets/manifest.json tests/yuqi-ui-contract.test.mjs yuqi-runtime/test/preset-registry.test.mjs
git commit -m "feat: publish Yuqi persona 1.1"
```

### Task 3: Refresh Android assets and verify the live bridge

**Files:**
- Generated: `android/app/src/main/assets/public/index.html`
- Generated: `android/app/build/outputs/apk/debug/app-debug.apk`
- Runtime data: `C:/Users/PC/Documents/虞栖AL记忆库备份/database/yuqi-runtime.sqlite`

**Interfaces:**
- Consumes: profile and preset version `1.1.0` from Task 2.
- Produces: refreshed Android APK/assets and a restarted desktop runtime whose health reports three role threads and preset `1.1.0`.

- [ ] **Step 1: Refresh Android assets and build the APK**

Run: `npm run android:debug`

Expected: Gradle `BUILD SUCCESSFUL`; `app-debug.apk` exists.

- [ ] **Step 2: Stop and restart the runtime**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop-yuqi-background.ps1`

Expected: the recorded runtime process stops.

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-yuqi-background.ps1`

Expected: `Yuqi runtime started. PID=...`.

- [ ] **Step 3: Verify local, role, memory, pairing, APK, and cloud state**

Run: `node scripts/verify-yuqi-runtime.mjs`

Expected JSON: `ok: true`, roles `brain`, `memory`, `supervisor`, `isolatedRoles: true`, `presetVersion: "1.1.0"`, `contextLimit: 200`, `phonePairingReady: true`, and `cloudRelayReady: true`.

- [ ] **Step 4: Submit one signed first-acquaintance bridge turn**

Send a unique test message through the same signed `/v1/turns` protocol used by Android, poll `/v1/sync`, and confirm the returned reply has `characterId: "yuqi"`, `speakerId: "yuqi"`, `origin: "codex"`, and preset version `1.1.0`.

- [ ] **Step 5: Inspect persisted turn stages**

Query the test turn in SQLite and confirm it reached `committed` after storing `memory_packet_json`, `brain_draft_json`, and `supervisor_json`. Remove the test turn/message only if the protocol provides a supported cleanup path; otherwise keep it clearly labeled as a system verification record.

- [ ] **Step 6: Report the phone test sequence**

Tell the user to refresh or install the new APK, open Settings → 虞栖专属 AL → 运行状态, then send the first real message. Report separately whether profile publication, three-role processing, LAN routing, and cloud fallback passed.
