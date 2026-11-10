import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { DirectTransport } from './direct.js';
import { readPrivate } from './private-files.js';

export function doctor(directory: string, authFile: string) {
  let lock: Record<string, unknown> = { state: 'absent' };
  try {
    const parsed: unknown = JSON.parse(readPrivate(join(directory, 'server.lock'), 8_000));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('pid' in parsed) ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0
    )
      throw new Error();
    const value = parsed as { pid: number; hostname?: string };
    if (value.hostname && value.hostname !== hostname())
      lock = { state: 'foreign_host', pid: value.pid };
    else {
      try {
        process.kill(value.pid, 0);
        lock = { state: 'active', pid: value.pid };
      } catch (error) {
        lock = {
          state: (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'unknown',
          pid: value.pid,
        };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lock = { state: 'unknown_or_unsafe' };
  }
  let stateDirectory = 'absent';
  try {
    const info = lstatSync(directory);
    stateDirectory =
      info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077) ? 'private' : 'unsafe';
  } catch {}
  const direct = new DirectTransport(authFile);
  return {
    stateDirectory,
    lock,
    authentication: direct.status(),
    recovery:
      lock.state === 'stale'
        ? 'The recorded process is gone. Preserve receipts.jsonl and operations.json. Remove only server.lock while all servers using this directory are stopped, then restart.'
        : null,
  };
}
