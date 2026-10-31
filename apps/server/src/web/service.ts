import type { WebSettings, WebStatusDto } from '@friday/shared';
import { z } from 'zod';
import type { SettingsRepo } from '../repositories/settings.js';
import type { Redactor } from '../security/redact.js';
import { decodeBody, extractHtml } from './extract.js';
import { fetchPublic, WebFetchError, type FetchOptions } from './fetch.js';
import { queryProblem } from './query.js';
import { SearchError, TavilySearch, type SearchResult } from './tavily.js';

export const WEB_HARD_LIMITS = { maxSearches: 30, maxPages: 40, maxMinutes: 15 };
const DEFAULTS: WebSettings = { enabled: true, maxSearches: 12, maxPages: 15, maxMinutes: 5 };
const SETTINGS_KEY = 'web';

export const webSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  maxSearches: z.number().int().min(1).max(WEB_HARD_LIMITS.maxSearches),
  maxPages: z.number().int().min(1).max(WEB_HARD_LIMITS.maxPages),
  maxMinutes: z.number().int().min(1).max(WEB_HARD_LIMITS.maxMinutes),
});

/** A refused or failed search or page; the message is meant for the model and the user. */
export class WebError extends Error {}

export interface WebPage {
  /** After redirects. */
  url: string;
  title: string;
  byline: string | null;
  publishedAt: string | null;
  text: string;
  /** Characters cut from the end (page or download limit). */
  truncated: boolean;
}

export interface WebDeps {
  settings: SettingsRepo;
  redactor: Redactor;
  envFile: string;
  tavilyApiKey: string | null;
  /** Host names of the user's own servers (SSH hosts, databases): never put in a query. */
  privateHosts: () => string[];
  /** Tests. */
  searchFetch?: typeof fetch;
  pageFetch?: Pick<FetchOptions, 'lookup'>;
}

/**
 * Web access: searching with Tavily (only the query is sent) and reading public pages. Results and
 * page text are untrusted data; callers mark them so for the model.
 */
export class WebService {
  private readonly tavily: TavilySearch | null;

  constructor(private readonly d: WebDeps) {
    this.tavily = d.tavilyApiKey ? new TavilySearch(d.tavilyApiKey, d.searchFetch) : null;
  }

  getSettings(): WebSettings {
    return this.d.settings.get(SETTINGS_KEY, webSettingsSchema) ?? DEFAULTS;
  }

  setSettings(s: WebSettings): WebSettings {
    this.d.settings.set(SETTINGS_KEY, s);
    return s;
  }

  status(): WebStatusDto {
    return {
      settings: this.getSettings(),
      searchConfigured: this.tavily !== null,
      envFile: this.d.envFile,
      hardLimits: WEB_HARD_LIMITS,
    };
  }

  /** Reading pages needs only the switch; searching also needs the Tavily key. */
  available(): { read: boolean; search: boolean } {
    const on = this.getSettings().enabled;
    return { read: on, search: on && this.tavily !== null };
  }

  /** Why this query can't be sent, or null. */
  checkQuery(query: string): string | null {
    return queryProblem(query, this.d.redactor, this.d.privateHosts());
  }

  async search(query: string, o: { maxResults?: number; signal?: AbortSignal } = {}) {
    if (!this.available().search)
      throw new WebError(
        this.getSettings().enabled
          ? `Web search needs a Tavily API key: add TAVILY_API_KEY to ${this.d.envFile} and restart Friday.`
          : 'Web access is turned off in Settings → Web.',
      );
    const problem = this.checkQuery(query);
    if (problem) throw new WebError(`Query not sent: ${problem}`);
    try {
      const results = await this.tavily!.search(query.trim(), o);
      return results.map((r): SearchResult => ({
        ...r,
        title: this.d.redactor.redact(r.title),
        snippet: this.d.redactor.redact(r.snippet),
      }));
    } catch (e) {
      if (e instanceof SearchError) throw new WebError(e.message);
      throw e;
    }
  }

  async read(url: string, o: { signal?: AbortSignal; maxChars?: number } = {}): Promise<WebPage> {
    if (!this.available().read) throw new WebError('Web access is turned off in Settings → Web.');
    // A page could ask the model to put a secret in an address ("?k=<key>"). Only known secret
    // patterns are checked: ids and hashes are normal in URLs.
    if (this.d.redactor.redact(url) !== url)
      throw new WebError(
        'This address looks like it contains a secret (key, token or password); secrets are never sent.',
      );
    let page;
    try {
      page = await fetchPublic(url, {
        ...(o.signal ? { signal: o.signal } : {}),
        ...this.d.pageFetch,
      });
    } catch (e) {
      if (e instanceof WebFetchError) throw new WebError(e.message);
      throw e;
    }
    if (page.status >= 400) throw new WebError(`${page.url} answered HTTP ${page.status}.`);
    const type = page.contentType.split(';')[0]!.trim().toLowerCase();
    let title = new URL(page.url).hostname;
    let byline: string | null = null;
    let publishedAt: string | null = null;
    let text: string;
    if (type === 'text/html' || type === 'application/xhtml+xml' || type === '') {
      const html = decodeBody(page.body, page.contentType);
      const extracted = extractHtml(html, page.url);
      ({ title, byline, publishedAt, text } = extracted);
    } else if (type.startsWith('text/')) {
      text = decodeBody(page.body, page.contentType);
    } else if (type === 'application/json' || type.endsWith('+json')) {
      const raw = decodeBody(page.body, page.contentType);
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
    } else {
      throw new WebError(
        type === 'application/pdf'
          ? `${page.url} is a PDF; Friday can only read web pages and text.`
          : `${page.url} is ${type}, not a page Friday can read.`,
      );
    }
    const max = o.maxChars ?? 40_000;
    const clean = this.d.redactor.redact(text.replaceAll('\u0000', ''));
    return {
      url: page.url,
      title: this.d.redactor.redact(title).slice(0, 300),
      byline: byline ? this.d.redactor.redact(byline).slice(0, 200) : null,
      publishedAt,
      text: clean.length > max ? clean.slice(0, max) : clean,
      truncated: page.truncated || clean.length > max,
    };
  }
}
