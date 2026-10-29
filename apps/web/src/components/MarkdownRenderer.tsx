import { Check, Copy } from 'lucide-react';
import { useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

function CodeBlock(props: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.textContent ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className="absolute right-2 top-2 rounded-md border border-zinc-700 bg-zinc-800/90 p-1.5 text-zinc-300 opacity-0 transition-opacity hover:text-white focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre
        ref={ref}
        className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-[0.82rem] leading-snug"
      >
        {props.children}
      </pre>
    </div>
  );
}

/**
 * Renders model output as Markdown. Raw HTML is not rendered (react-markdown escapes it by default).
 * Loaded on demand through ./Markdown, because the parser and syntax highlighter are most of the
 * bundle.
 */
export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose-friday">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
