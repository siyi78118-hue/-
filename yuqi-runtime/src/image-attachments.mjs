import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const MAX_IMAGE_BYTES = 96 * 1024;
const MAX_IMAGES_PER_TURN = 1;
const SAFE_ID = /[^a-zA-Z0-9_-]/g;

function safeId(value, fallback) {
  const normalized = String(value || '').replace(SAFE_ID, '_').slice(0, 96);
  return normalized || fallback;
}

function decodeImageDataUrl(attachment) {
  if (!attachment || attachment.kind !== 'image') throw new Error('attachment is not an image');
  const source = String(attachment.dataUrl || '');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source);
  if (!match) throw new Error('invalid image data URL');
  const mime = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('image attachment exceeds size limit');
  if (mime === 'image/jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new Error('invalid JPEG signature');
  }
  if (mime === 'image/png' && !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('invalid PNG signature');
  }
  if (mime === 'image/webp' && !(bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')) {
    throw new Error('invalid WebP signature');
  }
  const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { bytes, extension };
}

export async function materializeImageAttachments(attachments, options = {}) {
  const source = Array.isArray(attachments) ? attachments : [];
  if (source.length > MAX_IMAGES_PER_TURN) throw new Error('too many image attachments');
  const rootDir = resolve(options.rootDir || join(tmpdir(), 'yuqi-al-images'));
  const directory = join(rootDir, safeId(options.turnId, `turn_${Date.now()}`));
  const paths = [];
  if (!source.length) return { directory, paths, cleanup: async () => {} };
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  try {
    for (let index = 0; index < source.length; index += 1) {
      const attachment = source[index];
      const decoded = decodeImageDataUrl(attachment);
      const filename = `${String(index + 1).padStart(2, '0')}_${safeId(attachment.attachmentId, 'image')}.${decoded.extension}`;
      const path = join(directory, filename);
      await writeFile(path, decoded.bytes, { flag: 'wx' });
      paths.push(path);
    }
    return {
      directory,
      paths,
      cleanup: () => rm(directory, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function materializeRoleImages({
  messages,
  role,
  dedupeByChecksum = true,
  rootDir = join(tmpdir(), 'yuqi-al-role-images')
} = {}) {
  const directory = join(
    resolve(rootDir),
    `${safeId(role, 'role')}_${Date.now()}_${randomUUID().slice(0, 8)}`
  );
  const paths = [];
  const references = [];
  const checksumPaths = new Map();
  await mkdir(directory, { recursive: true });
  try {
    for (const message of Array.isArray(messages) ? messages : []) {
      for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        if (attachment?.kind !== 'image') continue;
        const decoded = decodeImageDataUrl(attachment);
        const checksum = createHash('sha256').update(decoded.bytes).digest('hex');
        let path = dedupeByChecksum ? checksumPaths.get(checksum) : '';
        if (!path) {
          const filename = `${String(paths.length + 1).padStart(2, '0')}_${checksum.slice(0, 16)}.${decoded.extension}`;
          path = join(directory, filename);
          await writeFile(path, decoded.bytes, { flag: 'wx' });
          checksumPaths.set(checksum, path);
          paths.push(path);
        }
        references.push({
          messageId: String(message?.messageId || attachment?.messageId || ''),
          attachmentId: String(attachment?.attachmentId || ''),
          mime: String(attachment?.mime || ''),
          checksum,
          path
        });
      }
    }
    return {
      directory,
      paths,
      references,
      cleanup: () => rm(directory, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
