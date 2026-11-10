import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Cookie, CookieJar } from 'tough-cookie';
import { z } from 'zod';
import { readPrivate, writePrivate } from './private-files.js';
import { YCError } from './errors.js';
import { YC_ORIGIN } from './graphql.js';

const header = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => !/[^\x20-\x7e]/.test(value));
const schema = z.object({
  cookie: header,
  csrfToken: header.max(16_384).optional(),
  capturedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});
export type Session = z.infer<typeof schema>;
export const sessionDigest = (session: Session) =>
  createHash('sha256')
    .update(JSON.stringify({ cookie: session.cookie, csrfToken: session.csrfToken }))
    .digest('hex');

export class SessionFile {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  read(): Session {
    let source: string;
    try {
      source = readPrivate(this.path, 100_000, 'AUTH_FILE_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new YCError(
          'AUTH_REQUIRED',
          'Run yc-graphql-mcp login to capture a YC session locally.',
        );
      throw new YCError(
        'AUTH_FILE_INVALID',
        'The auth file must be private, owned by you, and a regular file under 100 KB.',
      );
    }
    let parsed;
    try {
      parsed = schema.safeParse(JSON.parse(source));
    } catch {
      throw new YCError('AUTH_FILE_INVALID', 'The auth file is not valid session JSON.');
    }
    if (!parsed.success || !parsed.data.cookie.trim())
      throw new YCError('AUTH_FILE_INVALID', 'The auth file contains invalid session headers.');
    if (parsed.data.cookie.split(';').some((pair) => !Cookie.parse(pair.trim())?.key))
      throw new YCError('AUTH_FILE_INVALID', 'The auth file contains an invalid Cookie header.');
    if (parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= Date.now())
      throw new YCError('AUTH_EXPIRED', 'The saved session has expired. Run yc-graphql-mcp login.');
    return parsed.data;
  }
  rotate(snapshot: Session, response: Response): Session {
    const updates = response.headers.getSetCookie();
    if (!updates.length || response.status < 200 || response.status >= 300) return snapshot;
    const jar = new CookieJar(undefined, { prefixSecurity: 'strict' });
    try {
      for (const pair of snapshot.cookie
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean))
        jar.setCookieSync(pair + '; Path=/; Secure; HttpOnly', YC_ORIGIN);
      for (const value of updates)
        jar.setCookieSync(value, YC_ORIGIN + '/graphql', { ignoreError: true });
      const cookie = jar.getCookieStringSync(YC_ORIGIN + '/graphql');
      if (!cookie || cookie === snapshot.cookie) return snapshot;
      // A new manual login always wins over an older in-flight response.
      if (sessionDigest(this.read()) !== sessionDigest(snapshot)) return snapshot;
      const next = { ...snapshot, cookie };
      writePrivate(this.path, next);
      return next;
    } catch (error) {
      if (error instanceof YCError) throw error;
      throw new YCError(
        'AUTH_PERSIST_FAILED',
        'Session rotation could not be persisted. Do not retry a dispatched mutation; refresh authentication before further work.',
      );
    }
  }
}

export function redactSession(value: unknown, session: Session): unknown {
  const secrets = [
    session.cookie,
    session.csrfToken,
    ...session.cookie
      .split(';')
      .map((pair) => pair.slice(pair.indexOf('=') + 1))
      .filter((part) => part.length >= 8),
  ].filter((item): item is string => !!item);
  let encoded = JSON.stringify(value);
  for (const secret of secrets)
    encoded = encoded.replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]');
  return JSON.parse(encoded);
}
