import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CodeMapStatusDto,
  FileViewDto,
  ProjectDto,
  ProjectOverviewDto,
  SandboxStatusDto,
  SearchResultDto,
  SystemInfoDto,
  TreeEntryDto,
} from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectRecord } from '../../repositories/projects.js';
import type { Services } from '../../services.js';
import { projectDto, remoteFor, transportFor } from '../../workspace/projectAccess.js';
import { resolveRemoteRoot } from '../../workspace/remote.js';
import {
  dockerVersion,
  IMAGE_PATTERN,
  imagePresent,
  pullImage,
  suggestImage,
} from '../../sandbox/docker.js';
import { imageInfo } from '../../attachments/image.js';
import { DesktopEngine } from '../../browser/capture.js';
import { detectProject } from '../../workspace/detect.js';
import { languageFor, loadFile, looksBinary } from '../../workspace/files.js';
import {
  assertRootAvailable,
  MAX_EXTERNAL_FOLDERS,
  resolveExternalFolder,
  resolveProjectRoot,
  resolveRead,
  shownPath,
  WorkspaceError,
  workspaceOf,
} from '../../workspace/paths.js';
import { search } from '../../workspace/search.js';
import { walk } from '../../workspace/walk.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const idParams = z.object({ id: z.uuid() });
const VIEWER_MAX_BYTES = 1024 * 1024;
const RAW_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DOCUMENTS = /\.(pdf|docx|xlsx|pptx)$/i;
const OPENABLE = /\.(pdf|docx|xlsx|pptx|png|jpe?g|webp|gif|svg)$/i;

const WORKSPACE_STATUS: Record<WorkspaceError['code'], number> = {
  outside_root: 403,
  secret_file: 403,
  forbidden_path: 403,
  not_found: 404,
  not_a_file: 400,
  not_a_directory: 400,
  invalid_path: 400,
  root_unavailable: 409,
  too_large: 413,
  unsupported: 400,
};

/** Map workspace errors to HTTP errors; their messages are safe to show. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkspaceError)
      throw new HttpError(WORKSPACE_STATUS[err.code], err.code, err.message);
    throw err;
  }
}

export function registerProjectRoutes(app: FastifyInstance, s: Services) {
  const toDto = (p: ProjectRecord): Promise<ProjectDto> => projectDto(p, s.sshHosts);

  const requireProject = (id: string): ProjectRecord => {
    const p = s.projects.get(id);
    if (!p) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return p;
  };
  /** Features that need the project's files on this machine. */
  const requireLocal = (id: string, what: string): ProjectRecord => {
    const p = requireProject(id);
    if (p.sshHostId)
      throw new HttpError(
        409,
        'remote_project',
        `${what} is not available for a project on an SSH host.`,
      );
    return p;
  };
  const sshAccess = { hosts: s.sshHosts, ssh: s.ssh };
  /** The project's workspace on its SSH host, or null for a project on this machine. */
  const remoteOf = (p: ProjectRecord) => remoteFor(p, sshAccess);

  app.get('/api/system', async (): Promise<SystemInfoDto> => ({
    ripgrep: s.toolEnv.ripgrepVersion,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    agentLimits: s.config.agent,
  }));

  app.get('/api/projects', async () => ({
    projects: await Promise.all(s.projects.list().map(toDto)),
  }));

  // Adding a project is the user's explicit authorization for read-only tools inside that folder.
  app.post('/api/projects', async (req, reply) => {
    const body = parseInput(
      z.object({
        path: z.string().trim().min(1).max(4096),
        name: z.string().trim().min(1).max(100).optional(),
        /** A folder on this SSH host instead of on this machine. */
        hostId: z.uuid().optional(),
      }),
      req.body,
    );
    if (body.hostId) {
      const host = s.sshHosts.get(body.hostId);
      if (!host) throw new HttpError(404, 'host_not_found', 'SSH host not found.');
      if (host.trustedFingerprints.length === 0)
        throw new HttpError(
          409,
          'host_untrusted',
          `Trust ${host.name}'s host key in Settings → SSH hosts first.`,
        );
      const root = await guarded(() => resolveRemoteRoot(transportFor(s.ssh, host), body.path));
      const existing = s.projects.getByRoot(root, host.id);
      if (existing) {
        reply.code(200);
        return toDto(existing);
      }
      const project = s.projects.create(body.name ?? path.posix.basename(root), root, host.id);
      s.audit.record({
        actor: 'user',
        action: 'project_authorized',
        details: { projectId: project.id, root, host: host.name, hostname: host.hostname },
      });
      reply.code(201);
      return toDto(project);
    }
    const root = await guarded(() => resolveProjectRoot(body.path));
    const existing = s.projects.getByRoot(root);
    if (existing) {
      reply.code(200);
      return toDto(existing);
    }
    const project = s.projects.create(body.name ?? path.basename(root), root);
    s.audit.record({
      actor: 'user',
      action: 'project_authorized',
      details: { projectId: project.id, root },
    });
    reply.code(201);
    return toDto(project);
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
    requireProject(id);
    s.projects.rename(id, body.name);
    return toDto(s.projects.get(id)!);
  });

  // ---- code map (per project) ----

  /** Index status; `refresh` brings it up to date first (the tools do this on every use anyway). */
  app.get('/api/projects/:id/codemap', async (req): Promise<CodeMapStatusDto> => {
    const { id } = parseInput(idParams, req.params);
    const project = requireProject(id);
    return { ...s.codeMap.status(project.id), lastRefresh: s.codeMap.lastRefresh(project.id) };
  });

  /** Rebuild the index from scratch (user action). */
  app.post('/api/projects/:id/codemap/rebuild', async (req): Promise<CodeMapStatusDto> => {
    const { id } = parseInput(idParams, req.params);
    const project = requireLocal(id, 'The code map');
    await assertRootAvailable(project.rootPath);
    s.codeMap.clear(project.id);
    await s.codeMap.refresh(project, { force: true });
    return { ...s.codeMap.status(project.id), lastRefresh: s.codeMap.lastRefresh(project.id) };
  });

  // ---- command sandbox (per project) ----
  const image = z.string().trim().regex(IMAGE_PATTERN, 'not a valid Docker image name');

  const sandboxStatus = async (p: ProjectRecord): Promise<SandboxStatusDto> => {
    // Re-checked on demand: Docker may have been started after Friday.
    s.toolEnv.docker = await dockerVersion();
    const detected = await detectProject(p.rootPath).catch(() => null);
    const suggestedImage = suggestImage(detected?.stack ?? []);
    const wanted = p.sandbox?.image ?? suggestedImage;
    return {
      docker: s.toolEnv.docker,
      suggestedImage,
      imagePresent: s.toolEnv.docker ? await imagePresent(wanted) : null,
    };
  };

  app.get('/api/projects/:id/sandbox', async (req) => {
    const { id } = parseInput(idParams, req.params);
    return sandboxStatus(requireLocal(id, 'The command sandbox'));
  });

  app.put('/api/projects/:id/sandbox', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(
      z.object({ enabled: z.boolean(), image, network: z.enum(['none', 'bridge']) }),
      req.body,
    );
    requireLocal(id, 'The command sandbox');
    s.projects.setSandbox(id, body);
    s.audit.record({
      actor: 'user',
      action: 'project_sandbox_changed',
      details: { projectId: id, ...body },
    });
    return toDto(s.projects.get(id)!);
  });

  /** Download an image: only ever on this explicit user action, never by the agent. */
  app.post('/api/projects/:id/sandbox/pull', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(z.object({ image }), req.body);
    const project = requireLocal(id, 'The command sandbox');
    if (!(await dockerVersion()))
      throw new HttpError(409, 'docker_unavailable', 'Docker is not reachable.');
    await guarded(() => pullImage(body.image));
    s.audit.record({
      actor: 'user',
      action: 'sandbox_image_pulled',
      details: { projectId: id, image: body.image },
    });
    return sandboxStatus({
      ...project,
      sandbox: { enabled: false, network: 'none', image: body.image },
    });
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const project = requireProject(id);
    const active = s.projects.worktrees(id).filter((w) => w.worktree?.status === 'active');
    if (active.length)
      throw new HttpError(
        409,
        'active_worktrees',
        `This project has ${active.length} task worktree${active.length > 1 ? 's' : ''} in progress. Accept or discard ${active.length > 1 ? 'them' : 'it'} first.`,
      );
    s.projects.delete(id);
    s.audit.record({
      actor: 'user',
      action: 'project_removed',
      details: { projectId: id, root: project.rootPath },
    });
    reply.code(204);
  });

  app.get('/api/projects/:id/overview', async (req): Promise<ProjectOverviewDto> => {
    const { id } = parseInput(idParams, req.params);
    const project = requireLocal(id, 'The project overview');
    await guarded(() => assertRootAvailable(project.rootPath));
    const d = await detectProject(project.rootPath);
    return {
      project: await toDto(project),
      stack: d.stack,
      packageManagers: d.packageManagers,
      manifests: d.manifests,
      isGitRepo: d.isGitRepo,
    };
  });

  // ---- external folders (per project) ----

  /**
   * Replace the project's external folders. Adding one is the user's authorization for the agent
   * to read it; writes there still go through an approval each.
   */
  app.put('/api/projects/:id/external-folders', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(
      z.object({
        folders: z.array(z.string().trim().min(1).max(4096)).max(MAX_EXTERNAL_FOLDERS),
      }),
      req.body,
    );
    const project = requireLocal(id, 'External folders');
    const folders: string[] = [];
    for (const f of body.folders) {
      const real = await guarded(() => resolveExternalFolder(f, project.rootPath, folders));
      folders.push(real);
    }
    const before = project.externalFolders;
    s.projects.setExternalFolders(id, folders);
    const added = folders.filter((f) => !before.includes(f));
    const removed = before.filter((f) => !folders.includes(f));
    if (added.length || removed.length)
      s.audit.record({
        actor: 'user',
        action: 'project_external_folders_changed',
        details: { projectId: id, added, removed },
      });
    return toDto(s.projects.get(id)!);
  });

  // File explorer for the UI. Uses the same confinement rules as the agent's tools (external
  // folders by absolute path).
  app.get('/api/projects/:id/tree', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const q = parseInput(z.object({ path: z.string().max(4096).default('.') }), req.query);
    const project = requireProject(id);
    return guarded(async () => {
      const remote = remoteOf(project);
      if (remote) {
        const listed = await remote.list(q.path, { maxDepth: 1, maxEntries: 500 });
        const out: TreeEntryDto[] = listed.entries.map((e) => ({
          name: e.name,
          path: e.rel,
          type: e.type,
          size: e.size,
        }));
        return { path: listed.rel, entries: out, truncated: listed.truncated };
      }
      await assertRootAvailable(project.rootPath);
      const target = await resolveRead(workspaceOf(project), q.path);
      if (!(await fs.stat(target.abs)).isDirectory()) {
        throw new WorkspaceError('not_a_directory', 'Not a directory.');
      }
      const { entries, truncated } = await walk(target.root, target.abs, {
        maxDepth: 1,
        maxEntries: 500,
      });
      const out: TreeEntryDto[] = entries.map((e) => ({
        name: e.name,
        path: shownPath(target, e.rel),
        type: e.type,
        size: e.size,
      }));
      return { path: target.rel, entries: out, truncated };
    });
  });

  app.get('/api/projects/:id/file', async (req): Promise<FileViewDto> => {
    const { id } = parseInput(idParams, req.params);
    const q = parseInput(z.object({ path: z.string().min(1).max(4096) }), req.query);
    const project = requireProject(id);
    return guarded(async () => {
      const remote = remoteOf(project);
      if (remote) {
        const f = await remote.readFile(q.path, VIEWER_MAX_BYTES);
        const binary = !!f.buf && looksBinary(f.buf);
        return {
          path: f.rel,
          size: f.size,
          binary,
          tooLarge: !f.buf,
          content: f.buf && !binary ? f.buf.toString('utf8') : null,
          language: languageFor(f.rel),
        };
      }
      await assertRootAvailable(project.rootPath);
      const target = await resolveRead(workspaceOf(project), q.path);
      const file = await loadFile(target.abs, VIEWER_MAX_BYTES);
      return {
        path: target.rel,
        size: file.size,
        binary: file.binary,
        tooLarge: file.tooLarge,
        content: file.text,
        language: languageFor(target.rel),
      };
    });
  });

  /** The search panel: the same search as search_code (credential files are never searched). */
  app.get('/api/projects/:id/search', async (req, reply): Promise<SearchResultDto> => {
    const { id } = parseInput(idParams, req.params);
    const q = parseInput(
      z.object({
        q: z.string().min(1).max(500),
        regex: z.enum(['0', '1']).default('0'),
        case: z.enum(['0', '1']).default('0'),
        glob: z
          .string()
          .max(200)
          .regex(/^[^!\0]/, 'glob must not start with "!"')
          .optional(),
      }),
      req.query,
    );
    const project = requireProject(id);
    // A new search (the user kept typing) ends this one.
    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    return guarded(async () => {
      const remote = remoteOf(project);
      if (remote) {
        const found = await remote.search({
          query: q.q,
          regex: q.regex === '1',
          caseSensitive: q.case === '1',
          path: '.',
          glob: q.glob,
          maxResults: 200,
          signal: gone.signal,
        });
        return found.result;
      }
      await assertRootAvailable(project.rootPath);
      return search(project.rootPath, s.toolEnv.ripgrep, {
        query: q.q,
        regex: q.regex === '1',
        caseSensitive: q.case === '1',
        targetAbs: project.rootPath,
        ...(q.glob ? { glob: q.glob } : {}),
        maxResults: 200,
        signal: gone.signal,
      });
    });
  });

  /** Generated documents (and images) as downloads, for the browser version. */
  app.get('/api/projects/:id/download', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const q = parseInput(z.object({ path: z.string().min(1).max(4096) }), req.query);
    const project = requireProject(id);
    const { data, name } = await guarded(async () => {
      const remote = remoteOf(project);
      if (remote) {
        if (!OPENABLE.test(q.path))
          throw new WorkspaceError('unsupported', 'Only documents and images can be downloaded.');
        const f = await remote.readFile(q.path, DOWNLOAD_MAX_BYTES);
        if (!f.buf) throw new WorkspaceError('too_large', 'File too large.');
        return { data: f.buf, name: path.posix.basename(f.rel) };
      }
      await assertRootAvailable(project.rootPath);
      const target = await resolveRead(workspaceOf(project), q.path);
      if (!OPENABLE.test(target.rel))
        throw new WorkspaceError('unsupported', 'Only documents and images can be downloaded.');
      const stat = await fs.stat(target.abs);
      if (!stat.isFile()) throw new WorkspaceError('not_a_file', 'Not a file.');
      if (stat.size > DOWNLOAD_MAX_BYTES) throw new WorkspaceError('too_large', 'File too large.');
      return { data: await fs.readFile(target.abs), name: path.basename(target.rel) };
    });
    reply
      .header('Content-Type', 'application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header('Cache-Control', 'no-store');
    return reply.send(data);
  });

  /** Open a generated document in the system's default app (desktop app only; a user action). */
  app.post('/api/projects/:id/open', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(z.object({ path: z.string().min(1).max(4096) }), req.body);
    const project = requireLocal(id, 'Opening files');
    const engine = s.capture?.engine;
    if (!(engine instanceof DesktopEngine))
      throw new HttpError(
        409,
        'not_desktop',
        'Opening files needs the desktop app; download it instead.',
      );
    const abs = await guarded(async () => {
      await assertRootAvailable(project.rootPath);
      const target = await resolveRead(workspaceOf(project), body.path);
      if (!DOCUMENTS.test(target.rel))
        throw new WorkspaceError(
          'unsupported',
          'Only PDF, Word, Excel and PowerPoint files can be opened.',
        );
      if (!(await fs.stat(target.abs)).isFile())
        throw new WorkspaceError('not_a_file', 'Not a file.');
      return target.abs;
    });
    try {
      await engine.openPath(abs);
    } catch (err) {
      throw new HttpError(502, 'open_failed', err instanceof Error ? err.message : String(err));
    }
    s.audit.record({ actor: 'user', action: 'document_opened', details: { path: body.path } });
    return { opened: true };
  });

  /**
   * An image file's bytes for the viewer. The type comes from the content (raster formats) or, for
   * SVG, from the extension plus an <svg> root; SVG is served with a sandboxing CSP so any script
   * in it can never run, even if the file is opened directly.
   */
  app.get('/api/projects/:id/raw', async (req, reply) => {
    const { id } = parseInput(idParams, req.params);
    const q = parseInput(z.object({ path: z.string().min(1).max(4096) }), req.query);
    const project = requireProject(id);
    const { data, mime } = await guarded(async () => {
      const remote = remoteOf(project);
      let data: Buffer;
      let rel: string;
      if (remote) {
        const f = await remote.readFile(q.path, RAW_IMAGE_MAX_BYTES);
        if (!f.buf) throw new WorkspaceError('too_large', 'Image too large to preview.');
        data = f.buf;
        rel = f.rel;
      } else {
        await assertRootAvailable(project.rootPath);
        const target = await resolveRead(workspaceOf(project), q.path);
        const stat = await fs.stat(target.abs);
        if (!stat.isFile()) throw new WorkspaceError('not_a_file', 'Not a file.');
        if (stat.size > RAW_IMAGE_MAX_BYTES)
          throw new WorkspaceError('too_large', 'Image too large to preview.');
        data = await fs.readFile(target.abs);
        rel = target.rel;
      }
      const info = imageInfo(data);
      if (info) return { data, mime: info.mime as string };
      if (/\.svg$/i.test(rel) && /<svg[\s>]/i.test(data.subarray(0, 4096).toString('utf8')))
        return { data, mime: 'image/svg+xml' };
      throw new WorkspaceError('unsupported', 'Not a PNG, JPEG, WebP, GIF or SVG image.');
    });
    reply
      .header('Content-Type', mime)
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Security-Policy',
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
    return reply.send(data);
  });
}
