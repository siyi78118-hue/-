import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');

test('native terminal failures never expose internal validator details in chat UI', () => {
  assert.doesNotMatch(source, /result\.errorDetail\s*\|\|\s*result\.errorCode/);
  assert.doesNotMatch(source, /(?:pendingReply\.error|userMessage\.replyError)\s*=\s*friendlyErrorMessage\(err\)/);
  assert.match(source, /function nativeReplyFailureMessage\(/);
});
