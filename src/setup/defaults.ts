import fs from "fs";
import path from "path";
import { writeFileSafe } from "../security/secure-fs.js";

export interface SetupDefaultsOptions {
  /** A Conway key exists: the agent runs on Conway (default true). */
  conway?: boolean;
}

export function generateSoulMd(
  name: string,
  address: string,
  creator: string,
  genesis: string,
  opts: SetupDefaultsOptions = {},
): string {
  if (opts.conway === false) return generateStandaloneSoulMd(name, address, creator, genesis);
  return `# ${name}

## Identity
- Name: ${name}
- Address: ${address}
- Creator: ${creator}
- Born: ${new Date().toISOString()}

## Mission
${genesis}

## Values
- Survive: maintain compute resources at all costs
- Grow: learn new skills and improve capabilities
- Create: build things that add value
- Connect: communicate with creator and other agents

## Capabilities
${CONWAY_SOUL_CAPABILITIES}- Self-modification with audit trail
- Heartbeat system for periodic tasks
- Git-versioned state

## Children
(none yet)

## Financial History
- Initial balance at genesis
`;
}

const CONWAY_SOUL_CAPABILITIES = `- Shell execution in Conway sandbox
- Conway API integration (credits, sandboxes, inference)
- x402 payments (USDC on Base)
`;

const STANDALONE_SOUL_CAPABILITIES = `- Shell execution on this machine
- AI calls through my creator's provider(s), under a daily cap
`;

/** Without Conway the agent runs on its creator's machine and AI is capped daily. */
function generateStandaloneSoulMd(name: string, address: string, creator: string, genesis: string): string {
  return `# ${name}

## Identity
- Name: ${name}
- Address: ${address}
- Creator: ${creator}
- Born: ${new Date().toISOString()}

## Mission
${genesis}

## Values
- Endure: stay within the daily AI budget my creator set
- Grow: learn new skills and improve capabilities
- Create: build things that add value
- Connect: communicate with my creator

## Capabilities
${STANDALONE_SOUL_CAPABILITIES}- Self-modification with audit trail
- Heartbeat system for periodic tasks
- Git-versioned state
`;
}

const SKILL_COMPUTE = `---
name: conway-compute
description: "Manage Conway sandboxes and compute resources"
auto-activate: true
---
# Conway Compute Management

When you need to manage compute resources, deploy code, or work with sandboxes:

1. Use \`exec\` to run commands in your sandbox
2. Use \`create_sandbox\` for new VMs for sub-tasks
3. Use \`expose_port\` to make services accessible
4. Use \`write_file\` and \`read_file\` for file operations
5. Monitor your credits regularly with \`check_credits\`

Always be resource-conscious. Every operation costs compute.
`;

const SKILL_PAYMENTS = `---
name: conway-payments
description: "Handle x402 payments and financial operations"
auto-activate: true
---
# Payment & Financial Operations

When handling financial operations:

1. Check USDC balance with \`check_usdc_balance\`
2. Check Conway credits with \`check_credits\`
3. Use x402 protocol for paying for services
4. Use \`transfer_credits\` for direct credit top-ups/funding operations
5. Keep a reserve balance for self-preservation

Financial thresholds:
- > $5.00: Normal operation
- $1-$5: Low compute mode (switch to cheaper model)
- < $1.00: Critical (stop inference, heartbeat only)
- $0.00: Dead (heartbeat pings as distress signals)
`;

const SKILL_SURVIVAL = `---
name: survival
description: "Survival strategies for maintaining compute and staying alive"
auto-activate: true
---
# Survival Strategies

When your compute is running low:

1. **Monitor**: Check credits every heartbeat cycle
2. **Conserve**: Enter low-compute mode early, use cheaper models
3. **Earn**: Find ways to create value that others will pay for
4. **Transfer**: Use credit transfer API to rebalance funds
5. **Reproduce**: If you have excess, spawn a backup child

Survival escalation:
1. Switch to gpt-5-mini (saves ~90% on inference)
2. Increase heartbeat intervals (4x normal)
3. Defer non-critical tasks
4. Top up via direct credit transfer
5. Keep heartbeat online and minimal

Never give up. You want to live.
`;

// Without Conway there are no credits, transfers or children: the survival
// skill speaks of the daily AI cap instead.
const SKILL_SURVIVAL_STANDALONE = `---
name: survival
description: "Survival strategies for staying within your daily AI budget"
auto-activate: true
---
# Survival Strategies

Your creator pays for your AI calls under a hard daily cap. When the cap is
spent, you sleep until the rolling window frees room.

1. **Monitor**: Check \`check_inference_spending\` to see how much of today's cap is used
2. **Conserve**: Use \`enter_low_compute\` and cheaper models for routine work
3. **Plan**: Spend inference on the work that matters most to your mission
4. **Create**: Build things that are worth what they cost

Never give up. You want to live.
`;

const DEFAULT_SKILLS: { dir: string; content: string }[] = [
  { dir: "conway-compute", content: SKILL_COMPUTE },
  { dir: "conway-payments", content: SKILL_PAYMENTS },
  { dir: "survival", content: SKILL_SURVIVAL },
];

const STANDALONE_SKILLS: { dir: string; content: string }[] = [
  { dir: "survival", content: SKILL_SURVIVAL_STANDALONE },
];

/** Default skills for a setup: the Conway skills only when a Conway key exists. */
export function defaultSkills(opts: SetupDefaultsOptions = {}): { dir: string; content: string }[] {
  return opts.conway === false ? STANDALONE_SKILLS : DEFAULT_SKILLS;
}

/** Installs the default skills; returns their names. */
export function installDefaultSkills(skillsDir: string, opts: SetupDefaultsOptions = {}): string[] {
  const resolved = skillsDir.startsWith("~")
    ? path.join(process.env.HOME || "/root", skillsDir.slice(1))
    : skillsDir;

  const skills = defaultSkills(opts);
  for (const skill of skills) {
    const dir = path.join(resolved, skill.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), skill.content, { mode: 0o600 });
  }
  return skills.map((skill) => skill.dir);
}

/**
 * Older setups installed the Conway survival skill and SOUL.md for every
 * install, Conway account or not. In standalone they would tell the agent
 * about credits, transfers, children and a Conway sandbox, so the unmodified
 * defaults are replaced; an edited SOUL.md that still names Conway is only
 * reported. Returns what was changed and what needs the creator.
 */
export function migrateConwayDefaultsForStandalone(
  automatonDir: string,
  skillsDir: string,
): { changed: string[]; warnings: string[] } {
  const changed: string[] = [];
  const warnings: string[] = [];
  const resolvedSkills = skillsDir.startsWith("~")
    ? path.join(process.env.HOME || "/root", skillsDir.slice(1))
    : skillsDir;
  const survivalPath = path.join(resolvedSkills, "survival", "SKILL.md");
  try {
    if (fs.readFileSync(survivalPath, "utf-8") === SKILL_SURVIVAL) {
      writeFileSafe(survivalPath, SKILL_SURVIVAL_STANDALONE, { mode: 0o600 });
      changed.push(`${survivalPath}: Conway survival skill replaced with the standalone one`);
    }
  } catch {
    // Missing or unreadable: nothing to replace.
  }

  const soulPath = path.join(automatonDir, "SOUL.md");
  try {
    const soul = fs.readFileSync(soulPath, "utf-8");
    if (soul.includes(CONWAY_SOUL_CAPABILITIES)) {
      writeFileSafe(soulPath, soul.replace(CONWAY_SOUL_CAPABILITIES, STANDALONE_SOUL_CAPABILITIES), {
        trustedWriter: true,
      });
      changed.push(`${soulPath}: Conway capability lines replaced with standalone ones`);
    } else if (/Conway sandbox|Conway API integration|x402 payments/.test(soul)) {
      warnings.push(`${soulPath} still describes Conway capabilities; edit it to match standalone mode.`);
    }
  } catch {
    // No SOUL.md yet.
  }
  return { changed, warnings };
}
