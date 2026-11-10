import { build } from 'esbuild';
import { mkdir, copyFile, chmod } from 'node:fs/promises';

await mkdir('extension/dist', { recursive: true });
await Promise.all([
  ...['manifest.json', 'popup.html', 'popup.css'].map((file) =>
    copyFile(`extension/${file}`, `extension/dist/${file}`),
  ),
  build({
    entryPoints: [
      'src/browser/service-worker.ts',
      'src/browser/popup.ts',
      'src/browser/page-runtime.ts',
    ],
    outdir: 'extension/dist',
    bundle: true,
    platform: 'browser',
    target: 'chrome116',
    format: 'iife',
    sourcemap: true,
    legalComments: 'eof',
  }),
  chmod('dist/cli.js', 0o755),
]);
// Standalone console client: loading makes no requests. Same implementation as the extension.
await build({
  entryPoints: ['src/browser/page-runtime.ts'],
  outfile: 'dist/yc-client.js',
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  format: 'iife',
  legalComments: 'eof',
});
