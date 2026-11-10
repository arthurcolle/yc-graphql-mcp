import test from 'node:test';
import assert from 'node:assert/strict';
import { createYCGraphQLClient, type BrowserEnvironment } from '../src/browser/client.js';

function environment(
  mockFetch: typeof fetch,
  options: { origin?: string; scripts?: string[] } = {},
): BrowserEnvironment {
  return {
    location: { origin: options.origin ?? 'https://apply.ycombinator.com' },
    document: {
      querySelector: (() => ({ content: 'browser-only-csrf' })) as any,
      scripts: (options.scripts ?? []).map((src) => ({ src })) as any,
    },
    fetch: mockFetch,
    AbortController,
    setTimeout,
    clearTimeout,
  };
}

test('loading makes no requests; browser auth remains same-origin and never in returned data', async () => {
  const calls: any[] = [];
  const client = createYCGraphQLClient(
    environment(async (...args: any[]) => {
      calls.push(args);
      return Response.json({ data: { id: 'app' } });
    }),
  );
  assert.equal(calls.length, 0);
  const result = await client.request({ query: 'query Read { id }', operationName: 'Read' });
  assert.deepEqual(result, { id: 'app' });
  assert.equal(calls[0][0], 'https://apply.ycombinator.com/graphql');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers['X-CSRF-Token'], 'browser-only-csrf');
  assert.ok(!JSON.stringify(result).includes('csrf'));
  assert.throws(() =>
    createYCGraphQLClient(environment(fetch, { origin: 'https://evil.example' })),
  );
});

test('mutations require explicit allowance, and every failure after dispatch is uncertain without retry', async () => {
  let calls = 0;
  const client = createYCGraphQLClient(
    environment(async () => {
      calls++;
      throw new TypeError('lost response');
    }),
  );
  const mutation = { query: 'mutation Write { update { id } }', operationName: 'Write' };
  await assert.rejects(client.request(mutation), { code: 'MUTATION_BLOCKED' });
  assert.equal(calls, 0);
  await assert.rejects(client.request({ ...mutation, allowMutation: true }), {
    code: 'MUTATION_UNCERTAIN',
  });
  assert.equal(calls, 1);
});

test('query errors are bounded, structured, and never return partial data or echoed arguments', async () => {
  for (const [response, code] of [
    [new Response('', { status: 403 }), 'AUTH_REQUIRED'],
    [
      new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
      'INVALID_RESPONSE',
    ],
    [Response.json({ errors: [{ message: 'secret password' }], data: { id: 1 } }), 'GRAPHQL_ERROR'],
    [Response.json({ extensions: {} }), 'INVALID_RESPONSE'],
    [Response.json({ data: 'x'.repeat(2_000_001) }), 'RESPONSE_TOO_LARGE'],
  ] as const) {
    const client = createYCGraphQLClient(environment(async () => response));
    await assert.rejects(
      client.describeSchema(),
      (error: any) => error.code === code && !error.message.includes('secret password'),
    );
  }
});

test('script inspection confines origins, strips URL query strings, and caps hits', async () => {
  const calls: any[] = [];
  const client = createYCGraphQLClient(
    environment(
      async (...args: any[]) => {
        calls.push(args);
        return new Response('SHOW_APP '.repeat(20));
      },
      {
        scripts: [
          'https://evil.example/steal.js',
          'https://apply.ycombinator.com/a.js?tracking=private',
          'https://bookface-static.ycombinator.com/b.js',
          'https://apply.ycombinator.com/not-js',
        ],
      },
    ),
  );
  const result = await client.inspectLoadedScripts({ terms: ['SHOW_APP'], maxHitsPerTerm: 2 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[1][1].credentials, 'omit');
  assert.equal(result.results[0]?.hits?.length, 2);
  assert.ok(!JSON.stringify(result).includes('tracking=private'));
});
