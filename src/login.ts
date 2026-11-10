import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext } from 'playwright';
import { YC_ORIGIN } from './graphql.js';
import { readBounded } from './browser/client.js';
import { privateDirectory, writePrivate } from './private-files.js';
import { YCError } from './errors.js';

export async function captureSession(
  context: BrowserContext,
  path: string,
  signal: AbortSignal,
  httpFetch: typeof fetch = fetch,
): Promise<void> {
  if (signal.aborted)
    throw new YCError(
      'LOGIN_CANCELLED',
      'Login was cancelled. Existing credentials were preserved.',
    );
  for (const page of context.pages()) {
    if (new URL(page.url()).origin !== YC_ORIGIN) continue;
    const signedIn =
      (await page.getByRole('button', { name: /^log\s*out$/i }).count()) ||
      (await page.getByRole('link', { name: /^log\s*out$/i }).count());
    if (!signedIn) continue;
    const cookies = await context.cookies(YC_ORIGIN + '/graphql');
    const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    const csrfToken = await page.locator('meta[name="csrf-token"]').getAttribute('content');
    if (!cookie) continue;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    const response = await httpFetch(YC_ORIGIN + '/graphql', {
      method: 'POST',
      redirect: 'manual',
      signal: requestSignal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: cookie,
        Origin: YC_ORIGIN,
        Referer: YC_ORIGIN + '/',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      body: JSON.stringify({
        operationName: 'YCLoginCheck',
        query: 'query YCLoginCheck { allApps { uuid } }',
        variables: {},
      }),
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new YCError(
        'AUTH_REQUIRED',
        'YC rejected the direct session check. Existing saved credentials were preserved.',
      );
    }
    let data;
    try {
      data = JSON.parse(await readBounded(response, 256_000, requestSignal));
    } catch {
      throw new YCError(
        'INVALID_RESPONSE',
        'YC did not return a valid session-check response. Existing credentials were preserved.',
      );
    }
    if (data.errors?.length || !Array.isArray(data.data?.allApps))
      throw new YCError(
        'AUTH_REQUIRED',
        'YC did not authenticate the application query. Existing credentials were preserved.',
      );
    writePrivate(path, {
      cookie,
      ...(csrfToken ? { csrfToken } : {}),
      capturedAt: new Date().toISOString(),
    });
    return;
  }
  throw new YCError(
    'LOGIN_PENDING',
    'Sign in in the browser window and open your application dashboard.',
  );
}

export async function login(path: string): Promise<void> {
  const { chromium } = await import('playwright');
  const profile = mkdtempSync(join(tmpdir(), 'yc-sign-in-'));
  privateDirectory(profile);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const deadline = setTimeout(stop, 15 * 60_000);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: false,
      viewport: null,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(YC_ORIGIN + '/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    process.stderr.write(
      'Sign in in the Chromium window. Session headers will be saved privately after a direct API check.\n',
    );
    while (!abort.signal.aborted) {
      try {
        await captureSession(context, path, abort.signal);
        process.stderr.write('Session saved. Direct GraphQL authentication verified.\n');
        return;
      } catch (error) {
        if (!(error instanceof YCError) || error.code !== 'LOGIN_PENDING') throw error;
      }
      await delay(1500, undefined, { signal: abort.signal });
    }
    throw new YCError(
      'LOGIN_CANCELLED',
      'Login cancelled or timed out. Existing saved credentials were preserved.',
    );
  } catch (error) {
    if (error instanceof YCError) throw error;
    throw new YCError(
      'LOGIN_FAILED',
      'Login could not be completed. Ensure Chromium is installed with npx playwright install chromium. Existing saved credentials were preserved.',
    );
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await context?.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
