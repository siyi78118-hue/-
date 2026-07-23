import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const androidBuild = readFileSync('android/app/build.gradle', 'utf8');
const androidWorkflow = readFileSync('.github/workflows/android-apk.yml', 'utf8');

test('release builds remain unsigned when the formal keystore is unavailable', () => {
  assert.match(
    androidBuild,
    /release\s*\{\s*if\s*\(System\.getenv\("ANDROID_KEYSTORE_PATH"\)\)\s*\{\s*signingConfig\s+signingConfigs\.release/
  );
});

test('formal signing uses the explicit Android release version instead of the workflow run number', () => {
  assert.match(androidBuild, /AL_VERSION_CODE"\) \?: "88"/);
  assert.match(androidBuild, /AL_VERSION_NAME"\) \?: "1\.0\.88"/);
  assert.match(androidWorkflow, /AL_RELEASE_VERSION_CODE:\s*88/);
  assert.match(androidWorkflow, /AL_RELEASE_VERSION_NAME:\s*1\.0\.88/);
  assert.doesNotMatch(androidWorkflow, /github\.run_number/);
});
