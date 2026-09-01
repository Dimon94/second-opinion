import { redact } from "../logger/index.js";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_LINES = 200;

const HARD_REJECT: RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /-----BEGIN OPENSSH PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
];

const EXTRA_REDACT: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /((?:api[_-]?key|secret|password|passwd|authorization)\s*[:=]\s*)\S+/gi,
  /(https?:\/\/)[^\s/@"']+:[^\s/@"']+@/gi,
  /((?:set-cookie|cookies?|browser[_-]?cookies?)\s*[:=]\s*)[^\r\n]+/gi,
];

export type SanitizeResult =
  | { allowed: true; text: string; truncated: boolean }
  | { allowed: false; reason: string };

function redactHomePaths(text: string): string {
  return text
    .replace(/\/Users\/[^/\s"'`]+/g, "/Users/[user]")
    .replace(/\/home\/[^/\s"'`]+/g, "/home/[user]")
    .replace(/C:(\\{1,2})Users\1[^\\\s"'`]+/gi, (_match, slash: string) =>
      `C:${slash}Users${slash}[user]`
    );
}

/** Redact share-unsafe values without changing the surrounding output format. */
export function sanitizeDiagnosticText(raw: string): string {
  let text = redact(raw);
  text = applyExtraRedact(text);
  return redactHomePaths(text);
}

/** Sanitize structured diagnostic data before serializing it. */
export function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeDiagnosticValue(item)])
    );
  }
  return value;
}

function applyExtraRedact(text: string): string {
  let out = text;
  for (const pattern of EXTRA_REDACT) {
    out = out.replace(pattern, (match, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]"
    );
  }
  return out;
}

function truncate(text: string): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  let truncated = false;
  let next = text;
  if (lines.length > MAX_OUTPUT_LINES) {
    next = lines.slice(0, MAX_OUTPUT_LINES).join("\n") + "\n…[truncated]";
    truncated = true;
  }
  if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
    let cut = next;
    while (Buffer.byteLength(cut, "utf8") > MAX_OUTPUT_BYTES && cut.length > 0) {
      cut = cut.slice(0, Math.floor(cut.length * 0.9));
    }
    next = `${cut}\n…[truncated]`;
    truncated = true;
  }
  return { text: next, truncated };
}

/** Deterministic gate. Codex may nominate output; this decides if ChatGPT may read it. */
export function sanitizeExecutionOutput(raw: string): SanitizeResult {
  if (HARD_REJECT.some((pattern) => pattern.test(raw))) {
    return { allowed: false, reason: "private_key" };
  }
  const text = sanitizeDiagnosticText(raw);
  const { text: limited, truncated } = truncate(text);
  return { allowed: true, text: limited, truncated };
}
