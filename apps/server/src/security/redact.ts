// Best-effort secret redaction for anything that may reach logs, the database, or the UI.
// This is a safety net, not a guarantee: callers should still avoid handling secrets at all.

const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b((?:api[_-]?key|secret|password|passwd|token)\s*[=:]\s*)["']?[^\s"']{6,}/gi,
];

const REDACTED = '[REDACTED]';

export class Redactor {
  private readonly literals: string[];

  constructor(knownSecrets: Array<string | null | undefined> = []) {
    // Only redact literals long enough to be meaningful; short strings would mangle text.
    this.literals = knownSecrets.filter((s): s is string => typeof s === 'string' && s.length >= 8);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.literals) {
      out = out.split(secret).join(REDACTED);
    }
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (match, prefix?: string) =>
        typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
      );
    }
    return out;
  }
}
