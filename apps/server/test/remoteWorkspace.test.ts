import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browseRemote,
  checkRemoteRoot,
  RemoteWorkspace,
  resolveRemoteRoot,
} from '../src/workspace/remote.js';
import { makeProject } from './helpers.js';
import { localTransport } from './remoteHelpers.js';

function setup(files: Record<string, string> = {}) {
  const root = makeProject({
    'README.md': '# shop\n',
    'src/app.ts': 'export const answer = 42;\nconsole.log("Answer");\n',
    'src/lib/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    '.env': 'SECRET=hunter2\n',
    '.gitignore': 'storage/\n*.log\n',
    'storage/cache.txt': 'answer cached\n',
    'debug.log': 'answer logged\n',
    'node_modules/x/index.js': 'answer\n',
    ...files,
  });
  const { transport, calls } = localTransport();
  return { root, ws: new RemoteWorkspace(root, transport), calls };
}

describe('remote workspace', () => {
  it('lists like the local tree: ignored and excluded folders skipped, folders first', async () => {
    const { ws } = setup();
    const top = await ws.list('.', { maxDepth: 1, maxEntries: 100 });
    expect(top.entries.map((e) => `${e.type}:${e.rel}`)).toEqual([
      'dir:src',
      'file:.env',
      'file:.gitignore',
      'file:README.md',
    ]);
    const deep = await ws.list('src', { maxDepth: 3, maxEntries: 100 });
    expect(deep.entries.map((e) => [e.rel, e.depth])).toEqual([
      ['src/lib', 1],
      ['src/lib/math.ts', 2],
      ['src/app.ts', 1],
    ]);
    expect(deep.entries.at(-1)).toMatchObject({ size: 49, type: 'file' });
    const capped = await ws.list('.', { maxDepth: 3, maxEntries: 2 });
    expect(capped.truncated).toBe(true);
  });

  it('reads files, refuses credentials, folders and symlink escapes', async () => {
    const { root, ws } = setup();
    const f = await ws.readFile('src/app.ts', 1000);
    expect(f.rel).toBe('src/app.ts');
    expect(f.buf!.toString()).toContain('answer = 42');
    expect((await ws.readFile('src/app.ts', 10)).buf).toBeNull();
    await expect(ws.readFile('.env', 1000)).rejects.toThrow(/credentials file/);
    await expect(ws.readFile('src', 1000)).rejects.toThrow(/is a folder/);
    await expect(ws.readFile('../etc/passwd', 1000)).rejects.toThrow(/outside the project/);
    await expect(ws.readFile('nope.txt', 1000)).rejects.toThrow(/does not exist/);

    const outside = makeProject({ 'secret.txt': 'outside' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await expect(ws.readFile('link.txt', 1000)).rejects.toThrow(/outside the project/);
    // A symlink to a credentials file inside the project is refused by its real name.
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.txt'));
    await expect(ws.readFile('innocent.txt', 1000)).rejects.toThrow(/credentials file/);

    expect(await ws.stat('src')).toMatchObject({ type: 'dir', rel: 'src' });
  });

  it('searches with grep or ripgrep, never in credentials, ignored or excluded files', async () => {
    const { ws } = setup();
    const { result } = await ws.search({
      query: 'answer',
      regex: false,
      caseSensitive: false,
      path: '.',
      maxResults: 50,
    });
    const paths = result.matches.map((m) => `${m.path}:${m.line}`).sort();
    // grep doesn't know .gitignore; ripgrep (when installed) also skips storage/ and *.log.
    expect(paths).toEqual(expect.arrayContaining(['src/app.ts:1', 'src/app.ts:2']));
    expect(paths.some((p) => p.startsWith('.env') || p.startsWith('node_modules'))).toBe(false);
    const sensitive = await ws.search({
      query: 'Answer',
      regex: false,
      caseSensitive: true,
      path: 'src',
      maxResults: 50,
    });
    expect(sensitive.result.matches.map((m) => m.line)).toEqual([2]);
    const globbed = await ws.search({
      query: 'return',
      regex: true,
      caseSensitive: false,
      path: '.',
      glob: 'src/**/*.ts',
      maxResults: 50,
    });
    expect(globbed.result.matches.map((m) => m.path)).toEqual(['src/lib/math.ts']);
  });

  it('writes, keeps the mode, refuses credentials and .git, and never clobbers on move', async () => {
    const { root, ws } = setup();
    const target = await ws.resolveWrite('src/new/deep.ts');
    expect(target).toMatchObject({ rel: 'src/new/deep.ts', exists: false });
    await ws.write(target.abs, 'export {};\n');
    expect(fs.readFileSync(path.join(root, 'src/new/deep.ts'), 'utf8')).toBe('export {};\n');

    fs.chmodSync(path.join(root, 'src/app.ts'), 0o755);
    const existing = await ws.resolveWrite('src/app.ts');
    expect(existing.exists).toBe(true);
    await ws.write(existing.abs, Buffer.from('changed\n'));
    expect(fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8')).toBe('changed\n');
    expect(fs.statSync(path.join(root, 'src/app.ts')).mode & 0o777).toBe(0o755);
    // No temp files left behind.
    expect(fs.readdirSync(path.join(root, 'src')).filter((f) => f.includes('friday'))).toEqual([]);

    await expect(ws.resolveWrite('.env.local')).rejects.toThrow(/credentials file/);
    await expect(ws.resolveWrite('.git/config')).rejects.toThrow(/\.git internals/);
    await expect(ws.resolveWrite('/etc/passwd')).rejects.toThrow(/outside the project/);
    const outside = makeProject({});
    fs.symlinkSync(outside, path.join(root, 'out'));
    await expect(ws.resolveWrite('out/x.txt')).rejects.toThrow(/outside the project/);
    // The write script checks again on the server, even for a path Friday didn't resolve.
    await expect(ws.write(path.join(root, 'out', 'y.txt'), 'x')).rejects.toThrow(
      /outside the project/,
    );
    expect(fs.existsSync(path.join(outside, 'y.txt'))).toBe(false);

    const from = await ws.resolveWrite('README.md');
    const to = await ws.resolveWrite('docs/README.md');
    await ws.move(from.abs, to.abs);
    expect(fs.existsSync(path.join(root, 'docs/README.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(false);
    fs.writeFileSync(path.join(root, 'taken.md'), 'keep me');
    await expect(ws.move(to.abs, path.join(root, 'taken.md'))).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(root, 'taken.md'), 'utf8')).toBe('keep me');

    await ws.remove(to.abs);
    expect(fs.existsSync(path.join(root, 'docs/README.md'))).toBe(false);
  });

  it('runs git in the project and builds quoted command lines', async () => {
    const { root, ws } = setup();
    const r = await ws.git(['rev-parse', '--is-inside-work-tree']);
    expect(r.code).not.toBe(0); // not a repository yet
    // Runs in a login shell in the folder, with quoting intact.
    const { transport } = localTransport();
    const out = await transport.run(
      ws.commandLine(
        path.join(root, 'src'),
        { argv: ['sh', '-c', 'pwd; echo "$1"', 'x', "it's ok"], shellCommand: null },
        30,
      ),
      { timeoutMs: 20_000, signal: new AbortController().signal },
    );
    expect(out.output.trim().split('\n')).toEqual([path.join(root, 'src'), "it's ok"]);
    const shell = await transport.run(
      ws.commandLine(root, { argv: null, shellCommand: 'echo $CI && exit 3' }, 30),
      { timeoutMs: 20_000, signal: new AbortController().signal },
    );
    expect(shell.output.trim()).toBe('1');
    expect(shell.exitCode).toBe(3);
  });

  it('chooses project folders by the breadth rules', async () => {
    expect(() => checkRemoteRoot('/var/www/shop', '/home/deploy')).not.toThrow();
    expect(() => checkRemoteRoot('/home/deploy/apps/shop', '/home/deploy')).not.toThrow();
    for (const bad of [
      '/',
      '/var',
      '/srv/',
      '/etc/nginx',
      '/var/log/nginx',
      '/home/deploy',
      '/home',
      '/home/deploy/.ssh',
      'relative/path',
    ]) {
      expect(() => checkRemoteRoot(bad, '/home/deploy'), bad).toThrow();
    }
    const { transport } = localTransport();
    const project = makeProject({ 'a/b/.keep': '', 'a/.hidden/x': '' });
    const listing = await browseRemote(transport, project);
    expect(listing.path).toBe(project);
    expect(listing.folders).toEqual(['a']);
    await expect(browseRemote(transport, path.join(project, 'missing'))).rejects.toThrow(
      /does not exist/,
    );
    // Test folders live in /tmp, which is never a project folder on a server.
    await expect(resolveRemoteRoot(transport, path.join(project, 'a'))).rejects.toThrow(
      /too broad/,
    );
  });
});
