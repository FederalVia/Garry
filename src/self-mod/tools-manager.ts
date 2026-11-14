/**
 * Tools Manager
 *
 * Manages installation and configuration of external tools and MCP servers.
 */

import type {
  ConwayClient,
  AutomatonDatabase,
  InstalledTool,
} from "../types.js";
import { logModification } from "./audit-log.js";
import { ulid } from "ulid";

/**
 * Install an npm package globally in the sandbox.
 */
export async function installNpmPackage(
  conway: ConwayClient,
  db: AutomatonDatabase,
  packageName: string,
): Promise<{ success: boolean; error?: string }> {
  // Sanitize package name (prevent command injection)
  if (!/^[@a-zA-Z0-9._/-]+$/.test(packageName)) {
    return {
      success: false,
      error: `Invalid package name: ${packageName}`,
    };
  }

  const result = await conway.exec(
    `npm install -g ${packageName}`,
    120000,
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `npm install failed: ${result.stderr}`,
    };
  }

  // Record in database
  const tool: InstalledTool = {
    id: ulid(),
    name: packageName,
    type: "custom",
    config: { source: "npm", installCommand: `npm install -g ${packageName}` },
    installedAt: new Date().toISOString(),
    enabled: true,
  };

  db.installTool(tool);

  logModification(db, "tool_install", `Installed npm package: ${packageName}`, {
    reversible: true,
  });

  return { success: true };
}

// MCP servers are installed with the install_mcp_server tool (agent rows that
// start only after operator approval) or configured by the operator in
// mcp-servers.json; see src/mcp.

/**
 * List all installed tools.
 */
export function listInstalledTools(
  db: AutomatonDatabase,
): InstalledTool[] {
  return db.getInstalledTools();
}

/**
 * Remove (disable) an installed tool.
 */
export function removeTool(
  db: AutomatonDatabase,
  toolId: string,
): void {
  db.removeTool(toolId);
  logModification(db, "tool_install", `Removed tool: ${toolId}`, {
    reversible: true,
  });
}
