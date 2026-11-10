import { taskSchema, type BrowserTask } from '../protocol.js';
import type { YCGraphQLClient } from './client.js';

interface Pairing {
  url: string;
  token: string;
  tabId: number;
  allowMutations: boolean;
}
let socket: WebSocket | undefined;
let pairing: Pairing | undefined;
let ready = false;
let busy = false;
let lastError = '';

// This function is serialized by chrome.scripting. Keep it free of module closures.
async function inPage(task: BrowserTask) {
  try {
    if (location.origin !== 'https://apply.ycombinator.com')
      return { ok: false as const, error: { code: 'WRONG_ORIGIN', message: 'Wrong origin' } };
    const client = (window as unknown as { ycGraphQL: YCGraphQLClient }).ycGraphQL;
    let data: unknown;
    switch (task.method) {
      case 'request':
        data = await client.request(task.input);
        break;
      case 'describeSchema':
        data = await client.describeSchema();
        break;
      case 'describeType':
        data = await client.describeType(task.name, task.includeDeprecated);
        break;
      case 'introspectSchema':
        data = await client.introspectSchema();
        break;
      case 'inspectEditability':
        data = await client.inspectEditability(task.appUuid);
        break;
      case 'inspectLoadedScripts':
        data = await client.inspectLoadedScripts(task.input);
        break;
    }
    return { ok: true as const, data };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'BROWSER_ERROR';
    return {
      ok: false as const,
      error: { code, message: 'Browser operation failed. Inspect the selected tab.' },
    };
  }
}

async function run(task: BrowserTask, config: Pairing) {
  const tab = await chrome.tabs.get(config.tabId);
  if (!tab.url || new URL(tab.url).origin !== 'https://apply.ycombinator.com' || tab.pendingUrl)
    throw new Error('TAB_UNAVAILABLE');
  if (task.method === 'request' && task.input.allowMutation && !config.allowMutations)
    throw new Error('MUTATION_BLOCKED');
  const installed = await chrome.scripting.executeScript({
    target: { tabId: config.tabId },
    world: 'MAIN',
    files: ['page-runtime.js'],
  });
  const documentId = installed.find((r) => r.frameId === 0)?.documentId;
  if (!documentId) throw new Error('TAB_UNAVAILABLE');
  const result = await chrome.scripting.executeScript({
    target: { tabId: config.tabId, documentIds: [documentId] },
    world: 'MAIN',
    func: inPage,
    args: [task],
  });
  const value = result[0]?.result;
  if (!value) throw new Error('TAB_UNAVAILABLE');
  return value;
}

function validatePairing(value: unknown): Pairing {
  if (!value || typeof value !== 'object')
    throw new Error('Paste the pairing JSON from the MCP server.');
  const config = value as Pairing;
  const url = new URL(config.url);
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/bridge' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Bridge must be ws://127.0.0.1:<port>/bridge.');
  if (
    typeof config.token !== 'string' ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(config.token) ||
    !Number.isInteger(config.tabId) ||
    config.tabId < 0 ||
    typeof config.allowMutations !== 'boolean'
  )
    throw new Error('Invalid pairing configuration.');
  return {
    url: url.href,
    token: config.token,
    tabId: config.tabId,
    allowMutations: config.allowMutations,
  };
}

async function connect(value: unknown) {
  const config = validatePairing(value);
  const tab = await chrome.tabs.get(config.tabId);
  if (!tab.url || new URL(tab.url).origin !== 'https://apply.ycombinator.com')
    throw new Error('Select a signed-in YC tab.');
  if (busy) throw new Error('Wait for the running browser operation before changing the pairing.');
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    const previous = socket;
    await new Promise<void>((resolve) => {
      previous.addEventListener('close', () => resolve(), { once: true });
      previous.close();
    });
  }
  pairing = config;
  ready = false;
  lastError = '';
  const ws = new WebSocket(config.url);
  socket = ws;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timed out. Check that the MCP server is running.'));
    }, 6_000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: 1,
          token: config.token,
          tabId: config.tabId,
          origin: 'https://apply.ycombinator.com',
          allowMutations: config.allowMutations,
        }),
      );
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        ws.close();
        return;
      }
      if (message.type === 'ready') {
        ready = true;
        clearTimeout(timer);
        resolve();
        return;
      }
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (
        !ready ||
        message.type !== 'task' ||
        typeof message.id !== 'string' ||
        !/^[a-f0-9-]{36}(?![\s\S])/.test(message.id)
      ) {
        ws.close();
        return;
      }
      const parsed = taskSchema.safeParse(message.task);
      if (!parsed.success || busy) {
        ws.close();
        return;
      }
      busy = true;
      void run(parsed.data, config)
        .then((result) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'result', id: message.id, ...result }));
        })
        .catch((error) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: 'result',
                id: message.id,
                ok: false,
                error: {
                  code:
                    error instanceof Error &&
                    ['MUTATION_BLOCKED', 'TAB_UNAVAILABLE'].includes(error.message)
                      ? error.message
                      : 'TAB_UNAVAILABLE',
                  message: 'Browser task failed.',
                },
              }),
            );
        })
        .finally(() => {
          busy = false;
        });
    };
    ws.onerror = () => {
      lastError = 'Cannot reach the local MCP server.';
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (socket === ws) {
        ready = false;
        lastError ||= 'Disconnected. Reconnect when the MCP server is ready.';
      }
      reject(
        new Error(lastError || 'Pairing rejected. Check the token and other connected browsers.'),
      );
    };
  });
  await chrome.storage.session.set({ pairing: config });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))
    return false;
  void (async () => {
    if (message?.type === 'status')
      return {
        connected: ready,
        busy,
        tabId: pairing?.tabId ?? null,
        allowMutations: pairing?.allowMutations ?? false,
        error: lastError,
      };
    if (message?.type === 'connect') {
      await connect(message.config);
      return { connected: true };
    }
    if (message?.type === 'disconnect') {
      if (busy) throw new Error('Wait for the running operation before disconnecting.');
      socket?.close();
      pairing = undefined;
      ready = false;
      await chrome.storage.session.remove('pairing');
      return { connected: false };
    }
    throw new Error('Unknown extension command.');
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Extension operation failed.',
      }),
    );
  return true;
});

// Service-worker suspension can drop the bridge. Restoring the connection never replays tasks.
void chrome.storage.session
  .get('pairing')
  .then((stored) => {
    if (stored.pairing) return connect(stored.pairing);
  })
  .catch(() => {
    lastError = 'Reconnect the extension to the running MCP server.';
  });
