import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const androidBuild = readFileSync('android/app/build.gradle', 'utf8');
const androidWorkflow = readFileSync('.github/workflows/android-apk.yml', 'utf8');
const updateManifest = JSON.parse(readFileSync('android-update.json', 'utf8'));

test('release builds remain unsigned when the formal keystore is unavailable', () => {
  assert.match(
    androidBuild,
    /release\s*\{\s*if\s*\(System\.getenv\("ANDROID_KEYSTORE_PATH"\)\)\s*\{\s*signingConfig\s+signingConfigs\.release/
  );
});

test('formal signing uses the explicit Android release version instead of the workflow run number', () => {
  assert.match(androidBuild, /AL_VERSION_CODE"\) \?: "108"/);
  assert.match(androidBuild, /AL_VERSION_NAME"\) \?: "1\.0\.108"/);
  assert.match(androidWorkflow, /AL_RELEASE_VERSION_CODE:\s*108/);
  assert.match(androidWorkflow, /AL_RELEASE_VERSION_NAME:\s*1\.0\.108/);
  assert.doesNotMatch(androidWorkflow, /github\.run_number/);
});

test('the signed branch build publishes an OTA manifest that names the real release asset', () => {
  assert.equal(updateManifest.latestBuild, 108);
  assert.equal(updateManifest.version, '1.0.108');
  assert.equal(
    updateManifest.releaseUrl,
    'https://github.com/siyi78118-hue/-/releases/download/android-v108/app-release.apk'
  );
  assert.match(
    androidWorkflow,
    /if:\s*github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/codex\/al-tdd'/
  );
  assert.match(androidWorkflow, /releases\/download\/android-v%s\/app-release\.apk/);
});
