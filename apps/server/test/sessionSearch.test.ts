import type { SessionSearchResultDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { snippetAround } from '../src/repositories/sessions.js';
import { makeProject, testServices } from './helpers.js';

const H = { host: '127.0.0.1:4317', 'x-friday-client': '1' };
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const s = testServices();
  app = await buildApp(s);
  const project = s.projects.create('shop', makeProject({ 'README.md': '# shop' }));
  const say = (sessionId: string, role: 'user' | 'assistant' | 'tool', content: string) =>
    s.messages.insert({ sessionId, role, content, status: 'complete' });
  const deploy = s.sessions.create('Deploy to staging', project.id);
  say(deploy.id, 'user', 'How do we roll out?');
  const redis = s.sessions.create('Caching', project.id);
  say(redis.id, 'user', 'Should we add Redis for sessions?');
  say(
    redis.id,
    'assistant',
    `Yes. ${'Background. '.repeat(20)}Redis keeps sessions warm across restarts.`,
  );
  const tool = s.sessions.create('Logs', project.id);
  say(tool.id, 'tool', 'redis connection refused');
  const loose = s.sessions.create('Redis questions');
  const search = async (q: string, scope: string = project.id) => {
    const res = await app!.inject({
      method: 'GET',
      url: `/api/sessions/search?q=${encodeURIComponent(q)}&project=${scope}`,
      headers: H,
    });
    return {
      status: res.statusCode,
      results: (res.json() as { results: SessionSearchResultDto[] }).results,
    };
  };
  return { s, project, deploy, redis, tool, loose, search };
}

describe('conversation search', () => {
  it('matches titles and user/assistant messages in the project, newest first', async () => {
    const { redis, deploy, loose, search, s } = await setup();
    const { results } = await search('REDIS');
    // Tool output isn't searched, and the conversation without a project is out of scope.
    expect(results.map((r) => r.session.id)).toEqual([redis.id]);
    expect(results[0]).toMatchObject({ titleMatch: false });
    // The latest matching message, trimmed around the match.
    expect(results[0]!.snippet).toMatch(/^….*Redis keeps sessions warm across restarts\.$/);
    expect(results[0]!.snippet!.length).toBeLessThan(200);

    const deploys = await search('staging');
    expect(deploys.results).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({ id: deploy.id }),
        titleMatch: true,
        snippet: null,
      }),
    ]);
    expect((await search('redis', 'none')).results.map((r) => r.session.id)).toEqual([loose.id]);

    s.sessions.touch(deploy.id);
    expect((await search('o')).results[0]!.session.id).toBe(deploy.id);
  });

  it('treats % and _ literally and refuses an empty query', async () => {
    const { s, project, search } = await setup();
    const pct = s.sessions.create('Discount 100% off', project.id);
    expect((await search('%')).results.map((r) => r.session.id)).toEqual([pct.id]);
    expect((await search('_')).results).toEqual([]);
    expect((await search('   ')).status).toBe(400);
  });

  it('cuts snippets on a single line', () => {
    expect(snippetAround('short\n\nnote', 'note')).toBe('short note');
    const long = `${'a '.repeat(100)}needle${' b'.repeat(100)}`;
    const cut = snippetAround(long, 'needle');
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toContain('needle');
  });
});
