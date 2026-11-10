import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DirectTransport } from '../src/direct.js';
import { YCService } from '../src/service.js';
import { StateStore } from '../src/store.js';

function privateAuth() {
  const directory = mkdtempSync(join(tmpdir(), 'yc-direct-'));
  const path = join(directory, 'auth.json');
  writeFileSync(
    path,
    JSON.stringify({
      cookie: 'session=synthetic-private-session',
      csrfToken: 'synthetic-private-csrf',
    }),
    { mode: 0o600 },
  );
  return { directory, path, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('direct HTTP attaches local authentication only to the fixed YC origin, and never returns it', async () => {
  const f = privateAuth();
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport = new DirectTransport(f.path, false, async (input, init) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return Response.json({ data: { __schema: { queryType: { name: 'Query' } } } });
  });
  try {
    assert.equal(calls.length, 0);
    const result = await transport.execute({ method: 'describeSchema' });
    assert.equal(calls[0]!.url, 'https://apply.ycombinator.com/graphql');
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get('cookie'), 'session=synthetic-private-session');
    assert.equal(headers.get('x-csrf-token'), 'synthetic-private-csrf');
    assert.equal(headers.get('origin'), 'https://apply.ycombinator.com');
    assert.equal(calls[0]!.init?.redirect, 'manual');
    assert.ok(
      !JSON.stringify({
        result,
        status: transport.status(),
        connection: transport.connection(),
      }).includes('synthetic-private'),
    );
    assert.equal(transport.status().mode, 'direct');
    assert.ok(transport.status().lastVerifiedAt);
  } finally {
    await transport.close();
    f.close();
  }
});

test('direct script discovery fetches HTML/code without executing it and never sends credentials to static origin', async () => {
  const f = privateAuth();
  const calls: string[] = [];
  const transport = new DirectTransport(f.path, false, async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/home'))
      return new Response(
        '<script src="https://bookface-static.ycombinator.com/bundle.js"></script><script src="https://evil.example/steal.js"></script>',
        { headers: { 'content-type': 'text/html' } },
      );
    assert.ok(url.startsWith('https://bookface-static.ycombinator.com/'));
    assert.equal(new Headers(init?.headers).get('cookie'), null);
    assert.equal(new Headers(init?.headers).get('x-csrf-token'), null);
    return new Response('/* SHOW_APP observed */');
  });
  try {
    const result = (await transport.execute({
      method: 'inspectLoadedScripts',
      input: { terms: ['SHOW_APP'], maxScripts: 20, maxHitsPerTerm: 3 },
    })) as any;
    assert.equal(result.results[0].hits[0].term, 'SHOW_APP');
    assert.equal(calls.length, 2);
  } finally {
    await transport.close();
    f.close();
  }
});

test('direct authentication rejects absent files, loose permissions and header injection before network dispatch', async () => {
  const f = privateAuth();
  let calls = 0;
  const transport = new DirectTransport(f.path, false, async () => {
    calls++;
    return Response.json({ data: {} });
  });
  try {
    chmodSync(f.path, 0o644);
    await assert.rejects(transport.execute({ method: 'describeSchema' }), {
      code: 'AUTH_FILE_INVALID',
    });
    chmodSync(f.path, 0o600);
    writeFileSync(f.path, JSON.stringify({ cookie: 'session=foo\r\nInjected: yes' }));
    await assert.rejects(transport.execute({ method: 'describeSchema' }), {
      code: 'AUTH_FILE_INVALID',
    });
    await assert.rejects(
      new DirectTransport(join(f.directory, 'missing')).execute({ method: 'describeSchema' }),
      { code: 'AUTH_REQUIRED' },
    );
    assert.equal(calls, 0);
  } finally {
    await transport.close();
    f.close();
  }
});

test('direct mutations retain preview/deduplication and invalidate previews when session credentials change', async () => {
  const f = privateAuth();
  let effects = 0;
  const transport = new DirectTransport(f.path, true, async () => {
    effects++;
    return Response.json({ data: { update: { id: 'app' } } });
  });
  const store = new StateStore(join(f.directory, 'state'));
  const service = new YCService(transport, store, true);
  try {
    const request = {
      operationName: 'Write',
      query: 'mutation Write { update { id } }',
      idempotencyKey: randomUUID(),
    };
    const preview = service.prepare(request);
    assert.equal(effects, 0);
    assert.equal(preview.receipt.target.transport, 'direct');
    const result = await service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(result.receipt.status, 'unverified');
    await service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(effects, 1);
    const next = service.prepare({ ...request, idempotencyKey: randomUUID() });
    writeFileSync(f.path, JSON.stringify({ cookie: 'session=new-session' }));
    await assert.rejects(service.commit(next.receipt.id, next.receipt.digest), {
      code: 'TARGET_CHANGED',
    });
    assert.equal(effects, 1);
  } finally {
    store.close();
    await transport.close();
    f.close();
  }
});

test('direct mutation response loss becomes uncertain and cannot be retried with its receipt', async () => {
  const f = privateAuth();
  let effects = 0;
  const transport = new DirectTransport(f.path, true, async () => {
    effects++;
    throw new TypeError('Lost response after synthetic commit');
  });
  const store = new StateStore(join(f.directory, 'state'));
  const service = new YCService(transport, store, true);
  try {
    const preview = service.prepare({
      operationName: 'Write',
      query: 'mutation Write { update { id } }',
      idempotencyKey: randomUUID(),
    });
    const result = await service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(result.receipt.status, 'uncertain');
    const replay = await service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(replay.error?.code, 'MUTATION_UNCERTAIN');
    assert.equal(effects, 1);
  } finally {
    store.close();
    await transport.close();
    f.close();
  }
});
