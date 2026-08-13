# Yuqi Owner Preview 2.1.1 Implementation Plan

> **Execution rule:** implement each task with a failing test first, make only the smallest production change, rerun the focused gate, and commit that task before continuing. Preserve all unrelated worktree changes.

**Goal:** Deliver a formally signed `1.0.109` overlay-install Android preview in which only `DIRECT_REPLY` uses preset `2.1.1` and the approved Sol model profile, while all existing chat history and long-term memory remain intact and the candidate can automatically or manually fall back to stable.

**Architecture:** Keep the existing release-pair and canary machinery as the only runtime authority. Add a narrowly-scoped `owner_preview_v1` evidence class and a dedicated transactional promotion entry point for `DIRECT_REPLY`; never mutate rollout rows with ad-hoc SQL. Resolve every v3 model call from the pinned release row. Activate only after a verified database snapshot and a successful full dry run on a clone. Build 1.0.109 from the current Android/Web source and deliver it only with the existing formal certificate.

**Stack:** Node.js ESM, `node:test`, SQLite via `node:sqlite`, Android Java/Room/Gradle, Capacitor WebView, GitHub Actions formal signing.

---

## Task 1: Freeze the release-owned model profile

**Files:**
- Create: `yuqi-runtime/src/release-model-profile.mjs`
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/src/quality-replay-production-bridge.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`
- Modify: `yuqi-runtime/test/quality-replay-production-bridge.test.mjs`

### Step 1: Write the failing profile-contract tests

Add tests that call `runV3ReleaseDraft()` with the candidate release profile:

```js
{
  cognitionFast: 'gpt-5.6-sol/medium',
  cognitionDeep: 'gpt-5.6-sol/xhigh',
  expression: 'gpt-5.6-sol/medium',
  supervisor: 'gpt-5.6-sol/medium'
}
```

Assert the first cognition call uses Sol/medium, an actual deep escalation uses Sol/xhigh, and expression uses Sol/medium. Assert the supervisor compatibility field is validated but does not create an extra ordinary model call. Add rejection cases for missing keys, unknown keys, whitespace, non-string values, an unsupported model, and an unsupported effort.

### Step 2: Run the red test

Run:

```powershell
node --test yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs
```

Expected: FAIL because production still uses hard-coded fast/deep/expression options.

### Step 3: Implement the closed resolver

Extract the existing quality-lane parser into one pure shared module, then make both the quality bridge and production cognitive pipeline consume it. The resolver:

- requires exactly four profile keys;
- parses exact `model/effort` strings without coercion or trimming;
- accepts only the current closed production model set (`gpt-5.6-sol|gpt-5.6-terra`) and Codex efforts already supported by the release runtime (`none|low|medium|high|xhigh|max`);
- returns immutable `{ model, effort }` records;
- is invoked before any model call;
- receives `release.modelProfile` from `runV3ReleaseDraft()` and supplies fast, deep and expression options to `runCognitionV3Turn()`.

Keep direct test calls that do not represent a release explicit: either pass a fixture profile or use an existing legacy-only default at the outer compatibility boundary. A persisted v3 release must never silently fall back to source defaults. The owner-preview validator in Task 2 separately requires the exact all-Sol profile approved for this preview; the generic parser must continue to load historical stable/quality releases without rewriting them.

### Step 4: Run focused tests

Run the command from Step 2. Expected: PASS.

### Step 5: Commit

Commit only the files above with message:

```text
feat: pin Yuqi v3 calls to release model profile
```

---

## Task 2: Add the owner-preview evidence contract and promotion transaction

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/promotion-controller.mjs`
- Modify: `yuqi-runtime/test/promotion-controller.test.mjs`
- Create: `yuqi-runtime/test/owner-preview-rollout.test.mjs`

### Step 1: Write failing owner-preview authority tests

Create a real temporary SQLite store, initialize all ten rollout kinds, create an exact preset-2.1.1 candidate release, materialize a `promotion_snapshot` report, and test:

1. `DIRECT_REPLY` shadow can enter active/canary with `evidenceClass=owner_preview_v1`.
2. The other nine rollout rows are byte/deep unchanged.
3. The visible release is the candidate and comparison release is stable for the first ten subjects.
4. The ordinary `promoteCognitionCandidateInternal()` rejects this report even if fake live-shadow counts/timestamps are injected.
5. The preview method rejects every non-`DIRECT_REPLY` kind.
6. It rejects wrong preset/model/scope/source head/authorization/report checksum/candidate release.
7. Exact replay is idempotent; stale revision is zero-write conflict.
8. Existing rollback returns new direct turns to stable without changing already pinned turns.

The report summary must be closed and include:

```js
{
  eligible: true,
  evidenceClass: 'owner_preview_v1',
  internalPreview: true,
  authorizedBy: 'owner',
  authorizationId,
  authorizedAt,
  sourceHead,
  rolloutScope: ['DIRECT_REPLY'],
  stableBaselineReleaseId,
  stableBaselineReleaseChecksum,
  candidateRelease,
  evaluatorVersion: 'lived-quality-supervisor-v3',
  suiteChecksum,
  presetVersion: '2.1.1',
  modelProfile: { ...exact approved profile }
}
```

### Step 2: Run the red test

```powershell
node --test yuqi-runtime/test/owner-preview-rollout.test.mjs yuqi-runtime/test/promotion-controller.test.mjs
```

Expected: FAIL because no preview entry point exists and formal promotion still accepts any eligible promotion snapshot.

### Step 3: Implement store-owned preview validation

In `store.mjs`:

- add a closed validator for the exact `owner_preview_v1` report summary;
- reject that evidence class from `promoteCognitionCandidateInternal()` and graduation as formal evidence;
- add `promoteCognitionOwnerPreviewInternal()` as one immediate transaction;
- require `DIRECT_REPLY`, shadow phase, exact revision/report/checksum/release/preset/model profile/source head/authorization;
- update only that rollout to existing active/canary state, increment canary epoch, reset counts, set first-ten canary comparison authority, and append one promotion-history event with reason `owner_preview_started`;
- do not insert synthetic shadow runs or promotion counts.

In `promotion-controller.mjs`, expose `startOwnerPreview(input)` and keep all later failure/backlog/deadline rollback paths on the existing controller.

### Step 4: Run focused tests

Run Step 2. Expected: PASS.

### Step 5: Run adjacent rollout tests

```powershell
node --test yuqi-runtime/test/release-pair.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/owner-preview-rollout.test.mjs
```

Expected: PASS.

### Step 6: Commit

```text
feat: add direct-reply owner preview rollout
```

---

## Task 3: Build the preset-2.1.1 candidate and verified activation tool

**Files:**
- Create: `scripts/activate-yuqi-owner-preview.mjs`
- Create: `tests/yuqi-owner-preview-activation.test.mjs`
- Modify: `.gitignore`
- Reuse: `scripts/backup-yuqi-memory.mjs`
- Reuse: `yuqi-runtime/src/preset-registry.mjs`

### Step 1: Write failing activation tests

Use temporary databases and fixtures; never use the formal DB in tests. Cover:

- creation of the exact candidate release (`yuqi-lived-agency-v3`, preset `2.1.1`, schemas 3/3, supervisor v3, approved model profile);
- deterministic release ID/checksum and materialized report ID/checksum;
- runtime-not-stopped rejection;
- verified backup before any source mutation;
- clone migration/seed/register/promote/reopen succeeds before the source DB is opened for write;
- message and fact counts plus ordered row SHA-256 remain identical on the clone;
- source DB fingerprint change between snapshot and activation aborts with zero rollout mutation;
- exact rerun is idempotent;
- activation receipt contains no secret/config token and records database before/after hash, backup path/hash, source head, report/release/rollout revisions and the nine unchanged rollout checksums;
- failure at each pre-source boundary leaves the source file byte-identical;
- a production failure restores the pre-activation backup and reports the restore hash instead of continuing.

### Step 2: Run the red test

```powershell
node --test tests/yuqi-owner-preview-activation.test.mjs
```

Expected: FAIL because the tool does not exist.

### Step 3: Implement a library-first activation module

Export pure/testable functions and place CLI parsing under an `isMain` guard. The real sequence is:

1. require explicit DB, project root, authorization ID/time and output directory;
2. verify runtime is stopped using the configured port/PID authority;
3. checkpoint SQLite and create a verified `VACUUM INTO` backup using the existing backup module;
4. record source main/WAL/SHM hashes and database logical manifest;
5. create a second temporary clone from the verified backup;
6. open the clone with current `YuqiStore`, seed preset 2.1.1, create/materialize/register/promote, close and reopen;
7. compare messages/facts whole-row ordered hashes and all non-direct rollout rows;
8. recheck source fingerprints;
9. apply the identical deterministic operation to the formal DB;
10. reopen, validate and write a redacted JSON receipt atomically;
11. delete temporary clones in `finally`, preserving the verified backup and receipt.

Never read the pairing secret into logs or the receipt. Never start the runtime or install the APK from this tool.

### Step 4: Run the focused test

Run Step 2. Expected: PASS.

### Step 5: Run memory and migration regressions

```powershell
node --test tests/yuqi-memory-backup.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs tests/yuqi-owner-preview-activation.test.mjs
```

Expected: PASS.

### Step 6: Commit

```text
feat: add verified Yuqi owner preview activation
```

---

## Task 4: Synchronize Android/Web version 1.0.109

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `android-update.json`
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/sw-v11.js`
- Modify: `test-basic.mjs`
- Modify: `tests/android-unsigned-release-contract.test.mjs`
- Modify: any checked-in release manifest contract that explicitly represents the current delivery channel, not historical artifacts/baselines

### Step 1: Write/update the failing version contract

Require all live version authorities to agree on code `109` and name `1.0.109`, Web build `2026-08-13.109`, and Service Worker cache `rpchat-v109`. Historical baseline files must remain unchanged.

### Step 2: Run the red gate

```powershell
node --test test-basic.mjs tests/android-unsigned-release-contract.test.mjs
```

Expected: FAIL on 108/old cache values.

### Step 3: Update only current release authorities

Change Gradle defaults, workflow environment, update manifest, Web build and cache. Do not edit package ID, signing configuration, database downgrade policy, archived 1.0.108 evidence or stable-runtime sources.

### Step 4: Run the focused gate

Run Step 2. Expected: PASS.

### Step 5: Commit

```text
chore: prepare Android 1.0.109 owner preview
```

---

## Task 5: Full source verification and unsigned build

**Files:** no production changes unless a real regression is found through TDD.

### Step 1: Run the complete Node gate

```powershell
npm.cmd test
```

Expected: all product tests pass. If unrelated quality-infrastructure failures remain from the known baseline, capture exact before/after evidence and do not relabel them as owner-preview failures.

### Step 2: Run Android unit/instrumentation compilation

With an exclusive Gradle lock:

```powershell
android\gradlew.bat :app:testDebugUnitTest :app:assembleDebugAndroidTest :app:assembleRelease --no-daemon --no-problems-report
```

Expected: BUILD SUCCESSFUL. If the restricted sandbox produces the known Gradle `classes.jar AccessDenied`, rerun once in the approved local execution mode and record both outcomes.

### Step 3: Device gate

Run:

```powershell
adb devices -l
```

If no device is connected, record `connectedDebugAndroidTest` and overlay-install/data-retention as unfulfilled hard gates. Do not call them skipped or passed.

### Step 4: Check worktree boundaries

Run `git diff --check` and confirm every task commit contains only its named files.

---

## Task 6: Activate the formal PC owner preview

**Files/data:**
- Formal DB: `C:\Users\PC\Documents\虞栖AL记忆库备份\database\yuqi-runtime.sqlite`
- Backup/receipt: project `artifacts/owner-preview/` plus the existing external backup location

### Step 1: Re-read deployment-time baseline

Record current DB user version, role-message count, fact count, ordered hashes, all rollout rows and source/WAL/SHM hashes. Counts may be greater than the design-time `1649/1086`; the deployment-time values are authoritative.

### Step 2: Run activation in dry-run clone mode

Execute the activation CLI with `--dry-run`. Require exact success, reopen stability, identical messages/facts and only the expected direct rollout delta.

### Step 3: Run formal activation

Execute without `--dry-run`, using the same authorization identity and source HEAD. Reopen the formal DB and verify:

- exact message/fact hashes;
- preset 2.1.1 exists;
- exact candidate release/report exist;
- DIRECT_REPLY is active/canary;
- other nine rollout rows match pre-activation checksums;
- no fake shadow/live counts were inserted.

### Step 4: Start runtime and check health

Recreate only the ignored runtime config from the existing pairing bundle without logging secrets. Start with the existing background script. Verify port/health/rollout status and that no proactive/cloud jobs were silently re-enabled.

If any check fails, stop runtime, restore the verified backup, reopen/rehash, and report the rollback receipt.

---

## Task 7: Formal signing and overlay-install delivery

**Files:** follow `docs/AL-android-signing-runbook.md`; do not add secrets to Git.

### Step 1: Trigger the formal build

Commit all verified work, push the exact source commit and trigger the existing formal GitHub workflow using the configured local GitHub credentials/API path.

### Step 2: Download and verify artifact

Verify:

- package `com.siyi.al`;
- versionCode `109`;
- versionName `1.0.109`;
- APK signature validity;
- signer SHA-256 exactly equals formal 1.0.108 signer SHA-256;
- APK SHA-256;
- workflow source commit equals the tested commit.

Archive under `artifacts/` and do not overwrite historical installers.

### Step 3: Overlay-install gate

With a connected device:

1. record installed package/version/cert and Web visible chat counts;
2. make a device-safe app-data/Room status backup if supported;
3. install with replacement semantics only (`adb install -r` or user-controlled package installer); never uninstall;
4. confirm app data, old chats, role, memories, plans and moments remain visible;
5. let the startup history sync finish before sending a new message;
6. verify no duplicate old messages and original timestamps remain;
7. send one controlled DIRECT_REPLY and confirm candidate release/model profile/preset 2.1.1, one visible output, and one stable dry-run compare;
8. verify every non-direct kind still resolves stable.

If no device is available, deliver the signed APK with an explicit “not yet overlay-installed or device-verified” status.

### Step 4: Final handoff

Provide the APK path, hashes, signer identity, activation receipt, backup path, rollout status, exact passed gates, any unfulfilled device gate, and one-command/manual rollback instructions. Do not mention or explain the one-week conversation gap in Yuqi prompts or generated memory.
