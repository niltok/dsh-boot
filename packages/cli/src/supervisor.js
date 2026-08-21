import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { acquireStartLock, ensureBootDir, isPidAlive, readJson, writeJsonAtomic } from "./fsutil.js";
import { migrateLegacyCredentialsFile } from "./credentials-migrate.js";
import { readStartupArgs } from "./startup-args.js";
import { paths } from "./paths.js";
import { writeInjectedPatch } from "./patch.js";

const DEFAULT_WEB_URL = "http://127.0.0.1:3080";
const START_TIMEOUT_MS = 90_000;
const RESTART_TIMEOUT_MS = 90_000;
const CONTROL_ACK_GRACE_MS = 500;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let currentChild;
let currentState;
let controlServer;
let restarting;
let stopping = false;
let unexpectedExitTimer;
let logger = createDefaultLogger();

function createDefaultLogger() {
  return {
    write(line) {
      process.stdout.write(`${line}\n`);
    },
    close() {},
  };
}

function createFileLogger() {
  const stream = createWriteStream(paths.bootLog, { flags: "a" });
  return {
    write(line) {
      const text = `${new Date().toISOString()} ${line}\n`;
      if (process.stderr.isTTY) process.stderr.write(text);
      stream.write(text);
    },
    close() {
      stream.end();
    },
  };
}

function log(line) {
  try {
    logger.write(line);
  } catch {
    // Logging must never take the supervisor down.
  }
}

function rotateLogs() {
  for (const file of [paths.bootLog, paths.dshLog]) {
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      // Rotation is best effort.
    }
  }
}

export function defaultWebUrl(args = []) {
  let host = "127.0.0.1";
  let port = 3080;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--host" && args[index + 1] !== void 0) host = args[index + 1];
    if (args[index] === "--port" && args[index + 1] !== void 0) {
      port = Number(args[index + 1]);
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) port = 3080;
  return `http://${host}:${String(port)}`;
}

export function readState() {
  return readJson(paths.stateFile);
}

export function writeState(patch) {
  currentState = { ...currentState, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(paths.stateFile, currentState);
  return currentState;
}

export async function fetchHealth(state = readState(), timeoutMs = 1500) {
  if (state?.controlPort === void 0 || !isPidAlive(state.pid)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.controlPort)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

export async function fetchWeb(url = currentState?.webUrl, timeoutMs = 2500) {
  if (url === void 0) return false;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchBootId(url, expectedBootId, timeoutMs = 2500) {
  if (url === void 0 || expectedBootId === void 0) return false;
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/dsh-boot/presence`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.bootId === expectedBootId;
  } catch {
    return false;
  }
}

async function requestControl(pathname, { timeoutMs = 5_000 } = {}) {
  const state = readState();
  if (state?.controlPort === void 0 || state?.token === void 0) {
    throw new Error("dsh-boot: service is not running");
  }
  const response = await fetch(`http://127.0.0.1:${String(state.controlPort)}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dsh-boot-token": String(state.token),
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON diagnostics are fine.
  }
  if (!response.ok) {
    throw new Error(body?.error ?? `dsh-boot: control request failed (HTTP ${response.status})`);
  }
  return body;
}

export async function waitForRunning(timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    const state = readState();
    if (state === void 0) {
      lastError = new Error("dsh-boot: supervisor has not written its state file yet");
    } else if (!isPidAlive(state.pid)) {
      throw new Error(`dsh-boot: supervisor process ${String(state.pid)} is not running`);
    } else if (state.phase === "failed") {
      throw new Error(state.lastError ?? "dsh-boot: dsh failed to start");
    } else if (state.phase === "running" && state.webUrl !== void 0) {
      const ready =
        state.bootId === void 0
          ? await fetchWeb(state.webUrl)
          : await fetchBootId(state.webUrl, state.bootId);
      if (ready) return state;
      lastError = new Error(`dsh-boot: dsh is bound but ${state.webUrl} is not answering yet`);
    } else {
      lastError = new Error(`dsh-boot: dsh is ${state.phase ?? "starting"}`);
    }

    if (Date.now() > deadline) {
      throw new Error(
        `dsh-boot: timed out waiting for dsh to start${lastError === void 0 ? "" : ` (${lastError.message})`}`,
      );
    }
    await delay(500);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnDetachedSupervisor() {
  ensureBootDir();
  // detached must be true on Windows as well: with detached:false the
  // supervisor inherits the launcher's console, so it is killed as soon as
  // the Start Menu shortcut's PowerShell window closes. windowsHide keeps
  // the detached process from flashing a new console window.
  const child = spawn(paths.nodeBin, [paths.cliEntry, "run"], {
    cwd: homedir(),
    env: { ...process.env, DSH_BOOT_SUPERVISOR: "1" },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

export async function ensureRunning({ openBrowser = false, timeoutMs = START_TIMEOUT_MS } = {}) {
  ensureBootDir();
  rotateLogs();

  let state = readState();
  if (state !== void 0 && isPidAlive(state.pid) && (await fetchHealth(state, 750))) {
    if (state.phase === "starting" || state.phase === "restarting") {
      process.stderr.write(`dsh-boot: dsh is ${state.phase}; waiting for it to become ready\n`);
      state = await waitForRunning(timeoutMs);
    } else if (state.phase === "failed" || state.phase === "stopped") {
      process.stderr.write(`dsh-boot: supervisor is up but dsh is ${state.phase}; requesting start\n`);
      await requestControl("/restart");
      state = await waitForRunning(timeoutMs);
    } else if (state.phase !== "running") {
      state = await waitForRunning(timeoutMs);
    } else if (!(await fetchWeb(state.webUrl))) {
      process.stderr.write("dsh-boot: supervisor is up but the web UI is not answering; requesting restart\n");
      await requestControl("/restart");
      state = await waitForRunning(timeoutMs);
    } else {
      process.stderr.write(`dsh-boot: dsh is already running at ${state.webUrl}\n`);
    }
  } else {
    const release = acquireStartLock(20_000);
    try {
      state = readState();
      if (!(state !== void 0 && isPidAlive(state.pid) && (await fetchHealth(state, 750)))) {
        const supervisorPid = spawnDetachedSupervisor();
        if (supervisorPid === void 0) throw new Error("dsh-boot: failed to spawn supervisor");
        process.stderr.write(`dsh-boot: started supervisor (pid ${String(supervisorPid)})\n`);

        // Hold the lock only until the new supervisor has claimed the state
        // file. A concurrent launcher then sees a live pid and waits instead
        // of spawning a duplicate supervisor.
        const claimedAt = Date.now() + 10_000;
        for (;;) {
          state = readState();
          if (state?.pid === supervisorPid) break;
          if (Date.now() > claimedAt) throw new Error("dsh-boot: timed out waiting for the supervisor to claim its state file");
          await delay(100);
        }
      }
    } finally {
      release();
    }
    // Wait outside the lock: a slow first boot must not make a second
    // launcher invocation (icon + autostart racing at login) fail.
    state = await waitForRunning(timeoutMs);
  }

  if (openBrowser && state?.webUrl !== void 0) await openBrowser(state.webUrl);
  return state;
}

export async function stopService() {
  const state = readState();
  if (state === void 0 || !isPidAlive(state.pid) || !(await fetchHealth(state, 750))) {
    process.stderr.write("dsh-boot: service is not running\n");
    return false;
  }
  await requestControl("/shutdown", { timeoutMs: 20_000 });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const latest = readState();
    if (latest?.phase === "stopped" || !isPidAlive(latest?.pid)) return true;
    if (Date.now() > deadline) throw new Error("dsh-boot: timed out waiting for the supervisor to stop");
    await delay(250);
  }
}

export async function restartService() {
  ensureBootDir();
  const state = readState();
  if (state === void 0 || !isPidAlive(state.pid) || !(await fetchHealth(state, 750))) {
    process.stderr.write("dsh-boot: service is not running; starting it\n");
    await ensureRunning({});
    return;
  }
  await requestControl("/restart", { timeoutMs: 5_000 });
  process.stderr.write("dsh-boot: restart requested\n");
  await waitForRunning(RESTART_TIMEOUT_MS);
}

export function printStatus(state, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(state ?? null, null, 2)}\n`);
    return;
  }
  if (state === void 0) {
    process.stdout.write("dsh-boot: not installed/running (no state file)\n");
    return;
  }
  const fields = [
    ["phase", state.phase],
    ["web", state.webUrl ?? "-"],
    ["supervisor pid", state.pid ?? "-"],
    ["dsh pid", state.childPid ?? "-"],
    ["control port", state.controlPort ?? "-"],
    ["boot id", state.bootId ?? "-"],
    ["log", paths.dshLog],
  ];
  for (const [name, value] of fields) process.stdout.write(`${name.padEnd(15)} ${String(value)}\n`);
}

export async function openBrowser(url) {
  const commands = openCommands(url);
  let lastError;
  for (const command of commands) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(command.file, command.args, { stdio: "ignore", windowsHide: true, detached: true });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("dsh-boot: no browser opener is available");
}

function openCommands(url) {
  if (process.platform === "win32") {
    return [{ file: "cmd.exe", args: ["/c", "start", "", `"${url}"`] }];
  }
  if (process.platform === "darwin") return [{ file: "open", args: [url] }];
  return [
    { file: "xdg-open", args: [url] },
    { file: "gio", args: ["open", url] },
    { file: "sensible-browser", args: [url] },
  ];
}

function spawnDshChild() {
  const bootId = randomUUID();
  if (migrateLegacyCredentialsFile()) {
    log("dsh-boot: migrated legacy ~/.dsh/.credentials.yaml (version/refs) to the flat format required by dsh; original kept at .credentials.yaml.bak");
  }
  const patchFile = writeInjectedPatch();
  const startupArgs = readStartupArgs();
  const token = currentState?.token ?? randomBytes(32).toString("hex");
  const controlPort = currentState?.controlPort;

  const env = {
    ...process.env,
    PATH: [paths.binDir, join(paths.installRoot, "node_modules", ".bin"), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    DSH_BOOT_CONTROL_PORT: controlPort === void 0 ? "" : String(controlPort),
    DSH_BOOT_CONTROL_TOKEN: token,
    DSH_BOOT_START_ID: bootId,
  };

  log(`starting dsh: ${paths.dshCli} --profile web --patch ${patchFile} ${startupArgs.map(quoteForLog).join(" ")}`);

  const child = spawn(paths.nodeBin, [paths.dshCli, "--profile", "web", "--patch", patchFile, ...startupArgs], {
    cwd: homedir(),
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  currentChild = child;
  writeState({ childPid: child.pid ?? void 0, bootId, phase: "starting", webUrl: currentState?.webUrl, lastError: void 0 });

  const logStream = createWriteStream(paths.dshLog, { flags: "a" });
  let parsedUrl;

  const consume = (chunk, label) => {
    const text = chunk.toString("utf8");
    logStream.write(`[${label}] ${text}`);
    if (!text.endsWith("\n")) logStream.write("\n");
    for (const line of text.split(/\r?\n/)) {
      const match = /dsh web:\s+(https?:\/\/\S+)/.exec(line);
      if (match?.[1] !== void 0 && parsedUrl === void 0) {
        parsedUrl = match[1];
        writeState({ webUrl: parsedUrl });
      }
    }
  };

  child.stdout.on("data", (chunk) => consume(chunk, "out"));
  child.stderr.on("data", (chunk) => consume(chunk, "err"));

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error !== void 0) reject(error);
      else resolve({ child, bootId, startupArgs });
    };

    child.once("error", (error) => {
      writeState({ phase: "failed", lastError: error.message });
      finish(error);
    });

    child.once("exit", (code, signal) => {
      logStream.end();
      if (currentChild === child) currentChild = void 0;
      const reason = signal === void 0 ? `exit code ${String(code ?? 0)}` : `signal ${signal}`;
      const intentional = restarting || stopping;
      if (!settled) {
        // This promise owns readiness for THIS child. If the child exits
        // before it is ready, the restart/start must fail instead of polling
        // for the full timeout. Intentional stops of a child whose promise is
        // already settled fall through untouched.
        if (!intentional) {
          writeState({ phase: code === 0 && signal === void 0 ? "stopped" : "failed", childPid: void 0, lastError: signal === void 0 ? void 0 : `dsh exited with ${signal}` });
          log(`dsh exited unexpectedly: ${reason}`);
        }
        finish(new Error(`dsh-boot: dsh process exited before ready (${reason})`));
      } else if (!intentional) {
        writeState({ phase: code === 0 && signal === void 0 ? "stopped" : "failed", childPid: void 0, lastError: signal === void 0 ? void 0 : `dsh exited with ${signal}` });
        log(`dsh exited unexpectedly: ${reason}; supervisor is shutting down`);
        clearTimeout(unexpectedExitTimer);
        unexpectedExitTimer = setTimeout(() => {
          void gracefulSupervisorExit(code === 0 && signal === void 0 ? 0 : 1);
        }, 50);
      }
    });

    const started = Date.now();
    const poll = async () => {
      for (;;) {
        if (settled) return;
        const url = parsedUrl ?? defaultWebUrl(startupArgs);
        if (parsedUrl !== void 0 && (await fetchWeb(url, 2500)) && (await fetchBootId(url, bootId, 2500))) {
          writeState({ phase: "running", webUrl: url, lastError: void 0 });
          log(`dsh is ready at ${url}`);
          finish();
          return;
        }
        if (Date.now() - started > START_TIMEOUT_MS) {
          // A child that never announced readiness must not linger behind a
          // failed state entry.
          try {
            if (process.platform === "win32") child.kill();
            else if (child.pid !== void 0) process.kill(-child.pid, "SIGTERM");
          } catch {
            // The child may already be gone.
          }
          const error = new Error(`dsh-boot: dsh did not become ready within ${String(START_TIMEOUT_MS / 1000)}s`);
          writeState({ phase: "failed", lastError: error.message });
          finish(error);
          return;
        }
        await delay(500);
      }
    };
    void poll();
  });
}

function quoteForLog(argument) {
  return /\s/.test(argument) ? JSON.stringify(argument) : argument;
}

export async function stopDshChild({ timeoutMs = 15_000 } = {}) {
  const child = currentChild;
  const pid = currentState?.childPid;
  if (child === void 0 && pid === void 0) {
    currentChild = void 0;
    writeState({ childPid: void 0 });
    return;
  }

  let exitTimer;
  const exitPromise =
    child === void 0 || child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
          exitTimer = setTimeout(resolve, timeoutMs);
          child.once("exit", () => {
            clearTimeout(exitTimer);
            resolve();
          });
        });

  if (process.platform === "win32") {
    try {
      child?.kill();
    } catch {
      // Already gone.
    }
    const killer = setTimeout(() => {
      if (pid !== void 0 && isPidAlive(pid)) {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      }
    }, 2500);
    killer.unref();
  } else if (pid !== void 0) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    const killer = setTimeout(() => {
      if (pid !== void 0 && isPidAlive(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    }, 8000);
    killer.unref();
  }

  await Promise.race([exitPromise, delay(timeoutMs)]);
  clearTimeout(exitTimer);
  currentChild = void 0;
  writeState({ childPid: void 0, phase: stopping ? "stopping" : "stopped" });
}

async function performRestart() {
  if (restarting !== void 0) return restarting;
  restarting = (async () => {
    clearTimeout(unexpectedExitTimer);
    writeState({ phase: "restarting", lastError: void 0 });
    log("restart requested from the web UI");
    try {
      // Give the dsh process time to relay the 202 response back to the
      // browser before it is stopped. Killing it immediately makes the UI
      // report "restart request failed" even though the restart succeeds.
      await delay(CONTROL_ACK_GRACE_MS);
      await stopDshChild({ timeoutMs: 15_000 });
      await spawnDshChild();
      writeState({ phase: "running", lastError: void 0 });
      log("restart complete");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeState({ phase: "failed", lastError: message, childPid: void 0 });
      log(`restart failed: ${message}`);
      throw error;
    }
  })();
  try {
    await restarting;
  } finally {
    restarting = void 0;
  }
}

async function performShutdown() {
  if (stopping) return;
  clearTimeout(unexpectedExitTimer);
  stopping = true;
  writeState({ phase: "stopping" });
  log("shutdown requested");
  try {
    // Give dsh time to relay the 202 response back to the browser before it
    // is stopped; otherwise the web UI reports a shutdown failure even though
    // the service is stopping successfully.
    await delay(CONTROL_ACK_GRACE_MS);
    await stopDshChild({ timeoutMs: 15_000 });
  } catch (error) {
    log(`stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeState({ phase: "stopped", childPid: void 0 });
  logger.write("dsh-boot: stopped");
  logger.close();
  if (controlServer !== void 0) controlServer.close();
  setTimeout(() => process.exit(0), 100);
}

function controlHandler(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const state = currentState;

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      name: "dsh-boot",
      version: paths.version,
      pid: process.pid,
      phase: state?.phase,
      childPid: state?.childPid ?? null,
      bootId: state?.bootId ?? null,
      webUrl: state?.webUrl ?? null,
    });
    return;
  }

  const authorized =
    req.headers["x-dsh-boot-token"] === currentState?.token ||
    req.headers.authorization === `Bearer ${currentState?.token ?? ""}`;

  if (!authorized) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/state") {
    sendJson(res, 200, { ...currentState, token: void 0 });
    return;
  }

  if (req.method === "POST" && url.pathname === "/restart") {
    if (restarting !== void 0) {
      sendJson(res, 409, { ok: false, error: "restart already in progress" });
      return;
    }
    sendJson(res, 202, { ok: true, status: "restarting" });
    void performRestart().catch(() => {});
    return;
  }

  if (req.method === "POST" && url.pathname === "/shutdown") {
    sendJson(res, 202, { ok: true, status: "stopping" });
    void performShutdown();
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function startControlServer() {
  controlServer = createServer(controlHandler);
  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(0, "127.0.0.1", () => {
      controlServer.off("error", reject);
      resolve();
    });
  });
  return controlServer.address().port;
}

async function gracefulSupervisorExit(code) {
  if (stopping) return;
  clearTimeout(unexpectedExitTimer);
  stopping = true;
  writeState({ phase: "stopping" });
  await stopDshChild({ timeoutMs: 10_000 }).catch(() => {});
  writeState({ phase: "stopped", childPid: void 0 });
  logger.write(`dsh-boot: supervisor exiting (${String(code)})`);
  logger.close();
  if (controlServer !== void 0) controlServer.close();
  setTimeout(() => process.exit(code), 100);
}

/** Internal foreground supervisor. Kept alive by the control server + child. */
export async function runSupervisor({ foreground = false } = {}) {
  ensureBootDir();
  rotateLogs();
  logger = foreground ? createDefaultLogger() : createFileLogger();

  const existing = readState();
  if (existing !== void 0 && existing.pid !== process.pid && isPidAlive(existing.pid) && (await fetchHealth(existing, 750))) {
    log(`another supervisor is already running (pid ${String(existing.pid)})`);
    logger.close();
    return;
  }

  const port = await startControlServer();
  currentState = {
    version: 1,
    name: "dsh-boot",
    cliVersion: paths.version,
    installRoot: paths.installRoot,
    pid: process.pid,
    childPid: void 0,
    controlPort: port,
    token: randomBytes(32).toString("hex"),
    phase: "starting",
    bootId: void 0,
    webUrl: void 0,
    lastError: void 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeState({});

  const onSignal = (signal) => {
    log(`received ${signal}`);
    void gracefulSupervisorExit(signal === "SIGINT" ? 130 : 0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  log(`supervisor pid ${process.pid}, control port ${String(port)}`);
  try {
    await spawnDshChild();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeState({ phase: "failed", lastError: message, childPid: void 0 });
    log(message);
    // Keep the control server alive briefly so a desktop launch can report
    // the failure and the state file retains the diagnostic.
    logger.write(`dsh-boot: startup failed: ${message}`);
    await delay(100);
    await gracefulSupervisorExit(1);
  }
}
