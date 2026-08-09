import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimePath = new URL(
  '../android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java',
  import.meta.url,
);

function methodBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

test('Android runtime drains durable role-notification cancellations before ordinary work', async () => {
  const source = await readFile(runtimePath, 'utf8');
  const create = methodBody(source, 'static ExecutionEngine create(Context context)', 'static int drainCloudInbox');
  const cloud = methodBody(source, 'static int drainCloudInbox(Context context)', 'static boolean drainLifecycleControl');
  const lifecycle = methodBody(source, 'static boolean drainLifecycleControl(Context context)', '/** Return the next store-owned lifecycle wake delay');

  for (const body of [create, cloud, lifecycle]) {
    const database = body.indexOf('AlExecutionDatabase.get(context)');
    const drain = body.indexOf('drainRoleNotificationCancellations(context, database)');
    const secrets = body.indexOf('new AlSecretStore(context)');
    assert.ok(database >= 0, 'database must be opened');
    assert.ok(drain > database, 'durable cancellation drain must follow database open');
    assert.ok(secrets === -1 || drain < secrets, 'durable cancellation drain must precede ordinary runtime work');
  }
});
