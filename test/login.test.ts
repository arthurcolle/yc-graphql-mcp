import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { captureSession } from '../src/login.js';

function context() {
  return {
    pages: () => [
      {
        url: () => 'https://apply.ycombinator.com/home',
        getByRole: () => ({ count: async () => 1 }),
        locator: () => ({ getAttribute: async () => 'private-csrf-value' }),
      },
    ],
    cookies: async () => [{ name: 'session', value: 'private-session-value' }],
  } as unknown as BrowserContext;
}

test('login capture verifies direct account access and saves private headers without browser storage exports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-login-test-')),
    file = join(directory, 'auth.json');
  try {
    await captureSession(context(), file, new AbortController().signal, async (url, init) => {
      assert.equal(String(url), 'https://apply.ycombinator.com/graphql');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('cookie'), 'session=private-session-value');
      assert.equal(JSON.parse(String(init?.body)).operationName, 'YCLoginCheck');
      return Response.json({ data: { allApps: [] } });
    });
    const auth = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(auth.cookie, 'session=private-session-value');
    assert.equal(auth.csrfToken, 'private-csrf-value');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal('origins' in auth, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed or cancelled login preserves an existing session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yc-login-test-')),
    file = join(directory, 'auth.json');
  try {
    const original = JSON.stringify({ cookie: 'session=preserve-this-session' });
    writeFileSync(file, original, { mode: 0o600 });
    await assert.rejects(
      captureSession(
        context(),
        file,
        new AbortController().signal,
        async () => new Response('{}', { status: 403 }),
      ),
      { code: 'AUTH_REQUIRED' },
    );
    assert.equal(readFileSync(file, 'utf8'), original);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(captureSession(context(), file, abort.signal), {
      code: 'LOGIN_CANCELLED',
    });
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
