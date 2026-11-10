import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// Inspect the index that will actually be committed, not a possibly different
// working-tree copy. Never print matching values or private account content.
const entries = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .map((line) => {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== '0') throw new Error('Unmerged or invalid Git index.');
    return { mode: match[1], path: match[3] };
  });
if (!entries.length) throw new Error('Stage the intended public files first.');
const forbidden = new Set();
const privateRoot = '.yc-graphql-mcp';
const authFile = join(privateRoot, 'auth.json');
if (existsSync(authFile)) {
  const auth = JSON.parse(readFileSync(authFile, 'utf8'));
  for (const value of [
    auth.cookie,
    auth.csrfToken,
    ...(auth.cookie ?? '').split(';').map((pair) => pair.slice(pair.indexOf('=') + 1)),
  ])
    if (typeof value === 'string' && value.length >= 8) forbidden.add(value);
}
// Catch private application/founder identifiers too, without baking any of them
// into the scanner, source code, or output. Public CI has no private directory.
function privateIdentifiers(directory) {
  if (!existsSync(directory)) return;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) privateIdentifiers(path);
    else if (item.isFile() && /\.jsonl?$/.test(item.name) && lstatSync(path).size <= 20_000_000) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\b[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\b/gi))
        forbidden.add(match[0]);
    }
  }
}
privateIdentifiers(privateRoot);
const scriptAllowlist = new Set([
  'build-browser.mjs',
  'build-bundle.mjs',
  'clean.mjs',
  'verify-package.mjs',
  'verify-public.mjs',
  'live-smoke.mjs',
]);
const issues = [];
for (const { mode, path } of entries) {
  if (!['100644', '100755'].includes(mode)) issues.push({ path, kind: 'non-regular file' });
  if (
    /(^|\/)(\.yc-graphql-mcp|node_modules|\.env(?:\..*)?|auth\.json|server\.lock|receipts\.jsonl)(\/|$)/i.test(
      path,
    ) ||
    /^(examples|artifacts|dist|extension\/dist)\//.test(path) ||
    (path.startsWith('scripts/') && !scriptAllowlist.has(path.slice(8)))
  )
    issues.push({ path, kind: 'private or generated path' });
  const body = execFileSync('git', ['show', ':' + path], { maxBuffer: 24_000_000 });
  for (const value of forbidden)
    if (body.includes(Buffer.from(value))) {
      issues.push({ path, kind: 'known private credential or identifier' });
      break;
    }
  const source = body.toString('utf8');
  if (
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk_live_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(
      source,
    )
  )
    issues.push({ path, kind: 'credential pattern' });
  if (/\/Users\/[^/\s]+\//.test(source)) issues.push({ path, kind: 'private local path' });
}
if (issues.length) {
  console.error(JSON.stringify({ publicTree: 'blocked', issues }, null, 2));
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      publicTree: 'passed',
      stagedFiles: entries.length,
      knownPrivateValuesChecked: forbidden.size,
    }),
  );
