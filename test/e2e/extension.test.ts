import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test(
  'built extension executes real page fetch through MCP while browser credentials stay in the page',
  { timeout: 60_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yc-extension-'));
    const extension = resolve('extension/dist');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('dist/cli.js'),
        '--transport',
        'browser',
        '--port',
        '0',
        '--state-dir',
        join(directory, 'state'),
        '--allow-mutations',
      ],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'yc-browser-e2e', version: '1.0.0' });
    const context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: 'chromium',
      headless: true,
      viewport: { width: 400, height: 640 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    let effects = 0,
      graphqlCalls = 0,
      storedText = 'Before';
    const observed: { csrf?: string; cookie?: string }[] = [];
    try {
      // Intercept EVERY http(s) request: this test must never contact real YC.
      await context.route(/^https?:\/\//, async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== 'https://apply.ycombinator.com') return route.abort();
        if (url.pathname === '/graphql') {
          graphqlCalls++;
          const headers = await request.allHeaders();
          observed.push({ csrf: headers['x-csrf-token'], cookie: headers.cookie });
          const body = request.postDataJSON();
          if (body.operationName === 'YCGetApplication')
            return route.fulfill({
              json: {
                data: {
                  app: {
                    uuid: body.variables.appUuid,
                    submitted: true,
                    submittedAt: '2026-01-01T00:00:00Z',
                    status: 'submitted',
                    editable: true,
                    fullEditable: false,
                    questions: { howfar: storedText },
                  },
                },
              },
            });
          if (body.operationName === 'Write') {
            effects++;
            storedText = body.variables.text;
          }
          const data =
            body.operationName === 'YCSchemaRoots'
              ? {
                  __schema: {
                    queryType: { name: 'Query' },
                    mutationType: { name: 'Mutation' },
                    subscriptionType: null,
                  },
                }
              : body.operationName === 'YCDescribeType'
                ? { __type: { name: body.variables.name, kind: 'OBJECT', fields: [] } }
                : body.operationName === 'Write'
                  ? { update: { success: true, id: 'fixture' } }
                  : { application: { locationExplanation: storedText } };
          return route.fulfill({ json: { data } });
        }
        if (url.pathname === '/assets/app.js')
          return route.fulfill({
            contentType: 'application/javascript',
            body: 'window.fixtureLoaded = true; /* SHOW_APP observed fixture operation */',
          });
        if (/\/apps\/[a-f0-9-]{36}\/edit/.test(url.pathname)) {
          const kind = url.pathname.split('/').at(-1)!;
          if (kind === 'full') return route.fulfill({ status: 404, body: '' });
          const props =
            kind === 'edit'
              ? { visibleUpdateKinds: { progress: true } }
              : {
                  app_uuid: url.pathname.split('/')[2],
                  update_kind: kind,
                  active_question_groups: {
                    Progress: { howfar: { prompt: { q: 'How far along?', required: false } } },
                  },
                };
          return route.fulfill({
            contentType: 'text/html',
            body: `<script type="application/json">mount({component: "components/${kind === 'edit' ? 'ChooseUpdateKind' : 'AppForm'}", props: ${JSON.stringify(props)}\n})</script>`,
          });
        }
        return route.fulfill({
          contentType: 'text/html',
          headers: {
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'",
          },
          body: '<!doctype html><title>YC test application</title><meta name="csrf-token" content="fixture-browser-csrf"><script src="/assets/app.js"></script><h1>Isolated YC fixture</h1>',
        });
      });
      await context.addCookies([
        {
          name: 'session',
          value: 'fixture-http-only-session',
          domain: 'apply.ycombinator.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      await page.goto('https://apply.ycombinator.com/apps/fixture');
      let worker = context.serviceWorkers()[0];
      if (!worker) worker = await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await client.connect(transport);
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })).structuredContent as any;
      const connection = (await call('yc_connection')).data;
      await popup.locator('#config').fill(JSON.stringify(connection));
      await popup.locator('#mutations').check();
      await popup.locator('#connect').click();
      await popup.waitForFunction(() =>
        document.querySelector('#status')?.textContent?.startsWith('Connected to tab'),
      );
      assert.equal(graphqlCalls, 0, 'pairing must make no YC GraphQL request');
      assert.equal((await call('yc_status')).data.connected, true);
      const editability = await call('yc_get_editability', {
        appUuid: '63a4d22c-1096-443e-894b-349e9c46fabb',
      });
      assert.equal(editability.ok, true);
      assert.ok(
        editability.data.forms.some((form: any) => form.groups[0].fields[0].field === 'howfar'),
      );
      assert.equal((await call('yc_describe_schema')).data.__schema.queryType.name, 'Query');
      assert.equal((await call('yc_describe_type', { name: 'Query' })).data.__type.name, 'Query');
      const scripts = await call('yc_inspect_scripts', { terms: ['SHOW_APP'] });
      assert.equal(scripts.data.results[0].hits[0].term, 'SHOW_APP');
      const read = {
        operationName: 'Read',
        query: 'query Read { application { locationExplanation } }',
      };
      assert.equal((await call('yc_query', read)).data.application.locationExplanation, 'Before');
      await call('yc_register_operation', { ...read, description: 'Fixture application read' });
      assert.equal(
        (await call('yc_run_operation', { operationName: 'Read' })).data.application
          .locationExplanation,
        'Before',
      );
      const preview = (
        await call('yc_prepare_mutation', {
          operationName: 'Write',
          query: 'mutation Write($text: String!) { update(text: $text) { success id } }',
          variables: { text: 'After' },
          idempotencyKey: randomUUID(),
        })
      ).data;
      assert.equal(effects, 0);
      const commit = await call('yc_commit_mutation', {
        receiptId: preview.receipt.id,
        confirmDigest: preview.receipt.digest,
      });
      assert.equal(commit.data.receipt.status, 'succeeded');
      assert.equal(effects, 1);
      await call('yc_commit_mutation', {
        receiptId: preview.receipt.id,
        confirmDigest: preview.receipt.digest,
      });
      assert.equal(effects, 1);
      assert.equal((await call('yc_query', read)).data.application.locationExplanation, 'After');
      assert.ok(
        observed.every(
          (headers) =>
            headers.csrf === 'fixture-browser-csrf' &&
            headers.cookie?.includes('fixture-http-only-session'),
        ),
      );
      const receipt = await call('yc_mutation_receipts', { receiptId: preview.receipt.id });
      assert.ok(!JSON.stringify(receipt).includes('fixture-browser-csrf'));
      const journal = readFileSync(join(directory, 'state', 'receipts.jsonl'), 'utf8');
      assert.ok(!journal.includes('fixture-http-only-session'));
      assert.ok(!journal.includes('After'));
      if (process.env.YC_CAPTURE_PREVIEW === '1') {
        mkdirSync('artifacts', { recursive: true });
        await popup.screenshot({
          path: 'artifacts/extension-preview.png',
          clip: { x: 0, y: 0, width: 360, height: 600 },
        });
      }
      await popup.locator('#disconnect').click();
      await popup.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Disconnected',
      );
      assert.equal((await call('yc_query', read)).error.code, 'BROWSER_DISCONNECTED');
    } finally {
      await context.close();
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
