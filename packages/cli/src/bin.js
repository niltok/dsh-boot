#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setAutostart } from "./autostart.js";
import { ensureBootDir } from "./fsutil.js";
import { paths } from "./paths.js";
import { writeInjectedPatch } from "./patch.js";
import { readStartupArgs } from "./startup-args.js";
import {
  ensureRunning,
  fetchHealth,
  fetchWeb,
  openBrowser,
  printStatus,
  readState,
  restartService,
  runSupervisor,
  stopService,
  waitForRunning,
} from "./supervisor.js";

const HELP = `dsh-boot ${paths.version} — lightweight DeepSeek Harness (dsh) launcher

Usage:
  dsh-boot launch                    ensure dsh is running, then open the web UI
  dsh-boot start [--foreground] [--no-browser]
                                     start dsh as a background service (never opens a browser)
  dsh-boot stop                      stop dsh and its supervisor
  dsh-boot restart                   restart dsh
  dsh-boot status [--json]           show service status
  dsh-boot open                      open the web UI (dsh must already be running)
  dsh-boot autostart <enable|disable|status> [--system]
                                     manage boot-time autostart
  dsh-boot args                      print the effective startup arguments
  dsh-boot patch                     print the path of the generated --patch overlay
  dsh-boot doctor                    verify the bundled runtime
  dsh-boot run                       internal foreground supervisor (used by services)

Startup arguments:
  ${paths.startupArgsFile}

One dsh-web flag per line, e.g.:
  --port 3080
  --host 127.0.0.1

The file is read fresh for every launch path: boot-time autostart, the
desktop icon, and the web-UI restart button.
`;

function fail(message, code = 1) {
  if (!String(message).startsWith("dsh-boot:")) message = `dsh-boot: ${message}`;
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() ?? "help";

  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "-V" || command === "--version" || command === "version") {
    process.stdout.write(`${paths.version}\n`);
    return;
  }

  switch (command) {
    case "launch": {
      await ensureRunning({ openBrowser: true });
      return;
    }

    case "start": {
      let foreground = false;
      const rest = [];
      for (const argument of args) {
        if (argument === "--foreground") foreground = true;
        else if (argument === "--no-browser") continue; // Accepted for autostart compatibility; start never opens a browser.
        else rest.push(argument);
      }
      if (rest.length > 0) fail(`unknown start option: ${rest.join(" ")}`);
      if (foreground) {
        await runSupervisor({ foreground: true });
        return;
      }
      await ensureRunning({});
      return;
    }

    case "stop":
      await stopService();
      return;

    case "restart":
      await restartService();
      return;

    case "status": {
      const json = args.includes("--json");
      const state = readState();
      const healthy = state === void 0 ? false : await fetchHealth(state, 750);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ...(state ?? {}), healthy, webHealthy: await fetchWeb(state?.webUrl, 1500) }, null, 2)}\n`,
        );
      } else {
        printStatus(state);
        process.stdout.write(`${"healthy".padEnd(15)} ${String(healthy)}\n`);
      }
      process.exitCode = healthy && state?.phase === "running" ? 0 : 1;
      return;
    }

    case "open": {
      const state = readState();
      if (state?.webUrl !== void 0 && (await fetchHealth(state, 750))) {
        await openBrowser(state.webUrl);
        return;
      }
      fail("dsh is not running; use 'dsh-boot launch' to start it and open the UI");
      return;
    }

    case "autostart": {
      const action = args.shift();
      const system = args.includes("--system");
      if (action === void 0) fail("autostart needs enable, disable, or status");
      process.stdout.write(`${setAutostart(action, { system })}\n`);
      return;
    }

    case "args": {
      ensureBootDir();
      const startupArgs = readStartupArgs();
      for (const argument of startupArgs) process.stdout.write(`${argument}\n`);
      return;
    }

    case "patch": {
      ensureBootDir();
      process.stdout.write(`${writeInjectedPatch()}\n`);
      return;
    }

    case "doctor": {
      ensureBootDir();
      const restartPlugin = join(paths.installRoot, "node_modules", "@dsh-boot", "restart-plugin", "package.json");
      const checks = [
        ["install root", paths.installRoot, existsSync(paths.installRoot)],
        ["node", paths.nodeBin, existsSync(paths.nodeBin)],
        ["dsh cli", paths.dshCli, existsSync(paths.dshCli)],
        ["restart plugin", restartPlugin, existsSync(restartPlugin)],
        ["startup args", paths.startupArgsFile, existsSync(paths.startupArgsFile)],
      ];
      let ok = true;
      for (const [name, value, passed] of checks) {
        if (!passed) ok = false;
        process.stdout.write(`${passed ? "ok" : "FAIL".padEnd(5)} ${String(name).padEnd(14)} ${String(value)}\n`);
      }
      process.exitCode = ok ? 0 : 1;
      return;
    }

    case "run":
      await runSupervisor({ foreground: args.includes("--foreground") });
      return;

    case "wait":
      // Internal helper, mostly useful for service wrappers that prefer to
      // wait for the web socket instead of a detached start.
      await waitForRunning();
      return;

    default:
      fail(`unknown command ${JSON.stringify(command)}; run 'dsh-boot --help'`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
