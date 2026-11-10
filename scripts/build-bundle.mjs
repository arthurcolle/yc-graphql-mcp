import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { zipSync, unzipSync } from 'fflate';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('registry/manifest.json', 'utf8'));
assert.equal(manifest.version, pkg.version);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(
  JSON.parse(readFileSync('registry/mcpb-manifest.schema.json', 'utf8')),
);
assert.ok(validate(manifest), JSON.stringify(validate.errors));
const directory = mkdtempSync(join(tmpdir(), 'yc-bundle-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const packed = JSON.parse(
    execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      encoding: 'utf8',
      maxBuffer: 4_000_000,
    }),
  )[0];
  for (const file of packed.files)
    assert.ok(
      !/(^|\/)(\.yc-graphql-mcp|auth\.json|receipts\.jsonl|server\.lock|\.env)(\/|$)/.test(
        file.path,
      ),
    );
  const server = join(directory, 'payload', 'server');
  mkdirSync(server, { recursive: true });
  execFileSync(
    npm,
    [
      'install',
      '--prefix',
      server,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(directory, packed.filename),
    ],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 4_000_000 },
  );
  const files = {};
  let total = 0;
  const entry = (body) => [new Uint8Array(body), { mtime: new Date('2026-01-01T00:00:00Z') }];
  function collect(path, relative = '') {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const name = relative ? relative + '/' + item.name : item.name;
      if (item.name === '.bin' || item.name === '.package-lock.json') continue;
      const source = join(path, item.name);
      assert.ok(!item.isSymbolicLink(), 'Unexpected bundle symlink');
      if (item.isDirectory()) {
        collect(source, name);
        continue;
      }
      assert.ok(item.isFile());
      const size = lstatSync(source).size;
      total += size;
      assert.ok(total <= 100_000_000 && size <= 20_000_000, 'Bundle exceeds build limits');
      files['server/node_modules/' + name] = entry(readFileSync(source));
    }
  }
  collect(join(server, 'node_modules'));
  files['manifest.json'] = entry(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  files['README.md'] = entry(readFileSync('docs/bundle.md'));
  const zipped = zipSync(files, { level: 6 });
  assert.ok(zipped.length <= 30_000_000);
  const extracted = join(directory, 'extracted');
  mkdirSync(extracted);
  for (const [name, content] of Object.entries(unzipSync(zipped))) {
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
    const path = join(extracted, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const client = new Client({ name: 'mcp-bundle-install-check', version: pkg.version });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(extracted, manifest.server.entry_point),
      '--auth-file',
      join(directory, 'missing-auth.json'),
      '--state-dir',
      join(directory, 'smoke-state'),
    ],
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 22);
    const status = (await client.callTool({ name: 'yc_status', arguments: {} })).structuredContent;
    assert.equal(status.ok, true);
    assert.equal(status.data.connected, false);
    assert.equal(status.data.serverMutationsEnabled, false);
  } finally {
    await client.close();
  }
  mkdirSync('artifacts', { recursive: true });
  const filename = `yc-graphql-mcp-${pkg.version}.mcpb`;
  writeFileSync(join('artifacts', filename), zipped);
  const hash = createHash('sha256').update(zipped).digest('hex');
  const metadata = JSON.parse(readFileSync('registry/server.template.json', 'utf8'));
  assert.equal(metadata.name, pkg.mcpName);
  assert.equal(metadata.version, pkg.version);
  metadata.packages = [
    {
      registryType: 'mcpb',
      identifier: `https://github.com/arthurcolle/yc-graphql-mcp/releases/download/v${pkg.version}/${filename}`,
      fileSha256: hash,
      transport: { type: 'stdio' },
    },
  ];
  writeFileSync('artifacts/server.json', JSON.stringify(metadata, null, 2) + '\n');
  writeFileSync('artifacts/SHA256SUMS', hash + '  ' + filename + '\n');
  console.log(
    JSON.stringify({
      bundle: filename,
      bytes: zipped.length,
      entries: Object.keys(files).length,
      sha256: hash,
      manifestValidated: true,
      extractedCliVerified: true,
      tools: 22,
      privateFilesIncluded: false,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
