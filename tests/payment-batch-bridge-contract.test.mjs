import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../tavern-app/index.html', import.meta.url), 'utf8');

function bodyOf(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test('outgoing payment stays staged until the user finishes the batch', () => {
  const submit = bodyOf('submitPayMessage', 'uid');
  assert.match(submit, /stagePlayerMessage\(chat,\s*content,/);
  assert.doesNotMatch(submit, /queueAndroidUserReply\(/);
  assert.doesNotMatch(submit, /continueAssistantTurn\(/);
});

test('finishing a batch preserves the latest payment metadata for reply settlement', () => {
  const finish = bodyOf('finishStagedBatch', 'voiceButtonEl');
  assert.match(finish, /paymentMessageId/);
  assert.match(finish, /payment:\s*\{\s*kind:/);
});

test('finishing a batch serializes every visible bubble as one ordered AI batch', () => {
  const finish = bodyOf('finishStagedBatch', 'voiceButtonEl');
  assert.match(finish, /batchMessages\s*=\s*committed\.messages\.map/);
  assert.match(finish, /batchMessageForAI\(charId,\s*message\)/);
  assert.match(finish, /batchMessages,/);

  const taskBuilder = bodyOf('buildAndroidUserReplyTask', 'dumpCharacterMemoryForRunner');
  assert.match(taskBuilder, /batchMessages:\s*Array\.isArray\(options\.batchMessages\)/);

  const queue = bodyOf('queueAndroidUserReply', 'mirrorAppStateNow');
  assert.match(queue, /wireBatchMessages/);
  assert.match(queue, /message:\s*wireSourceMessage/);
});

test('discarding a staged outgoing payment refunds it exactly once', () => {
  const refund = bodyOf('refundStagedOutgoingPayment', 'retractMessage');
  assert.match(refund, /deliveryState\s*!==\s*'staged'/);
  assert.match(refund, /message\.refunded/);
  assert.match(refund, /saveWalletBalance\(walletBalance\(\)\s*\+\s*amount\)/);

  const retract = bodyOf('retractMessage', 'deleteChatMessage');
  const remove = bodyOf('deleteChatMessage', 'retractSelectedMessage');
  assert.match(retract, /refundStagedOutgoingPayment\(message\)/);
  assert.match(remove, /refundStagedOutgoingPayment\(chat\.messages\[index\]\)/);
});

test('automatic moments use a practical bounded cadence', () => {
  assert.match(source, /MOMENT_DICE_INTERVAL_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /MOMENT_DICE_CHANCE\s*=\s*0\.20/);
  assert.match(source, /MOMENT_DICE_MAX_ROLLS\s*=\s*12/);
});
