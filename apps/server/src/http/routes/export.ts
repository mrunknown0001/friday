import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CaptureError } from '../../browser/capture.js';
import { documentHtml, pdfFooter } from '../../documents/html.js';
import { parseMarkdown } from '../../documents/markdown.js';
import { toMessageDto } from '../../repositories/messages.js';
import { toRunDto } from '../../repositories/runs.js';
import { conversationMarkdown } from '../../reports/export.js';
import type { Services } from '../../services.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';

/** A file name from the conversation title: letters, digits, dots and dashes only. */
export function exportFileName(title: string, day: string, ext: string): string {
  const slug =
    title
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || 'conversation';
  return `${slug}-${day}.${ext}`;
}

/**
 * Download a conversation as Markdown or PDF. A user action from the UI (never a model tool):
 * messages, tool calls, approvals and run reports, redacted like everything else Friday shows.
 */
export function registerExportRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/sessions/:id/export', async (req, reply) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const q = parseInput(
      z.object({
        format: z.enum(['md', 'pdf']).default('md'),
        detail: z.enum(['summary', 'full']).default('summary'),
        tz: z.coerce.number().int().min(-720).max(840).default(0),
      }),
      req.query,
    );
    const session = s.sessions.get(id);
    if (!session) throw new HttpError(404, 'session_not_found', 'Conversation not found.');
    if (q.format === 'pdf' && !s.capture)
      throw new HttpError(
        409,
        'pdf_unavailable',
        'PDF export needs a browser engine: use the desktop app, or set FRIDAY_CHROME. Markdown export works everywhere.',
      );

    const project = session.projectId ? s.projects.get(session.projectId) : null;
    const now = new Date();
    const markdown = s.redactor.redact(
      conversationMarkdown({
        title: session.title,
        createdAt: session.createdAt,
        project: project ? { name: project.name, rootPath: project.rootPath } : null,
        messages: s.messages.listBySession(id).map(toMessageDto),
        approvals: s.approvalRepo.listBySession(id),
        runs: s.runs.listBySession(id).map(toRunDto),
        detail: q.detail,
        tzOffsetMinutes: q.tz,
        now,
      }),
    );
    const day = new Date(now.getTime() + q.tz * 60_000).toISOString().slice(0, 10);

    let data: Buffer;
    let type: string;
    if (q.format === 'md') {
      data = Buffer.from(markdown, 'utf8');
      type = 'text/markdown; charset=utf-8';
    } else {
      // The document header shows the title and date; the Markdown's own title line is dropped.
      const blocks = parseMarkdown(markdown.replace(/^# .*\n/, ''));
      try {
        data = await s.capture!.engine.printPdf(
          documentHtml(
            { title: session.title, subtitle: 'Conversation with Friday', date: day },
            blocks,
          ),
          { footerHtml: pdfFooter(session.title) },
        );
      } catch (err) {
        if (err instanceof CaptureError) throw new HttpError(502, 'pdf_failed', err.message);
        throw err;
      }
      type = 'application/pdf';
    }

    s.audit.record({
      sessionId: id,
      actor: 'user',
      action: 'session_exported',
      details: { format: q.format, detail: q.detail },
    });
    const name = exportFileName(session.title, day, q.format);
    reply
      .header('Content-Type', type)
      .header(
        'Content-Disposition',
        `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header('Cache-Control', 'no-store');
    return reply.send(data);
  });
}
