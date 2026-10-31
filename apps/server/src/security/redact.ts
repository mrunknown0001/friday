// Best-effort secret redaction for anything that may reach logs, the database, or the UI.
// This is a safety net, not a guarantee: callers should still avoid handling secrets at all.

const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // NAME=value / name: value where the name contains a secret word, including env-var style names
  // such as DB_PASSWORD, AWS_SECRET_ACCESS_KEY or GITHUB_TOKEN ("_" is a word character, so \b
  // alone would miss them).
  /((?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_.-])*(?:api[_-]?key|access[_-]?key|secret|password|passwd|passphrase|token|credentials?|private[_-]?key)(?:[_.-][A-Za-z0-9]+)*\s*[=:]\s*)["']?[^\s"']{4,}/gi,
  // MYSQL_PWD=..., but not a bare PWD=/current/dir.
  /((?<![A-Za-z0-9])[A-Za-z0-9]+_PWD\s*[=:]\s*)["']?[^\s"']{4,}/gi,
];

/**
 * user:password@ in URLs (basic auth); the user name is kept. Neither part runs across a quote
 * or backslash, so a URL followed by an e-mail address in JSON is not mistaken for one.
 */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'\\]+:)[^\s/@"'\\]+@/gi;

const REDACTED = '[REDACTED]';

export class Redactor {
  private readonly literals: string[];

  constructor(knownSecrets: Array<string | null | undefined> = []) {
    // Only redact literals long enough to be meaningful; short strings would mangle text.
    this.literals = knownSecrets.filter((s): s is string => typeof s === 'string' && s.length >= 8);
  }

  /** Secrets learned at runtime (e.g. OAuth access tokens of connected apps). */
  addSecret(secret: string | null | undefined): void {
    if (typeof secret === 'string' && secret.length >= 8 && !this.literals.includes(secret))
      this.literals.push(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.literals) {
      out = out.split(secret).join(REDACTED);
    }
    out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (match, prefix?: string) =>
        typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
      );
    }
    return out;
  }
}
