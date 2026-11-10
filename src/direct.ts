import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createYCGraphQLClient, readBounded, type BrowserEnvironment } from './browser/client.js';
import { YCError } from './errors.js';
import { YC_ORIGIN } from './graphql.js';
import { taskSchema, type BrowserTask } from './protocol.js';
import type { ExecutionTarget, YCTransport } from './transport.js';
import { redactSession, SessionFile, sessionDigest, type Session } from './auth.js';
import { abortable } from './deadline.js';

export class DirectTransport implements YCTransport {
  readonly mode = 'direct' as const;
  readonly authFile: string;
  private fingerprint = '';
  private connectionId = randomUUID();
  private pending = 0;
  private stopped = new AbortController();
  private lastVerifiedAt: string | null = null;
  private authState: 'configured' | 'verified' | 'expired' | 'unavailable' = 'configured';
  private sessions: SessionFile;
  constructor(
    authFile: string,
    private readonly allowMutations = false,
    private readonly httpFetch: typeof fetch = fetch,
  ) {
    this.authFile = resolve(authFile);
    this.sessions = new SessionFile(this.authFile);
  }
  private readAuth(): Session {
    const auth = this.sessions.read();
    const fingerprint = sessionDigest(auth);
    if (this.fingerprint && this.fingerprint !== fingerprint) {
      this.connectionId = randomUUID();
      this.lastVerifiedAt = null;
      this.authState = 'configured';
    }
    this.fingerprint = fingerprint;
    return auth;
  }
  currentTarget(): ExecutionTarget {
    if (this.stopped.signal.aborted)
      throw new YCError('SERVER_STOPPED', 'Direct transport is closed.');
    this.readAuth();
    return {
      connectionId: this.connectionId,
      origin: YC_ORIGIN,
      transport: 'direct',
      allowMutations: this.allowMutations,
    };
  }
  status() {
    try {
      return {
        mode: this.mode,
        connected: true,
        target: this.currentTarget(),
        pendingRequests: this.pending,
        lastVerifiedAt: this.lastVerifiedAt,
        authentication: this.authState,
      };
    } catch (error) {
      return {
        mode: this.mode,
        connected: false,
        target: null,
        pendingRequests: this.pending,
        lastVerifiedAt: null,
        authentication:
          error instanceof YCError && error.code === 'AUTH_EXPIRED' ? 'expired' : 'unavailable',
        errorCode: error instanceof YCError ? error.code : 'AUTH_REQUIRED',
      };
    }
  }
  connection() {
    return {
      mode: this.mode,
      authFile: this.authFile,
      instructions:
        'Direct HTTP mode. Run npm run login to refresh authentication. No browser bridge or extension is required.',
    };
  }
  async execute(task: BrowserTask, signal?: AbortSignal, expectedConnectionId?: string) {
    taskSchema.parse(task);
    this.currentTarget();
    if (signal?.aborted) throw new YCError('CANCELLED', 'Request cancelled before HTTP dispatch.');
    if (this.pending)
      throw new YCError(
        'BRIDGE_BUSY',
        'A direct HTTP request is already running. Wait for its outcome.',
      );
    if (task.method === 'request' && task.input.allowMutation && !this.allowMutations)
      throw new YCError(
        'MUTATION_BLOCKED',
        'Direct mutations require --allow-mutations and a reviewed preview.',
      );
    const auth = this.readAuth();
    if (expectedConnectionId && this.connectionId !== expectedConnectionId)
      throw new YCError(
        'TARGET_CHANGED',
        'Authentication changed after preview. Prepare a fresh mutation.',
      );
    const signals = [this.stopped.signal, ...(signal ? [signal] : [])];
    const scripts: { src: string }[] = [];
    let currentSession = auth;
    const authenticatedFetch: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (
        ![YC_ORIGIN, 'https://bookface-static.ycombinator.com'].includes(url.origin) ||
        url.username ||
        url.password
      )
        throw new YCError(
          'WRONG_ORIGIN',
          'Direct HTTP is restricted to the YC endpoint and its static scripts.',
        );
      const headers = new Headers(init?.headers);
      if (url.origin === YC_ORIGIN) {
        headers.set('Cookie', currentSession.cookie);
        headers.set('Origin', YC_ORIGIN);
        headers.set('Referer', YC_ORIGIN + '/');
      } else {
        headers.delete('Cookie');
        headers.delete('X-CSRF-Token');
        headers.delete('Authorization');
      }
      const requestSignals = [...signals, ...(init?.signal ? [init.signal] : [])];
      const response = await this.httpFetch(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.any(requestSignals),
      });
      if (response.status >= 300 && response.status < 400) {
        this.authState = 'expired';
        this.lastVerifiedAt = null;
        await response.body?.cancel();
        throw new YCError(
          'AUTH_REQUIRED',
          'YC redirected the request. Refresh your session; redirects are never followed.',
        );
      }
      if ([401, 403, 422].includes(response.status)) {
        this.authState = 'expired';
        this.lastVerifiedAt = null;
      }
      if (url.origin === YC_ORIGIN) currentSession = this.sessions.rotate(currentSession, response);
      return response;
    };
    const document = {
      querySelector: () => (auth.csrfToken ? { content: auth.csrfToken } : null),
      scripts,
    } as unknown as BrowserEnvironment['document'];
    const operationSignal = AbortSignal.any(signals);
    const client = createYCGraphQLClient({
      location: { origin: YC_ORIGIN },
      document,
      fetch: authenticatedFetch,
      AbortController,
      setTimeout,
      clearTimeout,
      signal: operationSignal,
    });
    this.pending++;
    try {
      let data: unknown;
      switch (task.method) {
        case 'request':
          data = await client.request(task.input);
          break;
        case 'describeSchema':
          data = await client.describeSchema();
          break;
        case 'describeType':
          data = await client.describeType(task.name, task.includeDeprecated);
          break;
        case 'introspectSchema':
          data = await client.introspectSchema();
          break;
        case 'inspectEditability':
          data = await client.inspectEditability(task.appUuid);
          break;
        case 'inspectLoadedScripts': {
          const htmlSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(10_000)]);
          const response = await abortable(
            authenticatedFetch(YC_ORIGIN + '/home', { signal: htmlSignal }),
            htmlSignal,
          );
          if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) {
            void response.body?.cancel();
            throw new YCError(
              'AUTH_REQUIRED',
              'YC application HTML is unavailable. Refresh your session with yc-graphql-mcp login.',
            );
          }
          const source = await readBounded(response, 2_000_000, htmlSignal);
          // Parse script src attributes only; never execute fetched page or script code.
          const tags = source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi);
          for (const match of tags) {
            try {
              scripts.push({ src: new URL(match[1]!.replaceAll('&amp;', '&'), YC_ORIGIN).href });
            } catch {
              /* Ignore malformed src attributes. */
            }
          }
          data = await client.inspectLoadedScripts(task.input);
          break;
        }
      }
      this.readAuth();
      this.lastVerifiedAt = new Date().toISOString();
      this.authState = 'verified';
      return redactSession(redactSession(data, auth), currentSession);
    } catch (error) {
      if (
        error instanceof YCError &&
        ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'CSRF_REJECTED'].includes(error.code)
      ) {
        this.authState = 'expired';
        this.lastVerifiedAt = null;
      }
      if (task.method === 'request' && task.input.allowMutation) throw error;
      if (signal?.aborted) throw new YCError('CANCELLED', 'Direct request cancelled.');
      if (error instanceof YCError) throw error;
      throw new YCError('NETWORK_ERROR', 'Direct YC request failed. No automatic retry was made.');
    } finally {
      this.pending--;
    }
  }
  async close() {
    this.stopped.abort();
  }
}
