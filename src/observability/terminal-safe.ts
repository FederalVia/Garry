/**
 * Terminal-safe text.
 *
 * Log lines carry text from tool output, web pages and other agents. Escape
 * sequences in that text would reach the operator's terminal: OSC 52 can
 * replace the clipboard, cursor and erase sequences can hide or forge lines,
 * and bidi controls can reorder what is shown. Control characters are shown
 * in visible \x1b-style notation instead of being stripped, so tampering
 * stays visible.
 */

// C0 except tab, DEL, C1, line/paragraph separators, bidi controls.
const UNSAFE = new RegExp(
  "[\\x00-\\x08\\x0a-\\x1f\\x7f-\\x9f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);

function visible(ch: string): string {
  const code = ch.codePointAt(0)!;
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
}

/**
 * Replace control characters with visible escapes. Newlines are kept unless
 * keepNewlines is false; carriage returns are always escaped (they can
 * overwrite a line). Running it twice gives the same text.
 */
export function escapeForTerminal(text: string, opts: { keepNewlines?: boolean } = {}): string {
  const keepNewlines = opts.keepNewlines ?? true;
  return String(text).replace(UNSAFE, (ch) => (ch === "\n" && keepNewlines ? ch : visible(ch)));
}

// Characters JSON.stringify leaves raw that a terminal still interprets.
const JSON_UNSAFE = new RegExp(
  "[\\x7f-\\x9f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);

/** Escape what JSON.stringify leaves raw (DEL, C1, separators, bidi) as \uXXXX; still valid JSON. */
export function escapeJsonForTerminal(json: string): string {
  return json.replace(JSON_UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
