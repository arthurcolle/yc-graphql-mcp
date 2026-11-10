import { rmSync } from 'node:fs';
for (const path of ['dist', 'extension/dist']) rmSync(path, { recursive: true, force: true });
