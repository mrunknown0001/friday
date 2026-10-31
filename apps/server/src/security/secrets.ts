import type { Redactor } from './redact.js';

/**
 * Why a text looks like it holds a secret, or null. Used before anything leaves Friday's control
 * in a durable or outward form: memory writes ("stored") and web search queries ("sent").
 */
export function secretReason(
  text: string,
  redactor: Redactor,
  verb: 'stored' | 'sent',
): string | null {
  if (/:\/\/[^\s/:@]+:[^\s/@]+@/.test(text))
    return `This contains a URL with embedded credentials; secrets are never ${verb}.`;
  if (redactor.redact(text) !== text)
    return `This looks like it contains a secret (key, token or password); secrets are never ${verb}.`;
  // Natural-language secrets ("the staging password is hunter2"): a secret word followed by a value
  // that looks like a credential (has a digit or symbol). "The API key is stored in Vault" passes.
  const stated =
    /\b(password|passwd|passphrase|pwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|credentials?)\b[^.\n]{0,24}?\b(?:is|was|=|:|set to|equals)\s*["'`]?([^\s"'`,;]{6,})/i.exec(
      text,
    );
  if (stated && /[\d\W_]/.test(stated[2]!)) {
    return `This looks like it states a secret value; secrets are never ${verb}. Note where the secret lives instead (e.g. "in the .env file").`;
  }
  // "login admin:Summer2024!" — a user:password pair after a login-ish word.
  const pair =
    /\b(?:login|logins|user(?:name)?|account|creds?|credentials?)\b[^\n]{0,24}?[\w.@-]{2,}:([^\s:/]{6,})/i.exec(
      text,
    );
  if (pair && /[\d\W_]/.test(pair[1]!)) {
    return `This looks like a user name and password; secrets are never ${verb}. Note where the credentials live instead.`;
  }
  const tokens = text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? [];
  if (tokens.some((t) => /[A-Za-z]/.test(t) && /\d/.test(t) && !t.includes('/'))) {
    return `This contains a long random-looking string (possibly a key or token); secrets are never ${verb}.`;
  }
  return null;
}
