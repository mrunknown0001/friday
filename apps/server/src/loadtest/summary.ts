import type { LatencySummary, LoadTestDto } from '@friday/shared';
import { BODY_CHECK, INTERNAL_CONDITIONS, STATUS_CHECK, type LoadPlan } from './script.js';

/** Reading the summary k6 hands to handleSummary (written as JSON by the generated script). */

interface Metric {
  type?: string;
  contains?: string;
  values?: Record<string, number>;
  thresholds?: Record<string, { ok?: boolean }>;
}

interface Group {
  checks?:
    | Array<{ name?: string; passes?: number; fails?: number }>
    | Record<string, { name?: string; passes?: number; fails?: number }>;
  groups?: Group[] | Record<string, Group>;
}

export interface K6Summary {
  metrics?: Record<string, Metric>;
  root_group?: Group;
  state?: { testRunDurationMs?: number };
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

function latency(m: Metric | undefined): LatencySummary | null {
  const v = m?.values;
  if (!v || typeof v.avg !== 'number') return null;
  return {
    avg: round(v.avg),
    med: round(v.med ?? 0),
    p90: round(v['p(90)'] ?? 0),
    p95: round(v['p(95)'] ?? 0),
    p99: round(v['p(99)'] ?? 0),
    max: round(v.max ?? 0),
  };
}

/** What a threshold measured: "p(95)<500" → the p(95) value, "rate<0.01" → the rate. */
function actual(m: Metric, condition: string): string | null {
  const stat = /^\s*([a-z]+(?:\(\d+(?:\.\d+)?\))?)\s*[<>=!]/.exec(condition)?.[1];
  const v = stat ? m.values?.[stat] : undefined;
  if (typeof v !== 'number') return null;
  if (m.contains === 'time') return `${round(v)} ms`;
  if (m.type === 'rate') return `${round(v * 100, 2)}%`;
  return String(round(v, 2));
}

function checksOf(g: Group | undefined, out: LoadTestDto['checks'] = []): LoadTestDto['checks'] {
  if (!g) return out;
  const list = Array.isArray(g.checks) ? g.checks : Object.values(g.checks ?? {});
  for (const c of list)
    out.push({ name: c.name ?? '?', passes: c.passes ?? 0, fails: c.fails ?? 0 });
  const groups = Array.isArray(g.groups) ? g.groups : Object.values(g.groups ?? {});
  for (const child of groups) checksOf(child, out);
  return out;
}

export type ParsedSummary = Pick<
  LoadTestDto,
  'vusMax' | 'requests' | 'rate' | 'failedRate' | 'latency' | 'perRequest' | 'thresholds' | 'checks'
> & { durationMs: number; thresholdsFailed: boolean };

export function parseSummary(data: K6Summary, plan: LoadPlan): ParsedSummary {
  const m = data.metrics ?? {};
  const allChecks = checksOf(data.root_group);
  const statuses = new Map<string, Array<{ status: number; count: number }>>();
  const samples = new Map<string, Array<{ status: number; body: string }>>();
  // Request names never contain ":", so the first two colons split name and status.
  for (const c of allChecks) {
    if (!c.name.startsWith(BODY_CHECK)) continue;
    const [name, status, ...body] = c.name.slice(BODY_CHECK.length).split(':');
    const list = samples.get(name!) ?? [];
    if (!list.some((x) => x.status === Number(status)))
      list.push({ status: Number(status) || 0, body: body.join(':') });
    samples.set(name!, list);
  }
  for (const c of allChecks) {
    if (!c.name.startsWith(STATUS_CHECK)) continue;
    const rest = c.name.slice(STATUS_CHECK.length);
    const cut = rest.lastIndexOf(':');
    const name = rest.slice(0, cut);
    const list = statuses.get(name) ?? [];
    list.push({ status: Number(rest.slice(cut + 1)) || 0, count: c.passes });
    statuses.set(name, list);
  }
  const thresholds: LoadTestDto['thresholds'] = [];
  for (const [metric, def] of Object.entries(m))
    for (const [condition, res] of Object.entries(def.thresholds ?? {})) {
      if (INTERNAL_CONDITIONS.has(condition.replace(/\s+/g, ''))) continue;
      thresholds.push({ metric, condition, ok: res.ok !== false, actual: actual(def, condition) });
    }
  return {
    vusMax: m.vus_max?.values?.max ?? m.vus_max?.values?.value ?? 0,
    requests: m.http_reqs?.values?.count ?? 0,
    rate: round(m.http_reqs?.values?.rate ?? 0, 2),
    failedRate: m.http_req_failed?.values?.rate ?? 0,
    latency: latency(m.http_req_duration),
    perRequest: plan.requests.map((r) => {
      const d = m[`http_req_duration{name:${r.name}}`]?.values;
      return {
        name: r.name,
        count: m[`http_reqs{name:${r.name}}`]?.values?.count ?? 0,
        failedRate: m[`http_req_failed{name:${r.name}}`]?.values?.rate ?? 0,
        p95: typeof d?.['p(95)'] === 'number' ? round(d['p(95)']) : null,
        avg: typeof d?.avg === 'number' ? round(d.avg) : null,
        statuses: (statuses.get(r.name) ?? []).sort((a, b) => b.count - a.count),
        errorSamples: samples.get(r.name) ?? [],
      };
    }),
    thresholds,
    checks: allChecks.filter(
      (c) => !c.name.startsWith(STATUS_CHECK) && !c.name.startsWith(BODY_CHECK),
    ),
    durationMs: Math.round(data.state?.testRunDurationMs ?? 0),
    thresholdsFailed: thresholds.some((t) => !t.ok),
  };
}
