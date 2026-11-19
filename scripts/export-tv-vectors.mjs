import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const esbuild = require('esbuild');
const outFile = resolve(root, '.tmp/export-tv-vectors.cjs');

esbuild.buildSync({
  entryPoints: [resolve(root, 'scripts/export-tv-vectors.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
  outfile: outFile,
});

require(outFile);
