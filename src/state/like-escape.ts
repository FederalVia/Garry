/**
 * SQL LIKE escaping
 *
 * Every LIKE built from caller text goes through these helpers, used with
 * `LIKE ? ESCAPE '\'`, so '%', '_' and the escape character itself match
 * literally.
 */

/** The ESCAPE clause that pairs with escapeLike(). */
export const LIKE_ESCAPE = "ESCAPE '\\'";

/** Escape '\', '%' and '_' so the text matches only itself in LIKE. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Pattern matching any value that contains `text`. */
export function likeContains(text: string): string {
  return `%${escapeLike(text)}%`;
}

/** Pattern matching any value that starts with `text`. */
export function likePrefix(text: string): string {
  return `${escapeLike(text)}%`;
}
