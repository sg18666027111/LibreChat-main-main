import sharp from 'sharp';
import { crc32 } from 'node:zlib';
import { optimizePNGInput } from './png';

const maximumBytes = 20 * 1024 * 1024;
const smallPNG = () =>
  sharp({ create: { width: 8, height: 8, channels: 4, background: '#14517966' } })
    .png()
    .toBuffer();

test('refuses truncated chunks and damaged checksums', async () => {
  const bytes = await smallPNG();
  await expect(optimizePNGInput(bytes.subarray(0, -1), maximumBytes)).rejects.toThrow();
  const damaged = Buffer.from(bytes);
  damaged[16] ^= 1;
  await expect(optimizePNGInput(damaged, maximumBytes)).rejects.toThrow('checksum');
});

test('leaves animated PNG inputs for explicit size guidance', async () => {
  const bytes = await smallPNG();
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0);
  animation.write('acTL', 4);
  animation.writeUInt32BE(1, 8);
  animation.writeUInt32BE(crc32(animation.subarray(4, 16)), 16);
  const animated = Buffer.concat([bytes.subarray(0, 33), animation, bytes.subarray(33)]);
  await expect(optimizePNGInput(animated, maximumBytes)).resolves.toBeNull();
});

test('bounds decompression even for a tiny compressed image', async () => {
  const bytes = await sharp({
    create: { width: 3000, height: 6000, channels: 4, background: '#14517966' },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  expect(bytes.length).toBeLessThan(maximumBytes);
  await expect(optimizePNGInput(bytes, maximumBytes)).resolves.toBeNull();
});

test('bounds chunk indexing for images with excessive tiny chunks', async () => {
  const bytes = await smallPNG();
  const chunk = Buffer.alloc(12);
  chunk.write('vpAg', 4);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8)), 8);
  const manyChunks = Buffer.concat([
    bytes.subarray(0, 33),
    ...Array<Buffer>(5000).fill(chunk),
    bytes.subarray(33),
  ]);
  await expect(optimizePNGInput(manyChunks, maximumBytes)).resolves.toBeNull();
});
