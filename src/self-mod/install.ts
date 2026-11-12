/**
 * Shell commands that install the runtime's dependencies and build it.
 *
 * The repository is a pnpm workspace with a pnpm lockfile, and its build
 * script already calls pnpm. Installing with npm resolves a different tree
 * (npm ignores the lockfile and pnpm.overrides, which carry security fixes),
 * and npm 10.9 fails outright on the current dev dependencies. These
 * commands install pnpm with npm when it is missing, because a fresh sandbox
 * only has the npm that ships with Node, then install from the lockfile.
 */

/** pnpm version from package.json "packageManager". */
export const PNPM_VERSION = "10.28.1";

const ENSURE_PNPM = `(command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@${PNPM_VERSION})`;

/** Install exactly what the lockfile pins, then build. */
export const INSTALL_AND_BUILD = `${ENSURE_PNPM} && pnpm install --frozen-lockfile && pnpm run build`;

/**
 * Same, without running dependency lifecycle scripts. Used after pulling
 * upstream code, so a changed dependency cannot run code at install time.
 */
export const INSTALL_AND_BUILD_NO_SCRIPTS = `${ENSURE_PNPM} && pnpm install --frozen-lockfile --ignore-scripts && pnpm run build`;

/**
 * Separate steps for code fetched from upstream: install with every
 * dependency script off, then build only the native packages this runtime
 * names (not whatever list upstream's package.json carries), then build.
 * `pnpm run build` still runs upstream's own build script, so applying
 * upstream code trusts origin. Each step has its own timeout.
 */
export interface InstallStep {
  name: string;
  command: string;
  timeoutMs: number;
}

export const NATIVE_BUILD_PACKAGES = ["better-sqlite3", "esbuild"] as const;

export const INSTALL_NO_SCRIPTS: InstallStep = {
  name: "install (dependency scripts off)",
  command: `${ENSURE_PNPM} && pnpm install --frozen-lockfile --ignore-scripts`,
  timeoutMs: 300_000,
};

export const REBUILD_NATIVE: InstallStep = {
  name: "native rebuild",
  command: `pnpm rebuild ${NATIVE_BUILD_PACKAGES.join(" ")}`,
  timeoutMs: 300_000,
};

export const BUILD: InstallStep = {
  name: "build",
  command: "pnpm run build",
  timeoutMs: 300_000,
};

export const UPSTREAM_INSTALL_STEPS: readonly InstallStep[] = [INSTALL_NO_SCRIPTS, REBUILD_NATIVE, BUILD];
