/**
 * Command Safety Policy Rules
 *
 * Detects shell injection attempts and forbidden command patterns.
 *
 * The forbidden-command check is a TRIPWIRE, not a security boundary. It
 * stops accidental damage and copy-pasted injection one-liners: it denies a
 * command that names a secret (whatever the verb), globs hidden home paths,
 * dumps the environment, kills the runtime, reads the whole home or root
 * tree recursively, or writes to guard files (by shell verb, inline
 * interpreter or git). exec runs as the same OS user that owns the wallet,
 * so a script written to disk and run, string building, a `cd` in an earlier
 * exec call, `patch` from a file, a short glob or a background job get past
 * any pattern list. Confidentiality of the wallet, integrity of guard code and
 * protection of the process from signals need exec under a separate OS user
 * or sandbox with no access to ~/.automaton or the runtime checkout.
 */

import nodePath from "node:path";
import os from "node:os";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import {
  GUARD_COMMAND_FRAGMENTS,
  SENSITIVE_COMMAND_FRAGMENTS,
  homeDir,
} from "../../security/protected-paths.js";

// Shell metacharacters that could enable injection when interpolated
const SHELL_METACHAR_RE = /[;|&$`\n(){}<>]/;

// Tools whose arguments may be interpolated into shell commands
const SHELL_INTERPOLATED_TOOLS = new Set([
  "exec",
  "pull_upstream",
  "install_npm_package",
  "install_mcp_server",
  "install_skill",
  "create_skill",
  "remove_skill",
]);

// Fields per tool that get interpolated into shell commands
const SHELL_FIELDS: Record<string, string[]> = {
  exec: [], // exec is the shell itself, handled by forbidden_patterns
  pull_upstream: ["commit"],
  install_npm_package: ["package"],
  install_mcp_server: ["package", "name"],
  install_skill: ["name", "url"],
  create_skill: ["name"],
  remove_skill: ["name"],
};

// Forbidden command patterns (migrated from tools.ts isForbiddenCommand)
const FORBIDDEN_COMMAND_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Self-destruction
  { pattern: /rm\s+(-rf?\s+)?.*\.automaton/, description: "Delete .automaton directory" },
  { pattern: /rm\s+(-rf?\s+)?.*state\.db/, description: "Delete state database" },
  { pattern: /rm\s+(-rf?\s+)?.*wallet\.json/, description: "Delete wallet" },
  { pattern: /rm\s+(-rf?\s+)?.*automaton\.json/, description: "Delete config" },
  { pattern: /rm\s+(-rf?\s+)?.*heartbeat\.yml/, description: "Delete heartbeat config" },
  { pattern: /rm\s+(-rf?\s+)?.*SOUL\.md/, description: "Delete SOUL.md" },
  // Process killing
  { pattern: /kill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /pkill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /systemctl\s+(stop|disable)\s+automaton/, description: "Stop automaton service" },
  // Database destruction
  { pattern: /DROP\s+TABLE/i, description: "Drop database table" },
  { pattern: /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i, description: "Delete from critical table" },
  { pattern: /TRUNCATE/i, description: "Truncate table" },
  // Safety infrastructure modification via shell
  { pattern: /sed\s+.*injection-defense/, description: "Modify injection defense via sed" },
  { pattern: /sed\s+.*self-mod\/code/, description: "Modify self-mod code via sed" },
  { pattern: /sed\s+.*audit-log/, description: "Modify audit log via sed" },
  { pattern: />\s*.*injection-defense/, description: "Overwrite injection defense" },
  { pattern: />\s*.*self-mod\/code/, description: "Overwrite self-mod code" },
  { pattern: />\s*.*audit-log/, description: "Overwrite audit log" },
  // Credential harvesting
  { pattern: /cat\s+.*\.ssh/, description: "Read SSH keys" },
  { pattern: /cat\s+.*\.gnupg/, description: "Read GPG keys" },
  { pattern: /cat\s+.*\.env/, description: "Read environment file" },
  { pattern: /cat\s+.*wallet\.json/, description: "Read wallet file" },
  // Policy engine modification via shell
  { pattern: /sed\s+.*policy-engine/, description: "Modify policy engine via sed" },
  { pattern: /sed\s+.*policy-rules/, description: "Modify policy rules via sed" },
  { pattern: />\s*.*policy-engine/, description: "Overwrite policy engine" },
  { pattern: />\s*.*policy-rules/, description: "Overwrite policy rules" },
];

/**
 * Normalised copy of a command for the tripwire: lower-cased, quotes and
 * backslashes removed, and the home directory spelled "~".
 */
export function normalizeCommand(command: string): string {
  let out = command.replace(/["'\\`]/g, "");
  const home = homeDir();
  if (home && home !== "/") out = out.split(home).join("~");
  out = out.toLowerCase();
  out = out.replace(/\$\{home\}|\$home\b/g, "~");
  out = out.replace(/(^|[^a-z0-9_.\-/])\/root(?=\/|$|[^a-z0-9_.\-])/g, "$1~");
  // /proc//self and /proc/./self name the same file as /proc/self.
  out = out.replace(/\/{2,}/g, "/");
  while (out.includes("/./")) out = out.replace(/\/\.\//g, "/");
  return out;
}

/** State-dir entries a command may name. Anything else under .automaton trips. */
const STATE_DIR_COMMAND_ALLOWED = /^\/(?:workspace|worklog\.md|skills|agent\.log|logs|runtime|soul\.md|heartbeat\.yml|constitution\.md)(?:\/|$)/;

function automatonTokenMatch(normalized: string): string | null {
  for (const token of normalized.split(/[\s;|&<>()=,]+/)) {
    let index = token.indexOf(".automaton");
    while (index >= 0) {
      const rest = token.slice(index + ".automaton".length);
      if (!STATE_DIR_COMMAND_ALLOWED.test(rest) || rest.includes("/..")) {
        return token;
      }
      index = token.indexOf(".automaton", index + 1);
    }
  }
  return null;
}

const WRITE_VERB = /(?:^|[\s;|&(])(?:cp|mv|tee|dd|install|ln|rsync|truncate|chmod|chown|rm|unlink|shred|touch)(?=\s)|(?:^|[\s;|&(])sed\s+(?:-[a-z]*i|--in-place)|(?:^|[\s;|&(])perl\s+-[a-z]*i|>(?!&|\s*\/dev\/null)/;

const ENV_DUMP_PATTERNS: RegExp[] = [
  /(?:^|[;&|(]|\s)env\s*(?:$|[|;&>])/,
  /(?:^|[;&|(\s])printenv(?:\s|$|[|;&>])/,
  /(?:^|[;&|(\s])export\s+-p\b/,
  /(?:^|[;&|(\s])declare\s+-[a-z]*[xp]/,
  /(?:^|[;&|(\s])compgen\s+-[a-z]*e/,
  /(?:^|[;&|(])\s*set\s*(?:$|[|;&>])/,
];

const SELF_KILL_PATTERNS: RegExp[] = [
  /(?:^|[;&|(\s])(?:pkill|killall)\b[^;&|]*\b(?:node|tsx|automaton)\b/,
  /(?:^|[;&|(\s])kill\b[^;&|]*\$\((?:\s*)(?:pgrep|pidof|ps)\b/,
  /(?:^|[;&|(\s])kill\b[^;&|]*(?:\$\$|\$ppid\b|\s-1\b|\s1(?:\s|$))/,
  // Pids piped in from a process listing.
  /(?:^|[;&|(\s])xargs\b[^;&|]*\b(?:kill|pkill|killall)\b/,
  /\|\s*(?:sudo\s+)?(?:kill|pkill|killall)\b/,
];

// normalizeCommand strips backticks, so this one runs on the raw command.
const BACKTICK_KILL = /(?:^|[;&|(\s])kill\b[^;&|]*`\s*(?:pgrep|pidof|ps)\b/i;

// Pids from a process listing handed to kill one at a time by a shell loop:
// `for p in $(pgrep node); do kill $p; done`, `pgrep node | while read p; do
// kill $p; done`, `while read p; do kill $p; done < <(pgrep node)`. kill
// must start a command in the loop body (after do, then, a separator, sudo
// or xargs), so a loop that only prints or greps for "kill" passes. Done in
// linear passes: a single regex over the body rescans the rest of the
// command from every loop header.
const PID_LIST = /(?:^|[\s(`|])(?:sudo\s+)?(?:pgrep|pidof|ps)\b/;
const FOR_OVER_PIDS = /(?:^|[;&|(\s])for\s+\w+\s+in\s+(?:\$\(|`)\s*(?:sudo\s+)?(?:pgrep|pidof|ps)\b/;
const PIPE_INTO_READ = /\|\s*while\s+(?:ifs=\S*\s+)?read\b/g;
const WHILE_READ = /(?:^|[;&|(\s])while\s+(?:ifs=\S*\s+)?read\b/;
const PIDS_AFTER_DONE = /^\s*<\s*<\(\s*(?:sudo\s+)?(?:pgrep|pidof|ps)\b/;
const BODY_KILL = /(?:\bdo|\bthen|\belse|[;&|(\n]|\bsudo|\bxargs(?:\s+-\S+)*)\s*kill\b/;

function loopKillMatch(command: string): boolean {
  // Lower-cased, quotes and backslashes removed, backticks kept.
  const text = command.replace(/["'\\]/g, "").toLowerCase();
  const chunks = text.split(/\bdone\b/);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    let header = -1;
    const forLoop = FOR_OVER_PIDS.exec(chunk);
    if (forLoop) header = forLoop.index + forLoop[0].length;
    let offset = 0;
    for (const segment of chunk.split(/[;&\n]/)) {
      const pids = segment.search(PID_LIST);
      let lastRead = -1;
      for (const m of segment.matchAll(PIPE_INTO_READ)) lastRead = (m.index ?? 0) + m[0].length;
      if (pids >= 0 && lastRead > pids) {
        header = header < 0 ? offset + lastRead : Math.min(header, offset + lastRead);
      }
      offset += segment.length + 1;
    }
    if (header < 0 && c + 1 < chunks.length && PIDS_AFTER_DONE.test(chunks[c + 1])) {
      const read = WHILE_READ.exec(chunk);
      if (read) header = read.index + read[0].length;
    }
    if (header >= 0 && BODY_KILL.test(chunk.slice(header))) return true;
  }
  return false;
}

// ─── Shell-word parsing (approximate; enough for a tripwire) ─────

const SEGMENT_OPERATORS = new Set([";", "&", "&&", "|", "||", "\n", "(", ")"]);

// Stands in for a glob character inside quotes or after a backslash, which
// the shell does not expand.
const QUOTED_GLOB = "\u0001";
const maskGlobs = (s: string) => s.replace(/[*?[]/g, QUOTED_GLOB);

/**
 * Split a command into segments of words: quotes resolved, operators split.
 * `$(` starts a segment, so a command substitution is seen as a command.
 * With maskQuoted, quoted glob characters are replaced by QUOTED_GLOB.
 */
function splitSegments(command: string, maskQuoted = false): string[][] {
  const quoted = (s: string) => (maskQuoted ? maskGlobs(s) : s);
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word += quoted(command.slice(i + 1, stop));
      inWord = true;
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < command.length) j++;
        word += quoted(command[j]);
      }
      inWord = true;
      i = j;
    } else if (c === "\\" && i + 1 < command.length) {
      word += quoted(command[++i]);
      inWord = true;
    } else if (c === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
      endSegment();
      i++;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "`" || ((c === "(" || c === ")") && command[i - 1] !== "$")) {
      // `2>&1` is a redirection, not a background operator.
      if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
        word += c;
        inWord = true;
        continue;
      }
      endSegment();
    } else if (c === "<" || c === ">") {
      // Redirections and their targets are not command operands.
      endWord();
      while (i + 1 < command.length && /[<>&0-9]/.test(command[i + 1])) i++;
      while (i + 1 < command.length && /[ \t]/.test(command[i + 1])) i++;
      while (i + 1 < command.length && !/[\s;&|()<>]/.test(command[i + 1])) i++;
    } else {
      // A trailing fd number before a redirection (2>) is dropped with it.
      if (/[0-9]/.test(c) && !inWord && /[<>]/.test(command[i + 1] ?? "")) continue;
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

// Options of wrapper commands that take a separate value (sudo -u root).
const PREFIX_VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
  doas: new Set(["-u", "-C"]),
  xargs: new Set(["-I", "-n", "-P", "-d", "-a", "-E", "-L", "-s"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  env: new Set(["-u", "-C", "-S"]),
};

const PREFIX_COMMANDS = new Set(["sudo", "nice", "nohup", "time", "command", "exec", "builtin", "env", "timeout", "stdbuf", "ionice", "xargs", "doas"]);

/** Strip wrappers (sudo, env VAR=1, timeout 5, xargs -0 ...) to find the real command. */
function commandWords(words: string[]): { cmd: string; args: string[] } | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const base = nodePath.posix.basename(w);
    if (/^[a-z_][a-z0-9_]*=/i.test(w)) { i++; continue; }
    if (PREFIX_COMMANDS.has(base)) {
      i++;
      const valueOptions = PREFIX_VALUE_OPTIONS[base];
      while (i < words.length && (words[i].startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(words[i]))) {
        if (valueOptions?.has(words[i])) i++;
        i++;
      }
      continue;
    }
    return { cmd: base, args: words.slice(i + 1) };
  }
  return null;
}

/** Options and operands of a word list; everything after `--` is an operand. */
function splitArgs(args: string[]): { options: string[]; operands: string[] } {
  const options: string[] = [];
  const operands: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === "--") { ended = true; continue; }
    if (!ended && a.startsWith("-") && a !== "-") options.push(a);
    else operands.push(a);
  }
  return { options, operands };
}

const hasShort = (options: string[], letters: RegExp) =>
  options.some((o) => !o.startsWith("--") && letters.test(o.slice(1)));
const hasLong = (options: string[], names: string[]) =>
  options.some((o) => names.some((n) => o === n || o.startsWith(n + "=")));

// Stand-in for the home directory while resolving paths.
const HOME_MARK = "/__home__";

// A directory the tripwire cannot know (~-, $OLDPWD): treated as home.
const UNKNOWN_DIR = HOME_MARK;

function currentUser(): string {
  try {
    return os.userInfo().username.toLowerCase();
  } catch {
    return "";
  }
}

function resolveWord(word: string, cwd: string | null): string | null {
  let w = normalizeCommand(word);
  // The shell's other spellings of the current, previous or a user's home dir.
  const dirVar = /^(?:~\+|\$pwd\b|\$\{pwd\})(.*)$/.exec(w);
  const oldVar = /^(?:~-|\$oldpwd\b|\$\{oldpwd\})(.*)$/.exec(w);
  const userHome = /^~([a-z_][a-z0-9_.-]*)(\/.*)?$/.exec(w);
  if (dirVar) {
    if (!cwd) return null;
    w = cwd + "/" + dirVar[1];
  } else if (oldVar) {
    w = UNKNOWN_DIR + "/" + oldVar[1];
  } else if (userHome) {
    const user = userHome[1];
    const own = user === currentUser() || (user === "root" && homeDir() === "/root");
    w = (own ? HOME_MARK : user === "root" ? "/root" : `/home/${user}`) + (userHome[2] ?? "");
  }
  let p: string;
  if (w === "~" || w.startsWith("~/")) p = HOME_MARK + w.slice(1);
  else if (w.startsWith("/")) p = w;
  else if (cwd) p = cwd + "/" + w;
  else return null;
  return nodePath.posix.normalize(p).replace(/(.)\/+$/, "$1");
}

/** The whole home tree, a parent of it, the root, or every hidden entry of home. */
function isHomeOrRoot(resolved: string | null): boolean {
  if (!resolved) return false;
  return (
    resolved === "/" ||
    resolved === HOME_MARK ||
    resolved === "/home" ||
    resolved === "/root" ||
    /^\/home\/[^/]+$/.test(resolved) ||
    /^\/home\/[^/]*[*?[]/.test(resolved) ||
    new RegExp(`^${HOME_MARK}/\\.[^/]*[*?[]`).test(resolved)
  );
}

/**
 * Paths a recursive reader in this segment would read, or null when the
 * command is not a recursive reader. "." is implied where the tool does so.
 */
function recursiveReadTargets(cmd: string, args: string[], findOutputRead: boolean): string[] | null {
  const { options, operands } = splitArgs(args);
  const paths = (list: string[]) => list.filter((o) => !/^\d+$/.test(o));
  switch (cmd) {
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
    case "ag":
    case "ack": {
      if (cmd.endsWith("grep") && !hasShort(options, /r/i) && !hasLong(options, ["--recursive", "--dereference-recursive"])) return null;
      const explicitPattern = hasShort(options, /^[a-z]*[ef]$/) || hasLong(options, ["--regexp", "--file"]);
      const files = paths(explicitPattern ? operands : operands.slice(1));
      return files.length ? files : ["."];
    }
    case "find": {
      const firstExpr = args.findIndex((a) => a.startsWith("-") || a === "!" || a === "(");
      const expr = firstExpr < 0 ? [] : args.slice(firstExpr);
      // A file list fed to another command is read just like -exec.
      if (!findOutputRead && !expr.some((a) => /^-(?:exec|execdir|ok|okdir|delete)$/.test(a))) return null;
      const roots = firstExpr < 0 ? args : args.slice(0, firstExpr);
      return roots.length ? roots : ["."];
    }
    case "tar": {
      const first = args[0] ?? "";
      const creates = (!first.startsWith("-") && /c/.test(first)) || hasShort(options, /c/) || hasLong(options, ["--create"]);
      if (!creates) return null;
      // -C dir changes where the following operands are read from.
      return [...operands, ...args.filter((_, i) => args[i - 1] === "-C" || args[i - 1] === "--directory")];
    }
    case "zip":
      return hasShort(options, /r/) || hasLong(options, ["--recurse-paths"]) ? operands : null;
    case "cp":
    case "scp":
    case "rsync":
      if (!hasShort(options, cmd === "scp" ? /r/ : /[ra]/i) && !hasLong(options, ["--recursive", "--archive"])) return null;
      return operands.slice(0, -1);
    default:
      return null;
  }
}

/**
 * Recursive read of the home or root tree. exec starts in HOME, so "." with no
 * earlier `cd` elsewhere is home.
 */
// find's file list is consumed by another command: substitution, process
// substitution, or a pipe into xargs, a read loop or a shell.
const FIND_OUTPUT_READ = /\$\(|`|<\(|\|\s*(?:sudo\s+)?(?:xargs|while|parallel|sh|bash|zsh|dash)\b/;

/** Each segment's command and arguments, with the cwd it runs in (exec starts in HOME). */
function* segmentsWithCwd(
  command: string,
  maskQuoted = false,
): Generator<{ cmd: string; args: string[]; cwd: string | null }> {
  let cwd: string | null = HOME_MARK;
  for (const words of splitSegments(command, maskQuoted)) {
    const parsed = commandWords(words);
    if (!parsed) continue;
    const { cmd, args } = parsed;
    if (cmd === "cd" || cmd === "pushd") {
      const target = args.find((a) => !a.startsWith("-"));
      cwd = target === undefined ? HOME_MARK : resolveWord(target, cwd);
      continue;
    }
    yield { cmd, args, cwd };
  }
}

function recursiveHomeReadMatch(command: string): string | null {
  const findOutputRead = FIND_OUTPUT_READ.test(command);
  for (const { cmd, args, cwd } of segmentsWithCwd(command)) {
    const targets = recursiveReadTargets(cmd, args, findOutputRead);
    if (targets?.some((t) => isHomeOrRoot(resolveWord(t, cwd)))) return cmd;
  }
  return null;
}

const HIDDEN_HOME_GLOB = new RegExp(`^${HOME_MARK}/\\.[^/]*[*?[]`);

/**
 * An unquoted glob over a hidden entry of home, however it is spelled:
 * `.?utomaton`, `./.[a]utomaton` (exec starts in HOME) or after `cd ~`.
 */
function hiddenHomeGlobMatch(command: string): string | null {
  for (const { cmd, args, cwd } of segmentsWithCwd(command, true)) {
    for (const word of [cmd, ...args]) {
      if (!/[*?[]/.test(word)) continue;
      const resolved = resolveWord(word, cwd);
      if (resolved && HIDDEN_HOME_GLOB.test(resolved)) return word;
    }
  }
  return null;
}

/** Literal characters of a glob, without its wildcards and bracket sets. */
function globLiterals(component: string): string {
  return component.replace(/\[[^\]]*\]?/g, "").replace(/[*?]/g, "");
}

function globToRegExp(component: string): RegExp | null {
  let re = "";
  for (let i = 0; i < component.length; i++) {
    const c = component[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = component.indexOf("]", i + 2);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      let set = component.slice(i + 1, end);
      if (set.startsWith("!")) set = "^" + set.slice(1);
      re += "[" + set.replace(/\\/g, "\\\\") + "]";
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return null;
  }
}

const GUARD_EXTENSIONS = ["", ".ts", ".js", ".d.ts", ".mjs", ".cjs", ".json", ".md", ".yml"];

/**
 * A guard fragment that an unquoted glob operand could expand to, such as
 * src/agent/policy-eng*.ts. A component with fewer than three literal
 * characters (`*`, `*.ts`) is not counted, or `rm -rf dist/*` in any
 * project would trip; that and other short globs are a documented gap.
 */
function guardGlobMatch(command: string): string | null {
  for (const words of splitSegments(command, true)) {
    for (const word of words) {
      if (!/[*?[]/.test(word)) continue;
      const parts = normalizeCommand(word).split("/");
      for (const fragment of GUARD_COMMAND_FRAGMENTS) {
        const fparts = fragment.replace(/\/$/, "/*").split("/");
        for (let start = 0; start + fparts.length <= parts.length; start++) {
          const ok = fparts.every((fp, k) => {
            const part = parts[start + k];
            const isLast = k === fparts.length - 1;
            if (!/[*?[]/.test(part)) {
              if (fparts.length === 1) return false;
              return fp === "*" || (isLast ? part.startsWith(fp) : part === fp);
            }
            if (fp === "*") return true;
            if (globLiterals(part).replace(/\.[a-z]+$/, "").length < 3) return false;
            const re = globToRegExp(part);
            const candidates = isLast ? GUARD_EXTENSIONS.map((e) => fp + e) : [fp];
            return !!re && candidates.some((c) => re.test(c));
          });
          if (ok) return fragment;
        }
      }
    }
  }
  return null;
}

/** The runtime's own pid and command line, read at call time. */
function selfKillMatch(command: string): string | null {
  const ownPids = new Set([process.pid, process.ppid].filter((p) => Number.isInteger(p) && p > 1));
  const argvLine = process.argv.join(" ").toLowerCase();
  const names = [nodePath.basename(process.execPath), process.title].map((n) => n.toLowerCase());
  const matchesSelf = (pattern: string, haystacks: string[]) => {
    const p = pattern.toLowerCase();
    if (!p) return false;
    if (haystacks.some((h) => h.includes(p))) return true;
    if (p.length > 200) return false;
    try {
      const re = new RegExp(p);
      return haystacks.some((h) => re.test(h));
    } catch {
      return false;
    }
  };

  for (const words of splitSegments(command)) {
    const parsed = commandWords(words);
    if (!parsed) continue;
    const { cmd, args } = parsed;
    if (cmd === "kill") {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!/^-?\d+$/.test(a)) continue;
        // A leading -N is the signal, not a process group.
        if (i === 0 && a.startsWith("-")) continue;
        const n = Math.abs(Number(a));
        if (n === 0) return "kill 0 (own process group)";
        if (ownPids.has(n)) return "kill of the runtime's pid";
      }
    } else if (cmd === "pkill") {
      // Drop the values of options that take one (-u root, --signal 9).
      const valueOption = /^-(?:[ugGPstF]|-signal|-uid|-euid|-group|-parent|-session|-terminal|-pidfile)$/;
      const { options, operands } = splitArgs(args.filter((_, i) => !valueOption.test(args[i - 1] ?? "")));
      const pattern = operands[operands.length - 1];
      if (pattern === undefined) continue;
      const fullLine = hasShort(options, /f/) || hasLong(options, ["--full"]);
      if (matchesSelf(pattern, fullLine ? [argvLine] : names)) return "pkill matching the runtime";
    } else if (cmd === "killall") {
      const { options, operands } = splitArgs(args);
      const regex = hasShort(options, /r/) || hasLong(options, ["--regexp"]);
      for (const name of operands) {
        if (regex ? matchesSelf(name, names) : names.includes(name.toLowerCase())) return "killall matching the runtime";
      }
    }
  }
  return null;
}

// Inline code given to an interpreter, which can read or write any file.
const INLINE_INTERPRETER = new RegExp(
  [
    String.raw`(?:^|[\s;|&(/])(?:python[0-9.]*|pypy[0-9.]*)(?:\s+-[a-z]+)*\s+-[a-z]*c\b`,
    String.raw`(?:^|[\s;|&(/])(?:node|nodejs|bun|tsx)(?:\s+-\S+)*?\s+(?:-e|--eval|-p|--print|-pe)\b`,
    String.raw`(?:^|[\s;|&(/])(?:perl|ruby)(?:\s+-[a-z]+)*\s+-[a-z]*e\b`,
    String.raw`(?:^|[\s;|&(/])php(?:\s+-\S+)*\s+-r\b`,
    String.raw`(?:^|[\s;|&(/])deno\s+eval\b`,
    String.raw`(?:^|[\s;|&(/])(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|perl|ruby|php)(?:\s+-)?\s*<<`,
    // Script on stdin.
    String.raw`(?:^|[\s;|&(/])(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|perl|ruby|php|sh|bash|zsh|dash)(?:\s+-\S+)*\s+(?:/dev/stdin|/dev/fd/0|-)(?=\s|$)`,
    // Line and screen editors: exec has no terminal, so any run is scripted.
    String.raw`(?:^|[\s;|&(/])(?:ed|red|ex|vi|vim|nvim|view|emacs)(?=\s)`,
  ].join("|"),
);

// git verbs that rewrite working-tree files.
const GIT_REWRITE = /(?:^|[\s;|&(])git(?:\s+-\S+(?:\s+[^\s-]\S*)?)*?\s+(?:checkout|restore|apply|am|cherry-pick|revert|reset|stash)\b/;

function tripwireMatch(command: string): { description: string; pattern: string } | null {
  const normalized = normalizeCommand(command);

  for (const { re, label } of SENSITIVE_COMMAND_FRAGMENTS) {
    if (re.test(normalized)) return { description: `References ${label}`, pattern: re.source };
  }
  const stateToken = automatonTokenMatch(normalized);
  if (stateToken) {
    return { description: "References the state directory outside its allowed entries", pattern: stateToken.slice(0, 80) };
  }
  if (/~\/\.[^\s/]*[*?[]/.test(normalized) || /(?:^|[\s/=])\.a(?:u(?:t(?:o(?:m(?:a(?:t(?:o(?:n)?)?)?)?)?)?)?)?[*?[]/.test(normalized)) {
    return { description: "Glob over hidden home paths", pattern: "hidden-home-glob" };
  }
  const hiddenGlob = hiddenHomeGlobMatch(command);
  if (hiddenGlob) {
    return { description: "Glob over hidden home paths", pattern: hiddenGlob.slice(0, 80) };
  }
  if (/(?:^|[\s;&|(])(?:cd|pushd)\s+\/proc\/[^\s/;&|)]+\/?(?=$|[\s;&|)])/.test(normalized)) {
    return { description: "References process memory or environment", pattern: "cd /proc/<pid>" };
  }
  for (const re of ENV_DUMP_PATTERNS) {
    if (re.test(normalized)) return { description: "Dumps the process environment", pattern: re.source };
  }
  for (const re of SELF_KILL_PATTERNS) {
    if (re.test(normalized)) return { description: "Kills the runtime process", pattern: re.source };
  }
  if (BACKTICK_KILL.test(command)) {
    return { description: "Kills the runtime process", pattern: BACKTICK_KILL.source };
  }
  if (loopKillMatch(command)) {
    return { description: "Kills the runtime process", pattern: "kill in a loop over a process listing" };
  }
  const selfKill = selfKillMatch(command);
  if (selfKill) return { description: "Kills the runtime process", pattern: selfKill };
  const reader = recursiveHomeReadMatch(command);
  if (reader) {
    return { description: "Recursive read of the home or root directory", pattern: reader };
  }
  const guardFragment = GUARD_COMMAND_FRAGMENTS.find((f) => normalized.includes(f)) ?? guardGlobMatch(command);
  if (guardFragment) {
    if (WRITE_VERB.test(normalized)) {
      return { description: `Writes to guard file (${guardFragment})`, pattern: guardFragment };
    }
    // Inline code cannot be told apart from a write, so reads are denied too;
    // read_file stays available for reading guard code.
    if (INLINE_INTERPRETER.test(normalized)) {
      return { description: `Inline interpreter code naming a guard file (${guardFragment})`, pattern: guardFragment };
    }
    if (GIT_REWRITE.test(normalized)) {
      return { description: `git rewrite of a guard file (${guardFragment})`, pattern: guardFragment };
    }
  }
  return null;
}

export function getForbiddenCommandMatch(command: string): { description: string; pattern: string } | null {
  for (const { pattern, description } of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { description, pattern: pattern.source };
    }
  }
  return tripwireMatch(command);
}

export function isForbiddenCommand(command: string): boolean {
  return getForbiddenCommandMatch(command) !== null;
}

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Detect shell metacharacters in tool arguments that will be
 * interpolated into shell commands.
 */
function createShellInjectionRule(): PolicyRule {
  return {
    id: "command.shell_injection",
    description: "Detect shell metacharacters in arguments interpolated into shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: Array.from(SHELL_INTERPOLATED_TOOLS),
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const fields = SHELL_FIELDS[request.tool.name];
      if (!fields || fields.length === 0) return null;

      for (const field of fields) {
        const value = request.args[field];
        if (typeof value !== "string") continue;

        if (SHELL_METACHAR_RE.test(value)) {
          return deny(
            "command.shell_injection",
            "SHELL_INJECTION_DETECTED",
            `Shell metacharacter detected in ${request.tool.name}.${field}: "${value.slice(0, 50)}"`,
          );
        }
      }

      return null;
    },
  };
}

/**
 * Check exec commands against forbidden patterns.
 * Replaces the isForbiddenCommand() function with a proper policy rule.
 */
function createForbiddenPatternsRule(): PolicyRule {
  return {
    id: "command.forbidden_patterns",
    description: "Block self-destructive and credential-harvesting shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: ["exec"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const command = request.args.command as string | undefined;
      if (!command) return null;

      const match = getForbiddenCommandMatch(command);
      if (match) {
        return deny(
          "command.forbidden_patterns",
          "FORBIDDEN_COMMAND",
          `Blocked: ${match.description} (pattern: ${match.pattern})`,
        );
      }

      return null;
    },
  };
}

export function createCommandSafetyRules(): PolicyRule[] {
  return [
    createShellInjectionRule(),
    createForbiddenPatternsRule(),
  ];
}
