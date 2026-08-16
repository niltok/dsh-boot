import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureBootDir, writeTextAtomic } from "./fsutil.js";
import { paths } from "./paths.js";

const AUTOSTART_ID = "com.dsh-boot.autostart";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function windowsShortcutDir(system) {
  if (system) {
    const programData = process.env.ProgramData ?? "C:\\ProgramData";
    return join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "StartUp");
  }
  const appData = process.env.APPDATA;
  if (appData === void 0) throw new Error("dsh-boot: APPDATA is not set; cannot resolve the Startup folder");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "StartUp");
}

function runWindowsAutostart(action, system) {
  const launchScript = join(paths.installRoot, "scripts", "dsh-boot-launch.ps1");
  const runKey = system
    ? "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
    : "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$action = $env:DSH_BOOT_ACTION
$runKey = $env:DSH_BOOT_RUN_KEY
$launch = $env:DSH_BOOT_LAUNCH_SCRIPT
$dir = $env:DSH_BOOT_SHORTCUT_DIR
$lnk = Join-Path $dir 'DSH Boot.lnk'
$oldLnk = Join-Path $dir 'dsh-boot.lnk'
$name = 'DSH Boot'
$target = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$value = '"' + $target + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launch + '" start --no-browser'
if ($action -eq 'enable') {
  New-Item -Path $runKey -Force | Out-Null
  Set-ItemProperty -Path $runKey -Name $name -Value $value -Type String
  Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $oldLnk -Force -ErrorAction SilentlyContinue
  Write-Output 'enabled'
} elseif ($action -eq 'disable') {
  Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $oldLnk -Force -ErrorAction SilentlyContinue
  Write-Output 'disabled'
} elseif ($action -eq 'status') {
  $item = Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
  if ($null -ne $item -and $null -ne $item.$name) { Write-Output 'enabled' } else { Write-Output 'disabled' }
} else {
  throw "unknown action: $action"
}
`;
  const result = run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)],
    {
      env: {
        ...process.env,
        DSH_BOOT_ACTION: action,
        DSH_BOOT_RUN_KEY: runKey,
        DSH_BOOT_SHORTCUT_DIR: windowsShortcutDir(system),
        DSH_BOOT_LAUNCH_SCRIPT: launchScript,
      },
    },
  );
  if (result.code !== 0) {
    throw new Error(`dsh-boot: PowerShell autostart ${action} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function launchAgentPlist() {
  return join(homedir(), "Library", "LaunchAgents", `${AUTOSTART_ID}.plist`);
}

function launchAgentXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(AUTOSTART_ID)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(paths.nodeBin)}</string>
    <string>${escapeXml(paths.cliEntry)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(paths.bootLog)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(paths.bootLog)}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function macosUid() {
  if (typeof process.getuid === "function") return process.getuid();
  const result = run("id", ["-u"]);
  return Number(result.stdout.trim()) || 501;
}

function enableMacosAutostart() {
  ensureBootDir();
  writeTextAtomic(launchAgentPlist(), launchAgentXml());
  const uid = macosUid();
  let result = run("launchctl", ["bootout", `gui/${uid}`, launchAgentPlist()]);
  result = run("launchctl", ["bootstrap", `gui/${uid}`, launchAgentPlist()]);
  if (result.code !== 0) result = run("launchctl", ["load", "-w", launchAgentPlist()]);
  if (result.code !== 0) {
    throw new Error(`dsh-boot: failed to register LaunchAgent: ${result.stderr || result.stdout}`);
  }
  return "enabled";
}

function disableMacosAutostart() {
  const uid = macosUid();
  run("launchctl", ["bootout", `gui/${uid}`, launchAgentPlist()]);
  run("launchctl", ["unload", "-w", launchAgentPlist()]);
  rmSync(launchAgentPlist(), { force: true });
  return "disabled";
}

function macosAutostartStatus() {
  if (!existsSync(launchAgentPlist())) return "disabled";
  const result = run("launchctl", ["print", `gui/${macosUid()}/${AUTOSTART_ID}`]);
  return result.code === 0 ? "enabled" : "disabled";
}

const LINUX_USER_UNIT = join(homedir(), ".config", "systemd", "user", "dsh-boot.service");
const LINUX_XDG_AUTOSTART = join(homedir(), ".config", "autostart", "dsh-boot.desktop");

function hasSystemdUser() {
  return run("systemctl", ["--user", "--version"]).code === 0;
}

function systemdQuote(path) {
  return `"${String(path).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function linuxUnit() {
  return `# Managed by dsh-boot. Regenerate with: dsh-boot autostart enable
[Unit]
Description=DeepSeek Harness web service (dsh-boot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=DSH_BOOT_SUPERVISOR=1
ExecStart=${systemdQuote(paths.nodeBin)} ${systemdQuote(paths.cliEntry)} run
WorkingDirectory=${systemdQuote(homedir())}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function linuxDesktopAutostart() {
  return `[Desktop Entry]
Type=Application
Name=dsh-boot
Comment=Start the DeepSeek Harness web service at login
Exec=${systemdQuote(paths.nodeBin)} ${systemdQuote(paths.cliEntry)} start --no-browser
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function enableLinuxAutostart() {
  ensureBootDir();
  if (hasSystemdUser()) {
    mkdirSync(dirname(LINUX_USER_UNIT), { recursive: true });
    writeFileSync(LINUX_USER_UNIT, linuxUnit(), { encoding: "utf8", mode: 0o600 });
    let result = run("systemctl", ["--user", "daemon-reload"]);
    if (result.code !== 0) throw new Error(`dsh-boot: systemctl daemon-reload failed: ${result.stderr}`);
    result = run("systemctl", ["--user", "enable", "--now", "dsh-boot.service"]);
    if (result.code !== 0) throw new Error(`dsh-boot: systemctl enable failed: ${result.stderr}`);
    return "enabled (systemd user service)";
  }

  mkdirSync(dirname(LINUX_XDG_AUTOSTART), { recursive: true });
  writeFileSync(LINUX_XDG_AUTOSTART, linuxDesktopAutostart(), { encoding: "utf8", mode: 0o600 });
  chmodSync(LINUX_XDG_AUTOSTART, 0o700);
  return "enabled (XDG autostart)";
}

function disableLinuxAutostart() {
  let disabled = false;
  if (existsSync(LINUX_USER_UNIT)) {
    run("systemctl", ["--user", "disable", "--now", "dsh-boot.service"]);
    rmSync(LINUX_USER_UNIT, { force: true });
    if (hasSystemdUser()) run("systemctl", ["--user", "daemon-reload"]);
    disabled = true;
  }
  if (existsSync(LINUX_XDG_AUTOSTART)) {
    rmSync(LINUX_XDG_AUTOSTART, { force: true });
    disabled = true;
  }
  return disabled ? "disabled" : "disabled (nothing to remove)";
}

function linuxAutostartStatus() {
  if (existsSync(LINUX_USER_UNIT)) {
    const result = run("systemctl", ["--user", "is-enabled", "dsh-boot.service"]);
    return result.code === 0 ? "enabled (systemd user service)" : "configured (systemd unit present but disabled)";
  }
  return existsSync(LINUX_XDG_AUTOSTART) ? "enabled (XDG autostart)" : "disabled";
}

export function setAutostart(action, { system = false } = {}) {
  if (!["enable", "disable", "status"].includes(action)) {
    throw new Error(`dsh-boot: invalid autostart action ${action}`);
  }

  if (process.platform === "win32") return runWindowsAutostart(action, system);
  if (process.platform === "darwin") {
    if (action === "enable") return enableMacosAutostart();
    if (action === "disable") return disableMacosAutostart();
    return macosAutostartStatus();
  }
  if (action === "enable") return enableLinuxAutostart();
  if (action === "disable") return disableLinuxAutostart();
  return linuxAutostartStatus();
}
