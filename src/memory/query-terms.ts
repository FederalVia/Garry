/**
 * Query term extraction for memory retrieval.
 *
 * The pending input is a whole prompt (wakeup text, creator message), so it
 * is split into a few distinctive words that are searched one by one.
 */

const STOP_WORDS = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "been", "before", "but", "by", "can", "could", "did", "do",
  "does", "for", "from", "get", "got", "had", "has", "have", "he", "her", "here",
  "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "let",
  "me", "message", "more", "my", "no", "not", "now", "of", "on", "or", "our",
  "out", "please", "she", "should", "so", "some", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "too", "up", "us",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
  // Wakeup and inbox boilerplate.
  "wake", "woke", "woken", "waking", "awake", "sleep", "sleeping", "agent",
  "automaton", "turn", "turns", "time", "messages", "new", "last", "went",
  "total", "previous", "found", "triggered", "check", "decide", "status",
  "goals", "self", "creator", "heartbeat",
]);

// Scripts written without spaces: a run is kept even when short.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const HEX_LIKE = /^(0x[0-9a-f]*|[0-9a-f]{16,})$/;

/**
 * Distinctive search terms from free text: NFKC, lowercase, split on
 * non-letters/digits; stopwords, tokens under 3 characters (except CJK-like
 * runs), hex strings and addresses dropped; deduplicated; the `max` longest
 * kept, in their original order.
 */
export function extractQueryTerms(text: string | undefined | null, max: number = 8): string[] {
  if (!text || max <= 0) return [];
  // Bound the work for a very large input.
  const normalized = text.slice(0, 20_000).normalize("NFKC").toLowerCase();
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of normalized.split(/[^\p{L}\p{N}_]+/u)) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (STOP_WORDS.has(token)) continue;
    if (HEX_LIKE.test(token)) continue;
    if (/^\d+$/.test(token) && token.length < 3) continue;
    if (token.length < 3 && !NO_SPACE_SCRIPT.test(token)) continue;
    if (token.length > 64) continue;
    terms.push(token);
  }
  if (terms.length <= max) return terms;
  const keep = new Set(
    terms
      .map((t, i) => ({ t, i }))
      .sort((a, b) => b.t.length - a.t.length || a.i - b.i)
      .slice(0, max)
      .map((x) => x.t),
  );
  return terms.filter((t) => keep.has(t));
}
