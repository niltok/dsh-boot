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
const nodeBase = `node-v${NODE_VERSION}-${nodeOs}-${targetArch}`;

const outRoot = join(repoRoot, "dist", `runtime-${key}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== void 0) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function writeRuntimeManifest() {
  const manifest = {
    name: "dsh-boot-runtime",
    version,
    private: true,
    type: "module",
    description: "Self-contained dsh-boot runtime: Node.js, pnpm, dsh, and the restart plugin",
    dependencies: {
      "@deepseek-ai/dsh": DSH_VERSION,
      pnpm: PNPM_VERSION,
    },
    // pnpm >= 10 blocks dependency build scripts unless allowed. pnpm 11
    // reads the per-package allowBuilds map from pnpm-workspace.yaml (the
    // package.json pnpm field is ignored) and fails with
    // ERR_PNPM_IGNORED_BUILDS for every package left undecided. The list is
    // the full set of packages in the dsh dependency tree that ship
    // preinstall/install/postinstall scripts (verified against the tree).
    pnpm: {
      onlyBuiltDependencies: [
        "koffi",
        "node-pty",
        "@deepseek-ai/dsh-subprocess-local",
        "@google/genai",
        "protobufjs",
      ],
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function writeBootstrapScripts() {
  const scripts = join(outRoot, "scripts");
  mkdirSync(scripts, { recursive: true });

  if (targetOs === "win32") {
    const ps1 = String.raw`param(
      [string]$DistRoot,
      [string]$RuntimeRoot = "$HOME\\.dsh-boot"
    )
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# PowerShell 5.1 defaults to TLS 1.0/1.1, which nodejs.org and most mirrors
# reject. Pin TLS 1.2 so downloads work on older Windows builds.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# System.Net.Http is not loaded by default in Windows PowerShell 5.1;
# without this the mirror probes fail with "Unable to find type".
Add-Type -AssemblyName System.Net.Http

$NODE_VERSION = "${NODE_VERSION}"
$DSH_VERSION = "${DSH_VERSION}"
$PNPM_VERSION = "${PNPM_VERSION}"
$DIST_VERSION = (Get-Content (Join-Path $DistRoot ".dsh-boot-install")).Trim()

if (Test-Path (Join-Path $RuntimeRoot ".dsh-boot-install")) {
    $installedVersion = (Get-Content (Join-Path $RuntimeRoot ".dsh-boot-install")).Trim()
    # A version match alone is not enough: a previous failed install may have
    # left a marker-less runtime behind. Require node.exe to be present too.
    if ($installedVersion -eq $DIST_VERSION -and (Test-Path (Join-Path $RuntimeRoot "node\node.exe"))) {
        exit 0
    }
}

Write-Host "dsh-boot: installing/updating runtime to $DIST_VERSION..."
if (!(Test-Path $RuntimeRoot)) { New-Item -ItemType Directory -Path $RuntimeRoot -Force }

# Record everything below for diagnosis (PS 5.1 transcript overwrites).
$logsDir = Join-Path $RuntimeRoot "logs"
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
try { Start-Transcript -Path (Join-Path $logsDir "bootstrap.log") -Force | Out-Null } catch { }

# --- Mirror Selection: measure real download speed ---
# Link latency says little about throughput. Probe each source by actually
# downloading the first chunk of a real file: 1MB of the Node tarball and
# 512KB of the pnpm package tarball from the matching npm registry.
$MIRRORS = @(
    @{ Name = "Official"; Node = "https://nodejs.org/dist"; NPM = "https://registry.npmjs.org/" },
    @{ Name = "npmmirror"; Node = "https://npmmirror.com/mirrors/node"; NPM = "https://registry.npmmirror.com/" },
    @{ Name = "Huawei"; Node = "https://mirrors.huaweicloud.com/nodejs"; NPM = "https://repo.huaweicloud.com/repository/npm/" },
    @{ Name = "Tencent"; Node = "https://mirrors.cloud.tencent.com/nodejs-release"; NPM = "https://mirrors.cloud.tencent.com/npm/" }
)

function Measure-Speed([string]$Url, [int]$Bytes) {
    # With $ErrorActionPreference='Stop', PS 5.1 turns a redirected stderr of a
    # native command into a terminating error. Curl failing (timeout) must not
    # abort bootstrap, so keep this function immune and never redirect stderr.
    $ErrorActionPreference = 'Continue'
    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (Test-Path $curl) {
        $probe = Join-Path $env:TEMP "dsh-boot-probe.bin"
        $out = & $curl -L -s --connect-timeout 3 --max-time 8 -r 0-$($Bytes - 1) -o $probe -w '%{speed_download}' $Url
        Remove-Item $probe -Force -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -eq 0 -and $out) {
            try { return [double]$out } catch { return 0.0 }
        }
        return 0.0
    }
    # No curl (pre-1803 Windows): fall back to a HEAD probe with a pseudo speed.
    try {
        $client = [System.Net.Http.HttpClient]::new()
        $client.Timeout = [System.TimeSpan]::FromSeconds(3)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $resp = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        $resp.Dispose()
        $sw.Stop()
        return 1e9 / [math]::Max(1.0, $sw.Elapsed.TotalMilliseconds)
    } catch { return 0.0 }
}

function Download-Node([string]$Url, [string]$OutFile) {
    $ErrorActionPreference = 'Continue'
    if (Test-Path $OutFile) { Remove-Item -Force $OutFile }
    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (Test-Path $curl) {
        & $curl -L --fail --connect-timeout 15 --max-time 900 -sS -o $OutFile $Url
        return $LASTEXITCODE -eq 0
    }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

$nodeBase = "${nodeBase}"
$selectedMirror = $null   # fastest Node.js source
$selectedRegistry = $null # fastest npm registry
if ($env:DSH_BOOT_NODE_MIRROR) {
    Write-Host "dsh-boot: using manual mirror override: $($env:DSH_BOOT_NODE_MIRROR)"
    $selectedMirror = @{ Name = "Manual"; Node = $env:DSH_BOOT_NODE_MIRROR; NPM = $env:DSH_BOOT_NPM_REGISTRY }
    $selectedRegistry = $selectedMirror
} else {
    Write-Host "dsh-boot: measuring download speed (1MB node probe, 512KB registry probe)..."
    $bestNode = 0.0
    $bestReg = 0.0
    foreach ($m in $MIRRORS) {
        $nodeProbe = "$($m.Node)/v${NODE_VERSION}/$nodeBase.zip"
        $regProbe = "$($m.NPM)pnpm/-/pnpm-${PNPM_VERSION}.tgz"
        $ns = Measure-Speed $nodeProbe 1048576
        $rs = Measure-Speed $regProbe 524288
        if ($ns -gt 0) {
            Write-Host ("  {0}: node {1:N0} KB/s, registry {2:N0} KB/s" -f $m.Name, ($ns / 1KB), ($rs / 1KB))
            if ($ns -gt $bestNode) { $bestNode = $ns; $selectedMirror = $m }
            if ($rs -gt $bestReg) { $bestReg = $rs; $selectedRegistry = $m }
        } else {
            Write-Host ("  {0}: unreachable" -f $m.Name)
        }
    }
    if ($null -eq $selectedMirror) {
        Write-Host "dsh-boot: no Node source reachable; will try downloads in priority order"
    } else {
        Write-Host "dsh-boot: fastest Node source: $($selectedMirror.Name)"
    }
    if ($null -eq $selectedRegistry) {
        Write-Host "dsh-boot: no npm registry reachable; will fall back to npmmirror"
    } else {
        Write-Host "dsh-boot: fastest npm registry: $($selectedRegistry.Name)"
    }
}

$npmRegistry = if ($env:DSH_BOOT_NPM_REGISTRY) { $env:DSH_BOOT_NPM_REGISTRY }
    elseif ($null -ne $selectedRegistry) { $selectedRegistry.NPM }
    else { "https://registry.npmmirror.com/" }
$archivePath = Join-Path $RuntimeRoot "node.zip"

# --- Download Node.js ---
# Fastest mirror first (or manual override); on failure walk the mirror list
# in priority order and use the first mirror that actually downloads.
$nodeUrl = ""
$ok = $false
if ($null -ne $selectedMirror) {
    $nodeUrl = "$($selectedMirror.Node)/v${NODE_VERSION}/$nodeBase.zip"
    Write-Host "dsh-boot: downloading Node.js from $($selectedMirror.Name): $nodeUrl"
    $ok = Download-Node $nodeUrl $archivePath
}
if (-not $ok) {
    $priority = @("npmmirror", "Huawei", "Tencent", "Official")
    foreach ($name in $priority) {
        $m = $MIRRORS | Where-Object { $_.Name -eq $name }
        if ($null -eq $m) { continue }
        $tryUrl = "$($m.Node)/v${NODE_VERSION}/$nodeBase.zip"
        Write-Host "dsh-boot: download failed; trying $($m.Name): $tryUrl"
        if (Download-Node $tryUrl $archivePath) {
            $nodeUrl = $tryUrl
            $selectedMirror = $m
            $ok = $true
            break
        }
    }
}
if (-not $ok) {
    throw "dsh-boot: all mirrors failed to download Node.js (see $logsDir\bootstrap.log). Set DSH_BOOT_NODE_MIRROR to a reachable mirror and run again."
}

Write-Host "dsh-boot: extracting Node.js..."
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (Test-Path $tar) {
    & $tar -xf $archivePath -C $RuntimeRoot
    if ($LASTEXITCODE -ne 0) { throw "dsh-boot: tar extraction failed (exit $LASTEXITCODE)" }
} else {
    Expand-Archive -Path $archivePath -DestinationPath $RuntimeRoot -Force
}
Remove-Item $archivePath -Force

$nodeDir = Join-Path $RuntimeRoot "node"
if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }

# Move-Item onto a *non-existent* target renames the extracted folder into
# place. Pre-creating $nodeDir would nest it as node\node-vX.Y.Z-win-x64\.
$extractedDir = Get-ChildItem -Path $RuntimeRoot -Filter "node-v${NODE_VERSION}-win-${targetArch}*" | Select-Object -First 1
if ($null -eq $extractedDir) { throw "dsh-boot: extracted Node.js directory not found under $RuntimeRoot" }
Move-Item -Path $extractedDir.FullName -Destination $nodeDir

$nodeBin = Join-Path $nodeDir "node.exe"
$npmCli = Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js"
if (!(Test-Path $nodeBin)) { throw "dsh-boot: node.exe missing at $nodeBin" }
if (!(Test-Path $npmCli)) { throw "dsh-boot: npm-cli.js missing at $npmCli" }

# Install scripts (pnpm's, koffi's cnoke.cjs, ...) invoke 'node' by name.
$env:PATH = "$nodeDir;$env:PATH"

# Write UTF-8 without BOM: PowerShell 5.1 Set-Content defaults to ANSI, which
# would corrupt any non-ASCII bytes in the manifest. A here-string keeps the
# JSON literal (a bare { ... } would parse as a scriptblock).
$manifestJson = @'
${writeRuntimeManifest()}
'@
[System.IO.File]::WriteAllText((Join-Path $RuntimeRoot "package.json"), $manifestJson, [System.Text.UTF8Encoding]::new($false))

# pnpm 11 reads the build-script allowlist from pnpm-workspace.yaml as a
# per-package allowBuilds map; without explicit true/false for every package
# that ships lifecycle scripts, pnpm install fails with ERR_PNPM_IGNORED_BUILDS.
$workspaceYaml = @'
allowBuilds:
  koffi: true
  node-pty: true
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': true
  protobufjs: true
'@
[System.IO.File]::WriteAllText((Join-Path $RuntimeRoot "pnpm-workspace.yaml"), $workspaceYaml, [System.Text.UTF8Encoding]::new($false))

# Runtime-local .npmrc so we never touch the user's global npm config.
[System.IO.File]::WriteAllText((Join-Path $RuntimeRoot ".npmrc"), "registry=$npmRegistry", [System.Text.UTF8Encoding]::new($false))

Write-Host "dsh-boot: installing pnpm ${PNPM_VERSION} from $npmRegistry..."
& $nodeBin $npmCli install -g "pnpm@${PNPM_VERSION}" --prefix $nodeDir --registry $npmRegistry --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "dsh-boot: npm install -g pnpm failed (exit $LASTEXITCODE)" }

$pnpmCli = Join-Path $nodeDir "node_modules\pnpm\bin\pnpm.cjs"
if (!(Test-Path $pnpmCli)) { throw "dsh-boot: pnpm.cjs missing at $pnpmCli" }

Write-Host "dsh-boot: installing dependencies with pnpm (parallel downloads)..."
Push-Location $RuntimeRoot
try {
    & $nodeBin $pnpmCli install --prod --no-lockfile --network-concurrency 8
    if ($LASTEXITCODE -ne 0) { throw "dsh-boot: pnpm install failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$cliDest = Join-Path $RuntimeRoot "lib\dsh-boot"
if (Test-Path $cliDest) { Remove-Item -Recurse -Force $cliDest }
Copy-Item -Path (Join-Path $DistRoot "lib\dsh-boot") -Destination $cliDest -Recurse -Force

$pluginSrc = Join-Path $DistRoot "vendor\restart-plugin"
$pluginDest = Join-Path $RuntimeRoot "node_modules\@dsh-boot\restart-plugin"
if (Test-Path $pluginDest) { Remove-Item -Recurse -Force $pluginDest }
New-Item -ItemType Directory -Path (Split-Path $pluginDest) -Force
Copy-Item -Path $pluginSrc -Destination $pluginDest -Recurse -Force

$dshManifestPath = Join-Path $RuntimeRoot "node_modules\@deepseek-ai\dsh\package.json"
if (!(Test-Path $dshManifestPath)) { throw "dsh-boot: dsh package.json missing at $dshManifestPath" }
$dshManifest = Get-Content $dshManifestPath -Raw | ConvertFrom-Json
$dshManifest.dependencies["@dsh-boot/restart-plugin"] = "${version}"
[System.IO.File]::WriteAllText($dshManifestPath, ($dshManifest | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

Set-Content -Path (Join-Path $RuntimeRoot ".dsh-boot-install") -Value $DIST_VERSION
Write-Host "dsh-boot: installation complete"
`;
    writeFileSync(join(scripts, "bootstrap.ps1"), ps1);
  } else {
    const sh = String.raw`#!/bin/sh
set -eu
DIST_ROOT="$1"
RUNTIME_ROOT="\${2:-$HOME/.dsh-boot}"

NODE_VERSION="${NODE_VERSION}"
DSH_VERSION="${DSH_VERSION}"
PNPM_VERSION="${PNPM_VERSION}"
DIST_VERSION=$(cat "$DIST_ROOT/.dsh-boot-install" | tr -d '\\r\\n')

if [ -f "$RUNTIME_ROOT/.dsh-boot-install" ]; then
    INSTALLED_VERSION=$(cat "$RUNTIME_ROOT/.dsh-boot-install" | tr -d '\\r\\n')
    # Version match alone is not enough: a failed install may have left a
    # half-installed runtime. Require node to be present too.
    if [ "$INSTALLED_VERSION" = "$DIST_VERSION" ] && [ -x "$RUNTIME_ROOT/node/bin/node" ]; then
        exit 0
    fi
fi

echo "dsh-boot: installing/updating runtime to $DIST_VERSION..."
mkdir -p "$RUNTIME_ROOT"

# --- Mirror Selection (HEAD probes; never download the directory page) ---
MIRRORS="
Official|https://nodejs.org/dist|https://registry.npmjs.org/
npmmirror|https://npmmirror.com/mirrors/node|https://registry.npmmirror.com/
Huawei|https://mirrors.huaweicloud.com/nodejs|https://repo.huaweicloud.com/repository/npm/
Tencent|https://mirrors.cloud.tencent.com/nodejs-release|https://mirrors.cloud.tencent.com/npm/
"

selected_node_mirror=""
selected_npm_registry=""
node_base="${nodeBase}"

if [ -n "\${DSH_BOOT_NODE_MIRROR:-}" ]; then
    echo "dsh-boot: using manual mirror override: \${DSH_BOOT_NODE_MIRROR}"
    selected_node_mirror="\${DSH_BOOT_NODE_MIRROR}"
    selected_npm_registry="\${DSH_BOOT_NPM_REGISTRY:-}"
else
    echo "dsh-boot: measuring download speed (1MB node probe, 512KB registry probe)..."
    TMP_DIR=$(mktemp -d)
    for m in $MIRRORS; do
        [ -z "$m" ] && continue
        (
            name=$(echo "$m" | cut -d'|' -f1)
            node_url=$(echo "$m" | cut -d'|' -f2)
            npm_url=$(echo "$m" | cut -d'|' -f3)

            # Probe by actually downloading the first chunk of a real file:
            # 1MB of the Node tarball and 512KB of the pnpm tarball from the
            # matching registry. -w prints bytes/sec (float), so no date +%N.
            node_speed=$(curl -sL -o /dev/null --max-time 8 -r 0-1048575 -w '%{speed_download}' "$node_url/v${NODE_VERSION}/$node_base.tar.gz" 2>/dev/null)
            reg_speed=$(curl -sL -o /dev/null --max-time 8 -r 0-524287 -w '%{speed_download}' "$npm_url/pnpm/-/pnpm-${PNPM_VERSION}.tgz" 2>/dev/null)
            echo "$name|$node_url|$npm_url|$node_speed|$reg_speed" > "$TMP_DIR/$name"
        ) &
    done
    wait

    best_node=0
    best_reg=0
    for res_file in "$TMP_DIR"/*; do
        [ -e "$res_file" ] || continue
        res=$(cat "$res_file")
        name=$(echo "$res" | cut -d'|' -f1)
        node_url=$(echo "$res" | cut -d'|' -f2)
        npm_url=$(echo "$res" | cut -d'|' -f3)
        node_speed=$(echo "$res" | cut -d'|' -f4)
        reg_speed=$(echo "$res" | cut -d'|' -f5)

        node_kb=$(awk -v s="$node_speed" 'BEGIN { printf "%d", s/1024 }')
        reg_kb=$(awk -v s="$reg_speed" 'BEGIN { printf "%d", s/1024 }')
        if [ "$node_kb" -gt 0 ]; then
            echo "  $name: node \${node_kb} KB/s, registry \${reg_kb} KB/s"
        else
            echo "  $name: unreachable"
        fi
        if awk -v s="$node_speed" -v b="$best_node" 'BEGIN { exit !(s > b) }'; then
            best_node="$node_speed"
            selected_node_mirror="$node_url"
        fi
        if awk -v s="$reg_speed" -v b="$best_reg" 'BEGIN { exit !(s > b) }'; then
            best_reg="$reg_speed"
            selected_npm_registry="$npm_url"
        fi
    done
    rm -rf "$TMP_DIR"

    if [ -z "$selected_node_mirror" ]; then
        echo "dsh-boot: no Node source reachable; will try downloads in priority order"
    else
        echo "dsh-boot: fastest Node source selected"
    fi
    if [ -z "$selected_npm_registry" ]; then
        echo "dsh-boot: no npm registry reachable; will fall back to npmmirror"
    else
        echo "dsh-boot: fastest npm registry selected"
    fi
fi

npm_registry="\${DSH_BOOT_NPM_REGISTRY:-$selected_npm_registry}"
if [ -z "$npm_registry" ]; then npm_registry="https://registry.npmmirror.com/"; fi

# --- Installation ---
NODE_DIR="$RUNTIME_ROOT/node"
rm -rf "$NODE_DIR"
mkdir -p "$NODE_DIR"

ARCHIVE="$RUNTIME_ROOT/node.tar.gz"

download_node() {
    url="$1"
    rm -f "$ARCHIVE"
    if curl -L --fail --connect-timeout 15 --max-time 900 -sS -o "$ARCHIVE" "$url"; then
        return 0
    fi
    return 1
}

# Fastest mirror first (or manual override); on failure walk the list in
# priority order and use the first mirror that actually downloads.
node_url=""
if [ -n "$selected_node_mirror" ]; then
    node_url="$selected_node_mirror/v${NODE_VERSION}/$node_base.tar.gz"
    echo "dsh-boot: downloading Node.js from $node_url..."
    if ! download_node "$node_url"; then
        echo "dsh-boot: download failed; trying other mirrors"
        node_url=""
    fi
fi
if [ -z "$node_url" ]; then
    for name in npmmirror Huawei Tencent Official; do
        m=$(echo "$MIRRORS" | grep "^$name|" | head -1)
        [ -z "$m" ] && continue
        m_node=$(echo "$m" | cut -d'|' -f2)
        m_npm=$(echo "$m" | cut -d'|' -f3)
        try_url="$m_node/v${NODE_VERSION}/$node_base.tar.gz"
        echo "dsh-boot: trying $name: $try_url"
        if download_node "$try_url"; then
            node_url="$try_url"
            selected_npm_registry="$m_npm"
            npm_registry="\${DSH_BOOT_NPM_REGISTRY:-$selected_npm_registry}"
            break
        fi
    done
fi
if [ -z "$node_url" ]; then
    echo "dsh-boot: all mirrors failed to download Node.js. Set DSH_BOOT_NODE_MIRROR to a reachable mirror and run again." >&2
    exit 1
fi

echo "dsh-boot: extracting Node.js..."
tar -xzf "$ARCHIVE" -C "$NODE_DIR" --strip-components 1
rm "$ARCHIVE"

NODE_BIN="$NODE_DIR/bin/node"
NPM_CLI="$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
# npm postinstall scripts (e.g. koffi's cnoke.cjs) invoke 'node' by name.
export PATH="$NODE_DIR/bin:$PATH"

cat <<EOF > "$RUNTIME_ROOT/package.json"
${writeRuntimeManifest()}
EOF

# pnpm 11 reads the build-script allowlist from pnpm-workspace.yaml as a
# per-package allowBuilds map; without explicit true/false for every package
# that ships lifecycle scripts, pnpm install fails with ERR_PNPM_IGNORED_BUILDS.
cat <<'EOF' > "$RUNTIME_ROOT/pnpm-workspace.yaml"
allowBuilds:
  koffi: true
  node-pty: true
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': true
  protobufjs: true
EOF

echo "dsh-boot: configuring npm registry to $npm_registry..."
# Runtime-local .npmrc; never touch the user's global npm config.
printf 'registry=%s\n' "$npm_registry" > "$RUNTIME_ROOT/.npmrc"

echo "dsh-boot: installing pnpm ${PNPM_VERSION} from $npm_registry..."
"$NODE_BIN" "$NPM_CLI" install -g "pnpm@${PNPM_VERSION}" --prefix "$NODE_DIR" --registry "$npm_registry" --no-audit --no-fund
if [ $? -ne 0 ]; then echo "dsh-boot: npm install -g pnpm failed" >&2; exit 1; fi

PNPM_CLI="$NODE_DIR/lib/node_modules/pnpm/bin/pnpm.cjs"
if [ ! -f "$PNPM_CLI" ]; then echo "dsh-boot: pnpm.cjs missing at $PNPM_CLI" >&2; exit 1; fi

echo "dsh-boot: installing dependencies with pnpm (parallel downloads)..."
(
    cd "$RUNTIME_ROOT" && "$NODE_BIN" "$PNPM_CLI" install --prod --no-lockfile --network-concurrency 8
)
if [ $? -ne 0 ]; then echo "dsh-boot: pnpm install failed" >&2; exit 1; fi

CLI_DEST="$RUNTIME_ROOT/lib/dsh-boot"
rm -rf "$CLI_DEST"
cp -r "$DIST_ROOT/lib/dsh-boot" "$CLI_DEST"

# Mirror the wrapper scripts and bin/ into the runtime root so autostart
# entries (systemd/launchctl/XDG) can go through the bootstrapping wrapper
# instead of invoking node directly.
rm -rf "$RUNTIME_ROOT/scripts" "$RUNTIME_ROOT/bin"
cp -r "$DIST_ROOT/scripts" "$RUNTIME_ROOT/scripts"
cp -r "$DIST_ROOT/bin" "$RUNTIME_ROOT/bin"

PLUGIN_SRC="$DIST_ROOT/vendor/restart-plugin"
PLUGIN_DEST="$RUNTIME_ROOT/node_modules/@dsh-boot/restart-plugin"
rm -rf "$PLUGIN_DEST"
mkdir -p "$(dirname "$PLUGIN_DEST")"
cp -r "$PLUGIN_SRC" "$PLUGIN_DEST"

DSH_MANIFEST="$RUNTIME_ROOT/node_modules/@deepseek-ai/dsh/package.json"
"$NODE_BIN" -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('$DSH_MANIFEST', 'utf8'));
m.dependencies['@dsh-boot/restart-plugin'] = '${version}';
fs.writeFileSync('$DSH_MANIFEST', JSON.stringify(m, null, 2));
"

echo "$DIST_VERSION" > "$RUNTIME_ROOT/.dsh-boot-install"
echo "dsh-boot: installation complete"
`;
    writeFileSync(join(scripts, "bootstrap.sh"), sh);
    chmodSync(join(scripts, "bootstrap.sh"), 0o755);
  }
}

function writeWindowsWrappers() {
  const bin = join(outRoot, "bin");
  mkdirSync(bin, { recursive: true });
  
  const bootCmd = `powershell -ExecutionPolicy Bypass -File "%DSH_BOOT_ROOT%\\scripts\\bootstrap.ps1" -DistRoot "%DSH_BOOT_ROOT%" -RuntimeRoot "%RUNTIME_ROOT%"\r\nif errorlevel 1 (\r\n  echo dsh-boot: runtime bootstrap failed; see "%RUNTIME_ROOT%\\logs\\bootstrap.log"\r\n  exit /b %errorlevel%\r\n)`;
  
  writeFileSync(join(bin, "dsh-boot.cmd"), `@echo off\r\nsetlocal\r\nfor %%I in ("%~dp0..") do set "DSH_BOOT_ROOT=%%~fI"\r\nset "RUNTIME_ROOT=%USERPROFILE%\\.dsh-boot"\r\n${bootCmd}\r\nset "PATH=%RUNTIME_ROOT%\\node;%PATH%"\r\n"%RUNTIME_ROOT%\\node\\node.exe" "%RUNTIME_ROOT%\\lib\\dsh-boot\\bin.js" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  writeFileSync(join(bin, "dsh.cmd"), `@echo off\r\nsetlocal\r\nfor %%I in ("%~dp0..") do set "DSH_BOOT_ROOT=%%~fI"\r\nset "RUNTIME_ROOT=%USERPROFILE%\\.dsh-boot"\r\n${bootCmd}\r\nset "PATH=%RUNTIME_ROOT%\\node;%PATH%"\r\n"%RUNTIME_ROOT%\\node\\node.exe" "%RUNTIME_ROOT%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  writeFileSync(join(bin, "pnpm.cmd"), `@echo off\r\nsetlocal\r\nfor %%I in ("%~dp0..") do set "DSH_BOOT_ROOT=%%~fI"\r\nset "RUNTIME_ROOT=%USERPROFILE%\\.dsh-boot"\r\n${bootCmd}\r\n"%RUNTIME_ROOT%\\node\\node.exe" "%RUNTIME_ROOT%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);

  const scripts = join(outRoot, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "dsh-boot-launch.ps1"), `param([string]$Action = 'launch')\r\n$ErrorActionPreference = 'Stop'\r\n$root = Split-Path -Parent $PSScriptRoot\r\n$runtimeRoot = "$HOME\\.dsh-boot"\r\n# The Start Menu shortcut and the Run-key autostart both land here; make\r\n# sure the on-demand runtime exists before invoking node.\r\n& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\\bootstrap.ps1') -DistRoot $root -RuntimeRoot $runtimeRoot\r\nif ($LASTEXITCODE -ne 0) {\r\n  Add-Type -AssemblyName System.Windows.Forms | Out-Null\r\n  [System.Windows.Forms.MessageBox]::Show("dsh-boot could not start: runtime bootstrap failed (exit $LASTEXITCODE).\n\nSee $runtimeRoot\\logs\\bootstrap.log for details.", 'dsh-boot') | Out-Null\r\n  exit $LASTEXITCODE\r\n}\r\n$node = Join-Path $runtimeRoot 'node\\node.exe'\r\n$cli = Join-Path $runtimeRoot 'lib\\dsh-boot\\bin.js'\r\n& $node $cli $Action @args\r\nexit $LASTEXITCODE\r\n`);
  writeFileSync(join(scripts, "update-user-path.ps1"), UPDATE_USER_PATH_PS1);
}

function writeUnixWrappers() {
  const bin = join(outRoot, "bin");
  mkdirSync(bin, { recursive: true });
  const common = `#!/bin/sh\nset -eu\nSELF="$0"\nwhile [ -L "$SELF" ]; do\n  LINK=$(readlink "$SELF")\n  case "$LINK" in\n    /*) SELF="$LINK" ;;\n    *) SELF="$(dirname "$SELF")/ $LINK" ;;\n  esac\ndone\nROOT=$(CDPATH= cd "$(dirname "$SELF")/.." && pwd)\nexport PATH="$ROOT/bin:$PATH"\nRUNTIME_ROOT="$HOME/.dsh-boot"\n"$ROOT/scripts/bootstrap.sh" "$ROOT" "$RUNTIME_ROOT"\n`;
  writeFileSync(join(bin, "dsh-boot"), `${common}exec "$RUNTIME_ROOT/node/bin/node" "$RUNTIME_ROOT/lib/dsh-boot/bin.js" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "dsh"), `${common}exec "$RUNTIME_ROOT/node/bin/node" "$RUNTIME_ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "pnpm"), `${common}exec "$RUNTIME_ROOT/node/bin/node" "$RUNTIME_ROOT/node_modules/pnpm/bin/pnpm.cjs" "$@"\n`, { mode: 0o755 });
  chmodSync(join(bin, "dsh-boot"), 0o755);
  chmodSync(join(bin, "dsh"), 0o755);
  chmodSync(join(bin, "pnpm"), 0o755);
}

async function main() {
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  cpSync(join(repoRoot, "packages", "cli", "src"), join(outRoot, "lib", "dsh-boot"), { recursive: true });
  cpSync(join(repoRoot, "packages", "restart-plugin"), join(outRoot, "vendor", "restart-plugin"), { recursive: true });

  const pluginManifestPath = join(outRoot, "vendor", "restart-plugin", "package.json");
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  pluginManifest.version = version;
  writeFileSync(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);

  writeBootstrapScripts();

  writeFileSync(join(outRoot, ".dsh-boot-install"), `dsh-boot ${version}\n`);
  if (targetOs === "win32") writeWindowsWrappers();
  else writeUnixWrappers();

  const iconSource = join(repoRoot, "packaging", "windows", "dsh-boot.ico");
  if (existsSync(iconSource)) {
    cpSync(iconSource, join(outRoot, "dsh-boot.ico"));
  }

  console.log(`dsh-boot: runtime bundle ready at ${outRoot}`);
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
