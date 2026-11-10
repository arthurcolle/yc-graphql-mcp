import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { BrowserBridge } from '../src/bridge.js';
import { StateStore } from '../src/store.js';
import { YCService } from '../src/service.js';

export const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32);
export async function fixture(options: { mutations?: boolean; timeoutMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'yc-mcp-'));
  const bridge = new BrowserBridge(options.timeoutMs ?? 1000);
  await bridge.listen(0);
  const store = new StateStore(directory);
  const service = new YCService(bridge, store, options.mutations ?? false);
  let ws: WebSocket | undefined;
  return {
    directory,
    bridge,
    store,
    service,
    async pair(allowMutations = true, onTask?: (message: any, ws: WebSocket) => void) {
      ws = new WebSocket(bridge.connection().url, { origin: extensionOrigin });
      await once(ws, 'open');
      const authenticated = once(ws, 'message');
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: 1,
          token: bridge.token,
          tabId: 7,
          origin: 'https://apply.ycombinator.com',
          allowMutations,
        }),
      );
      await authenticated;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'task') onTask?.(message, ws!);
      });
      return ws;
    },
    async close() {
      ws?.terminate();
      await bridge.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
