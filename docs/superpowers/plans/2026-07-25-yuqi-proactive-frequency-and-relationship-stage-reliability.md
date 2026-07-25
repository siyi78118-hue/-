# Yuqi Proactive Frequency and Relationship Stage Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase Yuqi's opportunity to initiate a private chat while making dynamic relationship stages authoritative, cumulative across recent conversation history, and constrained by a valid phase state machine.

**Architecture:** Keep the existing cloud timer and two-axis relationship model. Change only policy constants, prompt authority, and pure relationship-stage validation; continue transporting accepted stage actions through the existing runtime → Android reply-part → web state path.

**Tech Stack:** JavaScript ES modules, Node.js `node:test`, Capacitor 8, Android Java/Gradle, Markdown runtime presets.

## Global Constraints

- Private-chat dice policy is exactly 10 minutes, 15% chance, maximum 144 rolls.
- Moment dice policy remains exactly 2 hours, 20% chance, maximum 12 rolls.
- `scene.relationshipStage` is the sole current relationship authority.
- Base stages remain `new`, `acquainted`, `familiar`, `close`, `committed`.
- Phase transitions must follow the graph in the approved design.
- Application ID remains `com.siyi.al`; release version becomes `1.0.93` / code `93`.
- The delivered APK must use the same signing certificate as `artifacts/AL-1.0.92-release.apk`.

---

### Task 1: Lock proactive cadence with contract tests

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/sw-v11.js`

**Interfaces:**
- Consumes: existing `proactiveDicePlan(options, now, randomValue)`.
- Produces: matching private-chat constants in foreground and service-worker execution paths.

- [ ] **Step 1: Add failing source-contract assertions**

Add assertions that both `index.html` and `sw-v11.js` contain:

```js
const PROACTIVE_DICE_INTERVAL_MS = 10 * 60 * 1000;
const PROACTIVE_DICE_CHANCE = 0.15;
const PROACTIVE_DICE_MAX_ROLLS = 144;
```

Also assert that the existing moment constants remain `2 * 60 * 60 * 1000`, `0.20`, and `12`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node --test tests/yuqi-ui-contract.test.mjs
```

Expected: failure because private-chat chance is still `0.05` and maximum rolls is still `432`.

- [ ] **Step 3: Update both execution contexts**

Set `PROACTIVE_DICE_CHANCE` to `0.15` and `PROACTIVE_DICE_MAX_ROLLS` to `144` in `tavern-app/index.html` and `tavern-app/sw-v11.js`. Do not change the moment constants or dice calculation.

- [ ] **Step 4: Run the focused test and verify pass**

Run the same `node --test` command. Expected: all tests pass.

### Task 2: Make dynamic relationship state authoritative

**Files:**
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/memory-manager.md`
- Modify: `tests/rp-preset-contract.test.mjs`
- Generated: `tavern-app/lib/yuqi-core-preset.js`

**Interfaces:**
- Consumes: `scene.relationshipStage.base`, `scene.relationshipStage.phase`, and the last 200 raw messages.
- Produces: a non-contradictory brain preset and cumulative review guidance for the memory role.

- [ ] **Step 1: Add failing preset-contract assertions**

Assert that compiled Yuqi core text:

```js
assert.doesNotMatch(prompt, /目前双方处于初识阶段/);
assert.match(prompt, /scene\.relationshipStage.*唯一.*当前关系/s);
```

Assert that memory-manager text names the cross-window evidence requirements for `new → acquainted`, `acquainted → familiar`, `familiar → close`, and explicit mutual confirmation for `committed`.

- [ ] **Step 2: Run the preset contract and verify failure**

Run:

```powershell
node --test tests/rp-preset-contract.test.mjs
```

Expected: failure on the fixed initial-stage sentence and missing cumulative criteria.

- [ ] **Step 3: Replace the contradictory core text**

Rewrite the fixed initial-stage paragraph so it states that the relationship began from first acquaintance, while the current state comes only from `scene.relationshipStage`. Preserve the world premise and gradual relationship development.

- [ ] **Step 4: Add cumulative evidence semantics to memory-manager**

Require the memory role to evaluate repeated voluntary contact and shared interaction across distinct time windows in the last 200 raw messages. Specify:

- two windows for `new → acquainted`;
- three windows plus stable habits/shared references for `acquainted → familiar`;
- sustained mutual trust/priority/vulnerability for `familiar → close`;
- direct mutual confirmation for entering `committed`.

Require `base: null` only when the cumulative record genuinely does not support a transition.

- [ ] **Step 5: Synchronize generated preset assets**

Run:

```powershell
npm.cmd run presets:sync
```

Expected: `tavern-app/lib/yuqi-core-preset.js` matches the runtime preset bundle.

- [ ] **Step 6: Run preset tests**

Run:

```powershell
npm.cmd run presets:check
node --test tests/rp-preset-contract.test.mjs
node --test yuqi-runtime/test/preset-registry.test.mjs
```

Expected: all commands pass.

### Task 3: Enforce graded base thresholds and the phase graph

**Files:**
- Modify: `yuqi-runtime/test/relationship-stage.test.mjs`
- Modify: `yuqi-runtime/src/relationship-stage.mjs`

**Interfaces:**
- Consumes: `resolveRelationshipStage(scene, review, recentMessages, now)`.
- Produces: the same `{ stage, action }` result shape with stricter transition validation.

- [ ] **Step 1: Add failing base-threshold tests**

Add cases proving:

```js
new -> acquainted accepts 0.78;
acquainted -> familiar rejects 0.79 and accepts 0.80;
familiar -> close rejects 0.83 and accepts 0.84;
close -> committed rejects 0.87;
close -> committed rejects 0.95 unless explicitMutualChange is true;
```

All ordinary transitions still require two real message IDs, and non-mutual multi-stage jumps remain rejected.

- [ ] **Step 2: Add failing phase-graph tests**

Add cases proving:

```js
normal -> repair is rejected;
normal -> cooling is rejected;
normal -> conflict is accepted at 0.80 with two sources;
conflict -> normal is rejected;
conflict -> repair is accepted;
conflict -> cooling is accepted;
cooling -> repair is accepted;
repair -> normal is accepted;
```

Also test that an explicit acknowledged transition may use one real source at confidence `0.78`.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
node --test yuqi-runtime/test/relationship-stage.test.mjs
```

Expected: failures on graded thresholds, committed explicitness, and illegal phase transitions.

- [ ] **Step 4: Implement pure policy helpers**

Add:

```js
function baseConfidenceThreshold(currentId, targetId, ids) { /* 0.78/0.80/0.84/0.88 */ }
function phaseTransitionAllowed(currentId, targetId) { /* approved directed graph */ }
```

Use these helpers inside `resolveBase` and `resolvePhase`. Entering `committed` additionally requires `explicitMutualChange === true`. Use `0.78` for explicitly acknowledged phase changes and `0.80` otherwise.

- [ ] **Step 5: Run focused tests and verify pass**

Run the same `node --test` command. Expected: all relationship-stage tests pass.

### Task 4: Run regression gates and prepare version 1.0.93

**Files:**
- Modify: `android/app/build.gradle`
- Modify only if required by generated sync: Android web assets under `android/app/src/main/assets/public/`

**Interfaces:**
- Consumes: tested web/runtime source and generated preset bundle.
- Produces: Android version code `93`, version name `1.0.93`, synchronized web assets.

- [ ] **Step 1: Run targeted combined tests**

Run:

```powershell
node --test tests/yuqi-ui-contract.test.mjs tests/rp-preset-contract.test.mjs
node --test yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs
```

Expected: all tests pass.

- [ ] **Step 2: Run the full project test suite**

Run:

```powershell
npm.cmd test
```

Expected: exit code 0.

- [ ] **Step 3: Bump Android defaults**

Change:

```gradle
versionCode Integer.parseInt(System.getenv("AL_VERSION_CODE") ?: "93")
versionName System.getenv("AL_VERSION_NAME") ?: "1.0.93"
```

- [ ] **Step 4: Synchronize Capacitor Android assets**

Run:

```powershell
npm.cmd run android:sync
```

Expected: current `tavern-app` files are copied into Android assets and Gradle sync succeeds.

### Task 5: Build and verify the signed update APK

**Files:**
- Create: `artifacts/AL-1.0.93-release.apk`

**Interfaces:**
- Consumes: established `ANDROID_KEYSTORE_*` environment and Android Gradle project.
- Produces: signed, update-compatible `com.siyi.al` APK.

- [ ] **Step 1: Run Android unit tests and release build**

Run with the established signing environment:

```powershell
android\gradlew.bat testDebugUnitTest assembleRelease --no-daemon --no-problems-report
```

Expected: `BUILD SUCCESSFUL` and a signed release APK.

- [ ] **Step 2: Copy the release artifact**

Copy `android/app/build/outputs/apk/release/app-release.apk` to `artifacts/AL-1.0.93-release.apk`.

- [ ] **Step 3: Verify package metadata**

Use Android build-tools `aapt.exe dump badging`. Expected:

```text
package: name='com.siyi.al' versionCode='93' versionName='1.0.93'
```

- [ ] **Step 4: Verify signing continuity**

Use `apksigner.bat verify --verbose --print-certs` on both `AL-1.0.92-release.apk` and `AL-1.0.93-release.apk`. Their signer certificate SHA-256 digests must match exactly.

- [ ] **Step 5: Record checksum and commit scoped changes**

Calculate SHA-256 for `artifacts/AL-1.0.93-release.apk`. Stage and commit only files changed by this plan; do not include unrelated deletions or untracked user files.
