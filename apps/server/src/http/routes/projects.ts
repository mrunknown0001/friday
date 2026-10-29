import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CodeMapStatusDto,
  FileViewDto,
  ProjectDto,
  ProjectOverviewDto,
  SandboxStatusDto,
  SystemInfoDto,
  TreeEntryDto,
} from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectRecord } from '../../repositories/projects.js';
import type { Services } from '../../services.js';
import {
  dockerVersion,
  IMAGE_PATTERN,
  imagePresent,
  pullImage,
  suggestImage,
} from '../../sandbox/docker.js';
import { detectProject } from '../../workspace/detect.js';
import { languageFor, loadFile } from '../../workspace/files.js';
import {
  assertRootAvailable,
  resolveInside,
  resolveProjectRoot,
  WorkspaceError,
} from '../../workspace/paths.js';
import { walk } from '../../workspace/walk.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const idParams = z.object({ id: z.uuid() });
const VIEWER_MAX_BYTES = 1024 * 1024;

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
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorkspaceError)
      throw new HttpError(WORKSPACE_STATUS[err.code], err.code, err.message);
    throw err;
  }
}

export function registerProjectRoutes(app: FastifyInstance, s: Services) {
  const toDto = async (p: ProjectRecord): Promise<ProjectDto> => ({
    ...p,
    available: await assertRootAvailable(p.rootPath).then(
      () => true,
      () => false,
    ),
  });

  const requireProject = (id: string): ProjectRecord => {
    const p = s.projects.get(id);
    if (!p) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return p;
  };

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
      }),
      req.body,
    );
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
    const project = requireProject(id);
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
    return sandboxStatus(requireProject(id));
  });

  app.put('/api/projects/:id/sandbox', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const body = parseInput(
      z.object({ enabled: z.boolean(), image, network: z.enum(['none', 'bridge']) }),
      req.body,
    );
    requireProject(id);
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
    const project = requireProject(id);
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
    const project = requireProject(id);
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

  // File explorer for the UI. Uses the same confinement rules as the agent's tools.
  app.get('/api/projects/:id/tree', async (req) => {
    const { id } = parseInput(idParams, req.params);
    const q = parseInput(z.object({ path: z.string().max(4096).default('.') }), req.query);
    const project = requireProject(id);
    return guarded(async () => {
      await assertRootAvailable(project.rootPath);
      const target = await resolveInside(project.rootPath, q.path);
      if (!(await fs.stat(target.abs)).isDirectory()) {
        throw new WorkspaceError('not_a_directory', 'Not a directory.');
      }
      const { entries, truncated } = await walk(project.rootPath, target.abs, {
        maxDepth: 1,
        maxEntries: 500,
      });
      const out: TreeEntryDto[] = entries.map((e) => ({
        name: e.name,
        path: e.rel,
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
      await assertRootAvailable(project.rootPath);
      const target = await resolveInside(project.rootPath, q.path);
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
}
