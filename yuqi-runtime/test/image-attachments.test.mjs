import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  materializeImageAttachments,
  materializeRoleImages
} from '../src/image-attachments.mjs';

const JPEG_1X1 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

test('materializes a bounded JPEG data URL into a task directory and removes it on cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-image-test-'));
  try {
    const prepared = await materializeImageAttachments([{
      attachmentId: 'att_one',
      kind: 'image',
      mime: 'image/jpeg',
      name: 'one.jpg',
      dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
    }], { rootDir: root, turnId: 'turn_one' });

    assert.equal(prepared.paths.length, 1);
    assert.equal(existsSync(prepared.paths[0]), true);
    assert.deepEqual([...readFileSync(prepared.paths[0]).subarray(0, 3)], [0xff, 0xd8, 0xff]);
    await prepared.cleanup();
    assert.equal(existsSync(prepared.directory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a non-image signature even when the data URL claims JPEG', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-image-test-'));
  try {
    await assert.rejects(materializeImageAttachments([{
      attachmentId: 'att_bad',
      kind: 'image',
      mime: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}`
    }], { rootDir: root, turnId: 'turn_bad' }), /signature/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retained image receipts reuse, rebuild missing artifacts, reject corruption, and cleanup once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-image-retained-test-'));
  const attachment = {
    attachmentId: 'att_retained',
    kind: 'image',
    mime: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
  };
  try {
    const first = await materializeImageAttachments([attachment], {
      rootDir: root,
      turnId: 'turn_retained',
      retainReceipt: true
    });
    const duplicate = await materializeImageAttachments([attachment], {
      rootDir: root,
      turnId: 'turn_retained',
      retainReceipt: true
    });
    assert.deepEqual(duplicate.receipt, first.receipt);

    rmSync(first.paths[0]);
    const rebuilt = await materializeImageAttachments([attachment], {
      rootDir: root,
      turnId: 'turn_retained',
      retainReceipt: true
    });
    assert.deepEqual(rebuilt.receipt, first.receipt);
    assert.equal(existsSync(rebuilt.paths[0]), true);

    writeFileSync(rebuilt.paths[0], Buffer.from('corrupt retained artifact'));
    await assert.rejects(
      materializeImageAttachments([attachment], {
        rootDir: root,
        turnId: 'turn_retained',
        retainReceipt: true
      }),
      /image materialization checksum conflict/
    );
    assert.equal(readFileSync(rebuilt.paths[0]).toString(), 'corrupt retained artifact');

    await rebuilt.cleanup();
    assert.equal(existsSync(rebuilt.directory), false);
    await first.cleanup();
    await duplicate.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retained changed bytes use a new checksum path without overwriting the old artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-image-retained-change-'));
  const original = Buffer.from(JPEG_1X1, 'base64');
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  try {
    const first = await materializeImageAttachments([{
      attachmentId: 'att_original',
      kind: 'image',
      mime: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
    }], { rootDir: root, turnId: 'turn_changed', retainReceipt: true });
    const second = await materializeImageAttachments([{
      attachmentId: 'att_changed',
      kind: 'image',
      mime: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${changed.toString('base64')}`
    }], { rootDir: root, turnId: 'turn_changed', retainReceipt: true });
    assert.notEqual(second.receipt.attachmentChecksum, first.receipt.attachmentChecksum);
    assert.notEqual(second.receipt.path, first.receipt.path);
    assert.deepEqual(readFileSync(first.paths[0]), original);
    assert.deepEqual(readFileSync(second.paths[0]), changed);
    await first.cleanup();
    assert.equal(existsSync(first.directory), false);
    await second.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializes one physical image per checksum while preserving every message reference', async () => {
  const messages = [
    {
      messageId: 'msg_image_1',
      attachments: [{
        attachmentId: 'att_image_1',
        messageId: 'msg_image_1',
        kind: 'image',
        mime: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
      }]
    },
    {
      messageId: 'msg_image_2',
      attachments: [{
        attachmentId: 'att_image_2',
        messageId: 'msg_image_2',
        kind: 'image',
        mime: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
      }]
    }
  ];
  const prepared = await materializeRoleImages({
    messages,
    role: 'cognition',
    dedupeByChecksum: true
  });
  try {
    assert.equal(prepared.paths.length, 1);
    assert.equal(prepared.references.length, 2);
    assert.deepEqual(
      prepared.references.map((item) => item.messageId),
      ['msg_image_1', 'msg_image_2']
    );
    assert.equal(prepared.references[0].path, prepared.references[1].path);
    assert.equal(JSON.stringify(prepared.references).includes('base64'), false);
  } finally {
    await prepared.cleanup();
  }
});
