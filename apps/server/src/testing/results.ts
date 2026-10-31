/**
 * Parsers for the machine-readable results test runners write: Jest/Vitest JSON, Playwright JSON,
 * JUnit XML (pytest, node:test) and `go test -json`, plus LCOV and Go cover profiles. Their input comes
 * from the project's own test run, so it is untrusted data: sizes are capped and nothing in it is
 * executed or followed.
 */

export type CaseStatus = 'passed' | 'failed' | 'skipped';

export interface TestCase {
  /** As reported: absolute, or relative to the folder the runner ran in. */
  file: string | null;
  /** Full name, with describe blocks / classes joined by " › ". */
  name: string;
  /** The name the runner itself filters by (vitest/jest full name, go top-level test). */
  filterName: string;
  status: CaseStatus;
  durationMs: number | null;
  /** Raw failure text (message and stack). */
  error: string | null;
  /** The runner's one-line failure message, when it gives one separately (JUnit). */
  message?: string | null;
  line: number | null;
  /** pytest node id (re-running exactly this test). */
  nodeId?: string;
  /** go package import path. */
  pkg?: string;
  /** Playwright: failed, then passed on its own retry. */
  flaky?: boolean;
  /** Playwright: files saved for the last failed attempt (absolute paths, as reported). */
  artifacts?: {
    screenshot: string | null;
    trace: string | null;
    video: string | null;
    /** error-context.md: the page's accessibility snapshot when the test failed. */
    context: string | null;
  };
}

export interface ParsedResults {
  cases: TestCase[];
  /** Failures not tied to one test: a file that failed to load, a package that didn't build. */
  fileErrors: Array<{ file: string | null; error: string }>;
}

const MAX_CASES = 20_000;
const SEP = ' › ';

// eslint-disable-next-line no-control-regex -- terminal colour codes are what this removes
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

function caseStatus(s: string): CaseStatus {
  if (s === 'passed') return 'passed';
  if (s === 'failed') return 'failed';
  return 'skipped'; // pending, todo, skipped, disabled, focused-out
}

interface JestAssertion {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
  duration?: number | null;
  failureMessages?: string[] | null;
  location?: { line?: number } | null;
}

interface JestFile {
  name?: string;
  testFilePath?: string;
  status?: string;
  message?: string;
  failureMessage?: string | null;
  assertionResults?: JestAssertion[];
  testResults?: JestAssertion[];
}

/** Jest `--json` and Vitest's json reporter (the same format). */
export function parseJestJson(text: string): ParsedResults {
  const data = JSON.parse(text) as { testResults?: JestFile[] };
  const out: ParsedResults = { cases: [], fileErrors: [] };
  for (const f of data.testResults ?? []) {
    const file = f.name ?? f.testFilePath ?? null;
    const assertions = f.assertionResults ?? f.testResults ?? [];
    for (const a of assertions) {
      if (out.cases.length >= MAX_CASES) break;
      const titles = [...(a.ancestorTitles ?? []), a.title ?? a.fullName ?? '(unnamed)'];
      const failures = (a.failureMessages ?? []).filter(Boolean);
      out.cases.push({
        file,
        name: titles.join(SEP),
        filterName: a.fullName ?? titles.join(' '),
        status: caseStatus(a.status ?? ''),
        durationMs: typeof a.duration === 'number' ? a.duration : null,
        error: failures.length ? stripAnsi(failures.join('\n')) : null,
        line: a.location?.line ?? null,
      });
    }
    const message = stripAnsi(f.message || f.failureMessage || '').trim();
    if (f.status === 'failed' && !assertions.some((a) => a.status === 'failed') && message)
      out.fileErrors.push({ file, error: message });
  }
  return out;
}

interface PwResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string; stack?: string; location?: { file?: string; line?: number } };
  errors?: Array<{ message?: string; location?: { file?: string; line?: number } }>;
  attachments?: Array<{ name?: string; contentType?: string; path?: string }>;
}

interface PwSpec {
  title?: string;
  file?: string;
  line?: number;
  tests?: Array<{ projectName?: string; status?: string; results?: PwResult[] }>;
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

/**
 * Playwright's json reporter. One case per test and project ("[firefox]" is added when there are
 * several projects); Playwright's own retries decide flaky. File paths in the report are relative
 * to config.rootDir.
 */
export function parsePlaywrightJson(text: string): ParsedResults {
  const data = JSON.parse(text) as {
    config?: { rootDir?: string };
    suites?: PwSuite[];
    errors?: Array<{ message?: string; location?: { file?: string } }>;
  };
  const rootDir = data.config?.rootDir ?? '';
  const abs = (f: string | undefined) => (f ? (f.startsWith('/') ? f : `${rootDir}/${f}`) : null);
  const out: ParsedResults = { cases: [], fileErrors: [] };
  const projects = new Set<string>();
  const visit = (suite: PwSuite, titles: string[], file: string | null) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) projects.add(t.projectName ?? '');
    for (const child of suite.suites ?? []) visit(child, titles, file);
  };
  for (const top of data.suites ?? []) visit(top, [], null);
  const tagProject = projects.size > 1;

  const walkSuite = (suite: PwSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (out.cases.length >= MAX_CASES) return;
        const results = t.results ?? [];
        const lastFailed = [...results]
          .reverse()
          .find((r) => r.status !== 'passed' && r.status !== 'skipped');
        const last = results.at(-1);
        // A flaky test failed first, like a test Friday re-runs itself: "failed", marked flaky.
        const status: CaseStatus =
          t.status === 'expected' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed';
        const name =
          [...titles, spec.title ?? '(unnamed)'].join(SEP) +
          (tagProject && t.projectName ? ` [${t.projectName}]` : '');
        const err = lastFailed?.error;
        const errText = err
          ? stripAnsi(
              [
                err.message ?? '',
                // Only the stack frames: the stack repeats the message.
                (err.stack ?? '')
                  .split('\n')
                  .filter((l) => /^\s+at /.test(l))
                  .join('\n'),
              ]
                .join('\n')
                .trim(),
            )
          : lastFailed?.status === 'timedOut'
            ? 'Test timed out.'
            : null;
        const pick = (pred: (a: { name?: string; contentType?: string }) => boolean) =>
          lastFailed?.attachments?.find((a) => a.path && pred(a))?.path ?? null;
        out.cases.push({
          file: abs(spec.file),
          name,
          filterName: [...titles, spec.title ?? ''].join(' '),
          status,
          durationMs: typeof last?.duration === 'number' ? last.duration : null,
          error: status === 'failed' || t.status === 'flaky' ? errText : null,
          line: err?.location?.line ?? spec.line ?? null,
          ...(t.status === 'flaky' ? { flaky: true } : {}),
          ...(lastFailed
            ? {
                artifacts: {
                  screenshot: pick((a) => a.contentType === 'image/png'),
                  trace: pick((a) => a.name === 'trace'),
                  video: pick((a) => (a.contentType ?? '').startsWith('video/')),
                  context: pick((a) => a.name === 'error-context'),
                },
              }
            : {}),
        });
      }
    }
    for (const child of suite.suites ?? []) walkSuite(child, [...titles, child.title ?? '']);
  };
  // The top-level suites are files; their titles are not part of a test's name.
  for (const top of data.suites ?? []) walkSuite(top, []);
  for (const e of data.errors ?? [])
    out.fileErrors.push({ file: abs(e.location?.file), error: stripAnsi(e.message ?? 'error') });
  return out;
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** A small, tolerant XML reader: elements, attributes, text and CDATA. Enough for JUnit files. */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token =
    /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  for (const m of text.matchAll(token)) {
    const top = stack.at(-1)!;
    top.text += decode(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      top.text += m[1];
      continue;
    }
    if (!m[3]) continue; // comment, declaration
    if (m[2] === '/') {
      const at = stack.map((n) => n.name).lastIndexOf(m[3]);
      if (at > 0) stack.length = at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs[a[1]!] = decode(a[2] ?? a[3] ?? '');
    const node: XmlNode = { name: m[3], attrs, children: [], text: '' };
    top.children.push(node);
    if (!m[5]) stack.push(node);
  }
  return root;
}

/**
 * node:test drops the line breaks from the message attribute ("equal:6 !== 7"); the failure text
 * has them. Puts them back when the text contains exactly the message plus line breaks.
 */
export function withLineBreaks(message: string, text: string): string {
  if (message.includes('\n') || !text) return message;
  const start = text.indexOf(message.slice(0, Math.min(30, message.length)));
  if (start < 0) return message;
  let out = '';
  let k = 0;
  for (let i = start; i < text.length && k < message.length; i++) {
    if (text[i] === message[k]) {
      out += text[i];
      k++;
    } else if (text[i] === '\n') out += '\n';
    else return message;
  }
  return k === message.length ? out : message;
}

/** JUnit XML (pytest with junit_family=xunit1, node:test's junit reporter). */
export function parseJunit(text: string): ParsedResults {
  const out: ParsedResults = { cases: [], fileErrors: [] };
  const walk = (node: XmlNode, suites: string[]) => {
    for (const c of node.children) {
      if (out.cases.length >= MAX_CASES) return;
      if (c.name === 'testsuite' || c.name === 'testsuites') {
        // pytest names its one suite "pytest"; node names suites after describe() blocks.
        const name = c.name === 'testsuite' && c.attrs.name !== 'pytest' ? c.attrs.name : null;
        walk(c, name ? [...suites, name] : suites);
        continue;
      }
      if (c.name !== 'testcase') continue;
      const failure = c.children.find((x) => x.name === 'failure' || x.name === 'error');
      const skipped = c.children.some((x) => x.name === 'skipped');
      const classname = c.attrs.classname ?? '';
      const file = c.attrs.file ?? null;
      const leaf = c.attrs.name ?? '(unnamed)';
      // pytest: the class part of "tests.test_cart.TestCart" is what follows the module.
      const module = file ? file.replace(/\.py$/, '').replace(/[\\/]/g, '.') : null;
      const cls =
        module && classname.startsWith(`${module}.`) ? classname.slice(module.length + 1) : null;
      const names = [...suites, ...(cls ? cls.split('.') : []), leaf];
      const seconds = Number(c.attrs.time);
      const error = failure
        ? [failure.attrs.message, failure.text.trim()].filter(Boolean).join('\n')
        : null;
      out.cases.push({
        file,
        name: names.join(SEP),
        filterName: leaf,
        status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
        durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
        error: error ? stripAnsi(error) : null,
        message: failure?.attrs.message
          ? stripAnsi(withLineBreaks(failure.attrs.message, failure.text))
          : null,
        line: c.attrs.line ? Number(c.attrs.line) || null : null,
        ...(file && file.endsWith('.py')
          ? { nodeId: [file, ...(cls ? cls.split('.') : []), leaf].join('::') }
          : {}),
      });
    }
  };
  walk(parseXml(text), []);
  return out;
}

interface GoEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Elapsed?: number;
  Output?: string;
}

/** `go test -json` (lines of JSON events; anything else, like build errors, is kept as output). */
export function parseGoJson(text: string): ParsedResults {
  const out: ParsedResults = { cases: [], fileErrors: [] };
  const output = new Map<string, string[]>();
  const done = new Map<string, TestCase>();
  const failedPackages = new Map<string, boolean>();
  const loose: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) {
      if (line.trim()) loose.push(line);
      continue;
    }
    let e: GoEvent;
    try {
      e = JSON.parse(line) as GoEvent;
    } catch {
      continue;
    }
    const pkg = e.Package ?? '';
    const key = `${pkg}\0${e.Test ?? ''}`;
    if (e.Action === 'output' && e.Output) {
      const list = output.get(key) ?? [];
      if (list.length < 400) list.push(e.Output);
      output.set(key, list);
    } else if (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip') {
      if (!e.Test) {
        failedPackages.set(pkg, e.Action === 'fail');
        continue;
      }
      const lines = (output.get(key) ?? []).filter(
        (l) => !/^\s*(=== (RUN|PAUSE|CONT)|--- (PASS|FAIL|SKIP))/.test(l),
      );
      const where = /^\s*([\w.-]+_test\.go|[\w.-]+\.go):(\d+):/m.exec(lines.join(''));
      done.set(key, {
        file: where?.[1] ?? null,
        name: e.Test.split('/').join(SEP),
        filterName: e.Test.split('/')[0]!,
        status: e.Action === 'pass' ? 'passed' : e.Action === 'fail' ? 'failed' : 'skipped',
        durationMs: typeof e.Elapsed === 'number' ? Math.round(e.Elapsed * 1000) : null,
        error: e.Action === 'fail' ? lines.join('').trim() || 'failed' : null,
        line: where ? Number(where[2]) : null,
        pkg,
      });
    }
  }
  // A parent test fails because a subtest did: report only the subtests.
  const names = [...done.values()];
  for (const c of names) {
    const prefix = `${c.pkg}\0${c.name.split(SEP).join('/')}/`;
    if ([...done.keys()].some((k) => k.startsWith(prefix))) continue;
    if (out.cases.length < MAX_CASES) out.cases.push(c);
  }
  for (const [pkg, failed] of failedPackages) {
    if (!failed || names.some((c) => c.pkg === pkg && c.status === 'failed')) continue;
    const text = (output.get(`${pkg}\0`) ?? []).join('').trim();
    out.fileErrors.push({ file: null, error: `${pkg}: ${text || 'failed'}` });
  }
  if (!out.cases.length && !out.fileErrors.length && loose.length)
    out.fileErrors.push({ file: null, error: loose.slice(0, 40).join('\n') });
  return out;
}

/** Hit counts per line, per file as named in the report. */
export type LineHits = Map<string, Map<number, number>>;

export function parseLcov(text: string): LineHits {
  const files: LineHits = new Map();
  let current: Map<number, number> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const name = line.slice(3);
      current = files.get(name) ?? new Map();
      files.set(name, current);
    } else if (line.startsWith('DA:') && current) {
      const [n, hits] = line.slice(3).split(',');
      const ln = Number(n);
      if (Number.isInteger(ln) && ln > 0)
        current.set(ln, Math.max(current.get(ln) ?? 0, Number(hits) || 0));
    } else if (line === 'end_of_record') current = null;
  }
  return files;
}

/** `go test -coverprofile` blocks: `pkg/file.go:12.3,15.2 3 1`. */
export function parseGoCover(text: string): LineHits {
  const files: LineHits = new Map();
  for (const line of text.split('\n')) {
    const m = /^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(line.trim());
    if (!m) continue;
    const lines = files.get(m[1]!) ?? new Map<number, number>();
    files.set(m[1]!, lines);
    const end = Math.min(Number(m[3]), Number(m[2]) + 5_000);
    for (let n = Number(m[2]); n <= end; n++)
      lines.set(n, Math.max(lines.get(n) ?? 0, Number(m[4])));
  }
  return files;
}
