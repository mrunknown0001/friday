// Bundles the Friday server into one ESM file for the desktop app. The only node_modules shipped
// are the voice packages, which the server loads at runtime (they contain native code: ONNX
// Runtime and sharp, both N-API, so the same binaries work under Electron).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'build', 'server');
const outfile = path.join(outDir, 'index.mjs');
const rootModules = path.join(here, '..', '..', '..', 'node_modules');

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

// ------------------------------------------------------------------ voice packages

/** Declared but not loaded by the Node build (the web runtime, install-time helpers). */
const SKIP = new Set(['onnxruntime-web', 'global-agent', 'tar']);

/** Leaves out other platforms' binaries, browser builds and non-English voices. */
function keep(pkg, rel) {
  const parts = rel.split('/');
  if (parts.includes('node_modules')) return false;
  if (pkg === 'onnxruntime-node' && parts[0] === 'bin' && parts[1] === 'napi-v3')
    return (!parts[2] || parts[2] === process.platform) && (!parts[3] || parts[3] === process.arch);
  if (pkg === 'kokoro-js')
    return (
      rel !== 'dist/kokoro.web.js' &&
      !(parts[0] === 'voices' && parts[1] && !/^[ab][fm]_/.test(parts[1]))
    );
  if (pkg === '@huggingface/transformers' && parts[0] === 'dist')
    return !parts[1] || /^transformers\.node\.(c|m)?js$/.test(parts[1]);
  return true;
}

/** Node's lookup: node_modules of the package's directory, then of each parent up to the repo. */
function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    if (dir === path.dirname(rootModules)) return null;
  }
}

const libc = process.report?.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
/** A package built for the other C library (its package.json "libc" field). */
function otherLibc(dir) {
  const { libc: wants } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return Array.isArray(wants) && !wants.includes(libc);
}

const modulesOut = path.join(outDir, 'node_modules');
fs.rmSync(modulesOut, { recursive: true, force: true });
const seen = new Set();
const queue = [path.join(rootModules, 'kokoro-js')];
let bytes = 0;
while (queue.length) {
  const dir = queue.shift();
  if (seen.has(dir)) continue;
  seen.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const target = path.join(modulesOut, path.relative(rootModules, dir));
  fs.cpSync(dir, target, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(dir, src).split(path.sep).join('/');
      if (!rel) return true;
      if (!keep(pkg.name, rel)) return false;
      const st = fs.statSync(src);
      if (st.isFile()) bytes += st.size;
      return true;
    },
  });
  for (const dep of [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]) {
    if (SKIP.has(dep)) continue;
    const found = locate(dep, dir);
    // Optional dependencies for other platforms are not installed; ones for another C library
    // (musl on a glibc system) can be, and are left out.
    if (found && !otherLibc(found)) queue.push(found);
    else if (!(pkg.optionalDependencies ?? {})[dep])
      throw new Error(`${pkg.name} needs ${dep}, which is not installed.`);
  }
}
console.log(
  `Voice packages -> ${path.relative(process.cwd(), modulesOut)} (${seen.size} packages, ${Math.round(bytes / 1e6)} MB)`,
);
