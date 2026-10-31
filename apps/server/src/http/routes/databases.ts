import path from 'node:path';
import type { DbConnectionDto, DbConnectionInput, DbConnectionTestResult } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DbError, testConnection } from '../../databases/clients.js';
import { secretVarProblem } from '../../databases/service.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$/;
const IDENT = /^[\w$.@-]{1,128}$/;

// strictObject: unknown fields (e.g. "password") are rejected outright.
const connectionInput = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[\w.-]+$/, 'letters, digits, . _ - only'),
  engine: z.enum(['postgres', 'mysql', 'sqlite']),
  projectId: z.uuid().nullable().default(null),
  environment: z.enum(['development', 'staging', 'production']),
  host: z.string().trim().regex(HOST, 'invalid host').nullable().default(null),
  port: z.number().int().min(1).max(65_535).nullable().default(null),
  database: z.string().trim().regex(IDENT, 'invalid database name').nullable().default(null),
  username: z.string().trim().regex(IDENT, 'invalid user name').nullable().default(null),
  secretVar: z.string().trim().max(128).nullable().default(null),
  secretKind: z.enum(['password', 'url']).default('password'),
  ssl: z.enum(['disable', 'require', 'verify']).default('disable'),
  path: z.string().trim().min(1).max(4_096).nullable().default(null),
});

/**
 * Database connections are created, changed and deleted only here, by the user through the UI.
 * Requests never carry a secret: only the name of the variable that holds it.
 */
export function registerDatabaseRoutes(app: FastifyInstance, s: Services) {
  const check = (body: DbConnectionInput, exceptId: string | null): DbConnectionInput => {
    const same = s.dbConnections.byName(body.name);
    if (same && same.id !== exceptId)
      throw new HttpError(
        409,
        'connection_exists',
        `A connection named "${body.name}" already exists.`,
      );
    if (body.projectId && !s.projects.get(body.projectId))
      throw new HttpError(400, 'project_not_found', 'That project does not exist.');
    if (body.secretVar) {
      const problem = secretVarProblem(body.secretVar);
      if (problem) throw new HttpError(400, 'invalid_secret_var', problem);
    }
    if (body.engine === 'sqlite') {
      if (!body.path) throw new HttpError(400, 'path_required', 'Give the SQLite database file.');
      if (!path.isAbsolute(body.path) && !body.projectId)
        throw new HttpError(
          400,
          'invalid_path',
          'Use an absolute path, or pick the project the file belongs to.',
        );
      return {
        ...body,
        host: null,
        port: null,
        database: null,
        username: null,
        secretVar: null,
        secretKind: 'password',
        ssl: 'disable',
      };
    }
    if (body.secretKind === 'url') {
      if (!body.secretVar)
        throw new HttpError(
          400,
          'invalid_secret_var',
          'Give the variable that holds the connection URL.',
        );
      return { ...body, host: null, port: null, database: null, username: null, path: null };
    }
    if (!body.host) throw new HttpError(400, 'invalid_host', 'Give the database host.');
    if (!body.username) throw new HttpError(400, 'invalid_user', 'Give the database user.');
    return { ...body, port: body.port ?? (body.engine === 'postgres' ? 5432 : 3306), path: null };
  };

  const requireConnection = (id: string): DbConnectionDto => {
    const c = s.dbConnections.get(id);
    if (!c) throw new HttpError(404, 'connection_not_found', 'Database connection not found.');
    return c;
  };

  const audited = (c: DbConnectionDto) => ({
    name: c.name,
    engine: c.engine,
    environment: c.environment,
    secretVar: c.secretVar,
  });

  app.get('/api/databases', async () => ({ connections: s.dbConnections.list() }));

  app.post('/api/databases', async (req, reply) => {
    const body = check(parseInput(connectionInput, req.body), null);
    const c = s.dbConnections.create(body);
    s.audit.record({ actor: 'user', action: 'db_connection_added', details: audited(c) });
    reply.code(201);
    return c;
  });

  app.put('/api/databases/:id', async (req) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    requireConnection(id);
    const body = check(parseInput(connectionInput, req.body), id);
    const c = s.dbConnections.update(id, body)!;
    s.audit.record({ actor: 'user', action: 'db_connection_changed', details: audited(c) });
    return c;
  });

  app.delete('/api/databases/:id', async (req, reply) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const c = requireConnection(id);
    s.dbConnections.delete(id);
    s.audit.record({ actor: 'user', action: 'db_connection_removed', details: { name: c.name } });
    reply.code(204);
  });

  app.post('/api/databases/:id/test', async (req): Promise<DbConnectionTestResult> => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const c = requireConnection(id);
    try {
      return await testConnection(s.databases.target(c));
    } catch (err) {
      if (err instanceof DbError) return { ok: false, message: err.message, warnings: [] };
      throw err;
    }
  });
}
