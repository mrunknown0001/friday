import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CaptureError } from '../../browser/capture.js';
import { renderDocx } from '../../documents/docx.js';
import { documentHtml, pdfFooter } from '../../documents/html.js';
import { parseMarkdown } from '../../documents/markdown.js';
import type { Services } from '../../services.js';
import { webSettingsSchema } from '../../web/service.js';
import { HttpError } from '../errors.js';
import { parseInput } from '../validation.js';
import { exportFileName } from './export.js';

/** Settings → Web, and saving a research report as a document. */
export function registerWebRoutes(app: FastifyInstance, s: Services) {
  app.get('/api/web', async () => s.web.status());

  app.put('/api/web/settings', async (req) => {
    const settings = s.web.setSettings(parseInput(webSettingsSchema, req.body));
    s.audit.record({ actor: 'user', action: 'web_settings_changed', details: { ...settings } });
    return settings;
  });

  app.get('/api/research/:id/export', async (req, reply) => {
    const { id } = parseInput(z.object({ id: z.uuid() }), req.params);
    const { format } = parseInput(
      z.object({ format: z.enum(['md', 'docx', 'pdf']).default('md') }),
      req.query,
    );
    const research = s.research.get(id);
    if (!research?.report)
      throw new HttpError(404, 'report_not_found', 'This research has no report.');
    const day = (research.finishedAt ?? research.startedAt).slice(0, 10);
    const title =
      research.question.length > 90 ? `${research.question.slice(0, 87)}…` : research.question;
    const markdown = s.redactor.redact(research.report);
    const meta = { title, subtitle: 'Research by Friday', date: day };
    let data: Buffer;
    let type: string;
    if (format === 'md') {
      data = Buffer.from(`# ${title}\n\n_Research by Friday, ${day}_\n\n${markdown}\n`, 'utf8');
      type = 'text/markdown; charset=utf-8';
    } else if (format === 'docx') {
      data = await renderDocx(meta, parseMarkdown(markdown));
      type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else {
      if (!s.capture)
        throw new HttpError(
          409,
          'pdf_unavailable',
          'PDF export needs a browser engine: use the desktop app, or set FRIDAY_CHROME. Markdown and Word work everywhere.',
        );
      try {
        data = await s.capture.engine.printPdf(documentHtml(meta, parseMarkdown(markdown)), {
          footerHtml: pdfFooter(title),
        });
      } catch (err) {
        if (err instanceof CaptureError) throw new HttpError(502, 'pdf_failed', err.message);
        throw err;
      }
      type = 'application/pdf';
    }
    s.audit.record({
      sessionId: research.sessionId,
      actor: 'user',
      action: 'research_exported',
      details: { format },
    });
    const name = exportFileName(`research-${research.question}`, day, format);
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
