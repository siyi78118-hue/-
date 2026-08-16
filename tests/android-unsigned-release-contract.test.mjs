import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const androidBuild = readFileSync('android/app/build.gradle', 'utf8');
const androidWorkflow = readFileSync('.github/workflows/android-apk.yml', 'utf8');
const updateManifest = JSON.parse(readFileSync('android-update.json', 'utf8'));
const appHtml = readFileSync('tavern-app/index.html', 'utf8');
const serviceWorker = readFileSync('tavern-app/sw-v11.js', 'utf8');

test('release builds remain unsigned when the formal keystore is unavailable', () => {
  assert.match(
    androidBuild,
    /release\s*\{\s*if\s*\(System\.getenv\("ANDROID_KEYSTORE_PATH"\)\)\s*\{\s*signingConfig\s+signingConfigs\.release/
  );
});

test('formal signing uses the explicit Android release version instead of the workflow run number', () => {
  assert.match(androidBuild, /AL_VERSION_CODE"\) \?: "122"/);
  assert.match(androidBuild, /AL_VERSION_NAME"\) \?: "1\.0\.122"/);
  assert.match(androidWorkflow, /AL_RELEASE_VERSION_CODE:\s*122/);
  assert.match(androidWorkflow, /AL_RELEASE_VERSION_NAME:\s*1\.0\.122/);
  assert.doesNotMatch(androidWorkflow, /github\.run_number/);
});

test('the app shell and service worker are pinned to the complete 1.0.122 recovery build', () => {
  assert.match(appHtml, /const APP_BUILD_VERSION = '2026-08-16\.122';/);
  assert.match(serviceWorker, /const CACHE_NAME = 'rpchat-v122';/);
  assert.match(serviceWorker, /'\.\/lib\/complete-app-restoration\.js'/);
});

test('the signed branch build publishes an OTA manifest that names the real release asset', () => {
  assert.equal(updateManifest.latestBuild, 122);
  assert.equal(updateManifest.version, '1.0.122');
  assert.equal(
    updateManifest.releaseUrl,
    'https://github.com/siyi78118-hue/-/releases/download/android-v122/app-release.apk'
  );
  assert.match(
    androidWorkflow,
    /if:\s*github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/codex\/al-tdd'/
  );
  assert.match(androidWorkflow, /releases\/download\/android-v%s\/app-release\.apk/);
});
