import net from 'node:net';
import type { Redactor } from '../security/redact.js';
import { secretReason } from '../security/secrets.js';
import { isPublicAddress, LOCAL_NAME } from './fetch.js';

export const MAX_QUERY_CHARS = 300;

/**
 * Why a search query may not leave the machine, or null. Queries may name public things (packages,
 * versions, error messages, APIs) but not secrets, code, file paths, or hosts of a private network.
 */
export function queryProblem(
  raw: string,
  redactor: Redactor,
  privateHosts: string[] = [],
): string | null {
  const q = raw.trim();
  if (q.length < 2) return 'The query is empty.';
  if (q.length > MAX_QUERY_CHARS)
    return `Queries are at most ${MAX_QUERY_CHARS} characters; search for the key terms.`;
  if (/[\r\n]/.test(q)) return 'Queries are one line; search for the key terms, not pasted text.';
  const secret = secretReason(q, redactor, 'sent');
  if (secret) return secret;
  if ((q.match(/[{};]/g) ?? []).length >= 3 || /=>|\bfunction\s*\(|\);/.test(q))
    return 'This looks like code; search for the error message or API name instead.';
  if (/(?:^|[\s"'(])(?:~|\.{1,2})?\/[\w.@-]+\/[\w.@/-]+|[A-Za-z]:\\[\w\\. -]+/.test(q))
    return 'Leave file paths out of search queries; they reveal how the machine is laid out.';
  for (const token of q.split(/[\s"'(),]+/)) {
    let host = token;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) host = new URL(token).hostname;
    } catch {
      continue;
    }
    // host:port (not an IPv6 address, which has more colons)
    if (/^[^:]+:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(':'));
    host = host.replace(/^\[|\]$/g, '').replace(/[.:]+$/, '');
    if (net.isIP(host) && !isPublicAddress(host))
      return `"${host}" is a private address; leave it out of search queries.`;
    if (host.includes('.') && LOCAL_NAME.test(host))
      return `"${host}" is a local-network name; leave it out of search queries.`;
    if (host === 'localhost') return 'Leave localhost addresses out of search queries.';
  }
  const lower = q.toLowerCase();
  const named = privateHosts.find((h) => h.length >= 4 && lower.includes(h.toLowerCase()));
  if (named)
    return `"${named}" is one of your servers; leave private host names out of search queries.`;
  return null;
}
