import fs from 'node:fs/promises';
import { resolveInside } from './paths.js';

/** Repository guidance files read into context, in priority order. */
export const GUIDANCE_FILES = ['AGENTS.md', 'CLAUDE.md', '.friday/memory.md'];
const MAX_PER_FILE = 4_000;
const MAX_TOTAL = 8_000;

/**
 * Read repository guidance (conventions, commands) from the project root. The content is written
 * by whoever controls the repository, so it is returned as data for an explicitly untrusted
 * prompt section and never grants permissions.
 */
export async function readGuidance(root: string): Promise<string | null> {
  const parts: string[] = [];
  let total = 0;
  for (const name of GUIDANCE_FILES) {
    try {
      const target = await resolveInside(root, name); // same symlink/secret rules as read_file
      const stat = await fs.stat(target.abs);
      if (!stat.isFile()) continue;
      let text = (await fs.readFile(target.abs, 'utf8')).trim();
      if (!text) continue;
      if (text.length > MAX_PER_FILE) text = `${text.slice(0, MAX_PER_FILE)}\n[truncated]`;
      if (total + text.length > MAX_TOTAL) break;
      parts.push(`### ${name}\n${text}`);
      total += text.length;
    } catch {
      /* absent or not readable */
    }
  }
  return parts.length ? parts.join('\n\n') : null;
}
