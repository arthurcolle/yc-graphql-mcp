import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { YCError } from './errors.js';

const owned = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !owned(stat.uid) ||
    (process.platform !== 'win32' && stat.mode & 0o077)
  )
    throw new YCError(
      'UNSAFE_STATE',
      'The private state directory must be owned by you, mode 0700, and not a symlink.',
    );
}

export function openPrivate(path: string, flags: number, code = 'UNSAFE_STATE'): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !owned(stat.uid) ||
      (process.platform !== 'win32' && stat.mode & 0o077)
    )
      throw new YCError(
        code,
        'Use a regular private file owned by you (mode 0600), without symlinks or hard links.',
      );
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readPrivate(path: string, maxBytes: number, code = 'UNSAFE_STATE'): string {
  const fd = openPrivate(path, constants.O_RDONLY, code);
  try {
    const stat = fstatSync(fd);
    if (stat.size > maxBytes) throw new YCError(code, 'Private file exceeds its size limit.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maxBytes || used > stat.size)
      throw new YCError(code, 'Private file changed or exceeds its size limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
  } finally {
    closeSync(fd);
  }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writePrivate(path: string, value: unknown): void {
  const directory = dirname(path);
  privateDirectory(directory);
  const temporary = join(directory, `.write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openPrivate(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // rename replaces a leaf symlink, never follows it.
    renameSync(temporary, path);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
