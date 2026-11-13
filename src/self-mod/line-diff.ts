/**
 * Line diff for the self-modification audit log.
 *
 * Myers' O(ND) algorithm on the lines between the common prefix and suffix,
 * rendered as unified hunks with 3 lines of context, so a change anywhere in
 * a file shows up in the audit entry whatever was inserted above it.
 */

/** Above this edit distance the diff is summarised (bounds time and memory). */
const MAX_EDIT_DISTANCE = 2000;
const CONTEXT_LINES = 3;

type Op = { kind: " " | "-" | "+"; text: string; oldNo: number; newNo: number };

export interface LineDiff {
  added: number;
  deleted: number;
  /** Unified hunks; for a summarised diff, a one-line note instead. */
  hunks: string[];
  /** True when the edit distance was too large for a line-by-line diff. */
  summarized: boolean;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Edit script for a[aLo..aHi) vs b[bLo..bHi), or null past the distance cap. */
function myers(a: string[], b: string[], aLo: number, aHi: number, bLo: number, bHi: number): Op[] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Walk the trace back from (n, m) to (0, 0).
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: " ", text: a[aLo + x], oldNo: aLo + x, newNo: bLo + y });
    }
    if (down) {
      y--;
      ops.push({ kind: "+", text: b[bLo + y], oldNo: aLo + x, newNo: bLo + y });
    } else {
      x--;
      ops.push({ kind: "-", text: a[aLo + x], oldNo: aLo + x, newNo: bLo + y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: " ", text: a[aLo + x], oldNo: aLo + x, newNo: bLo + y });
  }
  return ops.reverse();
}

function renderHunks(ops: Op[]): string[] {
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].kind === " ") i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - CONTEXT_LINES);
    // Extend while the next change is within 2 * context of the last one.
    let end = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j].kind !== " ") {
        end = j;
        j++;
        continue;
      }
      let run = 0;
      while (j + run < ops.length && ops[j + run].kind === " ") run++;
      if (j + run >= ops.length || run > 2 * CONTEXT_LINES) break;
      j += run;
    }
    const stop = Math.min(ops.length, end + 1 + CONTEXT_LINES);
    const slice = ops.slice(start, stop);
    const oldCount = slice.filter((o) => o.kind !== "+").length;
    const newCount = slice.filter((o) => o.kind !== "-").length;
    const oldStart = oldCount === 0 ? slice[0].oldNo : slice[0].oldNo + 1;
    const newStart = newCount === 0 ? slice[0].newNo : slice[0].newNo + 1;
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (const op of slice) lines.push(`${op.kind}${op.text}`);
    hunks.push(lines.join("\n"));
    i = stop;
  }
  return hunks;
}

/** Diff two texts line by line. */
export function diffLines(oldText: string, newText: string): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const middle = myers(a, b, pre, a.length - suf, pre, b.length - suf);
  if (!middle) {
    const deleted = a.length - pre - suf;
    const added = b.length - pre - suf;
    return {
      added,
      deleted,
      summarized: true,
      hunks: [`@@ -${pre + 1},${deleted} +${pre + 1},${added} @@ (too many changes for a line diff: lines ${pre + 1}-${a.length - suf} replaced)`],
    };
  }
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: " ", text: a[i], oldNo: i, newNo: i });
  ops.push(...middle);
  for (let i = suf; i > 0; i--) {
    ops.push({ kind: " ", text: a[a.length - i], oldNo: a.length - i, newNo: b.length - i });
  }
  return {
    added: middle.filter((o) => o.kind === "+").length,
    deleted: middle.filter((o) => o.kind === "-").length,
    summarized: false,
    hunks: renderHunks(ops),
  };
}

/**
 * The audit text: a header with the counts and the new content's hash, then
 * the hunks. Only the assembled text is cut, with a note of what was left out.
 */
export function formatAuditDiff(oldText: string, newText: string, newSha256: string, maxChars: number): string {
  const diff = diffLines(oldText, newText);
  const header = `+${diff.added} -${diff.deleted} lines; sha256(new)=${newSha256}`;
  const lines = [header, ...diff.hunks.join("\n").split("\n")];
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  let size = 0;
  let index = 0;
  const reserve = 120;
  for (; index < lines.length; index++) {
    if (size + lines[index].length + 1 > maxChars - reserve) break;
    kept.push(lines[index]);
    size += lines[index].length + 1;
  }
  const omitted = lines.slice(index).filter((l) => /^[+-]/.test(l)).length;
  kept.push(`… (truncated: ${omitted} more changed lines; see the git commit, if one was made, or the file (sha256 above))`);
  return kept.join("\n");
}
