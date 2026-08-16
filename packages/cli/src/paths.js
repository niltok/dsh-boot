import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NAME = "dsh-boot";
export const DSH_HOME_DIR_NAME = ".dsh";
export const BOOT_DIR_NAME = "dsh-boot";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Marker file written into every packaged runtime root. */
export const INSTALL_MARKER = ".dsh-boot-install";

/**
 * Find the installation root.
 *
 * In a packaged build the layout is:
 *   <root>/lib/dsh-boot/*.js
 * In a source checkout the CLI lives under packages/cli/src. We walk up until
 * we find either the marker file (packaged build) or a package.json named
 * `dsh-boot` (source checkout).
 */
export function findInstallRoot() {
  if (process.env.DSH_BOOT_INSTALL_ROOT !== void 0 && process.env.DSH_BOOT_INSTALL_ROOT.trim() !== "") {
    return resolve(process.env.DSH_BOOT_INSTALL_ROOT);
  }

  let current = here;
  for (;;) {
    if (existsSync(join(current, INSTALL_MARKER))) return current;

    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed.name === NAME || parsed.name === "dsh-boot-runtime") return current;
      } catch {
        // Not a usable manifest; keep walking up.
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    "dsh-boot: cannot locate installation root; set DSH_BOOT_INSTALL_ROOT to the unpacked dsh-boot directory",
  );
}

/** Resolve the dsh user-data home: `$DSH_HOME` or `~/.dsh`. */
export function resolveDshHome() {
  const override = process.env.DSH_HOME;
  if (override !== void 0 && override.trim() !== "") return resolve(override);
  return join(homedir(), DSH_HOME_DIR_NAME);
}

export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}

/** `$DSH_HOME/dsh-boot` — every piece of dsh-boot user state lives here. */
export function bootDir() {
  return dshHomePath(BOOT_DIR_NAME);
}

export const paths = {
  get installRoot() {
    return findInstallRoot();
  },
  get runtimeRoot() {
    return findInstallRoot();
  },
  get logsDir() {
    return join(bootDir(), "logs");
  },
  get dshLog() {
    return join(bootDir(), "logs", "dsh.log");
  },
  get bootLog() {
    return join(bootDir(), "logs", "dsh-boot.log");
  },
  get stateFile() {
    return join(bootDir(), "state.json");
  },
  get startLockFile() {
    return join(bootDir(), "start.lock");
  },
  get patchFile() {
    return join(bootDir(), "dsh-boot.patch.yml");
  },
  get startupArgsFile() {
    return join(bootDir(), "startup.args");
  },
  get nodeBin() {
    const root = findInstallRoot();
    const platformNode =
      process.platform === "win32" ? join(root, "node", "node.exe") : join(root, "node", "bin", "node");
    if (existsSync(platformNode)) return platformNode;
    return process.execPath;
  },
  get cliEntry() {
    // Packaged layout; used when re-spawning the supervisor.
    const packaged = join(findInstallRoot(), "lib", "dsh-boot", "bin.js");
    if (existsSync(packaged)) return packaged;
    return fileURLToPath(new URL("./bin.js", import.meta.url));
  },
  get dshCli() {
    const root = findInstallRoot();
    const bundled = join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (existsSync(bundled)) return bundled;
    if (process.env.DSH_BOOT_DSH_BIN) return resolve(process.env.DSH_BOOT_DSH_BIN);
    try {
      const manifest = require.resolve("@deepseek-ai/dsh/package.json");
      const candidate = join(dirname(manifest), "lib", "bin.js");
      if (existsSync(candidate)) return candidate;
    } catch {
      // Fall through to a helpful error.
    }
    throw new Error(
      "dsh-boot: bundled @deepseek-ai/dsh not found; set DSH_BOOT_DSH_BIN to dsh's lib/bin.js for development",
    );
  },
  get pnpmCli() {
    const root = findInstallRoot();
    const candidates = [
      join(root, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      join(root, "node_modules", ".pnpm", "pnpm", "bin", "pnpm.cjs"),
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
    if (process.env.DSH_BOOT_PNPM_CJS) return resolve(process.env.DSH_BOOT_PNPM_CJS);
    try {
      return require.resolve("pnpm/bin/pnpm.cjs");
    } catch {
      // Let the caller produce a helpful diagnostic.
    }
    return void 0;
  },
  get binDir() {
    return join(findInstallRoot(), "bin");
  },
  get version() {
    const manifest = join(findInstallRoot(), "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof parsed.version === "string") return parsed.version;
      } catch {
        // Ignore malformed runtime manifest and fall through.
      }
    }
    return "0.0.0";
  },
};
