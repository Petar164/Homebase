// Spotting secrets in what the owner types or says, so they can be labelled
// "secret" before any model sees them. Secret content is stored, but it is
// withheld from every model, local ones included (see helios.ts).
//
// This is a safety net with a few precise patterns, not a guarantee. It
// errs towards catching: a false alarm only means one message is not passed
// to a model.

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // API keys in the common "sk-" form
  /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/, // payment provider keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key ids
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // signed web tokens
  // "my password is ...", "the alarm code: ...", "recovery phrase = ..."
  /\b(pass ?word|pass ?code|pass ?phrase|pin( code)?|alarm code|security code|recovery (phrase|code|key)|seed phrase|secret key)\b[^.?!\n]{0,20}?\b(is|are|was)\b\s*\S+|\b(pass ?word|pass ?code|pin( code)?|recovery (phrase|code|key)|seed phrase)\s*[:=]\s*\S+/i,
];

export function looksLikeSecret(text: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(text));
}
