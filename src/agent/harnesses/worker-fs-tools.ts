/**
 * File and shell tools shared by the worker harnesses.
 *
 * Local mode (no sandboxId: the Conway client is the host anyway): files go
 * through the secure-fs primitives confined to the worker root, and exec runs
 * in the worker root with a scrubbed environment.
 *
 * Remote mode: only the Conway client is used. Its errors are returned to the
 * model; there is never a fallback to the host, which would bypass the
 * sandbox boundary.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AutomatonConfig, ConwayClient } from "../../types.js";
import type { HarnessContext } from "../harness-types.js";
import { childProcessEnv } from "../../security/child-env.js";
import {
  checkRead,
  checkWrite,
  matchProtected,
  matchSensitive,
  resolveReal,
} from "../../security/protected-paths.js";
import { listDirSafe, readFileSafe, UnsafePathError, writeFileSafe } from "../../security/secure-fs.js";

const MAX_EXEC_OUTPUT = 16_000;
const MAX_EXEC_BUFFER = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface WorkerFsContext {
  root: string;
  conway: ConwayClient;
  localMode: boolean;
}

export function isLocalMode(config: AutomatonConfig): boolean {
  return !config.sandboxId;
}

export function workerFsContext(context: HarnessContext): WorkerFsContext {
  return {
    root: context.allowedEditRoot,
    conway: context.conway,
    localMode: isLocalMode(context.config),
  };
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * "~" maps to the root. The path must stay inside the root both lexically
 * and after resolving symlinks.
 */
export function confineToWorkspace(filePath: string, root: string): string | { error: string } {
  const outside = { error: `Blocked: path "${filePath}" resolves outside workspace (${root}) [OUTSIDE_ROOT]` };
  const lexicalRoot = path.resolve(root);
  const expanded = filePath === "~" || filePath.startsWith("~/")
    ? path.join(lexicalRoot, filePath.slice(1))
    : filePath;
  const resolved = path.resolve(lexicalRoot, expanded);
  if (!isWithin(resolved, lexicalRoot)) return outside;

  const realRoot = tryRealpath(lexicalRoot);
  if (realRoot) {
    const real = resolveReal(resolved);
    if (!real) return { error: `Blocked: path "${filePath}" cannot be resolved [UNRESOLVABLE]` };
    if (!isWithin(real.real, realRoot)) return outside;
  }
  return resolved;
}

function blockedMessage(err: UnsafePathError): string {
  return `Blocked: ${err.code}: ${err.message}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Root for local fs checks in remote mode, when the root also exists here. */
function localRootIfPresent(root: string): string | undefined {
  return tryRealpath(root) ? root : undefined;
}

/** Remote mode: lexical checks always; fs checks when the path exists on this machine too. */
function remoteReadDenial(ctx: WorkerFsContext, abs: string): string | null {
  const rule = matchSensitive(abs);
  if (rule) return `Blocked: SENSITIVE_FILE: ${abs} is a sensitive path (${rule})`;
  if (resolveReal(abs)?.exists) {
    const decision = checkRead(abs, { root: localRootIfPresent(ctx.root) });
    if (!decision.ok) return `Blocked: ${decision.code}: ${decision.reason}`;
  }
  return null;
}

function remoteWriteDenial(ctx: WorkerFsContext, abs: string): string | null {
  const rule = matchProtected(abs);
  if (rule) return `Blocked: PROTECTED_FILE: ${abs} is a protected path (${rule})`;
  const decision = checkWrite(abs, { root: localRootIfPresent(ctx.root) });
  if (!decision.ok) return `Blocked: ${decision.code}: ${decision.reason}`;
  return null;
}

/** Local-mode write gate, checked before any read so a patch never reads what it may not write. */
function localWriteDenial(ctx: WorkerFsContext, abs: string): string | null {
  const decision = checkWrite(abs, { root: ctx.root });
  if (!decision.ok) return `Blocked: ${decision.code}: ${decision.reason}`;
  return null;
}

async function readContent(ctx: WorkerFsContext, abs: string): Promise<string> {
  if (ctx.localMode) return readFileSafe(abs, { root: ctx.root, maxBytes: MAX_FILE_BYTES });
  return ctx.conway.readFile(abs);
}

async function writeContent(ctx: WorkerFsContext, abs: string, content: string): Promise<void> {
  if (ctx.localMode) {
    writeFileSafe(abs, content, { root: ctx.root });
    return;
  }
  await ctx.conway.writeFile(abs, content);
}

export async function workerReadFile(
  ctx: WorkerFsContext,
  abs: string,
  offset: number,
  limit: number,
): Promise<string> {
  if (!ctx.localMode) {
    const denied = remoteReadDenial(ctx, abs);
    if (denied) return denied;
  }
  let content: string;
  try {
    content = await readContent(ctx, abs);
  } catch (err) {
    if (err instanceof UnsafePathError) return blockedMessage(err);
    return `read error: ${errorText(err)}`;
  }
  const slice = content.slice(offset, offset + limit);
  if (content.length > offset + limit) {
    return slice + `\n[TRUNCATED: ${content.length - offset - limit} more chars. Use offset=${offset + limit} to continue.]`;
  }
  return slice || "(empty file)";
}

export async function workerWriteFile(ctx: WorkerFsContext, abs: string, content: string): Promise<string> {
  const denied = ctx.localMode ? localWriteDenial(ctx, abs) : remoteWriteDenial(ctx, abs);
  if (denied) return denied;
  try {
    await writeContent(ctx, abs, content);
    return `Wrote ${content.length} bytes to ${abs}`;
  } catch (err) {
    if (err instanceof UnsafePathError) return blockedMessage(err);
    return `write error: ${errorText(err)}`;
  }
}

export async function workerPatchFile(
  ctx: WorkerFsContext,
  abs: string,
  search: string,
  replace: string,
): Promise<string> {
  const denied = ctx.localMode
    ? localWriteDenial(ctx, abs)
    : remoteWriteDenial(ctx, abs) ?? remoteReadDenial(ctx, abs);
  if (denied) return denied;
  try {
    const content = await readContent(ctx, abs);
    if (!content.includes(search)) {
      return `Error: search string not found in ${abs}. Make sure the search text matches exactly, including whitespace and newlines.`;
    }
    const patched = content.replace(search, () => replace);
    await writeContent(ctx, abs, patched);
    return `Patched ${abs}: replaced ${search.length} chars with ${replace.length} chars`;
  } catch (err) {
    if (err instanceof UnsafePathError) return blockedMessage(err);
    return `patch error: ${errorText(err)}`;
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export async function workerListDir(ctx: WorkerFsContext, abs: string): Promise<string> {
  if (ctx.localMode) {
    try {
      const entries = listDirSafe(abs, { root: ctx.root });
      return entries
        .map((entry) => `${entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"}\t${entry.name}`)
        .join("\n") || "(empty directory)";
    } catch (err) {
      if (err instanceof UnsafePathError) return blockedMessage(err);
      return `list error: ${errorText(err)}`;
    }
  }
  const denied = remoteReadDenial(ctx, abs);
  if (denied) return denied;
  try {
    const result = await ctx.conway.exec(`ls -1Ap -- ${shellQuote(abs)}`, 10_000);
    if (result.exitCode !== 0) return `list error: ${result.stderr || result.stdout}`;
    const lines = result.stdout.split("\n").filter(Boolean);
    return lines
      .map((line) => (line.endsWith("/") ? `dir\t${line.slice(0, -1)}` : `file\t${line}`))
      .join("\n") || "(empty directory)";
  } catch (err) {
    return `list error: ${errorText(err)}`;
  }
}

export function formatExecResult(stdout: string, stderr: string): string {
  const out = stdout.length > MAX_EXEC_OUTPUT
    ? stdout.slice(0, MAX_EXEC_OUTPUT) + `\n[TRUNCATED: ${stdout.length - MAX_EXEC_OUTPUT} chars]`
    : stdout;
  const err = stderr.length > 4000
    ? stderr.slice(0, 4000) + "\n[TRUNCATED]"
    : stderr;
  return err ? `stdout:\n${out}\nstderr:\n${err}` : out || "(no output)";
}

function localExec(root: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd: root, env: childProcessEnv(), timeout: timeoutMs, maxBuffer: MAX_EXEC_BUFFER },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (error && !out && !errOut) {
          resolve(`exec error: ${error.message}`);
          return;
        }
        resolve(formatExecResult(out, errOut));
      },
    );
  });
}

export async function workerExec(ctx: WorkerFsContext, command: string, timeoutMs: number): Promise<string> {
  if (ctx.localMode) {
    if (!tryRealpath(ctx.root)) return `exec error: workspace ${ctx.root} does not exist`;
    return localExec(ctx.root, command, timeoutMs);
  }
  try {
    const result = await ctx.conway.exec(command, timeoutMs);
    return formatExecResult(result.stdout ?? "", result.stderr ?? "");
  } catch (err) {
    return `exec error: ${errorText(err)}`;
  }
}
