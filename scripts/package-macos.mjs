import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const arch = process.argv[2] ?? "arm64";
const runtimeDir = resolve(process.argv[3] ?? join(repoRoot, "dist", `runtime-darwin-${arch}`));
const outDir = join(repoRoot, "dist");

if (!existsSync(runtimeDir)) {
  console.error(`dsh-boot: runtime not found at ${runtimeDir}; run scripts/bundle-runtime.mjs darwin-${arch} first`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== void 0) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const app = join(outDir, "macos", "dsh-boot.app");
const contents = join(app, "Contents");
const macos = join(contents, "MacOS");
const resources = join(contents, "Resources");

rmSync(app, { recursive: true, force: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });

console.log(`dsh-boot: copying ${runtimeDir} into ${app}`);
cpSync(runtimeDir, resources, { recursive: true, dereference: false });

const launcher = join(macos, "dsh-boot-launcher");
writeFileSync(launcher, `#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/../Resources" && pwd)"
export PATH="$ROOT/bin:$PATH"
NODE="$ROOT/node/bin/node"
CLI="$ROOT/lib/dsh-boot/bin.js"

# First launch from the app enables login autostart once. The marker lives in
# user state, so a later "dsh-boot autostart disable" (from Homebrew or the
# bundled CLI) is never silently re-enabled.
MARKER="$HOME/.dsh/dsh-boot/.autostart-app-once"
case "$ROOT" in
  /Volumes/*)
    # Running straight from the DMG would start a service whose runtime is
    # mounted on an ejectable volume. Ask Finder users to install first.
    osascript -e 'display alert "dsh-boot" message "Drag dsh-boot to Applications first, then open it from there."' >/dev/null 2>&1 || true
    exit 0
    ;;
  *)
    if [ ! -f "$MARKER" ]; then
      if "$NODE" "$CLI" autostart enable >/dev/null 2>&1; then
        mkdir -p "$HOME/.dsh/dsh-boot"
        touch "$MARKER"
      fi
    fi
    ;;
esac

exec "$NODE" "$CLI" launch "$@"
`, { mode: 0o755 });
chmodSync(launcher, 0o755);

writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>dsh-boot</string>
  <key>CFBundleDisplayName</key><string>DeepSeek Harness</string>
  <key>CFBundleIdentifier</key><string>com.dsh-boot.launcher</string>
  <key>CFBundleExecutable</key><string>dsh-boot-launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

// Ad-hoc sign when the runner has codesign. The artifact is meant to be
// notarization-friendly for maintainers who later add a Developer ID.
if (existsSync("/usr/bin/codesign")) {
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  if (sign.status !== 0) console.warn("dsh-boot: ad-hoc codesign skipped (non-fatal)");
}

const dmgRoot = join(outDir, `dmg-root-${arch}`);
rmSync(dmgRoot, { recursive: true, force: true });
mkdirSync(dmgRoot, { recursive: true });
cpSync(app, join(dmgRoot, "dsh-boot.app"), { recursive: true, dereference: false });
try {
  symlinkSync("/Applications", join(dmgRoot, "Applications"), "dir");
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
}

const dmg = join(outDir, `dsh-boot-${version}-darwin-${arch}.dmg`);
rmSync(dmg, { force: true });
run("hdiutil", ["create", "-volname", "dsh-boot", "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmg]);

const tarball = join(outDir, `dsh-boot-${version}-darwin-${arch}.tar.gz`);
rmSync(tarball, { force: true });
run("tar", ["-czf", tarball, "-C", runtimeDir, "."]);

console.log(`dsh-boot: built ${dmg}`);
console.log(`dsh-boot: built ${tarball} (for Homebrew)`);
