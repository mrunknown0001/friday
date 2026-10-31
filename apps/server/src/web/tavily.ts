import { z } from 'zod';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

export class SearchError extends Error {}

const responseSchema = z.object({
  results: z.array(
    z.looseObject({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

/** Tavily's search API. Only the query (and result count) is sent. */
export class TavilySearch {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(
    query: string,
    o: { maxResults?: number; signal?: AbortSignal } = {},
  ): Promise<SearchResult[]> {
    const timeout = AbortSignal.timeout(20_000);
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query,
          max_results: o.maxResults ?? 6,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      throw new SearchError(
        timeout.aborted ? 'Tavily did not answer within 20 s.' : 'Could not reach Tavily.',
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new SearchError(
        res.status === 401 || res.status === 403
          ? 'Tavily rejected the API key. Check TAVILY_API_KEY in the .env file.'
          : res.status === 429
            ? 'Tavily is rate limiting searches; wait a moment.'
            : res.status === 432 || res.status === 433
              ? "The Tavily plan's search limit is used up for now."
              : `Tavily answered HTTP ${res.status}.`,
      );
    }
    const parsed = responseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SearchError('Tavily returned an unexpected answer.');
    return parsed.data.results
      .filter((r) => /^https?:\/\//i.test(r.url))
      .map((r) => ({
        title: (r.title ?? '').trim() || r.url,
        url: r.url,
        snippet: (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
        publishedAt: r.published_date ?? null,
      }));
  }
}
