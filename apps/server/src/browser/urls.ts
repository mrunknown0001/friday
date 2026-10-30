/**
 * Pages Friday may capture or preview: only this machine (localhost, 127.0.0.1, ::1), never
 * Friday's own server. A page's own redirects and frames are held to the same rule by the engines.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

export function isLocalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export class PageUrlError extends Error {}

/** A local page URL to open, normalised ("0.0.0.0" means this machine). */
export function localPageUrl(input: string, fridayPort: number | null): string {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`);
  } catch {
    throw new PageUrlError(`"${input}" is not a URL.`);
  }
  if (!isLocalUrl(u.toString()))
    throw new PageUrlError(
      `Only pages on this machine (localhost or 127.0.0.1) can be captured, not "${u.host}".`,
    );
  if (u.hostname === '0.0.0.0') u.hostname = 'localhost';
  if (u.username || u.password) throw new PageUrlError('URLs with credentials are not allowed.');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (fridayPort !== null && port === fridayPort)
    throw new PageUrlError("That is Friday's own server; capture your app's dev server instead.");
  return u.toString();
}
