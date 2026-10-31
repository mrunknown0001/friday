import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

/** A page as the model reads it: its main text with headings, lists, code and links kept. */
export interface PageText {
  title: string;
  byline: string | null;
  publishedAt: string | null;
  text: string;
}

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'nav',
  'footer',
  'aside',
]);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'details',
  'summary',
  'tr',
]);

interface El {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<El>;
  getAttribute?: (name: string) => string | null;
}

/** HTML of the main content to Markdown-like text. */
function toText(root: El, base: string): string {
  const out: string[] = [];
  const walk = (node: El, ctx: { list: string | null; depth: number; pre: boolean }) => {
    if (node.nodeType === 3) {
      const t = node.textContent ?? '';
      out.push(ctx.pre ? t : t.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.nodeName.toLowerCase();
    if (SKIP.has(tag)) return;
    const children = (c = ctx) => Array.from(node.childNodes).forEach((n) => walk(n, c));
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      out.push(`\n\n${'#'.repeat(Number(heading[1]))} `);
      children();
      out.push('\n\n');
    } else if (tag === 'pre') {
      const lang = /language-([\w+-]+)/.exec(
        `${node.getAttribute?.('class') ?? ''} ${node.childNodes[0]?.getAttribute?.('class') ?? ''}`,
      )?.[1];
      out.push(
        `\n\n\`\`\`${lang ?? ''}\n${(node.textContent ?? '').replace(/\n+$/, '')}\n\`\`\`\n\n`,
      );
    } else if (tag === 'code' && !ctx.pre) {
      out.push(`\`${(node.textContent ?? '').replace(/\s+/g, ' ')}\``);
    } else if (tag === 'br') {
      out.push('\n');
    } else if (tag === 'ul' || tag === 'ol') {
      out.push('\n');
      let i = 0;
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1 && child.nodeName.toLowerCase() === 'li') {
          i++;
          out.push(`\n${'  '.repeat(ctx.depth)}${tag === 'ol' ? `${i}.` : '-'} `);
          Array.from(child.childNodes).forEach((n) =>
            walk(n, { ...ctx, list: tag, depth: ctx.depth + 1 }),
          );
        }
      }
      out.push('\n\n');
    } else if (tag === 'a') {
      const href = node.getAttribute?.('href') ?? '';
      const label = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      let abs: string | null = null;
      try {
        const u = new URL(href, base);
        if (u.protocol === 'http:' || u.protocol === 'https:') abs = u.toString();
      } catch {
        abs = null;
      }
      out.push(abs && label && !href.startsWith('#') ? `[${label}](${abs})` : label);
    } else if (tag === 'img') {
      const alt = node.getAttribute?.('alt');
      if (alt) out.push(`[image: ${alt}]`);
    } else if (tag === 'blockquote') {
      const inner = toText(node, base)
        .trim()
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      out.push(`\n\n${inner}\n\n`);
    } else if (tag === 'td' || tag === 'th') {
      children();
      out.push(' | ');
    } else if (tag === 'table') {
      out.push('\n\n');
      children();
      out.push('\n\n');
    } else if (tag === 'li') {
      out.push('\n- ');
      children();
    } else if (BLOCK.has(tag)) {
      out.push('\n\n');
      children();
      out.push(tag === 'tr' ? '\n' : '\n\n');
    } else {
      children();
    }
  };
  walk(root, { list: null, depth: 0, pre: false });
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?![-\d])/g, '\n')
    .replace(/ \| \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The main content of an HTML page (Readability), or the whole body when that finds none. */
export function extractHtml(html: string, url: string): PageText {
  const { document } = parseHTML(html);
  const meta = (sel: string) =>
    document.querySelector(sel)?.getAttribute('content')?.trim() || null;
  const published =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="date"]') ??
    meta('meta[itemprop="datePublished"]') ??
    document.querySelector('time[datetime]')?.getAttribute('datetime') ??
    null;
  const fallbackTitle = document.querySelector('title')?.textContent?.trim() ?? '';
  // Readability changes the document; read what it needs first.
  const article = new Readability(document as unknown as Document, {
    charThreshold: 300,
    // Code blocks name their language in a class (language-js).
    keepClasses: true,
  }).parse();
  let text: string;
  if (article?.content) {
    const { document: content } = parseHTML(`<html><body>${article.content}</body></html>`);
    text = toText(content.body as unknown as El, url);
  } else {
    const { document: whole } = parseHTML(html);
    text = toText(whole.body as unknown as El, url);
  }
  return {
    title: (article?.title || fallbackTitle || new URL(url).hostname).trim(),
    byline: article?.byline?.trim() || null,
    publishedAt: article?.publishedTime?.trim() || published,
    text,
  };
}

/** Decodes a response body with the charset from the header or the page's meta tag. */
export function decodeBody(body: Buffer, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = body.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}
