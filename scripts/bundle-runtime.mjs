import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

const DSH_VERSION = process.env.DSH_VERSION ?? "0.1.0-rc.6";
const PNPM_VERSION = process.env.PNPM_VERSION ?? "11.21.0";
const NODE_VERSION = process.env.NODE_VERSION ?? "22.23.2";

const targetArg = process.argv[2] ?? `${process.platform}-${process.arch}`;
const [targetOs = process.platform, targetArch = process.arch] = targetArg.split("-");
const supported = new Set(["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]);
const key = `${targetOs}-${targetArch}`;
if (!supported.has(key)) {
  console.error(`dsh-boot: unsupported target ${key}; supported targets: ${[...supported].join(", ")}`);
  process.exit(1);
}

if (targetOs !== process.platform || targetArch !== process.arch) {
  console.error(
    `dsh-boot: refusing cross-compile ${key} on ${process.platform}-${process.arch}; ` +
      "dsh ships native addons, so build each target on its own runner",
  );
  process.exit(1);
}

const nodeOs = { win32: "win", darwin: "darwin", linux: "linux" }[targetOs];
const ext = targetOs === "win32" ? "zip" : "tar.gz";
const nodeBase = `node-v${NODE_VERSION}-${nodeOs}-${targetArch}`;
const nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${nodeBase}.${ext}`;

const outRoot = join(repoRoot, "dist", `runtime-${key}`);
const archivePath = join(repoRoot, "dist", `${nodeBase}.${ext}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== void 0) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function download(url, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    console.log(`dsh-boot: using cached ${destination}`);
    return;
  }
  console.log(`dsh-boot: downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, bytes);
  console.log(`dsh-boot: downloaded ${destination} (${String(bytes.length)} bytes)`);
}

function extractNodeArchive() {
  const nodeDir = join(outRoot, "node");
  rmSync(nodeDir, { recursive: true, force: true });
  mkdirSync(nodeDir, { recursive: true });
  run("tar", ["-xf", archivePath, "-C", nodeDir, "--strip-components", "1"]);
}

function writeRuntimeManifest() {
  const manifest = {
    name: "dsh-boot-runtime",
    version,
    private: true,
    description: "Self-contained dsh-boot runtime: Node.js, pnpm, dsh, and the restart plugin",
    dependencies: {
      "@deepseek-ai/dsh": DSH_VERSION,
      pnpm: PNPM_VERSION,
    },
  };
  writeFileSync(join(outRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function installRuntime() {
  // npm produces the flat, self-contained node_modules tree we want inside
  // the packaged runtime (no pnpm virtual store reparse points for WiX to
  // harvest twice). pnpm is still bundled as a dependency for `dsh plugin`.
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--legacy-peer-deps"], {
    cwd: outRoot,
    shell: process.platform === "win32",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
}

/** Replace the npm `file:` symlink with a real plugin directory for MSI/DMG. */
function materializeRestartPlugin() {
  const pluginDir = join(outRoot, "node_modules", "@dsh-boot", "restart-plugin");
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(dirname(pluginDir), { recursive: true });
  cpSync(join(outRoot, "vendor", "restart-plugin"), pluginDir, { recursive: true });
}

/** Add the bundled restart plugin to dsh's dependency closure. */
function patchDshManifest() {
  const dshManifest = join(outRoot, "node_modules", "@deepseek-ai", "dsh", "package.json");
  if (!existsSync(dshManifest)) throw new Error(`dsh-boot: expected dsh at ${dshManifest}`);
  const manifest = JSON.parse(readFileSync(dshManifest, "utf8"));
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    "@dsh-boot/restart-plugin": version,
  };
  writeFileSync(dshManifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeWindowsWrappers() {
  const bin = join(outRoot, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "dsh-boot.cmd"), `@echo off\r\nsetlocal\r\nfor %%I in ("%~dp0..") do set "DSH_BOOT_ROOT=%%~fI"\r\nset "PATH=%~dp0;%PATH%"\r\n"%DSH_BOOT_ROOT%\\node\\node.exe" "%DSH_BOOT_ROOT%\\lib\\dsh-boot\\bin.js" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  writeFileSync(join(bin, "dsh.cmd"), `@echo off\r\nsetlocal\r\nfor %%I in ("%~dp0..") do set "DSH_BOOT_ROOT=%%~fI"\r\nset "PATH=%~dp0;%PATH%"\r\n"%DSH_BOOT_ROOT%\\node\\node.exe" "%DSH_BOOT_ROOT%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  writeFileSync(join(bin, "pnpm.cmd"), `@echo off\r\nsetlocal\r\nfor %%I in ("%~dp0..") do set "DSH_BOOT_ROOT=%%~fI"\r\n"%DSH_BOOT_ROOT%\\node\\node.exe" "%DSH_BOOT_ROOT%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);

  const scripts = join(outRoot, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "dsh-boot-launch.ps1"), `param([string]$Action = 'launch')\r\n$ErrorActionPreference = 'Stop'\r\n$root = Split-Path -Parent $PSScriptRoot\r\n$node = Join-Path $root 'node\\node.exe'\r\n$cli = Join-Path $root 'lib\\dsh-boot\\bin.js'\r\n& $node $cli $Action @args\r\nexit $LASTEXITCODE\r\n`);
  writeFileSync(join(scripts, "update-user-path.ps1"), UPDATE_USER_PATH_PS1);
}

function writeUnixWrappers() {
  const bin = join(outRoot, "bin");
  mkdirSync(bin, { recursive: true });
  const common = `#!/bin/sh\nset -eu\nSELF="$0"\nwhile [ -L "$SELF" ]; do\n  LINK=$(readlink "$SELF")\n  case "$LINK" in\n    /*) SELF="$LINK" ;;\n    *) SELF="$(dirname "$SELF")/$LINK" ;;\n  esac\ndone\nROOT=$(CDPATH= cd "$(dirname "$SELF")/.." && pwd)\nexport PATH="$ROOT/bin:$PATH"\n`;
  writeFileSync(join(bin, "dsh-boot"), `${common}exec "$ROOT/node/bin/node" "$ROOT/lib/dsh-boot/bin.js" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "dsh"), `${common}exec "$ROOT/node/bin/node" "$ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "pnpm"), `${common}exec "$ROOT/node/bin/node" "$ROOT/node_modules/pnpm/bin/pnpm.cjs" "$@"\n`, { mode: 0o755 });
  chmodSync(join(bin, "dsh-boot"), 0o755);
  chmodSync(join(bin, "dsh"), 0o755);
  chmodSync(join(bin, "pnpm"), 0o755);
}

function verifyRuntime() {
  const node = targetOs === "win32" ? join(outRoot, "node", "node.exe") : join(outRoot, "node", "bin", "node");
  const dsh = join(outRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const plugin = join(outRoot, "node_modules", "@dsh-boot", "restart-plugin", "package.json");
  for (const file of [node, dsh, plugin]) {
    if (!existsSync(file)) throw new Error(`dsh-boot: bundled runtime is missing ${file}`);
  }
}

async function main() {
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  await download(nodeUrl, archivePath);
  extractNodeArchive();

  cpSync(join(repoRoot, "packages", "cli", "src"), join(outRoot, "lib", "dsh-boot"), { recursive: true });
  cpSync(join(repoRoot, "packages", "restart-plugin"), join(outRoot, "vendor", "restart-plugin"), { recursive: true });

  const pluginManifestPath = join(outRoot, "vendor", "restart-plugin", "package.json");
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  pluginManifest.version = version;
  writeFileSync(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);

  writeRuntimeManifest();
  installRuntime();
  materializeRestartPlugin();
  patchDshManifest();

  writeFileSync(join(outRoot, ".dsh-boot-install"), `dsh-boot ${version}\n`);
  if (targetOs === "win32") writeWindowsWrappers();
  else writeUnixWrappers();

  verifyRuntime();
  console.log(`dsh-boot: runtime ready at ${outRoot}`);
  console.log(`dsh-boot: dsh ${DSH_VERSION}, pnpm ${PNPM_VERSION}, node ${NODE_VERSION}, plugin ${version}`);
}

const UPDATE_USER_PATH_PS1 = String.raw`param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$name = 'Path'
$current = [Environment]::GetEnvironmentVariable($name, 'User')
if ($null -eq $current) { $current = '' }
$entries = @($current -split ';' | Where-Object { $_ -ne '' })
$normalized = $Target.TrimEnd('\').ToLowerInvariant()
$remaining = @($entries | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -ne $normalized })
if ($Action -eq 'add') {
  if ($remaining.Count -eq $entries.Count) { $remaining = @($entries + $Target) }
  $value = ($remaining -join ';')
} else {
  $value = ($remaining -join ';')
}
[Environment]::SetEnvironmentVariable($name, $value, 'User')

Add-Type -Namespace DshBoot -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
$result = [UIntPtr]::Zero
[DshBoot.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
Write-Output ("user " + $Action + " -> " + $Target)
`;

main().catch((error) => {
  console.error(`dsh-boot: bundle failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
