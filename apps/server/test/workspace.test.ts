import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProject } from '../src/workspace/detect.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { looksBinary, sliceLines } from '../src/workspace/files.js';
import {
  isSecretPath,
  resolveInside,
  resolveProjectRoot,
  WorkspaceError,
} from '../src/workspace/paths.js';
import { globToRegExp, search } from '../src/workspace/search.js';
import { walk } from '../src/workspace/walk.js';
import { cleanupProjects, makeProject } from './helpers.js';

afterEach(cleanupProjects);

const code = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WorkspaceError);
  return (err as WorkspaceError).code;
};

describe('path confinement', () => {
  it('resolves paths inside the root', async () => {
    const root = makeProject({ 'src/a.ts': 'x' });
    await expect(resolveInside(root, 'src/a.ts')).resolves.toEqual({
      abs: path.join(root, 'src/a.ts'),
      rel: 'src/a.ts',
    });
    await expect(resolveInside(root, './src/../src/a.ts')).resolves.toMatchObject({
      rel: 'src/a.ts',
    });
    await expect(resolveInside(root, path.join(root, 'src'))).resolves.toMatchObject({
      rel: 'src',
    });
    await expect(resolveInside(root, '.')).resolves.toMatchObject({ rel: '.' });
  });

  it('blocks traversal and absolute paths outside the root', async () => {
    const root = makeProject({ 'a.txt': 'x' });
    expect(await code(resolveInside(root, '../outside.txt'))).toBe('outside_root');
    expect(await code(resolveInside(root, '/etc/passwd'))).toBe('outside_root');
    expect(await code(resolveInside(root, 'src/../../../etc/passwd'))).toBe('outside_root');
    expect(await code(resolveInside(root, 'a.txt\0.png'))).toBe('invalid_path');
    expect(await code(resolveInside(root, 'missing.txt'))).toBe('not_found');
  });

  it('blocks symlinks that escape the root but allows internal ones', async () => {
    const outside = makeProject({ 'secret.txt': 'top secret' });
    const root = makeProject({ 'real/file.txt': 'ok' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-out.txt'));
    fs.symlinkSync(outside, path.join(root, 'dir-out'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link-in'));
    expect(await code(resolveInside(root, 'link-out.txt'))).toBe('outside_root');
    expect(await code(resolveInside(root, 'dir-out/secret.txt'))).toBe('outside_root');
    await expect(resolveInside(root, 'link-in/file.txt')).resolves.toMatchObject({
      rel: 'real/file.txt',
    });
  });

  it('refuses credential files and git internals', async () => {
    const root = makeProject({
      '.env': 'DB_PASSWORD=x',
      '.env.production': 'x',
      '.env.example': 'DB_PASSWORD=',
      'certs/server.key': 'x',
      '.git/config': '[remote]',
    });
    expect(await code(resolveInside(root, '.env'))).toBe('secret_file');
    expect(await code(resolveInside(root, '.env.production'))).toBe('secret_file');
    expect(await code(resolveInside(root, 'certs/server.key'))).toBe('secret_file');
    expect(await code(resolveInside(root, '.git/config'))).toBe('forbidden_path');
    await expect(resolveInside(root, '.env.example')).resolves.toMatchObject({
      rel: '.env.example',
    });
  });

  it('refuses a symlink whose target is a secret file', async () => {
    const root = makeProject({ '.env': 'SECRET=1' });
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.txt'));
    expect(await code(resolveInside(root, 'innocent.txt'))).toBe('secret_file');
  });

  it('classifies secret paths', () => {
    for (const p of [
      '.env',
      'config/.env.local',
      'id_rsa',
      'a/b/.ssh/known_hosts',
      'x.pem',
      'auth.json',
      'infra/terraform.tfstate',
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    for (const p of [
      '.env.example',
      'env.ts',
      'src/key.ts',
      'id_rsa.pub',
      'keys/README.md',
      '.environment',
    ]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });
});

describe('project root authorization', () => {
  it('accepts a specific folder and canonicalizes it', async () => {
    const root = makeProject({ 'a.txt': '' });
    const viaLink = path.join(os.tmpdir(), `friday-link-${process.pid}`);
    fs.rmSync(viaLink, { force: true });
    fs.symlinkSync(root, viaLink);
    try {
      await expect(resolveProjectRoot(viaLink)).resolves.toBe(root);
    } finally {
      fs.rmSync(viaLink, { force: true });
    }
  });

  it('refuses broad or invalid locations', async () => {
    const root = makeProject({ 'file.txt': '' });
    expect(await code(resolveProjectRoot('/'))).toBe('forbidden_path');
    expect(await code(resolveProjectRoot('/etc'))).toBe('forbidden_path');
    expect(await code(resolveProjectRoot('/etc/nginx'))).toBe('forbidden_path');
    expect(await code(resolveProjectRoot(os.homedir()))).toBe('forbidden_path');
    expect(await code(resolveProjectRoot(path.dirname(os.homedir())))).toBe('forbidden_path');
    expect(await code(resolveProjectRoot('relative/path'))).toBe('invalid_path');
    expect(await code(resolveProjectRoot(path.join(root, 'file.txt')))).toBe('not_a_directory');
    expect(await code(resolveProjectRoot(path.join(root, 'nope')))).toBe('not_found');
  });
});

describe('walk', () => {
  it('honours .gitignore (including nested) and default exclusions', async () => {
    const root = makeProject({
      '.gitignore': 'logs/\n*.log\n',
      'src/index.ts': 'x',
      'src/.gitignore': 'generated.ts\n',
      'src/generated.ts': 'x',
      'app.log': 'x',
      'logs/a.txt': 'x',
      'node_modules/pkg/index.js': 'x',
      'dist/out.js': 'x',
      '.github/workflows/ci.yml': 'x',
    });
    const { entries } = await walk(root, root, { maxDepth: 5, maxEntries: 100 });
    const rels = entries.map((e) => e.rel);
    expect(rels).toContain('src/index.ts');
    expect(rels).toContain('.github/workflows/ci.yml');
    for (const hidden of [
      'src/generated.ts',
      'app.log',
      'logs',
      'logs/a.txt',
      'node_modules',
      'dist/out.js',
    ]) {
      expect(rels).not.toContain(hidden);
    }
  });

  it('applies parent .gitignore rules when starting in a subfolder', async () => {
    const root = makeProject({ '.gitignore': '*.tmp\n', 'sub/a.ts': '', 'sub/b.tmp': '' });
    const { entries } = await walk(root, path.join(root, 'sub'), { maxDepth: 2, maxEntries: 100 });
    expect(entries.map((e) => e.rel)).toEqual(['sub/a.ts']);
  });

  it('respects depth and entry limits and does not follow symlinks', async () => {
    const outside = makeProject({ 'x/y.txt': '' });
    const root = makeProject({ 'a/b/c/d.txt': '', f1: '', f2: '', f3: '' });
    fs.symlinkSync(outside, path.join(root, 'ext'));
    const shallow = await walk(root, root, { maxDepth: 1, maxEntries: 100 });
    expect(shallow.entries.map((e) => e.rel).sort()).toEqual(['a', 'ext', 'f1', 'f2', 'f3']);
    expect(shallow.entries.find((e) => e.rel === 'ext')?.type).toBe('symlink');
    const limited = await walk(root, root, { maxDepth: 5, maxEntries: 2 });
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });
});

describe('detectProject', () => {
  it('detects a Node/Vite/React project with npm', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({
        scripts: { dev: 'vite', test: 'vitest run' },
        dependencies: { react: '^19' },
        devDependencies: { vite: '^8', typescript: '^6', vitest: '^5' },
      }),
      'package-lock.json': '{}',
      Dockerfile: 'FROM node',
      '.github/workflows/ci.yml': 'on: push',
    });
    const d = await detectProject(root);
    expect(d.stack).toEqual(
      expect.arrayContaining([
        'Node.js',
        'React',
        'Vite',
        'TypeScript',
        'Vitest',
        'Docker',
        'GitHub Actions',
      ]),
    );
    expect(d.packageManagers).toEqual(['npm']);
    expect(d.scripts['package.json']).toEqual({ dev: 'vite', test: 'vitest run' });
    expect(d.isGitRepo).toBe(false);
  });

  it('detects Laravel with composer', async () => {
    const root = makeProject({
      'composer.json': JSON.stringify({
        require: { 'laravel/framework': '^12' },
        'require-dev': { 'pestphp/pest': '^3' },
      }),
      'composer.lock': '{}',
      artisan: '#!/usr/bin/env php',
      'docker-compose.yml': 'services: {}',
    });
    const d = await detectProject(root);
    expect(d.stack).toEqual(expect.arrayContaining(['PHP', 'Laravel', 'Pest', 'Docker Compose']));
    expect(d.packageManagers).toEqual(['composer']);
  });

  it('survives malformed manifests', async () => {
    const root = makeProject({ 'package.json': '{ not json' });
    const d = await detectProject(root);
    expect(d.stack).toContain('Node.js');
    expect(d.notes).toContain('package.json could not be parsed');
  });
});

describe('file helpers', () => {
  it('detects binary content', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(looksBinary(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(true);
    expect(looksBinary(Buffer.from('héllo wörld', 'utf8'))).toBe(false);
  });

  it('slices numbered lines within budgets', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const s = sliceLines(lines, 10, 12, 10_000);
    expect(s.output).toBe('10 | line 10\n11 | line 11\n12 | line 12');
    expect(s).toMatchObject({ startLine: 10, endLine: 12, totalLines: 50, truncated: true });
    const tight = sliceLines(lines, 1, 50, 40);
    expect(tight.endLine).toBeLessThan(50);
    expect(tight.truncated).toBe(true);
  });
});

describe('search', async () => {
  const env = await detectToolEnvironment();
  const engines: Array<[string, string | null]> = [['builtin', null]];
  if (env.ripgrep) engines.push(['ripgrep', env.ripgrep]);

  describe.each(engines)('%s engine', (_name, rg) => {
    const fixture = () =>
      makeProject({
        'src/app.ts': 'const token = getToken();\nexport function handler() {}\n',
        'src/util.ts': 'export const helper = () => "--version";\n',
        '.env': 'TOKEN=supersecretvalue',
        'node_modules/lib/index.js': 'getToken()',
        'README.md': 'Call getToken first',
      });

    it('finds literal matches, skipping secrets and excluded dirs', async () => {
      const root = fixture();
      const r = await search(root, rg, {
        query: 'token',
        regex: false,
        caseSensitive: false,
        targetAbs: root,
        maxResults: 50,
      });
      const files = [...new Set(r.matches.map((m) => m.path))].sort();
      expect(files).toEqual(['README.md', 'src/app.ts']);
      // The credential file's match is reported by name only; its contents never appear.
      expect(r.hiddenSecretFiles).toEqual(['.env']);
      expect(JSON.stringify(r)).not.toContain('supersecretvalue');
      expect(r.matches.find((m) => m.path === 'src/app.ts')).toMatchObject({ line: 1 });
    });

    it('treats queries starting with "-" as text, not flags', async () => {
      const root = fixture();
      const r = await search(root, rg, {
        query: '--version',
        regex: false,
        caseSensitive: true,
        targetAbs: root,
        maxResults: 10,
      });
      expect(r.matches.map((m) => m.path)).toEqual(['src/util.ts']);
    });

    it('applies globs and result limits', async () => {
      const root = fixture();
      const r = await search(root, rg, {
        query: 'e',
        regex: false,
        caseSensitive: false,
        targetAbs: root,
        glob: '*.md',
        maxResults: 50,
      });
      expect(new Set(r.matches.map((m) => m.path))).toEqual(new Set(['README.md']));
      const limited = await search(root, rg, {
        query: 'e',
        regex: false,
        caseSensitive: false,
        targetAbs: root,
        maxResults: 1,
      });
      expect(limited.matches).toHaveLength(1);
      expect(limited.truncated).toBe(true);
    });
  });

  it('refuses regex mode without ripgrep (no ReDoS-prone fallback)', async () => {
    const root = makeProject({ 'a.txt': 'aaaa' });
    await expect(
      search(root, null, {
        query: '(a+)+$',
        regex: true,
        caseSensitive: false,
        targetAbs: root,
        maxResults: 5,
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('converts globs to anchored patterns', () => {
    expect(globToRegExp('**/*.test.ts').test('src/a/b.test.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
    expect(globToRegExp('routes/*.php').test('routes/web.php')).toBe(true);
    expect(globToRegExp('a.(b)').test('a.(b)')).toBe(true);
  });
});
