import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const arch = process.argv[2] ?? "x64";
const runtimeDir = resolve(process.argv[3] ?? join(repoRoot, "dist", `runtime-linux-${arch}`));
const outDir = join(repoRoot, "dist");

if (!existsSync(runtimeDir)) {
  console.error(`dsh-boot: runtime not found at ${runtimeDir}; run scripts/bundle-runtime.mjs linux-${arch} first`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== void 0) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const staging = join(outDir, `linux-pkg-${arch}`);
const packageRoot = join(staging, "dsh-boot");
rmSync(staging, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });

console.log(`dsh-boot: copying ${runtimeDir} into ${packageRoot}`);
cpSync(runtimeDir, packageRoot, { recursive: true, dereference: false });

// Linux app icon: ship the 512px PNG next to the runtime; install.sh places it
// in the hicolor theme and points the .desktop entry at it.
const linuxIcon = join(repoRoot, "packaging", "linux", "dsh-boot.png");
if (existsSync(linuxIcon)) {
  cpSync(linuxIcon, join(packageRoot, "dsh-boot.png"));
} else {
  console.warn("dsh-boot: no icon at packaging/linux/dsh-boot.png; desktop entry will have no icon");
}

const installSh = `#!/bin/sh
# dsh-boot __VERSION__ portable Linux installer.
# Deliberately package-manager agnostic: Linux has many package ecosystems,
# while this tarball works unchanged on any glibc/musl distro with systemd,
# XDG autostart, or neither.
set -eu

VERSION="__VERSION__"
SRC=$(CDPATH= cd "$(dirname "$0")" && pwd)

if [ "$(id -u)" -eq 0 ]; then
  PREFIX="/opt/dsh-boot"
  BINDIR="/usr/local/bin"
  SYSTEM=1
else
  PREFIX="\${HOME}/.local/opt/dsh-boot"
  BINDIR="\${HOME}/.local/bin"
  SYSTEM=0
fi
AUTOSTART=1

usage() {
  cat <<EOF
Usage: $0 [--prefix DIR] [--bindir DIR] [--no-autostart] [--help]

Install the self-contained dsh-boot runtime:
  --prefix DIR       install files under DIR
                     default: /opt/dsh-boot (root) or ~/.local/opt/dsh-boot
  --bindir DIR       create dsh-boot/dsh/pnpm symlinks in DIR
                     default: /usr/local/bin (root) or ~/.local/bin
  --no-autostart     do not run 'dsh-boot autostart enable'
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --bindir) BINDIR="$2"; shift 2 ;;
    --no-autostart) AUTOSTART=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

echo "dsh-boot: installing to $PREFIX"
mkdir -p "$PREFIX" "$BINDIR"

# Copy to a temporary sibling then atomically swap, so an interrupted
# re-install never leaves a half-written runtime.
TMP="$PREFIX.tmp.$$"
rm -rf "$TMP"
mkdir -p "$TMP"
cp -a "$SRC"/. "$TMP"/
rm -rf "$PREFIX"
mv "$TMP" "$PREFIX"

for name in dsh-boot dsh pnpm; do
  ln -sfn "$PREFIX/bin/$name" "$BINDIR/$name"
  chmod +x "$PREFIX/bin/$name"
done

if [ "$SYSTEM" -eq 1 ]; then
  APPS="/usr/local/share/applications"
  ICONS="/usr/local/share/icons"
else
  APPS="\${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  ICONS="\${XDG_DATA_HOME:-$HOME/.local/share}/icons"
fi
mkdir -p "$APPS" "$ICONS/hicolor/512x512/apps"
cp "$PREFIX/dsh-boot.png" "$ICONS/hicolor/512x512/apps/dsh-boot.png"
cat > "$APPS/dsh-boot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DeepSeek Harness
Comment=Start the DeepSeek Harness web service and open the web UI
Exec="$PREFIX/bin/dsh-boot" launch
Icon=dsh-boot
Terminal=false
Categories=Development;Network;
EOF
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache "$ICONS/hicolor" >/dev/null 2>&1 || true
fi

if [ "$AUTOSTART" -eq 1 ]; then
  if [ "$SYSTEM" -eq 0 ]; then
    "$PREFIX/bin/dsh-boot" autostart enable
  else
    echo "dsh-boot: system-wide install; enable per-user autostart with: dsh-boot autostart enable"
  fi
fi

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "dsh-boot: note: $BINDIR is not on your PATH yet; add it or open a new shell" ;;
esac

echo "dsh-boot: installed"
echo "  launcher : $BINDIR/dsh-boot"
echo "  dsh      : $BINDIR/dsh"
echo "  pnpm     : $BINDIR/pnpm"
echo "  config   : ~/.dsh/dsh-boot/startup.args"
echo "  desktop  : $APPS/dsh-boot.desktop"
echo "  icon     : $ICONS/hicolor/512x512/apps/dsh-boot.png"
echo
echo "Next: run 'dsh-boot launch' (or the desktop icon) to start and open dsh."
`;
writeFileSync(join(packageRoot, "install.sh"), installSh.replaceAll("__VERSION__", version));
chmodSync(join(packageRoot, "install.sh"), 0o755);

const uninstallSh = `#!/bin/sh
# dsh-boot portable Linux uninstaller.
set -eu
SRC=$(CDPATH= cd "$(dirname "$0")" && pwd)
PREFIX="$SRC"

if [ "$(id -u)" -eq 0 ]; then
  BINDIR="/usr/local/bin"
  APPS="/usr/local/share/applications"
  ICONS="/usr/local/share/icons"
else
  BINDIR="\${HOME}/.local/bin"
  APPS="\${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  ICONS="\${XDG_DATA_HOME:-$HOME/.local/share}/icons"
fi

"$PREFIX/bin/dsh-boot" autostart disable 2>/dev/null || true
for name in dsh-boot dsh pnpm; do
  if [ -L "$BINDIR/$name" ] && [ "$(readlink "$BINDIR/$name")" = "$PREFIX/bin/$name" ]; then
    rm -f "$BINDIR/$name"
  fi
done
rm -f "$APPS/dsh-boot.desktop"
rm -f "$ICONS/hicolor/512x512/apps/dsh-boot.png"
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache "$ICONS/hicolor" >/dev/null 2>&1 || true
fi
echo "dsh-boot: stopping service if it is running"
"$PREFIX/bin/dsh-boot" stop 2>/dev/null || true
echo "dsh-boot: removing $PREFIX"
rm -rf "$PREFIX"
echo "dsh-boot: uninstalled (user state under ~/.dsh/dsh-boot was kept)"
`;
writeFileSync(join(packageRoot, "uninstall.sh"), uninstallSh);
chmodSync(join(packageRoot, "uninstall.sh"), 0o755);

const tarball = join(outDir, `dsh-boot-${version}-linux-${arch}.tar.gz`);
rmSync(tarball, { force: true });
run("tar", ["-czf", tarball, "-C", staging, "dsh-boot"]);

console.log(`dsh-boot: built ${tarball}`);
console.log("dsh-boot: Linux ships as a package-manager-agnostic tarball + systemd/XDG autostart");
