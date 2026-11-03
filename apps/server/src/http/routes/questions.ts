import type { EnhancePromptResult, QuestionDto } from '@friday/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enhancePrompt, MAX_DRAFT_CHARS } from '../../chat/enhance.js';
import { ProviderError } from '../../providers/errors.js';
import { MAX_ANSWER_CHARS } from '../../questions/service.js';
import type { Services } from '../../services.js';
import { detectProject } from '../../workspace/detect.js';
import { assertRootAvailable } from '../../workspace/paths.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

/** Clarifying questions: answering the agent's (ask_user), and improving a draft before sending. */
export function registerQuestionRoutes(app: FastifyInstance, s: Services) {
  app.post('/api/questions/:id/answer', async (req): Promise<QuestionDto> => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const body = parseInput(
      z.union([
        z.strictObject({ sessionId: z.uuid(), skip: z.literal(true) }),
        z.strictObject({
          sessionId: z.uuid(),
          answers: z
            .array(
              z.strictObject({
                selected: z.array(z.string().max(200)).max(10),
                text: z.string().max(MAX_ANSWER_CHARS).nullable(),
              }),
            )
            .min(1)
            .max(3),
        }),
      ]),
      req.body,
    );
    return s.questions.answer(id, body);
  });

  app.post('/api/enhance', async (req, reply): Promise<EnhancePromptResult> => {
    const body = parseInput(
      z.strictObject({
        draft: z.string().max(MAX_DRAFT_CHARS),
        projectId: z.uuid().nullable(),
        sessionId: z.uuid().nullable(),
        answers: z
          .array(
            z.strictObject({
              question: z.string().max(300),
              answer: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
            }),
          )
          .max(3)
          .optional(),
        noQuestions: z.boolean().optional(),
      }),
      req.body,
    );
    if (!body.draft.trim())
      throw new HttpError(400, 'empty_draft', 'Write something to improve first.');
    if (!s.provider.isConfigured())
      throw new HttpError(400, 'not_configured', new ProviderError('not_configured').message);
    const model = s.modelSettings.resolve().model;
    if (!model) throw new HttpError(400, 'model_not_selected', 'Select a model in Settings first.');

    const session = body.sessionId ? s.sessions.get(body.sessionId) : null;
    if (body.sessionId && !session)
      throw new HttpError(404, 'session_not_found', 'Session not found.');
    // A conversation's project is fixed; a new one uses the project picked in the sidebar.
    const projectId = session ? session.projectId : body.projectId;
    const project = projectId ? s.projects.get(projectId) : null;
    if (projectId && !project) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const detection = project
      ? await assertRootAvailable(project.rootPath)
          .then(() => detectProject(project.rootPath))
          .catch(() => null)
      : null;
    const history = session
      ? s.messages
          .listBySession(session.id)
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
          .slice(-6)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
      : [];

    const gone = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) gone.abort();
    });
    return enhancePrompt({
      provider: s.provider,
      redactor: s.redactor,
      model,
      sessionId: session?.id ?? null,
      draft: body.draft,
      project: project ? { name: project.name, detection } : null,
      history,
      answers: body.answers ?? [],
      noQuestions: body.noQuestions ?? false,
      signal: gone.signal,
    });
  });
}
