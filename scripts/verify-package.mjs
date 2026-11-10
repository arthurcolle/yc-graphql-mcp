import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const directory = mkdtempSync(join(tmpdir(), 'yc-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const result = JSON.parse(
    execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      encoding: 'utf8',
      maxBuffer: 4_000_000,
    }),
  )[0];
  const files = result.files.map((file) => file.path);
  assert.equal(result.files.find((file) => file.path === 'dist/cli.js').mode & 0o111, 0o111);
  assert.ok(
    files.includes('dist/cli.js') &&
      files.includes('dist/login.js') &&
      files.includes('dist/index.d.ts'),
  );
  for (const file of files) {
    assert.ok(
      !/(^|\/)(\.yc-graphql-mcp|auth\.json|server\.lock|\.env)(\/|$)/.test(file),
      `Private data in package: ${file}`,
    );
    assert.ok(
      !file.startsWith('scripts/') && !file.startsWith('test/'),
      `Development/admin code in package: ${file}`,
    );
    assert.ok(
      file === 'package.json' ||
        file === 'LICENSE' ||
        file === 'README.md' ||
        ['CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'].includes(file) ||
        file.startsWith('dist/') ||
        file.startsWith('extension/dist/') ||
        file.startsWith('docs/assets/') ||
        ['docs/tool-contract.md', 'docs/operations.md'].includes(file),
    );
  }
  const installed = join(directory, 'installed');
  mkdirSync(installed);
  execFileSync(
    npm,
    [
      'install',
      '--prefix',
      installed,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(directory, result.filename),
    ],
    { encoding: 'utf8', maxBuffer: 4_000_000, timeout: 120_000 },
  );
  const root = join(installed, 'node_modules', 'yc-graphql-mcp');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '2.0.0');
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { VERSION, DirectTransport, StateStore } from 'yc-graphql-mcp'; if (VERSION !== '2.0.0' || !DirectTransport || !StateStore) process.exit(1);",
    ],
    { cwd: installed },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(root, 'dist', 'cli.js'),
      '--state-dir',
      join(directory, 'state'),
      '--auth-file',
      join(directory, 'missing-auth.json'),
    ],
    cwd: installed,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'production-install-smoke', version: '1' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 17);
    const status = await client.callTool({ name: 'yc_status', arguments: {} });
    assert.equal(status.structuredContent.ok, true);
    assert.equal(status.structuredContent.data.connected, false);
    assert.equal((await client.listResources()).resources.length, 4);
    assert.equal((await client.listPrompts()).prompts.length, 2);
  } finally {
    await client.close();
  }
  const doctor = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve(root, 'dist/cli.js'),
        'doctor',
        '--state-dir',
        join(directory, 'state'),
        '--auth-file',
        join(directory, 'missing-auth.json'),
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(doctor.authentication.connected, false);
  console.log(
    JSON.stringify({
      productionInstall: 'passed',
      version: '2.0.0',
      tools: 17,
      packagedFiles: files.length,
      privateFilesIncluded: false,
      devDependenciesRequired: false,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
