import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
