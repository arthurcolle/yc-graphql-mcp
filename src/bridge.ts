import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { helloSchema, replySchema, taskSchema, type BrowserTask } from './protocol.js';
import { YCError } from './errors.js';

export interface BrowserTarget {
  connectionId: string;
  tabId: number;
  origin: string;
  allowMutations: boolean;
}
interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class BrowserBridge {
  readonly mode = 'browser' as const;
  readonly token = randomBytes(32).toString('hex');
  private http: Server;
  private wss: WebSocketServer;
  private socket: WebSocket | undefined;
  private target: BrowserTarget | undefined;
  private pending = new Map<string, Pending>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private port = 0;
  private closed = false;
  private lastPong = Date.now();
  constructor(private readonly timeoutMs = 35_000) {
    this.http = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 2_100_000,
      perMessageDeflate: false,
    });
    this.http.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin ?? '';
      const host = req.headers.host;
      if (
        this.closed ||
        this.wss.clients.size >= 8 ||
        req.url !== '/bridge' ||
        host !== `127.0.0.1:${this.port}` ||
        !/^chrome-extension:\/\/[a-p]{32}(?![\s\S])/.test(origin)
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }
  async listen(port = 17373) {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, '127.0.0.1', () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('Invalid bridge address');
    this.port = address.port;
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        if (Date.now() - this.lastPong > 60_000) this.socket.terminate();
        else this.socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20_000);
    this.heartbeat.unref();
  }
  connection() {
    return { url: `ws://127.0.0.1:${this.port}/bridge`, token: this.token };
  }
  status() {
    return {
      mode: this.mode,
      connected: !this.closed && this.socket?.readyState === WebSocket.OPEN,
      target: this.target ? { ...this.target } : null,
      pendingRequests: this.pending.size,
    };
  }
  currentTarget(): BrowserTarget {
    if (this.closed || !this.target || this.socket?.readyState !== WebSocket.OPEN)
      throw new YCError(
        'BROWSER_DISCONNECTED',
        'Pair the extension with this server and select your signed-in YC tab.',
      );
    return { ...this.target };
  }
  private accept(ws: WebSocket) {
    let authenticated = false;
    const timer = setTimeout(() => ws.close(1008, 'Authentication required'), 5_000);
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        ws.close(1008, 'Invalid JSON');
        return;
      }
      if (!authenticated) {
        const hello = helloSchema.safeParse(value);
        if (
          !hello.success ||
          !timingSafeEqual(Buffer.from(hello.data.token), Buffer.from(this.token))
        ) {
          ws.close(1008, 'Authentication failed');
          return;
        }
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          ws.close(1008, 'A browser is already paired');
          return;
        }
        clearTimeout(timer);
        authenticated = true;
        this.socket = ws;
        this.lastPong = Date.now();
        this.target = {
          connectionId: randomUUID(),
          tabId: hello.data.tabId,
          origin: hello.data.origin,
          allowMutations: hello.data.allowMutations,
        };
        ws.send(JSON.stringify({ type: 'ready', connectionId: this.target.connectionId }));
        return;
      }
      if (value && typeof value === 'object' && 'type' in value && value.type === 'pong') {
        this.lastPong = Date.now();
        return;
      }
      const reply = replySchema.safeParse(value);
      if (!reply.success) {
        ws.close(1008, 'Invalid result');
        return;
      }
      const pending = this.pending.get(reply.data.id);
      if (!pending) return; // Late replies never revive timed-out mutations.
      pending.cleanup();
      if (reply.data.ok) pending.resolve(reply.data.data);
      else {
        // Only known codes/messages are forwarded; the page cannot inject instructions via errors.
        const known: Record<string, string> = {
          AUTH_REQUIRED: 'YC rejected authentication. Sign in manually in the selected tab.',
          GRAPHQL_ERROR: 'YC returned a GraphQL error. Check the observed operation and variables.',
          INVALID_RESPONSE: 'YC did not return a valid GraphQL response. Check the signed-in tab.',
          HTTP_ERROR: 'YC returned an HTTP error. Stop and inspect the signed-in tab.',
          TIMEOUT: 'The browser request timed out. No automatic retry was made.',
          MUTATION_UNCERTAIN:
            'Mutation outcome is uncertain. Do not retry. Read the application again.',
          MUTATION_BLOCKED: 'Mutations are disabled in the browser extension.',
          WRONG_ORIGIN: 'The selected tab is no longer on apply.ycombinator.com.',
          RESPONSE_TOO_LARGE: 'YC response exceeds the local limit. Request fewer fields.',
          NETWORK_ERROR: 'The browser request failed. Check the signed-in tab.',
          TAB_UNAVAILABLE: 'The selected YC tab is unavailable. Select it again in the extension.',
          RATE_LIMITED: 'YC rate limited the request. No automatic retry was made.',
          CSRF_REJECTED: 'YC rejected the request or CSRF token. Refresh the signed-in session.',
          RESPONSE_TOO_COMPLEX:
            'YC response exceeds the nesting or node limit. Request fewer fields.',
          CANCELLED: 'The browser operation was cancelled.',
          INVALID_APPLICATION: 'A valid application UUID is required.',
          INVALID_EDIT_FORM: 'YC edit metadata is invalid or does not match the application.',
          EDITABILITY_UNAVAILABLE:
            'No recognized edit forms were found. No writable fields were inferred.',
        };
        const code = Object.hasOwn(known, reply.data.error.code)
          ? reply.data.error.code
          : 'BROWSER_ERROR';
        pending.reject(
          new YCError(code, known[code] ?? 'Browser execution failed. Inspect the selected tab.'),
        );
      }
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.target = undefined;
      this.failPending(
        new YCError(
          'BROWSER_DISCONNECTED',
          'Browser disconnected. In-flight mutations have uncertain outcomes; do not retry.',
        ),
      );
    });
  }
  async execute(
    task: BrowserTask,
    signal?: AbortSignal,
    expectedConnectionId?: string,
  ): Promise<unknown> {
    taskSchema.parse(task);
    const target = this.currentTarget();
    if (expectedConnectionId && target.connectionId !== expectedConnectionId)
      throw new YCError('TARGET_CHANGED', 'The browser pairing changed after preview.');
    if (signal?.aborted)
      throw new YCError('CANCELLED', 'Request cancelled before browser dispatch.');
    if (this.pending.size)
      throw new YCError(
        'BRIDGE_BUSY',
        'A browser request is already running. Wait for its outcome.',
      );
    if (task.method === 'request' && task.input.allowMutation && !this.target?.allowMutations)
      throw new YCError(
        'MUTATION_BLOCKED',
        'Enable mutations in the extension before preparing this change.',
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        cleanup();
        this.socket?.close(1011, 'Request cancelled');
        reject(
          new YCError(
            'CANCELLED',
            'Stopped waiting for browser execution. Dispatched requests may still finish; never retry a mutation blindly.',
          ),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        // Disconnect on timeout to prevent new work racing an operation still running in the page.
        this.socket?.close(1011, 'Request deadline exceeded');
        reject(
          new YCError(
            'BRIDGE_TIMEOUT',
            'Browser deadline exceeded. In-flight mutations are uncertain; read the application before further changes.',
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket!.send(JSON.stringify({ type: 'task', id, task }), (error) => {
        if (error && this.pending.has(id)) {
          cleanup();
          reject(
            new YCError(
              'BROWSER_DISCONNECTED',
              'Browser dispatch failed. The mutation outcome may be uncertain.',
            ),
          );
        }
      });
    });
  }
  private failPending(error: Error) {
    for (const pending of [...this.pending.values()]) {
      pending.cleanup();
      pending.reject(error);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.failPending(
      new YCError('SERVER_STOPPED', 'Server stopped. In-flight mutations are uncertain.'),
    );
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
