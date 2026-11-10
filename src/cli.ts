#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BrowserBridge } from './bridge.js';
import { StateStore } from './store.js';
import { YCService } from './service.js';
import { createMcpServer } from './server.js';
import { DirectTransport } from './direct.js';
import type { YCTransport } from './transport.js';
import { VERSION } from './version.js';
import { Logger, type LogLevel } from './log.js';
import { doctor } from './doctor.js';
import { errorInfo, YCError } from './errors.js';
import { readPrivate } from './private-files.js';

const HELP = `yc-graphql-mcp [serve|login|doctor|connection] [options]

  --port <number>       Local browser bridge port (default 17373; 0 chooses a free port)
  --transport <mode>    direct (default) or browser (optional extension bridge)
  --auth-file <path>    Private session file captured by npm run login
  --state-dir <path>    Private operation registry and receipt journal
  --allow-mutations    Enable reviewed preview/commit (browser mode also needs its toggle)
  --log-level <level>  error, warn (default), or info; JSON diagnostics on stderr
  --help               Show this help
  --version            Show version

serve uses MCP stdio; stdout is reserved for protocol messages.
login opens Chromium for manual sign-in and saves a private session file.
doctor reports local authentication and lock health without changing state or contacting YC.
connection prints setup information (or pairing JSON in browser mode).
Default state: $XDG_STATE_HOME/yc-graphql-mcp or ~/.local/state/yc-graphql-mcp
`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      port: { type: 'string', default: process.env.YC_BRIDGE_PORT ?? '17373' },
      'state-dir': { type: 'string' },
      'allow-mutations': { type: 'boolean', default: process.env.YC_ALLOW_MUTATIONS === 'true' },
      transport: { type: 'string', default: process.env.YC_TRANSPORT ?? 'direct' },
      'auth-file': { type: 'string' },
      'log-level': { type: 'string', default: 'warn' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || !['serve', 'connection', 'login', 'doctor'].includes(command))
    throw new Error('Unknown command. Use --help.');
  const stateDir = resolve(
    values['state-dir'] ??
      process.env.YC_MCP_STATE_DIR ??
      join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'yc-graphql-mcp'),
  );
  const legacyAuth = fileURLToPath(new URL('../.yc-graphql-mcp/auth.json', import.meta.url));
  const authFile =
    values['auth-file'] ??
    process.env.YC_AUTH_FILE ??
    (existsSync(legacyAuth) ? legacyAuth : join(stateDir, 'auth.json'));
  if (!['direct', 'browser'].includes(values.transport))
    throw new Error('Transport must be direct or browser');
  if (!['error', 'warn', 'info'].includes(values['log-level']))
    throw new Error('Invalid log level');
  const logger = new Logger(values['log-level'] as LogLevel);
  if (command === 'login') {
    const { login } = await import('./login.js');
    await login(authFile);
    return;
  }
  if (command === 'doctor') {
    process.stdout.write(JSON.stringify(doctor(stateDir, authFile), null, 2) + '\n');
    return;
  }
  if (command === 'connection') {
    process.stdout.write(
      values.transport === 'direct'
        ? JSON.stringify(new DirectTransport(authFile).connection(), null, 2) + '\n'
        : readPrivate(join(stateDir, 'connection.json'), 8_000),
    );
    return;
  }
  if (!/^[0-9]{1,5}(?![\s\S])/.test(values.port)) throw new Error('Invalid port');
  const port = Number(values.port);
  if (port > 65535) throw new Error('Invalid port');
  const store = new StateStore(stateDir);
  const bridge: YCTransport =
    values.transport === 'direct'
      ? new DirectTransport(authFile, values['allow-mutations'])
      : new BrowserBridge();
  try {
    if (bridge instanceof BrowserBridge) {
      await bridge.listen(port);
      store.writeConnection(bridge.connection());
    }
  } catch (error) {
    await bridge.close();
    store.close();
    throw error;
  }
  const service = new YCService(bridge, store, values['allow-mutations']);
  const stdio = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 1_000_000,
  });
  const handle = serveStdio(() => createMcpServer(service, logger), {
    transport: stdio,
    onerror: () => logger.event('error', 'transport_error'),
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await service.shutdown();
      await handle.close();
    } finally {
      store.close();
    }
  };
  const finish = () => {
    void shutdown().catch(() => {
      logger.event('error', 'shutdown_error');
      process.exitCode = 1;
    });
  };
  const protocolClose = stdio.onclose;
  stdio.onclose = () => {
    protocolClose?.();
    finish();
  };
  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);
  process.stdin.once('end', finish);
  process.stdin.once('error', finish);
  process.stdout.once('error', finish);
  logger.event('info', 'server_ready', { mode: bridge.mode, version: VERSION });
}

main().catch((error) => {
  const info = errorInfo(
    error instanceof YCError
      ? error
      : new YCError(
          'STARTUP_FAILED',
          'Invalid configuration or unavailable resources. Use --help and doctor to inspect setup.',
        ),
  );
  process.stderr.write(JSON.stringify({ level: 'error', event: 'startup_failed', ...info }) + '\n');
  process.exitCode = 1;
});
