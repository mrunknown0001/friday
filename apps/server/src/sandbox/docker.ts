import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SandboxSettings } from '@friday/shared';
import { runProcess, type RunResult } from '../commands/runner.js';
import { isSecretPath, WorkspaceError } from '../workspace/paths.js';

/**
 * Command sandbox: run a project command in a throwaway Docker container instead of on this
 * machine. The container gets the project folder (read-write, so tests and builds work) and
 * nothing else from the host:
 * - no network unless the project allows it, no Docker socket, no host environment variables;
 * - credential files and folders in the project hidden (empty file / empty folder over them);
 * - .git mounted read-only, so nothing can plant hooks that would later run on the host;
 * - runs as your user id (files it writes are yours), all capabilities dropped,
 *   no-new-privileges, read-only root filesystem with a private /tmp, CPU, memory and process
 *   limits, removed when it exits.
 * It limits what a command can reach; it does not make an approved command harmless to the
 * project folder itself.
 */

/** Docker image references: lowercase name, optional tag or digest. Never starts with "-". */
export const IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9._/-]{0,200}(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

export const WORKSPACE = '/workspace';
const LABEL = 'dev.friday.sandbox';
const MAX_SCAN_ENTRIES = 20_000;
const MAX_MASKS = 200;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SECRET_DIR_NAMES = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube']);

/** Image suggested for a project, from its detected stack (Debian-based, to match host glibc). */
export function suggestImage(stack: string[]): string {
  const has = (s: string) => stack.includes(s);
  if (has('Node.js')) return 'node:22-bookworm-slim';
  if (has('PHP')) return 'php:8.4-cli';
  if (has('Python')) return 'python:3.12-slim-bookworm';
  if (has('Go')) return 'golang:1.24-bookworm';
  if (has('Rust')) return 'rust:1-slim-bookworm';
  if (has('Ruby')) return 'ruby:3.3-slim-bookworm';
  if (has('Java (Maven)')) return 'maven:3-eclipse-temurin-21';
  if (has('Deno')) return 'denoland/deno:debian';
  return 'debian:bookworm-slim';
}

function docker(args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ ok: !err, out: (err ? stderr || err.message : stdout).trim() }),
    );
  });
}

/** Docker server version, or null if the CLI or daemon is unavailable. */
export async function dockerVersion(): Promise<string | null> {
  const r = await docker(['version', '--format', '{{.Server.Version}}'], 5_000);
  return r.ok && r.out ? r.out : null;
}

export async function imagePresent(image: string): Promise<boolean> {
  if (!IMAGE_PATTERN.test(image)) return false;
  return (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).ok;
}

/** Download an image. Only ever called on an explicit user action (Settings). */
export async function pullImage(image: string): Promise<void> {
  if (!IMAGE_PATTERN.test(image)) throw new WorkspaceError('invalid_path', 'Invalid image name.');
  const r = await docker(['pull', '--quiet', image], 15 * 60_000);
  if (!r.ok) throw new WorkspaceError('unsupported', `docker pull failed: ${r.out.slice(0, 300)}`);
}

/** Label value identifying this Friday instance's containers (one per data folder). */
export function instanceLabel(dataDir: string): string {
  return createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
}

/** Remove containers a previous run of this instance left behind (crash, kill). Only ours. */
export async function cleanupSandboxes(instance: string): Promise<number> {
  const list = await docker(['ps', '-aq', '--filter', `label=${LABEL}=${instance}`]);
  const ids = list.ok ? list.out.split('\n').filter(Boolean) : [];
  if (ids.length) await docker(['rm', '-f', ...ids]);
  return ids.length;
}

export interface Masks {
  files: string[];
  dirs: string[];
  /** True if the scan stopped early (very large project); masking may be incomplete. */
  truncated: boolean;
}

/**
 * Find credential files and folders in the project, ignoring .gitignore (a .env is usually
 * ignored by git, which is exactly why it must be hidden). Symlinks are not followed.
 */
export async function findCredentials(root: string): Promise<Masks> {
  const masks: Masks = { files: [], dirs: [], truncated: false };
  let seen = 0;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_SCAN_ENTRIES) {
        masks.truncated = true;
        return;
      }
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SECRET_DIR_NAMES.has(e.name.toLowerCase())) masks.dirs.push(child);
        else if (!SKIP_DIRS.has(e.name)) await visit(child, depth + 1);
      } else if (e.isFile() && isSecretPath(child)) {
        masks.files.push(child);
      }
    }
  };
  await visit('', 0);
  return masks;
}

/** A path usable inside a --mount option (which is comma-separated). */
function mountable(p: string): string {
  if (p.includes(',') || p.includes('\n') || p.includes('"')) {
    throw new WorkspaceError(
      'unsupported',
      `The path "${p}" contains characters the sandbox cannot mount (comma, quote or newline). Run on this machine instead, or rename it.`,
    );
  }
  return p;
}

export interface SandboxRun {
  root: string;
  /** Working directory relative to the project root ("." for the root). */
  cwdRel: string;
  settings: SandboxSettings;
  argv: string[] | null;
  shellCommand: string | null;
  masks: Masks;
  gitDir: boolean;
  instance: string;
  name: string;
  uid: number;
  gid: number;
}

/** The exact `docker run` arguments for a sandboxed command (pure; tested directly). */
export function dockerRunArgs(r: SandboxRun): string[] {
  const root = mountable(r.root);
  const workdir = path.posix.join(WORKSPACE, r.cwdRel === '.' ? '' : r.cwdRel);
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    r.name,
    '--label',
    `${LABEL}=${r.instance}`,
    '--network',
    r.settings.network,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=1g',
    '--user',
    `${r.uid}:${r.gid}`,
    // A fixed, minimal environment: nothing from the host (no API keys, tokens, PATH).
    ...['HOME=/tmp', 'CI=1', 'TERM=dumb', 'NO_COLOR=1', 'FORCE_COLOR=0', 'LANG=C.UTF-8'].flatMap(
      (e) => ['--env', e],
    ),
    '--mount',
    `type=bind,src=${root},dst=${WORKSPACE}`,
  ];
  if (r.gitDir) {
    args.push('--mount', `type=bind,src=${root}/.git,dst=${WORKSPACE}/.git,readonly`);
  }
  for (const f of r.masks.files.slice(0, MAX_MASKS)) {
    args.push('--mount', `type=bind,src=/dev/null,dst=${WORKSPACE}/${mountable(f)},readonly`);
  }
  for (const d of r.masks.dirs.slice(0, MAX_MASKS)) {
    args.push('--mount', `type=tmpfs,dst=${WORKSPACE}/${mountable(d)},tmpfs-size=1m`);
  }
  args.push('--workdir', workdir, '--', r.settings.image);
  if (r.shellCommand !== null) args.push('/bin/sh', '-c', r.shellCommand);
  else args.push(...r.argv!);
  return args;
}

export function sandboxName(): string {
  return `friday-sbx-${randomBytes(6).toString('hex')}`;
}

/**
 * Run the command in a container. The docker client runs like any child process (closed stdin,
 * output streamed); on timeout or cancel the container itself is removed too, since killing the
 * client alone does not always stop it.
 */
export async function runInSandbox(
  r: SandboxRun,
  opts: { timeoutMs: number; signal: AbortSignal; onOutput?: (chunk: string) => void },
): Promise<RunResult> {
  const result = await runProcess({
    argv: ['docker', ...dockerRunArgs(r)],
    shellCommand: null,
    cwd: r.root,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
  });
  if (result.timedOut || result.cancelled || result.signal) await docker(['rm', '-f', r.name]);
  return result;
}

/** Map container paths in output back to project paths (for locations and readability). */
export function hostPaths(output: string, root: string): string {
  return output.split(`${WORKSPACE}/`).join(`${root}/`);
}
