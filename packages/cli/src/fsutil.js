import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootDir, paths } from "./paths.js";

/** Create the dsh-boot user state directory (0700 on POSIX). */
export function ensureBootDir() {
  const dir = bootDir();
  mkdirSync(paths.logsDir, { recursive: true });
  try {
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  } catch {
    // Best effort; the directory is inside the user profile.
  }
  ensureStartupArgsTemplate();
}

const STARTUP_ARGS_TEMPLATE = `# dsh-boot startup arguments.
#
# One argument per line. Blank lines are ignored. Use single or double quotes
# around an argument that contains spaces, and backslash to escape a character.
#
# These arguments are passed to "dsh --profile web" for every launch path:
#   - boot-time autostart
#   - Start Menu / launchpad icon
#   - the restart button in Settings -> General
#
# Examples:
#   --host 127.0.0.1
#   --port 3080
#   --trusted-host app.internal
`;

/** Create a commented startup.args template only when the file does not exist. */
export function ensureStartupArgsTemplate() {
  if (!existsSync(paths.startupArgsFile)) {
    writeFileSync(paths.startupArgsFile, STARTUP_ARGS_TEMPLATE, { encoding: "utf8", mode: 0o600 });
  }
}

export function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

export function writeTextAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

/**
 * Advisory lock so concurrent `dsh-boot start` calls (desktop icon + autostart
 * racing at login) spawn exactly one supervisor. The lock is not security
 * machinery: it only serializes launcher starts.
 */
export function acquireStartLock(timeoutMs = 30_000) {
  mkdirSync(join(bootDir()), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd;
    try {
      fd = openSync(paths.startLockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        try {
          rmSync(paths.startLockFile, { force: true });
        } catch {
          // Already removed or owned by another process.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        // Last-resort stale-lock recovery: never keep the launcher dead forever.
        const lock = readJson(paths.startLockFile);
        if (lock?.pid === void 0 || !isPidAlive(lock.pid)) {
          rmSync(paths.startLockFile, { force: true });
          continue;
        }
        throw new Error("dsh-boot: another launcher is already starting the service");
      }
      sleepSync(150);
    }
  }
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
