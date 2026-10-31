import type { ResearchDto } from '@friday/shared';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Globe,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { saveDownload } from './ExportDialog';
import { Markdown } from './Markdown';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const STATUS: Record<
  ResearchDto['status'],
  { label: string; tone: 'info' | 'success' | 'warning' | 'danger' }
> = {
  running: { label: 'researching', tone: 'info' },
  completed: { label: 'done', tone: 'success' },
  stopped: { label: 'stopped', tone: 'warning' },
  failed: { label: 'failed', tone: 'danger' },
};

const PHASE: Record<ResearchDto['phase'], string> = {
  planning: 'Planning sub-questions',
  searching: 'Searching',
  reading: 'Reading pages',
  writing: 'Writing the report',
  done: '',
};

function progress(r: ResearchDto): string {
  const read = r.sources.filter((s) => s.status === 'read').length;
  return [
    `${r.searches.length} of ${r.limits.maxSearches} searches`,
    `${read} of ${r.limits.maxPages} pages read`,
  ].join(' · ');
}

/** A deep_research call: live progress (plan, searches, pages), then the report with sources. */
export function ResearchCard({ research: r }: { research: ResearchDto }) {
  const s = STATUS[r.status];
  const running = r.status === 'running';
  const [steps, setSteps] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showSteps = steps || running;

  const save = (format: 'md' | 'docx' | 'pdf') => {
    setSaving(format);
    setError(null);
    void api
      .exportResearch(r.id, format)
      .then(({ blob, name }) => saveDownload(blob, name))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(null));
  };

  return (
    <section
      aria-label={`Research: ${s.label}`}
      className="ml-10 rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm"
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Globe className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="min-w-0 flex-1 font-medium text-zinc-200">{r.question}</h2>
        <Badge tone={s.tone}>{s.label}</Badge>
      </header>
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/70 px-3 py-1.5 text-xs text-zinc-400">
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
        <span role={running ? 'status' : undefined}>
          {running ? `${PHASE[r.phase]} · ` : ''}
          {progress(r)}
        </span>
        {running && <span className="text-zinc-500">· Stop in the composer ends it</span>}
        {!running && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 hover:text-zinc-200"
            aria-expanded={steps}
            onClick={() => setSteps(!steps)}
          >
            {steps ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Searches and pages
          </button>
        )}
      </div>
      {r.note && (
        <p
          role={r.status === 'failed' ? 'alert' : undefined}
          className="mx-3 my-2 flex gap-2 rounded-md border border-amber-900/60 bg-amber-950/30 p-2 text-xs text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
          {r.note}
        </p>
      )}
      {showSteps && (
        <div className="space-y-2 border-t border-zinc-800/70 px-3 py-2 text-xs">
          {r.subQuestions.length > 0 && (
            <section aria-label="Sub-questions">
              <h3 className="mb-0.5 font-medium text-zinc-400">Sub-questions</h3>
              <ol className="list-decimal space-y-0.5 pl-5 text-zinc-200">
                {r.subQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ol>
            </section>
          )}
          {r.searches.length > 0 && (
            <section aria-label="Searches">
              <h3 className="mb-0.5 font-medium text-zinc-400">Searches (sent to Tavily)</h3>
              <ul className="space-y-0.5">
                {r.searches.map((q, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <Search className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500" aria-hidden />
                    <span className="font-mono text-zinc-200">{q.query}</span>
                    <span className={q.error ? 'text-amber-300' : 'text-zinc-500'}>
                      {q.error ?? `${q.results} result${q.results === 1 ? '' : 's'}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {r.sources.length > 0 && (
            <section aria-label="Pages">
              <h3 className="mb-0.5 font-medium text-zinc-400">Pages</h3>
              <ul className="space-y-0.5">
                {r.sources.map((p) => (
                  <li key={p.url} className="flex items-start gap-1.5">
                    {p.status === 'read' ? (
                      <Check
                        className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400"
                        role="img"
                        aria-label="read"
                      />
                    ) : p.status === 'pending' ? (
                      <Loader2
                        className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-zinc-500"
                        role="img"
                        aria-label="reading"
                      />
                    ) : (
                      <X
                        className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500"
                        role="img"
                        aria-label="not read"
                      />
                    )}
                    <span className="min-w-0">
                      {p.n !== null && <span className="text-zinc-500">[{p.n}] </span>}
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-sky-300 hover:underline"
                      >
                        {p.title}
                      </a>{' '}
                      <span className="text-zinc-500">{p.site}</span>
                      {p.error && <span className="block text-zinc-500">{p.error}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {r.report && (
        <div className="border-t border-zinc-800/70 px-3 py-3">
          <div className="max-h-[32rem] overflow-y-auto" tabIndex={0} aria-label="Research report">
            <Markdown content={r.report} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span>Save the report:</span>
            {(['md', 'docx', 'pdf'] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant="secondary"
                className="h-6"
                disabled={!!saving}
                onClick={() => save(f)}
              >
                {saving === f ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Download className="h-3 w-3" />
                )}
                {f === 'md' ? 'Markdown' : f === 'docx' ? 'Word' : 'PDF'}
              </Button>
            ))}
            <span>From web pages: check claims before acting on them.</span>
          </div>
          {error && (
            <p role="alert" className="mt-1 text-xs text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
