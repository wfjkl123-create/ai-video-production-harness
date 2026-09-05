import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Text(value) {
  if (typeof value !== 'string') throw new TypeError('checksum input must be a string');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}
