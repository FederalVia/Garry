/**
 * Single-instance lock for one state database.
 *
 * The lock is an exclusive SQLite lock on `<db>.lock`, which is a kernel
 * advisory lock: the OS drops it when the holder exits or is killed, so a
 * stale lock can never block a start and two starters can never both win a
 * takeover race (a pidfile can do neither). The holder's pid is kept in the
 * file header (PRAGMA user_version) so a refused starter can name it.
 *
 * The file is never deleted: unlinking a lock file while another process
 * has it open would let two processes lock two different files.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { protectRuntimeFile } from "../security/protected-paths.js";

export class InstanceLockedError extends Error {
  readonly pid: number | null;
  readonly lockPath: string;

  constructor(pid: number | null, lockPath: string) {
    super(
      `Another automaton${pid ? ` (pid ${pid})` : ""} holds ${lockPath}`,
    );
    this.name = "InstanceLockedError";
    this.pid = pid;
    this.lockPath = lockPath;
  }
}

export interface InstanceLock {
  readonly lockPath: string;
  release(): void;
}

interface HeldLock {
  db: Database.Database;
  refs: number;
}

const held = new Map<string, HeldLock>();
let exitHookInstalled = false;

/** Offset of the 4-byte big-endian user_version in an SQLite file header. */
const USER_VERSION_OFFSET = 60;

/**
 * Take the lock or throw InstanceLockedError naming the holder. Taking it
 * again in the same process returns another handle to the same lock.
 */
export function acquireInstanceLock(lockPath: string): InstanceLock {
  const key = path.resolve(lockPath);
  const existing = held.get(key);
  if (existing) {
    existing.refs++;
    return makeHandle(key);
  }

  fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
  let db: Database.Database | undefined;
  try {
    // timeout 0: a held lock fails at once instead of waiting.
    db = new Database(key, { timeout: 0 });
    // In EXCLUSIVE locking mode the lock taken by the first write is kept
    // until the connection closes.
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    try {
      db?.close();
    } catch {
      // Closing a connection that never locked cannot matter.
    }
    if (isBusy(err)) throw new InstanceLockedError(readHolderPid(key), key);
    throw err;
  }

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, started_at TEXT NOT NULL, argv TEXT NOT NULL)",
    );
    db.exec("DELETE FROM holder");
    db.prepare("INSERT INTO holder (pid, started_at, argv) VALUES (?, ?, ?)").run(
      process.pid,
      new Date().toISOString(),
      JSON.stringify(process.argv),
    );
    db.pragma(`user_version = ${Math.trunc(process.pid)}`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.close();
    } catch {
      // The process exits or retries; the lock goes with the connection.
    }
    throw err;
  }
  try {
    fs.chmodSync(key, 0o600);
  } catch {
    // Permissions are a nicety; the lock already holds.
  }

  // An in-process open/close of the file (read_file, write_file) would drop the lock.
  protectRuntimeFile(key);
  held.set(key, { db, refs: 1 });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", releaseAllInstanceLocks);
  }
  return makeHandle(key);
}

function makeHandle(key: string): InstanceLock {
  let released = false;
  return {
    lockPath: key,
    release(): void {
      if (released) return;
      released = true;
      const entry = held.get(key);
      if (!entry) return;
      entry.refs--;
      if (entry.refs > 0) return;
      held.delete(key);
      try {
        entry.db.close();
      } catch {
        // The OS releases the lock when the process exits in any case.
      }
    },
  };
}

/** Close every lock this process holds (also run on process exit). */
export function releaseAllInstanceLocks(): void {
  for (const [key, entry] of held) {
    held.delete(key);
    try {
      entry.db.close();
    } catch {
      // Exiting anyway.
    }
  }
}

/** True when this process holds the lock at lockPath. */
export function holdsInstanceLock(lockPath: string): boolean {
  return held.has(path.resolve(lockPath));
}

function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** The holder's pid from the file header, read without SQLite or a lock. */
function readHolderPid(key: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(key, "r");
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, USER_VERSION_OFFSET);
    if (n !== 4) return null;
    const pid = buf.readInt32BE(0);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Read-only descriptor.
      }
    }
  }
}
