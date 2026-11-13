/**
 * Input Validation Policy Rules
 *
 * Validates tool arguments before execution. Catches malformed
 * input before it reaches any shell command or API call.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import { hasValidEvmChecksum, isValidEvmAddress, isValidSolanaAddress, isZeroAddress, type ChainType } from "../../identity/chain.js";

/**
 * An npm registry package: name or @scope/name, optionally @version, tag or
 * range. No leading "-", "." or "/", no owner/repo shorthand, paths, URLs or
 * tarballs: npm would fetch those from outside the registry and run their
 * lifecycle scripts. The version may not start with "." (npm reads "foo@.."
 * as a directory), and a name ending in .tgz/.tar is read as a local file.
 */
const REGISTRY_PACKAGE_SPEC_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[0-9a-z^~<>=*][0-9a-z.^~<>=*+-]*)?$/i;
const TARBALL_NAME_RE = /\.(?:tgz|tar|tar\.gz)(?:@|$)/i;
const MAX_PACKAGE_SPEC_LENGTH = 214;

export function isRegistryPackageSpec(spec: unknown): spec is string {
  return (
    typeof spec === "string" &&
    spec.length <= MAX_PACKAGE_SPEC_LENGTH &&
    REGISTRY_PACKAGE_SPEC_RE.test(spec) &&
    !TARBALL_NAME_RE.test(spec)
  );
}
const SKILL_NAME_RE = /^[a-zA-Z0-9-]+$/;
const GIT_HASH_RE = /^[a-f0-9]{7,40}$/;
const CRON_PARTS_RE = /^(\*|[\d,*/-]+)\s+(\*|[\d,*/-]+)\s+(\*|[\d,*/-]+)\s+(\*|[\d,*/-]+)\s+(\*|[\d,*/-]+)$/;

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Validate npm package name format.
 */
function createPackageNameRule(): PolicyRule {
  return {
    id: "validate.package_name",
    description: "Validate npm package name format",
    priority: 100,
    appliesTo: {
      by: "name",
      names: ["install_npm_package", "install_mcp_server"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const pkg = request.args.package;
      if (pkg === undefined) return null;
      if (typeof pkg !== "string") {
        return deny("validate.package_name", "VALIDATION_FAILED", "package must be a string");
      }

      if (!isRegistryPackageSpec(pkg)) {
        return deny(
          "validate.package_name",
          "VALIDATION_FAILED",
          `Invalid package spec: "${String(pkg).slice(0, 100)}". Only npm registry packages (name, @scope/name, optionally @version) are accepted.`,
        );
      }
      return null;
    },
  };
}

/**
 * Validate skill name format.
 */
function createSkillNameRule(): PolicyRule {
  return {
    id: "validate.skill_name",
    description: "Validate skill name format (alphanumeric + hyphens only)",
    priority: 100,
    appliesTo: {
      by: "name",
      names: ["install_skill", "create_skill", "remove_skill"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const name = request.args.name;
      if (name === undefined) return null;
      if (typeof name !== "string") {
        return deny("validate.skill_name", "VALIDATION_FAILED", "name must be a string");
      }

      if (!SKILL_NAME_RE.test(name)) {
        return deny(
          "validate.skill_name",
          "VALIDATION_FAILED",
          `Invalid skill name: "${name}". Must match ${SKILL_NAME_RE.source}`,
        );
      }
      return null;
    },
  };
}

/**
 * Validate git commit hash format.
 */
function createGitHashRule(): PolicyRule {
  return {
    id: "validate.git_hash",
    description: "Validate git commit hash format",
    priority: 100,
    appliesTo: {
      by: "name",
      names: ["pull_upstream"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const commit = request.args.commit;
      if (commit === undefined) return null; // commit is optional
      if (typeof commit !== "string") {
        return deny("validate.git_hash", "VALIDATION_FAILED", "commit must be a string");
      }

      if (!GIT_HASH_RE.test(commit)) {
        return deny(
          "validate.git_hash",
          "VALIDATION_FAILED",
          `Invalid git hash: "${commit}". Must be 7-40 lowercase hex characters.`,
        );
      }
      return null;
    },
  };
}

/**
 * Validate port number range.
 */
function createPortRangeRule(): PolicyRule {
  return {
    id: "validate.port_range",
    description: "Validate port number is in valid range (1-65535)",
    priority: 100,
    appliesTo: {
      by: "name",
      names: ["expose_port", "remove_port"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const port = request.args.port;
      if (port === undefined) return null;

      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        return deny(
          "validate.port_range",
          "VALIDATION_FAILED",
          `Invalid port: ${port}. Must be integer 1-65535.`,
        );
      }
      return null;
    },
  };
}

/**
 * Validate cron expression structure.
 */
function createCronExpressionRule(): PolicyRule {
  return {
    id: "validate.cron_expression",
    description: "Validate cron expression format",
    priority: 100,
    appliesTo: {
      by: "name",
      names: ["modify_heartbeat"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const schedule = request.args.schedule;
      if (schedule === undefined) return null;
      if (typeof schedule !== "string") {
        return deny("validate.cron_expression", "VALIDATION_FAILED", "schedule must be a string");
      }

      if (!CRON_PARTS_RE.test(schedule.trim())) {
        return deny(
          "validate.cron_expression",
          "VALIDATION_FAILED",
          `Invalid cron expression: "${schedule}". Must be 5 space-separated fields.`,
        );
      }
      return null;
    },
  };
}

/** Tools that move credits: the recipient must be on the automaton's own chain. */
const OWN_CHAIN_ADDRESS_TOOLS = new Set(["transfer_credits", "fund_child"]);

const EVM_FORMAT = "0x followed by 40 hex characters";
const SOLANA_FORMAT = "a base58 Solana public key (case-sensitive)";

function ownChainType(request: PolicyRequest): ChainType {
  const chain = request.context?.config?.chainType || request.context?.identity?.chainType;
  return chain === "solana" ? "solana" : "evm";
}

/**
 * Validate recipient addresses. Messaging is chain-agnostic, so send_message
 * takes an EVM or Solana address whatever this automaton's chain. Credit
 * transfers take only this automaton's own chain format: whether Conway
 * routes a cross-chain recipient is unverified, and a misrouted transfer
 * moves money. Addresses are checked as given; base58 is case-sensitive.
 */
function createAddressFormatRule(): PolicyRule {
  return {
    id: "validate.address_format",
    description: "Validate recipient address format (EVM or Solana; credit transfers on the automaton's own chain)",
    priority: 100,
    appliesTo: {
      by: "name",
      names: ["transfer_credits", "send_message", "fund_child"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const address = request.args.to_address ?? request.args.agent_address;
      if (address === undefined) return null;
      if (typeof address !== "string") {
        return deny("validate.address_format", "VALIDATION_FAILED", "address must be a string");
      }

      if (OWN_CHAIN_ADDRESS_TOOLS.has(request.tool.name)) {
        const chain = ownChainType(request);
        const valid = chain === "solana" ? isValidSolanaAddress(address) : isValidEvmAddress(address);
        if (!valid) {
          return deny(
            "validate.address_format",
            "VALIDATION_FAILED",
            `Invalid address format: "${address}". This automaton is on ${chain === "solana" ? "Solana" : "EVM"}; credit transfers need ${chain === "solana" ? SOLANA_FORMAT : EVM_FORMAT}.`,
          );
        }
        if (chain !== "solana" && !hasValidEvmChecksum(address)) {
          return deny(
            "validate.address_format",
            "VALIDATION_FAILED",
            `Address "${address}" has a wrong EIP-55 checksum (mixed case that does not match); it is probably mistyped.`,
          );
        }
      } else if (!isValidEvmAddress(address) && !isValidSolanaAddress(address)) {
        return deny(
          "validate.address_format",
          "VALIDATION_FAILED",
          `Invalid address format: "${address}". Must be ${EVM_FORMAT}, or ${SOLANA_FORMAT}.`,
        );
      }

      if (isZeroAddress(address)) {
        return deny(
          "validate.address_format",
          "VALIDATION_FAILED",
          `Refusing the zero/system address "${address}": nothing sent there can be recovered.`,
        );
      }
      return null;
    },
  };
}

export function createValidationRules(): PolicyRule[] {
  return [
    createPackageNameRule(),
    createSkillNameRule(),
    createGitHashRule(),
    createPortRangeRule(),
    createCronExpressionRule(),
    createAddressFormatRule(),
  ];
}
