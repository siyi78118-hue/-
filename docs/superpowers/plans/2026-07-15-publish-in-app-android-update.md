# AL In-App Android Update Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the automatic-task-cleanup fix through AL's existing signed Android update channel so installed users can discover and install it from “检查更新”.

**Architecture:** Fast-forward the already-tested `codex/al-tdd` commit chain to `main`. The existing GitHub Actions workflow performs tests, restores the stable signing key, builds the release APK, creates a GitHub Release, and atomically advances the `update-channel` manifest only after preceding steps succeed.

**Tech Stack:** Git, GitHub Actions, GitHub CLI, Gradle, Capacitor, Android APK signing, GitHub Releases.

## Global Constraints

- Keep Android application ID `com.siyi.al` unchanged.
- Keep the existing stable release signing identity and GitHub Secrets unchanged.
- Keep the update manifest on the `update-channel` branch and the download on GitHub Releases.
- Publish a build greater than the current live `latestBuild: 13`.
- Do not stage, commit, or push unrelated working-tree deletions and untracked files.
- Do not publish the locally built debug-signed APK to the production update channel.

---

### Task 1: Preflight and Publish the Exact Commit Chain

**Files:**
- Review: `.github/workflows/android-apk.yml`
- Review: `android/app/build.gradle`
- Review: `tavern-app/index.html`
- Review: `test-basic.mjs`

**Interfaces:**
- Consumes: local commit `54bbd27` and its ancestors containing the cleanup feature, tests, version defaults, and approved design.
- Produces: `origin/main` pointing at the exact reviewed local HEAD, which triggers the signed Android publication workflow.

- [ ] **Step 1: Verify local tests and the publish diff**

Run:

```powershell
npm test
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: all JavaScript tests pass; diff check reports no errors; the log contains only the approved cleanup design, implementation, Android version, and update-publication documents.

- [ ] **Step 2: Verify GitHub authentication and current remote main**

Run:

```powershell
& 'C:\Users\Administrator\Tools\bin\gh.exe' auth status
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
```

Expected: GitHub authentication succeeds and `origin/main` is an ancestor of `HEAD`, so publication is a fast-forward without rewriting history.

- [ ] **Step 3: Push the exact reviewed HEAD to main**

Run:

```powershell
git push origin HEAD:main
```

Expected: Git reports a fast-forward update of `main`; no working-tree-only files are transferred because Git pushes commits, not unstaged files.

### Task 2: Monitor the Signed Build and Verify the Live Update Channel

**Files:**
- Read after publication: `.github/workflows/android-apk.yml`
- Read remotely after publication: `update-channel/android-update.json`

**Interfaces:**
- Consumes: the GitHub Actions run triggered by Task 1.
- Produces: a successful signed release, a public `app-release.apk`, and a live manifest consumed by `fetchLatestAndroidRelease()`.

- [ ] **Step 1: Locate and monitor the workflow run**

Run:

```powershell
$gh = 'C:\Users\Administrator\Tools\bin\gh.exe'
& $gh run list --repo siyi78118-hue/- --workflow android-apk.yml --branch main --limit 3
$runId = & $gh run list --repo siyi78118-hue/- --workflow android-apk.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId'
& $gh run watch $runId --repo siyi78118-hue/- --exit-status
```

Expected: `Build Android APK` completes successfully, including JavaScript tests, Android tests, signature verification, Release creation, and update-manifest publication.

- [ ] **Step 2: Read and validate the authoritative update manifest**

Run:

```powershell
$gh = 'C:\Users\Administrator\Tools\bin\gh.exe'
$manifestText = & $gh api -H 'Accept: application/vnd.github.raw+json' 'repos/siyi78118-hue/-/contents/android-update.json?ref=update-channel'
$manifest = $manifestText | ConvertFrom-Json
$manifest | ConvertTo-Json
if ($manifest.latestBuild -le 13) { throw 'Published build did not advance past 13.' }
if ($manifest.version -ne "1.0.$($manifest.latestBuild)") { throw 'Manifest version does not match latestBuild.' }
if ($manifest.releaseUrl -notmatch "/android-v$($manifest.latestBuild)/app-release\.apk$") { throw 'Manifest releaseUrl does not match latestBuild.' }
```

Expected: valid JSON with `latestBuild > 13`; `version` equals `1.0.` followed by that build number; `releaseUrl` uses the same build number in its `android-v` tag and ends in `/app-release.apk`.

- [ ] **Step 3: Verify the Release and APK are publicly addressable**

Run:

```powershell
$gh = 'C:\Users\Administrator\Tools\bin\gh.exe'
$manifestText = & $gh api -H 'Accept: application/vnd.github.raw+json' 'repos/siyi78118-hue/-/contents/android-update.json?ref=update-channel'
$manifest = $manifestText | ConvertFrom-Json
$tag = "android-v$($manifest.latestBuild)"
& $gh release view $tag --repo siyi78118-hue/- --json tagName,isLatest,url,assets
```

Expected: the tag matches the manifest, `isLatest` is true, and assets include `app-release.apk` plus the compatibility APK.

- [ ] **Step 4: Verify application-side update comparison**

Run:

```powershell
npm test
```

Expected: update-checker assertions pass and the published `latestBuild` is greater than the installed `1.0.13` build, so AL opens the manifest's release URL after the user confirms the update prompt.
