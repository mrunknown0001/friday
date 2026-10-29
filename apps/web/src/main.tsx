import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark.css';
import './index.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Fetch the Markdown renderer once the app is idle, so the first answer renders formatted.
const preload = () => void import('./components/MarkdownRenderer');
if ('requestIdleCallback' in window) window.requestIdleCallback(preload);
else setTimeout(preload, 1000);
