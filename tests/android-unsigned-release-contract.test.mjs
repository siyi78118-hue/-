import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const androidBuild = readFileSync('android/app/build.gradle', 'utf8');

test('release builds remain unsigned when the formal keystore is unavailable', () => {
  assert.match(
    androidBuild,
    /release\s*\{\s*if\s*\(System\.getenv\("ANDROID_KEYSTORE_PATH"\)\)\s*\{\s*signingConfig\s+signingConfigs\.release/
  );
});
