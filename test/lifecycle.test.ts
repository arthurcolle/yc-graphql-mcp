import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { WebSocket } from 'ws';
import { StateStore } from '../src/store.js';
import { YCService } from '../src/service.js';
import { DirectTransport } from '../src/direct.js';
import { doctor } from '../src/doctor.js';

test(
  'SIGKILL after a synthetic effect leaves a durable uncertain receipt and cannot duplicate on restart',
  { timeout: 15_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yc-kill-test-'));
    const auth = join(directory, 'auth.json');
    writeFileSync(auth, JSON.stringify({ cookie: 'session=synthetic-session' }), { mode: 0o600 });
    const script = join(directory, 'child.mjs');
    const module = pathToFileURL(resolve('dist/index.js')).href;
    writeFileSync(
      script,
      String.raw`import { StateStore, YCService, DirectTransport } from ${JSON.stringify(module)};
import { appendFileSync } from 'node:fs';
const store = new StateStore(${JSON.stringify(join(directory, 'state'))});
const transport = new DirectTransport(${JSON.stringify(auth)}, true, async () => { appendFileSync(${JSON.stringify(join(directory, 'effect'))}, 'once\n'); process.stdout.write('EFFECT\n'); return new Promise(() => {}); });
const service = new YCService(transport, store, true);
const preview = service.prepare({ operationName: 'Write', query: 'mutation Write { update { success } }', idempotencyKey: ${JSON.stringify(randomUUID())} });
process.stdout.write(JSON.stringify(preview.receipt) + '\n');
await service.commit(preview.receipt.id, preview.receipt.digest);`,
    );
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      diagnostics = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk.toString();
    });
    try {
      for (let n = 0; n < 100 && !output.includes('EFFECT\n'); n++) {
        if (child.exitCode !== null) break;
        await delay(20);
      }
      assert.ok(output.includes('EFFECT\n'), diagnostics);
      const receipt = JSON.parse(output.split('\n')[0]!);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      assert.equal(doctor(join(directory, 'state'), auth).lock.state, 'stale');
      unlinkSync(join(directory, 'state', 'server.lock'));
      const store = new StateStore(join(directory, 'state'));
      let effects = 0;
      const transport = new DirectTransport(auth, true, async () => {
        effects++;
        return Response.json({ data: {} });
      });
      const service = new YCService(transport, store, true);
      try {
        const replay = await service.commit(receipt.id, receipt.digest);
        assert.equal(replay.receipt.status, 'uncertain');
        assert.equal(effects, 0);
        assert.equal(readFileSync(join(directory, 'effect'), 'utf8').trim(), 'once');
      } finally {
        await service.shutdown();
        store.close();
      }
    } finally {
      child.kill('SIGKILL');
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'the actual MCP CLI flushes uncertain in-flight mutations before SIGTERM shutdown',
  { timeout: 15_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yc-terminate-test-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('dist/cli.js'),
        '--transport',
        'browser',
        '--port',
        '0',
        '--state-dir',
        directory,
        '--allow-mutations',
      ],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'termination-test', version: '1' });
    let ws: WebSocket | undefined;
    try {
      await client.connect(transport);
      const connection = JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8'));
      ws = new WebSocket(connection.url, { origin: 'chrome-extension://' + 'a'.repeat(32) });
      await once(ws, 'open');
      const ready = once(ws, 'message');
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: 1,
          token: connection.token,
          tabId: 1,
          origin: 'https://apply.ycombinator.com',
          allowMutations: true,
        }),
      );
      await ready;
      const prepared: any = (
        await client.callTool({
          name: 'yc_prepare_mutation',
          arguments: {
            query: 'mutation Write { update { success } }',
            operationName: 'Write',
            idempotencyKey: randomUUID(),
          },
        })
      ).structuredContent;
      const message = once(ws, 'message');
      const pending = client
        .callTool({
          name: 'yc_commit_mutation',
          arguments: {
            receiptId: prepared.data.receipt.id,
            confirmDigest: prepared.data.receipt.digest,
          },
        })
        .catch(() => null);
      await message;
      process.kill(transport.pid!, 'SIGTERM');
      await pending;
      for (let n = 0; n < 100 && existsSync(join(directory, 'server.lock')); n++) await delay(20);
      assert.equal(existsSync(join(directory, 'server.lock')), false);
      const store = new StateStore(directory);
      try {
        assert.equal(store.getReceipt(prepared.data.receipt.id).status, 'uncertain');
      } finally {
        store.close();
      }
    } finally {
      ws?.terminate();
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
