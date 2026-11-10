import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture, extensionOrigin } from './helpers.js';

test('bridge rejects website origins, missing origins, and bad pairing tokens', async () => {
  const f = await fixture();
  try {
    for (const origin of [
      undefined,
      'https://evil.example',
      'https://apply.ycombinator.com',
      extensionOrigin + '\n',
    ]) {
      if (origin?.includes('\n')) continue; // Node's HTTP encoder rejects this before transmission.
      const ws = new WebSocket(f.bridge.connection().url, origin ? { origin } : {});
      ws.on('error', () => {});
      await new Promise<void>((resolve) => ws.once('close', () => resolve()));
      assert.equal(f.bridge.status().connected, false);
    }
    const ws = new WebSocket(f.bridge.connection().url, { origin: extensionOrigin });
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send(
      JSON.stringify({
        type: 'hello',
        version: 1,
        token: '0'.repeat(64),
        tabId: 1,
        origin: 'https://apply.ycombinator.com',
        allowMutations: true,
      }),
    );
    await closed;
    assert.equal(f.bridge.status().connected, false);
  } finally {
    await f.close();
  }
});

test('unknown reply IDs are ignored and successful data is correlated to the request', async () => {
  const f = await fixture();
  try {
    await f.pair(true, (message, ws) => {
      ws.send(
        JSON.stringify({
          type: 'result',
          id: '00000000-0000-4000-8000-000000000001',
          ok: true,
          data: 'wrong',
        }),
      );
      ws.send(JSON.stringify({ type: 'result', id: message.id, ok: true, data: { roots: true } }));
    });
    assert.deepEqual(await f.bridge.execute({ method: 'describeSchema' }), { roots: true });
  } finally {
    await f.close();
  }
});
