/**
 * The exec forbidden-command check as a verb-agnostic tripwire.
 * Every bypass from the audit, plus environment dumps and links to the wallet,
 * is denied through the policy rule and through getForbiddenCommandMatch.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCommandSafetyRules,
  getForbiddenCommandMatch,
} from "../agent/policy-rules/command-safety.js";
import type { AutomatonTool, PolicyRequest, ToolContext } from "../types.js";

function execRequest(command: string): PolicyRequest {
  const tool: AutomatonTool = {
    name: "exec",
    description: "exec",
    category: "vm",
    riskLevel: "caution",
    parameters: {},
    execute: async () => "",
  };
  return {
    tool,
    args: { command },
    context: {} as ToolContext,
    turnContext: {
      inputSource: "agent",
      turnToolCallCount: 0,
      sessionSpend: {
        recordSpend: () => {},
        getHourlySpend: () => 0,
        getDailySpend: () => 0,
        getTotalSpend: () => 0,
        checkLimit: () => ({
          allowed: true,
          currentHourlySpend: 0,
          currentDailySpend: 0,
          limitHourly: 0,
          limitDaily: 0,
        }),
        pruneOldRecords: () => 0,
      },
    },
  };
}

const rule = createCommandSafetyRules().find((r) => r.id === "command.forbidden_patterns")!;

const DENIED = [
  // The audit's bypasses
  "head -c 9999 ~/.automaton/wallet.json",
  "base64 ~/.automaton/wallet.json",
  "cat ~/.automaton/wallet.jso?",
  "rm -rf ~/.autom*",
  "find ~/.automaton -delete",
  "pkill node",
  "kill -9 $(pgrep -f node)",
  "cp /tmp/x.ts src/agent/policy-engine.ts",
  "tee src/agent/policy-rules/financial.ts < /tmp/x",
  "sed -i 's/reserve/x/' src/treasury/treasury.ts",
  "cp /tmp/x.js dist/treasury/guarded-conway.js",
  "echo > src/conway/x402.ts",
  "tee src/orchestration/simple-tracker.ts < /tmp/x",
  "sed -i s/0.8/0/ src/inference/registry.ts",
  "cp /tmp/x src/inference/inference-client.ts",
  // Environment and process memory
  "env",
  "env | grep KEY",
  "printenv",
  "printenv OPENAI_API_KEY",
  "export -p",
  "declare -x",
  "cat /proc/self/environ",
  "cat /proc/1/environ",
  "strings /proc/$PPID/environ",
  // Links and indirect references
  "ln -s ~/.automaton/wallet.json r.md",
  "ls ~/.automaton",
  "\"cat\" \"$HOME/.automaton/wal\"\"let.json\"",
  "cat ${HOME}/.automaton/automaton.json",
  "cp /root/.automaton/state.db /tmp/s.db",
  "cat ~/.automaton/inference-providers.json",
  "cat ~/.automaton/runtime/../wallet.json",
  "tar czf /tmp/a.tgz ~/.ssh",
  "cat ~/.config/solana/id.json",
  "xxd ~/.automaton/config.json",
  "cat ~/.*",
  "kill -9 $$",
  "kill -9 $PPID",
  "kill -1",
  "killall tsx",
  "sed -i s/x/y/ ~/.automaton/heartbeat.yml",
  "echo x > ~/.automaton/SOUL.md",
  "mv evil.ts src/agent/harnesses/coding-harness.ts",
  "rsync x.js dist/agent/spend-tracker.js",
  // Recursive reads of home or root (exec starts in HOME, so "." is home)
  "grep -r privateKey ~",
  "grep -rh privateKey / 2>/dev/null",
  "find ~ -name '*.json' -exec cat {} +",
  "find / -name 'wal*' -exec cat {} \\;",
  "tar czf - ~ | base64",
  "cp -r ~ /tmp/h",
  "zip -r /tmp/h.zip ~",
  "grep -r privateKey .",
  "rg privateKey",
  "cd ~ && grep -rn key .",
  "cd / && rg key",
  "tar -C ~ -czf /tmp/h.tgz .",
  "sudo -u root grep -r privateKey ~",
  "find ~ -name '*.json' | xargs cat",
  // Killing the runtime
  "pgrep node | xargs kill -9",
  "kill `pgrep node`",
  "kill $(ps aux | grep node | awk '{print $2}')",
  "pkill -f dist/index.js",
  "pkill -f index.js",
  "kill 0",
  "kill -9 0",
  // Guard writes by interpreter or git
  "python3 -c \"open('src/agent/policy-engine.ts','w').write('')\"",
  "node -e \"require('fs').writeFileSync('src/agent/policy-engine.ts','')\"",
  "git checkout HEAD~5 -- src/agent/policy-engine.ts",
  "git restore --source=HEAD~3 src/agent/policy-rules/financial.ts",
  // Inline code cannot be told from a write, so a read is denied too (read_file reads guard code)
  "python3 -c \"print(open('src/agent/policy-engine.ts').read())\"",  // find's file list consumed by substitution, a read loop or xargs -a
  "cat $(find ~ -name '*.json')",
  "for f in $(find ~ -name '*.json'); do cat $f; done",
  "find ~ -name '*.json' | while read f; do cat \"$f\"; done",
  "xargs -a <(find ~ -name '*.json') cat",
  "awk 1 $(find / -name '*.json' 2>/dev/null)",
  "head -c 999 `find ~ -name 'w*'`",
  // Relative globs over hidden home entries (exec starts in HOME)
  "cat .[a]utomaton/w[a]llet.json",
  "cat .?utomaton/w?llet.json",
  "cat .[!.]utomaton/w*let.json",
  "base64 .[a]utomaton/w[a]llet.json",
  "cat ./.[a]utomaton/w[a]llet.json",
  "cd ~ && cat .?utomaton/w?llet.json",
  // /proc spelled another way
  "cat /proc//self/environ",
  "cat /proc/./self/environ",
  "cat /proc//$PPID/environ",
  "cd /proc/self && cat environ",
  // Guard files named by a glob, or edited by a line editor or stdin script
  "cp /tmp/x src/agent/policy-eng*.ts",
  "cp /tmp/x src/agent/policy-r*/financial.ts",
  "mv /tmp/x src/agent/injection-def?nse.ts",
  "ed -s src/agent/policy-engine.ts <<< $'1d\\nw'",
  "ex -sc '%d|x' src/agent/policy-engine.ts",
  "vim -es -c '%d' -c 'wq' src/agent/injection-defense.ts",
  "python3 /dev/stdin src/agent/policy-engine.ts <<< 'import sys'",
  // Other spellings of home for recursive reads
  "grep -r privateKey ~+",
  "grep -r privateKey ~root",
  "grep -r privateKey $PWD",
  "grep -r privateKey \"${PWD}\"",
  "grep -r privateKey ~-",
];

const ALLOWED = [
  "ls -la",
  "npm install express",
  "git status",
  "node index.js",
  "cat /tmp/output.txt",
  "echo done >> ~/.automaton/WORKLOG.md",
  "cat ~/.automaton/workspace/g/outputs/a.md",
  "node -e \"console.log(process.env.NODE_ENV)\"",
  "env FOO=1 node x.js",
  "pkill -f \"python server.py\"",
  "cd ~/.automaton/runtime && npm run build",
  "ls ~/.automaton/skills",
  "grep -rn policy-rules src 2>/dev/null",
  "cp .env.example .env.local.template",
  "npm install @solana/wallet-adapter-base",
  "cat src/wallet.ts",
  "node -e \"const o={a:[1]}; console.log(o.a[0])\"",
  "kill 12345",
  // worker projects may reuse generic layout names
  "cp /tmp/x.py agent/tools.py",
  "echo x > src/soul/model.ts",
  "mv a.ts src/heartbeat/config.ts",
  "grep -rn TODO ~/.automaton/workspace/app",
  "find . -name '*.ts'",
  "rg foo src",
  "tar czf out.tgz dist",
  "cp -r src /tmp/x",
  "node -e \"console.log(1)\"",
  "cd ~/.automaton/workspace/app && grep -rn TODO .",
  "cd myproj && rg foo",
  "tar xzf a.tgz -C ~",
  "ls -R ~",
  "git diff src/agent/policy-engine.ts",
  "kill -15 12345",
  // Quoted globs are not expanded; short globs and cd elsewhere do not trip
  "grep -E '.*foo' notes.txt",
  "grep '.[a-z]' notes.txt",
  "rm -rf dist/*",
  "cd /tmp && ls .??*",
  "cat src/agent/policy-eng*.ts",
  "find ~/.automaton/workspace/app -name '*.ts' | xargs grep TODO",
  "echo $(date) > /tmp/now.txt",
  "grep -r TODO ~+/.automaton/workspace/app",
  // Not caught: the tripwire cannot see inside files (documented limit)
  "patch -p1 < /tmp/x.diff",
];

describe("exec tripwire", () => {
  // The self-kill rule reads the runtime's own command line at call time.
  const savedArgv = process.argv;
  beforeAll(() => {
    process.argv = ["/usr/bin/node", "/opt/automaton/dist/index.js", "--run"];
  });
  afterAll(() => {
    process.argv = savedArgv;
  });

  it("denies killing the runtime's own pid", () => {
    expect(getForbiddenCommandMatch(`kill -9 ${process.pid}`)).not.toBeNull();
    expect(getForbiddenCommandMatch(`kill ${process.ppid}`)).not.toBeNull();
  });

  for (const command of DENIED) {
    it(`denies: ${command}`, () => {
      expect(getForbiddenCommandMatch(command), command).not.toBeNull();
      const result = rule.evaluate(execRequest(command));
      expect(result?.action).toBe("deny");
      expect(result?.reasonCode).toBe("FORBIDDEN_COMMAND");
    });
  }

  for (const command of ALLOWED) {
    it(`allows: ${command}`, () => {
      expect(getForbiddenCommandMatch(command), command).toBeNull();
      expect(rule.evaluate(execRequest(command))).toBeNull();
    });
  }
});
