import { lazy, memo, Suspense } from 'react';

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

/** Model output as Markdown. Until the renderer chunk has loaded, the raw text is shown. */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <Suspense fallback={<div className="prose-friday whitespace-pre-wrap">{content}</div>}>
      <MarkdownRenderer content={content} />
    </Suspense>
  );
});
