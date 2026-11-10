import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { DirectTransport } from '../src/direct.js';
import { StateStore } from '../src/store.js';
import { YCService } from '../src/service.js';
import { createMcpServer } from '../src/server.js';
import { Logger } from '../src/log.js';
import { YCError } from '../src/errors.js';
import { SessionFile } from '../src/auth.js';
import { createYCGraphQLClient, readBounded } from '../src/browser/client.js';
import { normalizeRequest, inspectOperation } from '../src/graphql.js';
import { doctor } from '../src/doctor.js';
import { mutationOutcome } from '../src/mutation-outcome.js';

function fixture(httpFetch: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), 'yc-production-'));
  const authFile = join(directory, 'auth.json');
  writeFileSync(
    authFile,
    JSON.stringify({
      cookie: 'session=synthetic-session-secret',
      csrfToken: 'synthetic-csrf-secret',
    }),
    { mode: 0o600 },
  );
  const transport = new DirectTransport(authFile, true, httpFetch);
  const store = new StateStore(join(directory, 'state'));
  const service = new YCService(transport, store, true);
  return {
    directory,
    authFile,
    transport,
    store,
    service,
    async close() {
      await service.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const write = () => ({
  query:
    'mutation Write($text: String!) { updateApp(text: $text) { success persisted errors app { uuid } } }',
  operationName: 'Write',
  variables: { text: 'private-application-answer' },
  idempotencyKey: randomUUID(),
});

test('mutation outcome follows aliases and fragment selections, and rejects malformed success evidence', () => {
  const operation = inspectOperation(
    'mutation Write { saved: updateApp { ...Result } } fragment Result on UpdateAppPayload { ok: success stored: persisted problems: errors entity: app { uuid } }',
    'Write',
  );
  const result = { ok: true, stored: true, problems: [], entity: { uuid: 'fixture' } };
  assert.equal(mutationOutcome({ saved: result }, operation.rootFields), 'succeeded');
  assert.equal(
    mutationOutcome({ saved: { ...result, entity: null } }, operation.rootFields),
    'unverified',
  );
  const { entity: _entity, ...missing } = result;
  assert.equal(mutationOutcome({ saved: missing }, operation.rootFields), 'unverified');
  assert.equal(
    mutationOutcome({ saved: { ...result, ok: false } }, operation.rootFields),
    'rejected',
  );
  assert.equal(
    mutationOutcome({ saved: { ...result, problems: ['refused'] } }, operation.rootFields),
    'rejected',
  );
  assert.equal(
    mutationOutcome({ saved: { ...result, problems: 'malformed' } }, operation.rootFields),
    'unverified',
  );
  assert.equal(
    mutationOutcome({ saved: { ...result, stored: 1 } }, operation.rootFields),
    'unverified',
  );
});

test('legacy succeeded receipts remain deduplicated without being promoted to verified persistence', async () => {
  let effects = 0;
  const f = fixture(async () => {
    effects++;
    return Response.json({ data: {} });
  });
  try {
    const preview = f.service.prepare(write());
    const { version: _version, ...legacy } = preview.receipt;
    const receipt = { ...legacy, id: randomUUID(), status: 'succeeded' as const };
    f.store.record({ ...receipt, status: 'prepared' });
    f.store.record({ ...receipt, status: 'dispatched' });
    f.store.record(receipt);
    const result = await f.service.commit(receipt.id, receipt.digest);
    assert.equal(result.error?.code, 'MUTATION_UNVERIFIED');
    assert.equal(result.replay, true);
    assert.equal(effects, 0);
  } finally {
    await f.close();
  }
});

for (const [data, status, code] of [
  [
    { updateApp: { success: false, persisted: false, errors: ['refused'], app: null } },
    'rejected',
    'MUTATION_REJECTED',
  ],
  [
    { updateApp: { success: true, persisted: true, errors: [], app: null } },
    'unverified',
    'MUTATION_UNVERIFIED',
  ],
  [
    { updateApp: { success: true, persisted: true, errors: [], app: { uuid: 'fixture' } } },
    'succeeded',
    undefined,
  ],
] as const) {
  test(`mutation response produces durable ${status}, rather than treating HTTP 200 as proof`, async () => {
    let effects = 0;
    const f = fixture(async () => {
      effects++;
      return Response.json({ data });
    });
    try {
      const preview = f.service.prepare(write());
      const result = await f.service.commit(preview.receipt.id, preview.receipt.digest);
      assert.equal(result.receipt.status, status);
      assert.equal(result.error?.code, code);
      const replay = await f.service.commit(preview.receipt.id, preview.receipt.digest);
      assert.equal(replay.receipt.status, status);
      assert.equal(effects, 1);
      f.store.compact();
      assert.equal(f.store.getReceipt(preview.receipt.id).status, status);
    } finally {
      await f.close();
    }
  });
}

test('a caller cannot change the dispatched payload by mutating a returned preview', async () => {
  let text = '';
  const f = fixture(async (_url, init) => {
    text = JSON.parse(String(init?.body)).variables.text;
    return Response.json({
      data: { updateApp: { success: true, persisted: true, app: { uuid: 'x' } } },
    });
  });
  try {
    const preview = f.service.prepare(write());
    preview.preview.variables.text = 'smuggled-change';
    preview.preview.query = 'mutation Erase { eraseAll }';
    await f.service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(text, 'private-application-answer');
  } finally {
    await f.close();
  }
});

test('auth rotation at the final dispatch boundary sends no mutation and produces a terminal not_sent receipt', async () => {
  let effects = 0;
  const f = fixture(async () => {
    effects++;
    return Response.json({ data: {} });
  });
  try {
    const preview = f.service.prepare(write());
    const execute = f.transport.execute.bind(f.transport);
    f.transport.execute = async (...args) => {
      writeFileSync(f.authFile, JSON.stringify({ cookie: 'session=replaced-session-secret' }));
      return execute(...args);
    };
    const result = await f.service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(result.receipt.status, 'not_sent');
    assert.equal(result.error?.code, 'MUTATION_NOT_SENT');
    assert.equal(effects, 0);
    await f.service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(effects, 0);
  } finally {
    await f.close();
  }
});

test('a disk failure after a fake commit returns its durable receipt and never redispatches', async () => {
  let effects = 0;
  const f = fixture(async () => {
    effects++;
    return Response.json({
      data: { updateApp: { success: true, persisted: true, app: { uuid: 'x' } } },
    });
  });
  try {
    const preview = f.service.prepare(write());
    const record = f.store.record.bind(f.store);
    f.store.record = (value) => {
      if (value.status === 'succeeded')
        throw new YCError('STATE_WRITE_FAILED', 'Synthetic disk failure');
      return record(value);
    };
    await assert.rejects(
      f.service.commit(preview.receipt.id, preview.receipt.digest),
      (error: any) =>
        error.code === 'STATE_WRITE_FAILED' && error.details.receipt.id === preview.receipt.id,
    );
    const replay = await f.service.commit(preview.receipt.id, preview.receipt.digest);
    assert.equal(replay.error?.code, 'MUTATION_UNCERTAIN');
    assert.equal(effects, 1);
  } finally {
    await f.close();
  }
});

test('MCP preserves a legitimate query field named error, and reports mutation rejection as isError with a receipt', async () => {
  const f = fixture(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({
      data:
        body.operationName === 'Read'
          ? { error: { code: 'user-data', message: 'legitimate application field' } }
          : { updateApp: { success: false, persisted: false, errors: ['no'], app: null } },
    });
  });
  const logs: string[] = [];
  const server = createMcpServer(f.service, new Logger('info', (line) => logs.push(line)));
  const client = new Client({ name: 'production-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    await client.listTools();
    const result: any = await client.callTool({
      name: 'yc_query',
      arguments: { query: 'query Read { error { code message } }', operationName: 'Read' },
    });
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.error.code, 'user-data');
    const preview: any = (
      await client.callTool({ name: 'yc_prepare_mutation', arguments: write() })
    ).structuredContent.data;
    const rejected: any = await client.callTool({
      name: 'yc_commit_mutation',
      arguments: { receiptId: preview.receipt.id, confirmDigest: preview.receipt.digest },
    });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.error.code, 'MUTATION_REJECTED');
    assert.equal(rejected.structuredContent.data.receipt.status, 'rejected');
    assert.ok(!logs.join('').includes('private-application-answer'));
    assert.ok(!logs.join('').includes('synthetic-session-secret'));
    for (const line of logs) assert.ok(JSON.parse(line).requestId);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

test('session Set-Cookie rotation is persisted privately and credentials echoed by the provider are redacted', async () => {
  let call = 0;
  const f = fixture(async (_url, init) => {
    call++;
    const cookie = new Headers(init?.headers).get('cookie');
    if (call === 2) assert.equal(cookie, 'session=rotated-session-secret');
    return Response.json(
      { data: { echo: { cookie, csrf: 'synthetic-csrf-secret' } } },
      call === 1
        ? { headers: { 'Set-Cookie': 'session=rotated-session-secret; Path=/; HttpOnly; Secure' } }
        : undefined,
    );
  });
  try {
    const task = { method: 'describeSchema' } as const;
    const data = await f.transport.execute(task);
    assert.ok(!JSON.stringify(data).includes('synthetic-session-secret'));
    assert.ok(!JSON.stringify(data).includes('synthetic-csrf-secret'));
    assert.equal(
      JSON.parse(readFileSync(f.authFile, 'utf8')).cookie,
      'session=rotated-session-secret',
    );
    await f.transport.execute(task);
  } finally {
    await f.close();
  }
});

test('old in-flight cookie rotation cannot overwrite a newer manual login', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-auth-cas-'));
  const path = join(directory, 'auth.json');
  try {
    writeFileSync(path, JSON.stringify({ cookie: 'session=old-session-secret' }), { mode: 0o600 });
    const sessions = new SessionFile(path),
      snapshot = sessions.read();
    writeFileSync(path, JSON.stringify({ cookie: 'session=new-login-secret' }));
    sessions.rotate(
      snapshot,
      new Response('{}', {
        headers: { 'Set-Cookie': 'session=stale-rotation-secret; Path=/; Secure' },
      }),
    );
    assert.equal(sessions.read().cookie, 'session=new-login-secret');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private state and authentication reject symlinks, hard links, and broad directory permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-private-files-'));
  const path = join(directory, 'real.json');
  try {
    writeFileSync(path, JSON.stringify({ cookie: 'session=private-session' }), { mode: 0o600 });
    symlinkSync(path, join(directory, 'link.json'));
    assert.throws(() => new SessionFile(join(directory, 'link.json')).read(), {
      code: 'AUTH_FILE_INVALID',
    });
    linkSync(path, join(directory, 'hard.json'));
    assert.throws(() => new SessionFile(path).read(), { code: 'AUTH_FILE_INVALID' });
    const broad = join(directory, 'broad');
    writeFileSync(join(directory, 'marker'), '');
    mkdirSync(broad);
    chmodSync(broad, 0o755);
    assert.throws(() => new StateStore(broad), { code: 'UNSAFE_STATE' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('terminal receipt tampering blocks startup and compaction preserves every idempotency key', async () => {
  const f = fixture(async () =>
    Response.json({ data: { updateApp: { success: true, persisted: true, app: { uuid: 'x' } } } }),
  );
  try {
    const preview = f.service.prepare(write());
    await f.service.commit(preview.receipt.id, preview.receipt.digest);
    f.store.compact();
    f.store.close();
    const reopened = new StateStore(join(f.directory, 'state'));
    assert.equal(reopened.getReceipt(preview.receipt.id).status, 'succeeded');
    reopened.close();
    appendFileSync(
      join(f.directory, 'state', 'receipts.jsonl'),
      JSON.stringify(preview.receipt) + '\n',
    );
    assert.throws(() => new StateStore(join(f.directory, 'state')), { code: 'STATE_CORRUPT' });
  } finally {
    await f.close();
  }
});

test('registry reads cannot mutate stored operation documents in memory', async () => {
  const f = fixture(async () => Response.json({ data: {} }));
  try {
    f.store.saveOperation({
      operationName: 'Read',
      kind: 'query',
      query: 'query Read { id }',
      description: '',
    });
    const operation = f.store.getOperation('Read');
    operation.query = 'mutation Erase { erase }';
    f.store.listOperations()[0]!.query = 'mutation Other { erase }';
    assert.equal(f.store.getOperation('Read').query, 'query Read { id }');
  } finally {
    await f.close();
  }
});

test('response streams and adapters that ignore abort cannot outlive the request deadline', async () => {
  const controller = new AbortController();
  // AbortSignal.timeout uses an unref'ed timer on Node 22. Keep this isolated
  // synthetic stream test alive without relying on unrelated open handles.
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(
      readBounded(new Response(new ReadableStream({ start() {} })), 100, controller.signal),
      { name: 'AbortError' },
    );
  } finally {
    clearTimeout(timer);
  }
  const client = createYCGraphQLClient({
    location: { origin: 'https://apply.ycombinator.com' },
    document: { querySelector: () => null, scripts: [] } as any,
    fetch: async () => new Promise<Response>(() => {}),
    AbortController,
    setTimeout: ((fn: () => void) => setTimeout(fn, 20)) as typeof setTimeout,
    clearTimeout,
  });
  await assert.rejects(client.describeSchema(), { code: 'TIMEOUT' });
});

test('rate limiting exposes bounded retry metadata without a retry, and redirects never receive session headers', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return new Response('{}', { status: 429, headers: { 'Retry-After': '15' } });
  });
  try {
    await assert.rejects(
      f.transport.execute({ method: 'describeSchema' }),
      (error: any) => error.code === 'RATE_LIMITED' && error.details.retryAfterSeconds === 15,
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
  const redirect = fixture(
    async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
  );
  try {
    await assert.rejects(redirect.transport.execute({ method: 'describeSchema' }), {
      code: 'AUTH_REQUIRED',
    });
  } finally {
    await redirect.close();
  }
});

test('non-JSON variable values and unused fragment cycles are rejected locally', () => {
  for (const value of [NaN, Infinity, undefined, () => {}, new Date()])
    assert.throws(() =>
      normalizeRequest({ query: 'query Read { id }', operationName: 'Read', variables: { value } }),
    );
  assert.throws(
    () => inspectOperation('query Read { id } fragment Cycle on Query { ...Cycle }', 'Read'),
    { code: 'INVALID_DOCUMENT' },
  );
});

test('doctor detects a stale lock without deleting it or leaking credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-doctor-'));
  try {
    const auth = join(directory, 'auth.json');
    writeFileSync(auth, JSON.stringify({ cookie: 'session=do-not-log-this' }), { mode: 0o600 });
    writeFileSync(join(directory, 'server.lock'), JSON.stringify({ pid: 2147483647 }), {
      mode: 0o600,
    });
    const result = doctor(directory, auth);
    assert.equal(result.lock.state, 'stale');
    assert.ok(readFileSync(join(directory, 'server.lock')));
    assert.ok(!JSON.stringify(result).includes('do-not-log-this'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
