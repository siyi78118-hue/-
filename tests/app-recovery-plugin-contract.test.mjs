import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pluginPath = new URL(
  '../android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java',
  import.meta.url,
);

test('Android plugin exposes only explicit app recovery read APIs', async () => {
  const source = await readFile(pluginPath, 'utf8');
  for (const method of [
    'inspectAppRecoveryState',
    'readAppRecoveryRoleCandidate',
    'readAppRecoveryMessages',
  ]) {
    assert.match(source, new RegExp(`@PluginMethod\\s+public void ${method}\\(PluginCall call\\)`));
  }
  assert.match(source, /databaseBytes/);
  assert.match(source, /walBytes/);
  assert.match(source, /shmBytes/);
});
