# Yuqi Unified RP and Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every Yuqi-visible generation receives the complete AL 综合 RP plus `yuqi-core`, rebuild automatic-task interaction state at execution time, allow silent skips, and give supervision a real veto before producing an installable overlay APK.

**Architecture:** Keep the AL 综合 RP in `tavern-app/index.html` as the user-edited source of truth and generate a checked runtime copy plus a browser-loadable `yuqi-core` asset. The desktop orchestrator composes the mandatory foundation and character preset for every brain turn, adds authoritative interaction state from the message ledger, and passes the same generation contract to supervision. Automatic turns use explicit `send|skip` decisions; Android and relay code treat `skip` as a successful terminal result with no visible message.

**Tech Stack:** Node.js ESM, Node test runner, SQLite runtime store, Android Java/Room, Capacitor 8, Gradle, APK signing tools.

## Global Constraints

- AL 综合 RP and `yuqi-core` are both mandatory for every Yuqi-visible generation: direct chat, proactive chat, payment, role plans, moment posts, moment comments, and moment replies.
- Missing or mismatched mandatory presets fail closed; no prompt downgrade is permitted.
- Automatic-task time, last-message state, and unanswered counts are rebuilt when the task executes.
- All automatic visible content is supervised; ordinary low-risk direct chat may remain on the fast route.
- Automatic `skip` creates no chat bubble, moment, notification, or fallback copy.
- A supervisor rejection is never force-approved after repeated rewrites.
- Preserve package `com.siyi.al`, the existing signing identity, user data, and the completed 1.0.83 race fix.
- Build delivery version `1.0.84` with version code `84` without changing checked-in Gradle defaults.

---

### Task 1: Synchronize mandatory preset assets

**Files:**
- Create: `scripts/sync-yuqi-preset-assets.mjs`
- Create: `yuqi-runtime/presets/al-combined-rp.md`
- Create: `tavern-app/lib/yuqi-core-preset.js`
- Modify: `tavern-app/index.html`
- Modify: `yuqi-runtime/presets/manifest.json`
- Modify: `package.json`
- Test: `tests/rp-preset-contract.test.mjs`

**Interfaces:**
- Produces: `extractCombinedRp(html: string): string`, `renderYuqiCoreAsset(markdown: string): string`, and synchronized preset artifacts.
- Consumes: the existing `RP_PRESETS.combined.prompt` template and `yuqi-runtime/presets/yuqi-core.md`.

- [ ] **Step 1: Write failing asset parity tests**

Add assertions that `yuqi-runtime/presets/al-combined-rp.md` exactly equals the extracted combined prompt after newline normalization, that `tavern-app/lib/yuqi-core-preset.js` contains the exact `yuqi-core.md` text, and that `index.html` loads the asset before its inline application script.

- [ ] **Step 2: Run the contract test and verify failure**

Run: `node --test tests/rp-preset-contract.test.mjs`

Expected: FAIL because the synchronized assets and loader do not exist.

- [ ] **Step 3: Implement the synchronizer and generated assets**

The script must support `--check` and normal write mode:

```js
const checkOnly = process.argv.includes('--check');
const combined = extractCombinedRp(readFileSync(indexPath, 'utf8'));
const core = readFileSync(corePath, 'utf8').trim();
const outputs = new Map([
  [combinedPath, `${combined}\n`],
  [browserCorePath, `globalThis.AL_YUQI_CORE_PROMPT = ${JSON.stringify(core)};\n`]
]);
```

Normal mode writes only changed generated files. Check mode throws when either artifact differs. Add `presets:sync` and `presets:check` scripts; run synchronization before Android copy/sync/debug commands and run check in the test suite. Add `<script src="./lib/yuqi-core-preset.js"></script>` immediately before the main inline script. Add `foundation: "al-combined-rp.md"` to the runtime manifest and bump the seed version to `1.2.0`.

- [ ] **Step 4: Generate assets and pass the parity test**

Run: `npm run presets:sync`

Run: `node --test tests/rp-preset-contract.test.mjs`

Expected: PASS; check mode reports no drift.

- [ ] **Step 5: Commit the isolated preset synchronization change**

Stage only the files in this task and commit with `feat: synchronize mandatory yuqi presets`.

### Task 2: Compose AL 综合 RP and `yuqi-core` for every runtime generation

**Files:**
- Modify: `yuqi-runtime/src/preset-registry.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Test: `yuqi-runtime/test/preset-registry.test.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Produces: `compileGeneration(scene): string` and `compileSupervisor(scene): string` semantics through `PresetRegistry.compileFor`.
- Guarantees: brain and supervisor requests both contain the same mandatory foundation/core versions.

- [ ] **Step 1: Write failing compilation tests**

Assert that brain compilation orders `foundation` before `brain`, supervisor compilation contains its review rules plus the exact foundation and brain modules, memory compilation excludes the roleplay foundation, and missing `foundation` throws instead of degrading.

- [ ] **Step 2: Run the focused runtime tests and verify failure**

Run: `node --test yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs`

Expected: FAIL because the registry currently recognizes only brain, memory, and supervisor modules.

- [ ] **Step 3: Implement mandatory composition**

Load and validate all four modules. Compile visible generation as:

```js
[
  preset.modules.foundation,
  preset.modules.brain,
  runtimeBoundary(scene)
].join('\n\n');
```

Compile supervision as the supervisor module followed by a clearly labelled authoritative generation contract containing the same foundation and brain modules. Pass `kind`, relationship stage, and revealed fact IDs through the scene object. Remove hard-coded `stage: 'initial'` call sites where current envelope/snapshot stage is available; otherwise explicitly default to initial.

- [ ] **Step 4: Run tests and verify mandatory composition passes**

Run the focused runtime tests again.

Expected: PASS, including exact order and fail-closed coverage.

- [ ] **Step 5: Commit**

Commit with `feat: require full rp for yuqi generation`.

### Task 3: Rebuild interaction state and support automatic `skip`

**Files:**
- Create: `yuqi-runtime/src/interaction-state.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/turn-status.mjs`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Test: `yuqi-runtime/test/interaction-state.test.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/turn-status.test.mjs`

**Interfaces:**
- Produces: `buildInteractionState({ envelope, messages, turnKindById, now }): InteractionState`.
- Produces brain drafts `{ action: 'send'|'skip', reply: string, usedFactIds: string[], internalReasonCode: string }`.
- Produces committed skip results `{ action: 'skip', reply: null }`.

- [ ] **Step 1: Write failing interaction-state and skip tests**

Cover a task scheduled at 20:27 but executed at 22:41 with a 22:31 message inserted. Assert that the state reports the 22:31 last message, real 22:41 execution time, unique proactive turns since the last user reply, and current character bubble count. Add orchestrator coverage where an automatic brain draft returns `skip` and no character message is stored.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test yuqi-runtime/test/interaction-state.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-status.test.mjs`

Expected: FAIL because state rebuilding and skip results are absent.

- [ ] **Step 3: Implement execution-time state**

Derive all elapsed values from `now` and message `sentAt`. Count proactive rounds by unique turn IDs whose stored envelope kind is `PROACTIVE_CHAT`, not by stale snapshot metadata. Include latest user/character content, crossed-day flags, elapsed thresholds, and previous automatic result.

- [ ] **Step 4: Implement structured send/skip protocol**

Extend the brain schema with `action` and `internalReasonCode`; permit empty `reply` only for automatic `skip`. Direct replies must remain `send` with non-empty text. Remove automatic empty-reply replacement with “等你有空再聊。”. Commit a skip without calling `putMessage`, and expose `action: 'skip'` through public terminal status.

- [ ] **Step 5: Add explicit core guidance**

Add a concise automatic-contact section to `yuqi-core.md`: time and unanswered messages change desire to continue; `skip` is correct when a real person would stop; a new invented lifestyle anecdote is not sufficient motive by itself.

- [ ] **Step 6: Run focused tests and verify pass**

Expected: all focused tests PASS and no fallback copy appears in runtime source or results.

- [ ] **Step 7: Commit**

Commit with `feat: allow yuqi to skip stale proactive turns`.

### Task 4: Give supervision full context and a real terminal veto

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Modify: `yuqi-runtime/src/route-policy.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/route-policy.test.mjs`

**Interfaces:**
- Supervisor input includes `generationPreset`, `interactionState`, `recentMessages`, `evidencePack`, `draft`, `attempt`, and `previousIssues`.
- Supervisor output is `{ decision: 'approve'|'rewrite'|'skip'|'reject', issues: [...] }`.

- [ ] **Step 1: Write failing supervision tests**

Assert that every automatic kind routes deep; payment and moment interaction kinds route deep; supervisor input contains the same mandatory preset used by brain; `skip` commits silently; `reject` fails without a reply; and two rewrites never force-approve an automatic message.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/route-policy.test.mjs`

Expected: FAIL on missing context and legacy three-attempt force approval.

- [ ] **Step 3: Implement supervisor context and decisions**

Pass the exact compiled generation preset and authoritative state. Replace `approved: boolean` with the four-way decision. On the second unresolved rewrite, automatic turns commit `skip`; direct turns enter failed state with a recoverable diagnostic. Preserve issue history between attempts.

- [ ] **Step 4: Run tests and verify pass**

Expected: PASS, with no `acceptedAfterRewrite` path remaining.

- [ ] **Step 5: Commit**

Commit with `feat: enforce yuqi supervisor veto`.

### Task 5: Apply both presets to the phone-local path and transport skip safely

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Test: `tests/yuqi-ui-contract.test.mjs`
- Test: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`

**Interfaces:**
- Phone prompt composer consumes `globalThis.AL_YUQI_CORE_PROMPT` after AL 综合 RP.
- `BridgeResult.skipped(...)` and `ExecutionStore.commitSkip(...)` represent a successful no-content automatic turn.

- [ ] **Step 1: Write failing phone prompt and skip tests**

Assert that `buildSceneSystemBase` includes both `RP_PRESETS.combined.prompt` and `AL_YUQI_CORE_PROMPT` for chat, proactive, payment, role-plan, moment-post, moment-comment, and moment-reply builders. Add Android tests proving a terminal `{ action: 'skip', reply: null }` does not fall back, create reply parts, or surface a failure badge.

- [ ] **Step 2: Run focused web and Android tests and verify failure**

Run: `node --test tests/rp-preset-contract.test.mjs tests/yuqi-ui-contract.test.mjs`

Run: `android\gradlew.bat testDebugUnitTest --no-problems-report`

Expected: FAIL until core injection and skip transport exist.

- [ ] **Step 3: Inject the core preset into every phone scene**

Add a mandatory prompt block immediately after the AL combined/character base. Throw before model invocation if the generated asset is missing or empty. Ensure moment builders use the same base composer instead of bypassing it.

- [ ] **Step 4: Implement Android skip transport**

Parse `action: 'skip'` as a successful terminal result only for automatic turn kinds. Add `commitSkip` that completes the active attempt and turn without reply parts, records an informational diagnostic, and marks the automatic occurrence handled. Cloud inbox skip results must complete the matching automatic turn without creating backfill messages. Direct replies may never use skip.

- [ ] **Step 5: Run focused tests and verify pass**

Expected: both Node and Android suites PASS, and the existing 1.0.83 late-reply-authority tests remain green.

- [ ] **Step 6: Commit**

Commit with `feat: unify phone rp and silent automatic skips`.

### Task 6: Full regression, package, and verify APK 1.0.84

**Files:**
- Create: `artifacts/AL-1.0.84-release.apk` when the stable signing environment is available; otherwise create a same-identity signed debug-compatible APK and name it `artifacts/AL-1.0.84-release.apk` only after certificate verification.
- Create: `artifacts/verification/yuqi-unified-rp-1.0.84.json`

**Interfaces:**
- Produces an overlay-installable APK for `com.siyi.al`, version code `84`, version name `1.0.84`.

- [ ] **Step 1: Run preset drift and complete Node tests**

Run: `npm run presets:check`

Run: `npm test`

Expected: PASS with zero failures.

- [ ] **Step 2: Run Android unit tests**

Run: `android\gradlew.bat testDebugUnitTest --no-problems-report`

Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Synchronize Capacitor assets**

Run: `npm run presets:sync`

Run: `npx cap sync android`

Expected: `tavern-app` assets, including `lib/yuqi-core-preset.js`, are copied into the Android application.

- [ ] **Step 4: Build version 1.0.84 with the existing signing identity**

Set `AL_VERSION_CODE=84` and `AL_VERSION_NAME=1.0.84` only in the build process, then run `android\gradlew.bat assembleRelease --no-problems-report`. Do not edit Gradle defaults.

- [ ] **Step 5: Verify installability and identity**

Use `aapt dump badging` to verify package/version, `apksigner verify --print-certs` to compare the SHA-256 certificate with the current signed APK, and inspect the APK archive to verify current `index.html` and `lib/yuqi-core-preset.js` hashes. Reject the artifact if the certificate differs.

- [ ] **Step 6: Copy and record the artifact**

Copy the verified APK to `artifacts/AL-1.0.84-release.apk`. Record SHA-256, package, version, certificate match, preset hashes, test results, and the preserved 1.0.83 race regression in `artifacts/verification/yuqi-unified-rp-1.0.84.json`.

- [ ] **Step 7: Commit implementation and verification metadata**

Stage only intended source, tests, generated preset assets, plan/spec, and verification metadata. Do not stage unrelated deleted or untracked user files. Commit with `release: build AL 1.0.84 unified rp`.
