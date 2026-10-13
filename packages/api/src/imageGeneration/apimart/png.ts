import { promisify } from 'node:util';
import { crc32, deflate, inflate } from 'node:zlib';

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = 4096;

/** Recompress only IDAT: filtered pixel bytes and every other PNG chunk stay intact. */
export async function optimizePNGInput(
  bytes: Buffer,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  signal?.throwIfAborted();
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Invalid PNG');
  }
  const before: Buffer[] = [SIGNATURE];
  const after: Buffer[] = [];
  const imageData: Buffer[] = [];
  let endedImageData = false;
  let endedPNG = false;
  let chunkCount = 0;
  for (let offset = 8; offset < bytes.length; ) {
    // Bound view allocation independently of the encoded/decompressed byte limits.
    if (++chunkCount > MAX_CHUNKS) {
      return null;
    }
    if (offset + 12 > bytes.length) {
      throw new Error('Truncated PNG');
    }
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      throw new Error('Truncated PNG chunk');
    }
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      throw new Error('Invalid PNG checksum');
    }
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) {
      throw new Error('Invalid PNG header');
    }
    if (type === 'acTL') {
      return null;
    }
    if (type === 'IDAT') {
      if (endedImageData) {
        throw new Error('Invalid PNG image data order');
      }
      imageData.push(bytes.subarray(offset + 8, end - 4));
    } else {
      if (imageData.length) {
        endedImageData = true;
        after.push(bytes.subarray(offset, end));
      } else {
        before.push(bytes.subarray(offset, end));
      }
    }
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) {
        throw new Error('Invalid PNG end');
      }
      endedPNG = true;
    }
    offset = end;
  }
  if (!imageData.length || !endedPNG) {
    throw new Error('Incomplete PNG');
  }
  let compressed: Buffer;
  try {
    const filteredPixels = await inflateAsync(Buffer.concat(imageData), {
      maxOutputLength: MAX_INFLATED_BYTES,
    });
    signal?.throwIfAborted();
    compressed = await deflateAsync(filteredPixels, { level: 9, maxOutputLength: maximumBytes });
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      return null;
    }
    throw error;
  }
  signal?.throwIfAborted();
  const otherBytes = [...before, ...after].reduce((sum, chunk) => sum + chunk.length, 0);
  if (otherBytes + 12 + compressed.length > maximumBytes) {
    return null;
  }
  const chunk = Buffer.allocUnsafe(compressed.length + 12);
  chunk.writeUInt32BE(compressed.length, 0);
  chunk.write('IDAT', 4, 'ascii');
  compressed.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return Buffer.concat([...before, chunk, ...after]);
}
