import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * GET requests to public web pages only. The host's addresses are checked after DNS resolution
 * and the connection uses exactly the checked address, so a name can't point at this machine or
 * the local network (also not after a redirect, which is followed by hand and checked again). No
 * cookies, credentials or Referer are sent.
 */

export class WebFetchError extends Error {}

/** Address ranges that are never public: loopback, private, link-local, CGNAT, multicast… */
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED.addSubnet(addr, prefix, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, 'ipv4');
  if (family !== 6) return false;
  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms are judged as IPv4.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]!);
  return !BLOCKED.check(ip, 'ipv6');
}

/** Names that only mean something on a local network. */
export const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

type Lookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => void;

/** dns.lookup that fails unless every address of the name is public. */
export const publicLookup: Lookup = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad || !addresses.length)
      return callback(
        Object.assign(new WebFetchError(`${hostname} is not a public address.`), {
          code: 'EBLOCKED',
        }),
        '',
      );
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

export interface FetchedPage {
  /** After redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** The body was longer than the limit and was cut. */
  truncated: boolean;
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Tests: resolve names differently (still checked). */
  lookup?: Lookup;
}

/** Throws a WebFetchError explaining why this URL may not be fetched, before any request. */
export function checkPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebFetchError(`"${raw.slice(0, 200)}" is not a URL.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new WebFetchError('Only http and https pages can be read.');
  if (u.username || u.password) throw new WebFetchError('URLs with credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) ? !isPublicAddress(host) : LOCAL_NAME.test(host) || !host.includes('.'))
    throw new WebFetchError(
      `${u.hostname} is on this machine or a local network; only public pages can be read.`,
    );
  return u;
}

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; Friday/0.1; local coding assistant)',
  accept:
    'text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,application/json;q=0.8,*/*;q=0.1',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en;q=1, *;q=0.5',
};

export async function fetchPublic(raw: string, o: FetchOptions = {}): Promise<FetchedPage> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  let url = checkPublicUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await request(url, signal, o);
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= (o.maxRedirects ?? 5)) throw new WebFetchError('Too many redirects.');
      url = checkPublicUrl(new URL(res.location, url).toString());
      continue;
    }
    return { ...res, url: url.toString() };
  }
}

function request(
  url: URL,
  signal: AbortSignal,
  o: FetchOptions,
): Promise<Omit<FetchedPage, 'url'> & { location: string | null }> {
  const maxBytes = o.maxBytes ?? 3_000_000;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const req = lib.get(
      url,
      { headers: HEADERS, lookup: o.lookup ?? publicLookup, signal, agent: false },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({
            status,
            contentType: '',
            body: Buffer.alloc(0),
            truncated: false,
            location,
          });
        }
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream =
          encoding === 'gzip'
            ? res.pipe(zlib.createGunzip())
            : encoding === 'br'
              ? res.pipe(zlib.createBrotliDecompress())
              : encoding === 'deflate'
                ? res.pipe(zlib.createInflate())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            req.destroy();
            done();
          } else chunks.push(c);
        });
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          resolve({
            status,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks),
            truncated,
            location: null,
          });
        };
        stream.on('end', done);
        stream.on('error', (e) => (truncated ? done() : reject(e)));
      },
    );
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (signal.aborted) return reject(abortError(signal));
      if (e instanceof WebFetchError || e.code === 'EBLOCKED')
        return reject(new WebFetchError(e.message));
      reject(new WebFetchError(`Could not load ${url.host}: ${e.code ?? e.message}.`));
    });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? new WebFetchError('The page took too long to load.')
    : new DOMException('Cancelled', 'AbortError');
}
