# AL Android 1.0.80 Official Signing Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign the verified unsigned AL 1.0.80 APK with the existing official AL key and publish it through the in-app Android update channel.

**Architecture:** Reuse the existing manually dispatched external-APK release workflow, but lock every source identity and release path to build 80. Transfer the unsigned source through a temporary Git branch, restore the official PKCS12 key only after source validation, and publish the signed APK to GitHub Release with an `update-channel` fallback.

**Tech Stack:** PowerShell 7, Node.js test runner, GitHub Actions, Android `aapt`/`zipalign`/`apksigner`, GitHub CLI, Git.

## Global Constraints

- Source package must be `com.siyi.al`, versionCode `80`, versionName `1.0.80`.
- Source SHA-256 must be `9AC694FB4858B999927218CE23D2ADB4C16D516A321634DC535E323F337A7139`.
- Source APK must be unsigned and ZIP-valid.
- Target signer SHA-256 must be `5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B`.
- Target APK must verify with APK Signature Scheme v2 and v3.
- Non-`META-INF/` ZIP entry names and contents must remain unchanged.
- Do not modify AL feature code or unrelated dirty-worktree files.
- Do not expose or export any GitHub Actions signing secret.

---

### Task 1: Lock the release contract to the unsigned 1.0.80 source

**Files:**
- Modify: `tests/external-apk-release-workflow.test.mjs`
- Test: `tests/external-apk-release-workflow.test.mjs`

**Interfaces:**
- Consumes: the YAML text at `.github/workflows/publish-external-android-apk.yml`.
- Produces: contract assertions that define the only acceptable 1.0.80 source, official signer, and release paths.

- [ ] **Step 1: Replace the 1.0.74 identity assertion with the 1.0.80 contract**

Replace the existing identity test with:

```js
test('工作流锁定未签名 1.0.80 的身份、原始哈希和正式证书', () => {
  assert.match(workflow, /EXPECTED_PACKAGE:\s*com\.siyi\.al/);
  assert.match(workflow, /EXPECTED_VERSION_CODE:\s*["']?80["']?/);
  assert.match(workflow, /EXPECTED_VERSION_NAME:\s*["']?1\.0\.80["']?/);
  assert.match(workflow, /9AC694FB4858B999927218CE23D2ADB4C16D516A321634DC535E323F337A7139/i);
  assert.match(workflow, /5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B/i);
  assert.doesNotMatch(workflow, /EXPECTED_SOURCE_SIGNER_SHA256/);
});
```

- [ ] **Step 2: Add an unsigned-source validation assertion**

Add:

```js
test('工作流在恢复正式密钥前验证 ZIP 并拒绝已签名源包', () => {
  assertOrdered(
    'name: Validate source APK',
    'name: Restore stable Android signing key'
  );
  assert.match(workflow, /unzip -tqq input\/source\.apk/);
  assert.match(workflow, /if "\$APKSIGNER" verify input\/source\.apk/);
  assert.match(workflow, /source APK must be unsigned/i);
});
```

- [ ] **Step 3: Change release and temporary-path assertions to v80**

Update the fallback assertions to require:

```js
assert.match(workflow, /codex\/android-v80-source/);
assert.match(workflow, /android-v80-source-20260721/);
assert.match(workflow, /update-channel-repo\/app-release-v80\.apk/);
assert.match(workflow, /app-release-v80\.apk/);
```

Also rename the old identity test text so it no longer claims the workflow is for 1.0.74.

- [ ] **Step 4: Run the contract test and verify RED**

Run:

```powershell
node --test tests/external-apk-release-workflow.test.mjs
```

Expected: FAIL because the production workflow still contains version `74`, the 1.0.74 SHA-256, the old temporary refs, and source-signer validation.

---

### Task 2: Update the guarded signing workflow to build 80

**Files:**
- Modify: `.github/workflows/publish-external-android-apk.yml`
- Test: `tests/external-apk-release-workflow.test.mjs`

**Interfaces:**
- Consumes: workflow-dispatch inputs `source_tag`, `source_ref`, `version_code`, and `source_sha256`.
- Produces: `android-v80/app-release.apk` or `update-channel/app-release-v80.apk`, followed by build-80 `android-update.json`.

- [ ] **Step 1: Replace the fixed 1.0.74 identity values**

Set the job environment to:

```yaml
env:
  EXPECTED_PACKAGE: com.siyi.al
  EXPECTED_VERSION_CODE: "80"
  EXPECTED_VERSION_NAME: "1.0.80"
  EXPECTED_SOURCE_SHA256: 9AC694FB4858B999927218CE23D2ADB4C16D516A321634DC535E323F337A7139
  EXPECTED_TARGET_SIGNER_SHA256: 5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B
  GH_TOKEN: ${{ github.token }}
```

Remove `EXPECTED_SOURCE_SIGNER_SHA256`.

- [ ] **Step 2: Replace the fixed temporary-source gate**

The request-validation commands must be:

```bash
test "$SOURCE_TAG" = "android-v80-source-20260721"
test "$SOURCE_REF" = "codex/android-v80-source"
test "$VERSION_CODE" = "$EXPECTED_VERSION_CODE"
test "$(printf '%s' "$SOURCE_SHA256" | tr '[:lower:]' '[:upper:]')" = "$EXPECTED_SOURCE_SHA256"
```

Keep the existing update-channel version floor check so build 80 cannot overwrite build 80 or a newer build.

- [ ] **Step 3: Validate an unsigned source without restoring the key**

In `Validate source APK`, keep the Android build-tools discovery, SHA-256 check, and `aapt dump badging` identity check. Replace source-certificate verification with:

```bash
unzip -tqq input/source.apk
if "$APKSIGNER" verify input/source.apk >/dev/null 2>&1; then
  echo "source APK must be unsigned" >&2
  exit 1
fi
```

This step must remain before `Restore stable Android signing key`.

- [ ] **Step 4: Update all version-specific release paths and notes**

Use:

```bash
cp output/app-release.apk update-channel-repo/app-release-v80.apk
```

The raw fallback URL must be:

```bash
https://raw.githubusercontent.com/${{ github.repository }}/update-channel/app-release-v80.apk
```

Update the release description to state that the verified unsigned 1.0.80 APK was signed with the existing official AL certificate. Keep the Release asset name `app-release.apk` and tag computation `android-v$EXPECTED_VERSION_CODE`.

- [ ] **Step 5: Update cleanup inputs to the v80 temporary resources**

Keep the existing successful-run cleanup commands:

```bash
gh release delete "$SOURCE_TAG" --repo '${{ github.repository }}' --cleanup-tag --yes || true
gh api --method DELETE "repos/${{ github.repository }}/git/refs/heads/$SOURCE_REF" || true
```

They now receive `android-v80-source-20260721` and `codex/android-v80-source` from the fixed dispatch inputs.

- [ ] **Step 6: Run the contract test and verify GREEN**

Run:

```powershell
node --test tests/external-apk-release-workflow.test.mjs
git diff --check -- .github/workflows/publish-external-android-apk.yml tests/external-apk-release-workflow.test.mjs
```

Expected: all tests PASS and `git diff --check` emits no error.

- [ ] **Step 7: Commit only workflow and contract-test files**

```powershell
git add -- .github/workflows/publish-external-android-apk.yml tests/external-apk-release-workflow.test.mjs
git commit -m "ci: publish unsigned Android 1.0.80"
```

Expected: exactly two files in the commit.

---

### Task 3: Safely append the workflow to remote main

**Files:**
- Read: `.git`
- No application source files changed.

**Interfaces:**
- Consumes: the tested local commit from Task 2.
- Produces: a fast-forward update of `origin/main` containing only the signing workflow and its test.

- [ ] **Step 1: Fetch main and verify no colleague commit would be overwritten**

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:10808'
$env:HTTP_PROXY='http://127.0.0.1:10808'
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
```

Expected: exit code `0`. If it is not `0`, stop and integrate the new remote commits without resetting unrelated local changes.

- [ ] **Step 2: Push the tested commit by fast-forward**

```powershell
git push origin HEAD:main
```

Expected: `main` advances to the Task 2 commit without force-push.

- [ ] **Step 3: Verify GitHub recognizes the workflow YAML**

```powershell
gh workflow view publish-external-android-apk.yml --repo siyi78118-hue/- --ref main --yaml
```

Expected: YAML output includes `EXPECTED_VERSION_CODE: "80"` and `EXPECTED_VERSION_NAME: "1.0.80"`.

---

### Task 4: Stage the verified unsigned APK on a temporary branch

**Files:**
- Read: `C:\Users\Administrator\Documents\xwechat_files\wxid_ytlnpjzkk8zj22_1e42\msg\file\2026-07\AL-1.0.80-unsigned.apk.1`
- Temporary Git path: `source.apk` on branch `codex/android-v80-source`

**Interfaces:**
- Consumes: the exact unsigned APK with the Global Constraints SHA-256.
- Produces: temporary commit/ref readable by `actions/checkout@v4`.

- [ ] **Step 1: Recalculate the source hash immediately before staging**

```powershell
$source='C:\Users\Administrator\Documents\xwechat_files\wxid_ytlnpjzkk8zj22_1e42\msg\file\2026-07\AL-1.0.80-unsigned.apk.1'
(Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
```

Expected: `9AC694FB4858B999927218CE23D2ADB4C16D516A321634DC535E323F337A7139`.

- [ ] **Step 2: Create a temporary commit without touching the dirty worktree**

Use a temporary index:

```powershell
$index=Join-Path $env:TEMP 'al-v80-source.index'
$env:GIT_INDEX_FILE=$index
git read-tree origin/main
$blob=(git hash-object -w -- $source).Trim()
git update-index --add --cacheinfo "100644,$blob,source.apk"
$tree=(git write-tree).Trim()
$commit=("Stage verified unsigned AL 1.0.80 APK`n" | git commit-tree $tree -p origin/main).Trim()
Remove-Item Env:GIT_INDEX_FILE
Remove-Item -LiteralPath $index -Force
```

Expected: the normal working tree and its index remain unchanged.

- [ ] **Step 3: Push only the temporary source ref**

```powershell
git push origin "${commit}:refs/heads/codex/android-v80-source"
```

Expected: a new temporary branch is created; it is not merged into `main`.

---

### Task 5: Trigger and monitor official signing

**Files:**
- Temporary local auth directory: `%TEMP%\al-gh-auth` only when the normal GitHub CLI token is unavailable.

**Interfaces:**
- Consumes: GitHub Actions Secrets and temporary source ref.
- Produces: an Actions run that validates, signs, and publishes build 80.

- [ ] **Step 1: Confirm GitHub CLI authentication**

```powershell
gh api user --jq '.login'
```

Expected: `siyi78118-hue`.

If the normal token is unavailable, use the previously approved temporary-auth pattern: set `GH_CONFIG_DIR` to `%TEMP%\al-gh-auth`, authenticate with `--insecure-storage` through the local proxy, use it only for this release, then delete it in Task 6.

- [ ] **Step 2: Dispatch the fixed build-80 workflow**

```powershell
gh workflow run publish-external-android-apk.yml --repo siyi78118-hue/- --ref main `
  -f source_tag=android-v80-source-20260721 `
  -f source_ref=codex/android-v80-source `
  -f version_code=80 `
  -f source_sha256=9AC694FB4858B999927218CE23D2ADB4C16D516A321634DC535E323F337A7139
```

If `gh workflow run` is blocked by a transient workflow-metadata 5xx, submit the identical JSON body directly to the workflow-dispatch endpoint and stop retrying immediately after HTTP 204.

- [ ] **Step 3: Monitor the unique run to completion**

```powershell
gh run list --repo siyi78118-hue/- --workflow publish-external-android-apk.yml --limit 3 `
  --json databaseId,number,status,conclusion,headSha,url
```

Then:

```powershell
$headSha=(git rev-parse HEAD).Trim()
$runs=gh run list --repo siyi78118-hue/- --workflow publish-external-android-apk.yml --limit 3 `
  --json databaseId,number,status,conclusion,headSha,url | ConvertFrom-Json
$run=$runs | Where-Object headSha -eq $headSha | Sort-Object number -Descending | Select-Object -First 1
if(-not $run){ throw 'Build-80 workflow run was not created' }
gh run watch $run.databaseId --repo siyi78118-hue/- --exit-status --interval 10
```

Expected: `conclusion=success`. If it fails, read the exact failed-step log before changing code and add a failing contract test for any workflow defect.

---

### Task 6: Verify the online APK and clean temporary resources

**Files:**
- Temporary verification directory: `%TEMP%\al-v80-final-verify`
- Read: `update-channel/android-update.json`

**Interfaces:**
- Consumes: the published `android-v80` asset or update-channel fallback.
- Produces: independent proof of identity, signer, content equality, update visibility, and cleanup.

- [ ] **Step 1: Verify Release and update manifest metadata**

```powershell
gh api 'repos/siyi78118-hue/-/releases/latest' --jq '{tag_name,name,assets:[.assets[]|{name,size,digest,browser_download_url}]}'
gh api -H 'Accept: application/vnd.github.raw+json' 'repos/siyi78118-hue/-/contents/android-update.json?ref=update-channel'
```

Expected: latest tag `android-v80`; manifest `latestBuild: 80`, `version: 1.0.80`, and a URL that resolves to the verified build-80 APK.

- [ ] **Step 2: Download the final APK and verify package/signature**

```powershell
$verifyDir=Join-Path $env:TEMP 'al-v80-final-verify'
New-Item -ItemType Directory -Path $verifyDir -Force | Out-Null
gh release download android-v80 --repo siyi78118-hue/- --pattern app-release.apk --dir $verifyDir
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.1.0\aapt.exe" dump badging "$verifyDir\app-release.apk"
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.1.0\apksigner.bat" verify --verbose --print-certs "$verifyDir\app-release.apk"
```

Expected: `com.siyi.al`, build `80`, version `1.0.80`, v2/v3 true, signer SHA-256 `5761277e...e832b2b`.

- [ ] **Step 3: Independently compare non-signature payloads**

Run Python against the source and final APK:

```python
import hashlib
import os
import zipfile

def payload(path):
    with zipfile.ZipFile(path) as archive:
        return {
            name: hashlib.sha256(archive.read(name)).hexdigest()
            for name in archive.namelist()
            if not name.upper().startswith("META-INF/")
        }

source_apk = os.environ["AL_SOURCE_APK"]
final_apk = os.environ["AL_FINAL_APK"]
assert payload(source_apk) == payload(final_apk)
print(f"PAYLOAD_MATCH entries={len(payload(source_apk))}")
```

Before running the Python snippet, set:

```powershell
$env:AL_SOURCE_APK='C:\Users\Administrator\Documents\xwechat_files\wxid_ytlnpjzkk8zj22_1e42\msg\file\2026-07\AL-1.0.80-unsigned.apk.1'
$env:AL_FINAL_APK=(Join-Path $verifyDir 'app-release.apk')
```

Expected: assertion passes and the compared entry count is reported.

- [ ] **Step 4: Verify cloud cleanup**

Confirm both return not found:

```powershell
gh api 'repos/siyi78118-hue/-/git/ref/heads/codex/android-v80-source'
gh release view android-v80-source-20260721 --repo siyi78118-hue/- --json tagName
```

- [ ] **Step 5: Remove only release-specific local temporary data**

After verifying each resolved path is under `%TEMP%`, remove:

```powershell
%TEMP%\al-gh-auth
%TEMP%\al-v80-final-verify
%TEMP%\al-v80-source.index
```

Do not remove or reset any unrelated working-tree file.

- [ ] **Step 6: Final status report**

Report the Release URL, manifest version, final APK SHA-256, official signer SHA-256, v2/v3 status, payload-entry count, and successful temporary-resource cleanup.
