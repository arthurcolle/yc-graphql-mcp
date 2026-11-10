import { getIntrospectionQuery } from 'graphql';
import { YCError } from '../errors.js';
import {
  normalizeRequest,
  ROOTS_QUERY,
  TYPE_QUERY,
  YC_ORIGIN,
  type GraphQLRequest,
} from '../graphql.js';
import { assertJSON } from '../json.js';
import { abortable } from '../deadline.js';

export interface BrowserEnvironment {
  location: Pick<Location, 'origin'>;
  document: Pick<Document, 'querySelector' | 'scripts'>;
  fetch: typeof fetch;
  AbortController: typeof AbortController;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  signal?: AbortSignal;
}

const MAX_RESPONSE = 2_000_000;

// Bound the stream, including decompressed bodies, before parsing or returning it.
export async function readBounded(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) throw new YCError('INVALID_RESPONSE', 'YC returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    text = '';
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new YCError(
          'RESPONSE_TOO_LARGE',
          'Response exceeds the local size limit. Request fewer fields.',
        );
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function createYCGraphQLClient(env: BrowserEnvironment) {
  const assertOrigin = () => {
    if (env.location.origin !== YC_ORIGIN)
      throw new YCError(
        'WRONG_ORIGIN',
        'Run this only on https://apply.ycombinator.com while signed in.',
      );
  };
  assertOrigin();

  async function request(input: GraphQLRequest & { allowMutation?: boolean; timeoutMs?: number }) {
    assertOrigin();
    const operation = normalizeRequest(input);
    if (operation.kind === 'mutation' && input.allowMutation !== true)
      throw new YCError(
        'MUTATION_BLOCKED',
        'Inspect the exact fields, then explicitly allow the mutation.',
      );
    const timeoutMs = input.timeoutMs ?? 20_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000)
      throw new YCError('INVALID_TIMEOUT', 'timeoutMs must be between 1,000 and 30,000.');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const csrf = (env.document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)
      ?.content;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const abort = new env.AbortController();
    const signal = env.signal ? AbortSignal.any([abort.signal, env.signal]) : abort.signal;
    const timer = env.setTimeout(() => abort.abort(), timeoutMs);
    let dispatched = false;
    try {
      dispatched = true;
      const response = await abortable(
        env.fetch(YC_ORIGIN + '/graphql', {
          method: 'POST',
          credentials: 'same-origin',
          mode: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          headers,
          body: JSON.stringify({
            operationName: operation.operationName,
            query: operation.query,
            variables: operation.variables,
          }),
          signal,
        }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel();
        if (response.status === 429) {
          const retry = response.headers.get('retry-after') ?? '';
          const seconds = /^\d+$/.test(retry)
            ? Number(retry)
            : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
          throw new YCError(
            'RATE_LIMITED',
            'YC rate limited this request. No automatic retry was made.',
            {
              httpStatus: 429,
              ...(Number.isFinite(seconds)
                ? { retryAfterSeconds: Math.max(0, Math.min(seconds, 86400)) }
                : {}),
            },
          );
        }
        const code =
          response.status === 401 || response.status === 403
            ? 'AUTH_REQUIRED'
            : response.status === 422
              ? 'CSRF_REJECTED'
              : 'HTTP_ERROR';
        throw new YCError(
          code,
          `YC returned HTTP ${response.status}. Check the session and request; do not bypass access restrictions.`,
          { httpStatus: response.status },
        );
      }
      if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
        void response.body?.cancel();
        throw new YCError(
          'INVALID_RESPONSE',
          'YC did not return JSON. Check whether the session has expired.',
        );
      }
      const text = await readBounded(response, MAX_RESPONSE, signal);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new YCError('INVALID_RESPONSE', 'YC returned invalid JSON.');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new YCError('INVALID_RESPONSE', 'YC returned an invalid GraphQL envelope.');
      if (
        payload.errors !== undefined &&
        (!Array.isArray(payload.errors) ||
          payload.errors.some(
            (error) => !error || typeof error !== 'object' || typeof error.message !== 'string',
          ))
      )
        throw new YCError('INVALID_RESPONSE', 'YC returned invalid GraphQL errors.');
      if (Array.isArray(payload.errors) && payload.errors.length) {
        // Server-provided messages may echo sensitive arguments. Do not forward them.
        throw new YCError(
          'GRAPHQL_ERROR',
          `YC returned ${payload.errors.length} GraphQL error(s). Check the observed operation and variables. Partial data was withheld.`,
        );
      }
      if (!Object.hasOwn(payload, 'data'))
        throw new YCError('INVALID_RESPONSE', 'YC returned no GraphQL data.');
      if (
        payload.data !== null &&
        (typeof payload.data !== 'object' || Array.isArray(payload.data))
      )
        throw new YCError('INVALID_RESPONSE', 'GraphQL data must be an object or null.');
      assertJSON(payload.data, 'RESPONSE_TOO_COMPLEX', 100, 100_000);
      return payload.data;
    } catch (error) {
      if (operation.kind === 'mutation' && dispatched)
        throw new YCError(
          'MUTATION_UNCERTAIN',
          'Mutation outcome is uncertain. Do not retry. Read the application again before deciding what to do next.',
        );
      if (error instanceof YCError) throw error;
      if (env.signal?.aborted)
        throw new YCError(
          'CANCELLED',
          'YC request cancelled. A dispatched mutation may still take effect.',
        );
      if (abort.signal.aborted)
        throw new YCError('TIMEOUT', 'YC request timed out. No automatic retry was made.');
      throw new YCError(
        'NETWORK_ERROR',
        'YC request failed or returned invalid JSON. Check the signed-in tab.',
      );
    } finally {
      env.clearTimeout(timer);
    }
  }

  async function inspectLoadedScripts(
    options: { terms?: string[] | undefined; maxScripts?: number; maxHitsPerTerm?: number } = {},
  ) {
    assertOrigin();
    const terms = options.terms ?? [
      'SHOW_APP',
      'UPDATE_APP',
      'updateApp',
      'locationExplanation',
      'location_explanation',
    ];
    const maxScripts = options.maxScripts ?? 20,
      maxHits = options.maxHitsPerTerm ?? 3;
    if (
      !Array.isArray(terms) ||
      terms.length < 1 ||
      terms.length > 10 ||
      terms.some((t) => typeof t !== 'string' || !t || t.length > 100) ||
      !Number.isInteger(maxScripts) ||
      maxScripts < 1 ||
      maxScripts > 30 ||
      !Number.isInteger(maxHits) ||
      maxHits < 1 ||
      maxHits > 5
    ) {
      throw new YCError(
        'INVALID_INSPECTION',
        'Use 1–10 terms, 1–30 scripts, and 1–5 hits per term.',
      );
    }
    const allowed = new Set([YC_ORIGIN, 'https://bookface-static.ycombinator.com']);
    const urls = [
      ...new Set(
        Array.from(env.document.scripts)
          .map((s) => s.src)
          .filter(Boolean),
      ),
    ].filter((src) => {
      try {
        const u = new URL(src, YC_ORIGIN);
        return allowed.has(u.origin) && !u.username && !u.password && u.pathname.endsWith('.js');
      } catch {
        return false;
      }
    });
    const results = [];
    // Overall time and aggregate bytes are bounded, not only each individual fetch.
    const abort = new env.AbortController();
    const signal = env.signal ? AbortSignal.any([abort.signal, env.signal]) : abort.signal;
    const timer = env.setTimeout(() => abort.abort(), 25_000);
    let total = 0;
    let outputBytes = 0;
    try {
      for (const src of urls.slice(0, maxScripts)) {
        assertOrigin();
        const url = new URL(src, YC_ORIGIN);
        const publicUrl = url.origin + url.pathname; // no query strings or fragments in excerpts
        try {
          const response = await abortable(
            env.fetch(url.href, {
              credentials: url.origin === YC_ORIGIN ? 'same-origin' : 'omit',
              redirect: 'error',
              cache: 'no-store',
              signal,
            }),
            signal,
          );
          if (!response.ok) {
            void response.body?.cancel();
            results.push({ url: publicUrl, status: response.status });
            continue;
          }
          const source = await readBounded(
            response,
            Math.min(5_000_000, 15_000_000 - total),
            signal,
          );
          total += new TextEncoder().encode(source).length;
          const hits = [];
          for (const term of terms) {
            let offset = -1;
            for (
              let n = 0;
              n < maxHits && (offset = source.indexOf(term, offset + 1)) !== -1;
              n++
            ) {
              const excerpt = source.slice(Math.max(0, offset - 150), offset + 850);
              const bytes = new TextEncoder().encode(excerpt).byteLength;
              if (outputBytes + bytes > 500_000) break;
              outputBytes += bytes;
              hits.push({ term, offset, excerpt });
            }
          }
          if (hits.length) results.push({ url: publicUrl, hits });
          if (total >= 15_000_000 || outputBytes >= 496_000) break;
        } catch (error) {
          results.push({
            url: publicUrl,
            error: error instanceof YCError ? error.code : 'SCRIPT_FETCH_FAILED',
          });
          if (signal.aborted) break;
        }
      }
      return {
        scriptsConsidered: urls.length,
        scriptsLimit: maxScripts,
        results,
        untrustedContent: true,
      };
    } finally {
      env.clearTimeout(timer);
    }
  }

  return Object.freeze({
    request,
    describeSchema: () => request({ operationName: 'YCSchemaRoots', query: ROOTS_QUERY }),
    describeType: (name: string, includeDeprecated = false) =>
      request({
        operationName: 'YCDescribeType',
        query: TYPE_QUERY,
        variables: { name, includeDeprecated },
      }),
    introspectSchema: () =>
      request({
        operationName: 'IntrospectionQuery',
        query: getIntrospectionQuery({ descriptions: false }),
      }),
    inspectLoadedScripts,
  });
}

export type YCGraphQLClient = ReturnType<typeof createYCGraphQLClient>;
