/**
 * The exec forbidden-command check as a verb-agnostic tripwire.
 * Every bypass from the audit, plus environment dumps and links to the wallet,
 * is denied through the policy rule and through getForbiddenCommandMatch.
 */

import { describe, expect, it } from "vitest";
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
];

describe("exec tripwire", () => {
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
