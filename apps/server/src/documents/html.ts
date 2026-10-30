import type { Block, Inline } from './markdown.js';

/**
 * Document HTML for printing to PDF. Everything is escaped (no raw HTML from the content), there
 * are no scripts and no external resources, so the page renders the same offline.
 */

export interface DocumentMeta {
  title: string;
  subtitle?: string | undefined;
  author?: string | undefined;
  /** Shown under the title, e.g. "30 October 2026". */
  date: string;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function inline(c: Inline[]): string {
  return c
    .map((x) => {
      switch (x.t) {
        case 'text':
          return esc(x.v);
        case 'code':
          return `<code>${esc(x.v)}</code>`;
        case 'strong':
          return `<strong>${inline(x.c)}</strong>`;
        case 'em':
          return `<em>${inline(x.c)}</em>`;
        case 'link':
          return `<a href="${esc(x.href)}">${inline(x.c)}</a>`;
      }
    })
    .join('');
}

function list(items: Extract<Block, { t: 'list' }>['items']): string {
  // Rebuild nesting from levels.
  let html = '';
  const open: Array<'ul' | 'ol'> = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    while (open.length > it.level + 1) html += `</li></${open.pop()}>`;
    // A different kind of list at the same level starts a new list.
    if (open.length === it.level + 1 && open.at(-1) !== tag) html += `</li></${open.pop()}>`;
    if (open.length === it.level + 1) html += '</li>';
    while (open.length < it.level + 1) {
      open.push(tag);
      html += `<${tag}>`;
    }
    const box = it.checked === null ? '' : `<span class="box">${it.checked ? '☑' : '☐'}</span> `;
    html += `<li>${box}${inline(it.c)}`;
  }
  while (open.length) html += `</li></${open.pop()}>`;
  return html;
}

export function blocksToHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'heading':
          return `<h${b.level}>${inline(b.c)}</h${b.level}>`;
        case 'para':
          return `<p>${inline(b.c)}</p>`;
        case 'quote':
          return `<blockquote>${inline(b.c)}</blockquote>`;
        case 'code':
          return `<pre><code>${esc(b.v)}</code></pre>`;
        case 'hr':
          return '<hr>';
        case 'pagebreak':
          return '<div class="pagebreak"></div>';
        case 'list':
          return list(b.items);
        case 'table': {
          const al = (k: number) => (b.align[k] ? ` style="text-align:${b.align[k]}"` : '');
          return `<table><thead><tr>${b.head.map((h, k) => `<th${al(k)}>${inline(h)}</th>`).join('')}</tr></thead><tbody>${b.rows
            .map((r) => `<tr>${r.map((c, k) => `<td${al(k)}>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`;
        }
      }
    })
    .join('\n');
}

/** The "clean built-in style": neutral type, a sky-blue accent, readable tables and code. */
const CSS = `
@page { size: A4; margin: 22mm 20mm 24mm 20mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif; font-size: 10.5pt;
  line-height: 1.5; color: #1f2937; margin: 0; }
header.doc { border-bottom: 3px solid #0369a1; padding-bottom: 10pt; margin-bottom: 18pt; }
header.doc h1 { font-size: 24pt; margin: 0 0 4pt; color: #0c4a6e; border: 0; padding: 0; }
header.doc .sub { font-size: 13pt; color: #374151; margin: 0 0 6pt; }
header.doc .meta { font-size: 9pt; color: #6b7280; }
h1, h2, h3, h4, h5, h6 { color: #0c4a6e; line-height: 1.25; margin: 16pt 0 6pt; page-break-after: avoid; }
h1 { font-size: 18pt; border-bottom: 1px solid #e5e7eb; padding-bottom: 3pt; }
h2 { font-size: 14pt; } h3 { font-size: 12pt; } h4, h5, h6 { font-size: 10.5pt; }
p { margin: 0 0 7pt; }
a { color: #0369a1; text-decoration: none; }
ul, ol { margin: 0 0 7pt; padding-left: 18pt; } li { margin: 2pt 0; }
ul ul, ol ol, ul ol, ol ul { margin: 2pt 0; }
.box { font-family: "DejaVu Sans", sans-serif; }
code { font-family: "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace; font-size: 9pt;
  background: #f3f4f6; border-radius: 3px; padding: 0 3px; }
pre { background: #f8fafc; border: 1px solid #e5e7eb; border-left: 3px solid #0369a1; border-radius: 4px;
  padding: 7pt 9pt; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; margin: 0 0 9pt; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 9pt; padding: 4pt 10pt; border-left: 3px solid #93c5fd; color: #374151; background: #f8fafc; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; font-size: 9.5pt; page-break-inside: auto; }
th, td { border: 1px solid #d1d5db; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #e0f2fe; color: #0c4a6e; font-weight: 600; }
tr { page-break-inside: avoid; } tbody tr:nth-child(even) td { background: #f9fafb; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 12pt 0; }
.pagebreak { page-break-after: always; }
`;

export function documentHtml(meta: DocumentMeta, blocks: Block[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(meta.title)}</title><style>${CSS}</style></head><body>
<header class="doc"><h1>${esc(meta.title)}</h1>${meta.subtitle ? `<p class="sub">${esc(meta.subtitle)}</p>` : ''}
<div class="meta">${[meta.author, meta.date]
    .filter(Boolean)
    .map((s) => esc(s!))
    .join(' · ')}</div></header>
${blocksToHtml(blocks)}
</body></html>`;
}

/** Page footer for the browser's PDF printer (its own tiny template language). */
export function pdfFooter(title: string): string {
  return `<div style="font-family: Arial, sans-serif; font-size: 8px; color: #6b7280; width: 100%; padding: 0 20mm; display: flex; justify-content: space-between;"><span>${esc(title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}
