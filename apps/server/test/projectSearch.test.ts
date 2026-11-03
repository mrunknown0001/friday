import type { SearchResultDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { cleanupProjects, makeProject, testServices } from './helpers.js';

afterEach(cleanupProjects);

const H = { host: '127.0.0.1:4317', 'x-friday-client': '1' };

describe('project search route', () => {
  it('searches by text or regex like search_code, never in credential files', async () => {
    const root = makeProject({
      'src/users.ts': 'export function getUser() {}\nexport const USER_LIMIT = 5;\n',
      'src/orders.php': '<?php function getUser() {}\n',
      '.env': 'export function getUser() {} // SECRET=abc\n',
    });
    const s = testServices();
    const project = s.projects.create('p', root);
    const app = await buildApp(s);
    const find = async (params: Record<string, string>) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/search?${new URLSearchParams(params).toString()}`,
        headers: H,
      });
      return {
        status: res.statusCode,
        body: res.json() as SearchResultDto & { error?: { message: string } },
      };
    };

    const text = await find({ q: 'getuser' });
    expect(text.status).toBe(200);
    expect(text.body.matches.map((m) => `${m.path}:${m.line}`).sort()).toEqual([
      'src/orders.php:1',
      'src/users.ts:1',
    ]);
    const regex = await find({ q: '^export (function|const) [A-Z_]+\\b', regex: '1', case: '1' });
    expect(regex.body.matches).toEqual([
      { path: 'src/users.ts', line: 2, text: 'export const USER_LIMIT = 5;' },
    ]);
    const php = await find({ q: 'getUser', glob: '*.php' });
    expect(php.body.matches.map((m) => m.path)).toEqual(['src/orders.php']);
    expect(JSON.stringify(text.body)).not.toContain('SECRET');

    const bad = await find({ q: '(unclosed', regex: '1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error!.message).toMatch(/^Invalid regex: /);
    expect((await find({ q: 'x', glob: '!*.ts' })).status).toBe(400);
  });
});
