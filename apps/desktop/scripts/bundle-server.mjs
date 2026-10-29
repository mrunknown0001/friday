// Bundles the Friday server into one ESM file for the desktop app, so the package ships no
// node_modules (and, with node:sqlite, no native code).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'build', 'server', 'index.mjs');

await build({
  entryPoints: [path.join(here, '..', '..', 'server', 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'linked',
  logLevel: 'warning',
  // Some dependencies are CommonJS and call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __fridayCreateRequire } from 'node:module'; const require = __fridayCreateRequire(import.meta.url);",
  },
});
console.log(`Bundled server -> ${path.relative(process.cwd(), outfile)}`);
