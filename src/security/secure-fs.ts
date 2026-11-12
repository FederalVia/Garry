/**
 * File primitives that never follow a symlink and never write into a shared
 * inode. Reads open with O_NOFOLLOW and confirm the opened file is the one
 * that was checked. Writes go to a fresh temp file in the real parent
 * directory and are renamed into place, which replaces the directory entry
 * instead of following it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../observability/logger.js";
import {
  checkRead,
  checkWrite,
  expandHome,
  matchSecret,
  sameInodeAsSensitive,
  type CheckWriteOptions,
  type DenyCode,
} from "./protected-paths.js";

const logger = createLogger("security.secure-fs");
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

export class UnsafePathError extends Error {
  constructor(readonly code: DenyCode, message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

function readOpenFd(fd: number, size: number, position = 0): Buffer {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const n = fs.readSync(fd, buf, offset, size - offset, position + offset);
    if (n === 0) break;
    offset += n;
  }
  return buf.subarray(0, offset);
}

/**
 * checkRead, then open the real path with O_NOFOLLOW|O_NONBLOCK and confirm
 * it is a regular file, the same inode that was checked, and at most
 * maxBytes. Throws UnsafePathError on a denial, or the fs error (ENOENT etc).
 */
export function readFileSafe(absPath: string, opts: { root?: string; maxBytes?: number } = {}): string {
  const decision = checkRead(absPath, { root: opts.root });
  if (!decision.ok || !decision.real) {
    throw new UnsafePathError(decision.code ?? "UNRESOLVABLE", decision.reason ?? "read denied");
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  const before = fs.lstatSync(decision.real);
  if (before.isDirectory()) {
    throw Object.assign(new Error(`EISDIR: ${absPath} is a directory`), { code: "EISDIR" });
  }
  const fd = fs.openSync(decision.real, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError("NOT_REGULAR", `${absPath} is not a regular file`);
    if (st.dev !== before.dev || st.ino !== before.ino) {
      throw new UnsafePathError("UNRESOLVABLE", `${absPath} changed while it was being opened`);
    }
    if (st.nlink > 1 && sameInodeAsSensitive(st)) {
      throw new UnsafePathError("HARDLINK", `${absPath} is a hard link to a sensitive file`);
    }
    if (st.size > maxBytes) {
      throw new UnsafePathError("NOT_REGULAR", `${absPath} is larger than ${maxBytes} bytes`);
    }
    return readOpenFd(fd, st.size).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const warnedPaths = new Set<string>();
function warnOnce(absPath: string, why: string): void {
  const key = `${absPath}:${why}`;
  if (warnedPaths.has(key)) return;
  warnedPaths.add(key);
  logger.warn(`Ignoring ${absPath}: ${why}`);
}

/**
 * For loaders that must never throw (SKILL.md, SOUL.md, WORKLOG.md,
 * constitution.md, the providers file). The file must be a regular file with
 * nlink == 1, reached from root without any symlink, at most maxBytes, and
 * not a secret by name. Returns null otherwise (logged once), including when
 * the file is absent (not logged).
 *
 * The agent-facing state-dir allowlist is deliberately not applied: these
 * are the runtime's own fixed paths (the providers file is outside it).
 * `trusted` also skips the secret-name rule, for internal loaders of
 * operator-owned files such as config.json; link, type and root checks stay.
 * `tail` returns the last maxBytes of a larger file instead of null, for
 * append-only logs whose newest entries matter.
 */
export function readRegularFileNoFollow(
  absPath: string,
  opts: { root: string; maxBytes: number; trusted?: boolean; tail?: boolean },
): string | null {
  const lexical = path.resolve(expandHome(absPath));
  const lexicalRoot = path.resolve(expandHome(opts.root));
  const rel = path.relative(lexicalRoot, lexical);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    warnOnce(lexical, "outside its root");
    return null;
  }
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(lexicalRoot);
    real = fs.realpathSync(lexical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") warnOnce(lexical, `cannot be resolved (${code})`);
    return null;
  }
  const expected = path.join(realRoot, rel);
  if (real !== expected) {
    warnOnce(lexical, "reached through a symbolic link");
    return null;
  }
  if (!opts.trusted && matchSecret(real)) {
    warnOnce(lexical, "secret file name");
    return null;
  }
  let fd: number;
  try {
    fd = fs.openSync(expected, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    warnOnce(lexical, `cannot be opened (${(err as NodeJS.ErrnoException).code})`);
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      warnOnce(lexical, "not a regular file");
      return null;
    }
    if (st.nlink !== 1) {
      warnOnce(lexical, "has other hard links");
      return null;
    }
    if (st.size > opts.maxBytes) {
      if (opts.tail) return readOpenFd(fd, opts.maxBytes, st.size - opts.maxBytes).toString("utf8");
      warnOnce(lexical, `larger than ${opts.maxBytes} bytes`);
      return null;
    }
    return readOpenFd(fd, st.size).toString("utf8");
  } catch {
    warnOnce(lexical, "read failed");
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export interface WriteFileSafeOptions extends Omit<CheckWriteOptions, "allowDirectory"> {
  /** File mode. Default: the existing file's mode, else 0o644. */
  mode?: number;
}

/**
 * checkWrite, mkdir -p the real parent (and re-check its realpath), write a
 * temp file opened O_EXCL|O_NOFOLLOW in that parent, fsync, rename onto the
 * final path. Returns the real path written.
 */
export function writeFileSafe(
  absPath: string,
  content: string | Buffer,
  opts: WriteFileSafeOptions = {},
): string {
  const decision = checkWrite(absPath, opts);
  if (!decision.ok || !decision.real) {
    throw new UnsafePathError(decision.code ?? "UNRESOLVABLE", decision.reason ?? "write denied");
  }
  const final = decision.real;
  const parent = path.dirname(final);
  fs.mkdirSync(parent, { recursive: true });
  // A parent swapped for a link between the check and the mkdir must not redirect the write.
  if (fs.realpathSync(parent) !== parent) {
    throw new UnsafePathError("UNRESOLVABLE", `parent of ${absPath} changed while it was being created`);
  }

  let mode = opts.mode;
  if (mode === undefined) {
    try {
      const st = fs.lstatSync(final);
      mode = st.isFile() ? st.mode & 0o7777 : 0o644;
    } catch {
      mode = 0o644;
    }
  }

  const tmp = `${final}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
    mode,
  );
  try {
    try {
      const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, final);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  return final;
}

/** checkRead on a directory, then readdir of its real path. */
export function listDirSafe(absPath: string, opts: { root?: string } = {}): fs.Dirent[] {
  const decision = checkRead(absPath, { root: opts.root });
  if (!decision.ok || !decision.real) {
    throw new UnsafePathError(decision.code ?? "UNRESOLVABLE", decision.reason ?? "list denied");
  }
  const st = fs.lstatSync(decision.real);
  if (!st.isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: ${absPath} is not a directory`), { code: "ENOTDIR" });
  }
  return fs.readdirSync(decision.real, { withFileTypes: true });
}
