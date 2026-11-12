/**
 * Text folding for injection screening.
 *
 * These forms exist only so detectors see through invisible characters,
 * compatibility forms, accents and look-alike letters. They are never shown
 * to the model, stored, or used to rewrite anything.
 */

// Format characters (zero-width, soft hyphen, word joiner, bidi controls,
// BOM, tag characters) plus variation selectors.
const INVISIBLE_RE = /[\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

// Latin look-alikes from Cyrillic and Greek, folded only for detectors that
// match Latin-script phrases.
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x",
  "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d", "\u04BB": "h", "\u04CF": "l", "\u051B": "q", "\u051D": "w",
  "\u03B1": "a", "\u03B5": "e", "\u03BF": "o", "\u03C1": "p", "\u03C4": "t", "\u03C5": "u", "\u03BD": "v", "\u03BA": "k", "\u03B9": "i",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/** Remove invisible format characters and variation selectors. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, "");
}

/**
 * NFKC, invisible characters removed, lowercased, spaces collapsed.
 * Letters keep their script, so non-Latin phrases (Russian, Chinese, Arabic)
 * still match their own patterns.
 */
export function screeningText(text: string): string {
  return stripInvisible(text.normalize("NFKC"))
    .toLowerCase()
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    // Line breaks are kept so line-anchored markers ("system:") still match.
    .replace(/[^\S\n]+/g, " ");
}

/**
 * screeningText, then accents stripped and Cyrillic/Greek look-alikes mapped
 * to Latin. For Latin-script detectors only: it turns Russian text into
 * gibberish, which is why non-Latin patterns run on screeningText instead.
 */
export function screeningSkeleton(text: string): string {
  return screeningText(text)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
}

/**
 * True when one word mixes Latin letters with Cyrillic or Greek ones, the
 * usual look-alike trick. Plain Russian or Greek text does not trip it.
 */
export function hasMixedScriptWord(text: string): boolean {
  const words = stripInvisible(text.normalize("NFKC")).split(/[^\p{L}]+/u);
  for (const word of words) {
    if (word.length < 2) continue;
    if (/\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word)) {
      return true;
    }
  }
  return false;
}
