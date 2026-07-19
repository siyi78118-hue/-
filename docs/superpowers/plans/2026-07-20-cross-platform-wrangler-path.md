# Wrangler Cross-Platform Path Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Wrangler CLI path resolution deterministic for the requested target platform so GitHub can build a formally signed Android update.

**Architecture:** Keep `resolveWranglerInvocation(options)` as the sole path-selection boundary. Select `node:path.win32` or `node:path.posix` from the injected `platform`, then leave the existing local-CLI preference and fallback behavior unchanged.

**Tech Stack:** Node.js 22, ES modules, `node:test`, GitHub Actions, Android Gradle, Android `apksigner`.

## Global Constraints

- Do not modify chat, memory, character presets, UI, mobile data structures, or package name.
- Android package name remains exactly `com.siyi.al`.
- The deliverable APK version code must be greater than `68`.
- The deliverable signer SHA-256 must equal `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.
- Preserve the existing Wrangler command fallback behavior.

---

### Task 1: Make Wrangler Paths Follow the Target Platform

**Files:**
- Modify: `tests/yuqi-deployment-contract.test.mjs`
- Modify: `scripts/wrangler-invocation.mjs`

**Interfaces:**
- Consumes: `resolveWranglerInvocation(options)` with `cwd`, `platform`, `execPath`, `fileExists`, and `env`.
- Produces: `{ command: string, prefixArgs: string[], shell: boolean }` with separators matching `options.platform`.

- [ ] **Step 1: Add a host-independent POSIX path test**

```js
test('Wrangler uses POSIX paths when the requested platform is Linux', () => {
  const invocation = resolveWranglerInvocation({
    cwd: '/home/runner/work/al',
    platform: 'linux',
    execPath: '/usr/bin/node',
    fileExists: path => path === '/home/runner/work/al/node_modules/wrangler/bin/wrangler.js',
    env: {}
  });
  assert.equal(invocation.command, '/usr/bin/node');
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.prefixArgs, [
    '/home/runner/work/al/node_modules/wrangler/bin/wrangler.js'
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="Wrangler uses POSIX paths" tests/yuqi-deployment-contract.test.mjs`

Expected: FAIL because the current Windows host builds the injected Linux `cwd` with backslashes, so the provided POSIX `fileExists` predicate does not find the local CLI.

- [ ] **Step 3: Select a path implementation from the injected platform**

Replace the `node:path` import and local CLI construction with:

```js
import { posix, win32 } from 'node:path';

const pathApi = platform === 'win32' ? win32 : posix;
const localCli = pathApi.join(cwd, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
```

- [ ] **Step 4: Run the focused deployment contract tests and verify GREEN**

Run: `node --test tests/yuqi-deployment-contract.test.mjs`

Expected: all tests pass, including both the Windows path test and new Linux path test.

- [ ] **Step 5: Commit the isolated fix**

```bash
git add tests/yuqi-deployment-contract.test.mjs scripts/wrangler-invocation.mjs
git commit -m "fix: resolve Wrangler paths by target platform"
```

### Task 2: Verify the Complete Local Test Suite

**Files:**
- Verify only: `package.json`
- Verify only: all files selected by `npm test`

**Interfaces:**
- Consumes: the repository test scripts from `package.json`.
- Produces: a clean test result suitable for GitHub Actions.

- [ ] **Step 1: Run all JavaScript checks**

Run: `npm test`

Expected: exit code `0`, with no failed subtests.

- [ ] **Step 2: Confirm no unrelated files were staged**

Run: `git status --short`

Expected: the two Task 1 files are committed; pre-existing unrelated working-tree entries remain unstaged.

### Task 3: Build and Verify the Formally Signed APK

**Files:**
- Create locally after download: `artifacts/AL-1.0.70-formal-signed.apk`
- Verify: `.github/workflows/android-apk.yml`

**Interfaces:**
- Consumes: committed branch `codex/al-tdd` and encrypted GitHub Android signing secrets.
- Produces: an APK that can replace installed 1.0.68 without clearing its app data.

- [ ] **Step 1: Push committed changes**

Run: `git push origin codex/al-tdd`

Expected: GitHub starts `Build Android APK` run number `70` or later.

- [ ] **Step 2: Wait for the GitHub Actions run**

Query the Actions API for branch `codex/al-tdd` until the run for the fix commit is `completed` with conclusion `success`.

- [ ] **Step 3: Download the release APK artifact**

Download `app-release.apk` from the successful `AL-android-installers` artifact and save it as `artifacts/AL-1.0.<run>-formal-signed.apk`.

- [ ] **Step 4: Verify identity and signature**

Run Android build tools `aapt dump badging` and `apksigner verify --verbose --print-certs` against the downloaded APK.

Expected:

```text
package: name='com.siyi.al' versionCode='<run>' versionName='1.0.<run>'
Signer #1 certificate SHA-256 digest: 5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b
```

- [ ] **Step 5: Report safe installation instructions**

Tell the user to install the verified APK directly over 1.0.68 without uninstalling. Ask them to confirm the Settings version changed before testing chat.
