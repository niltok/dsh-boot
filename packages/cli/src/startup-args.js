import { readFileSync } from "node:fs";
import { paths } from "./paths.js";

/**
 * Parse the startup.args file.
 *
 * The format is intentionally tiny: one argv token per line, `#` starts a
 * whole-line comment, and single/double quotes plus backslash escaping are
 * supported. Inline comments are NOT stripped, so `--url http://x/#y` keeps
 * its `#` when it is not the first non-whitespace character of a line.
 *
 * @param {string} content file content
 * @param {string} file path used in diagnostics
 * @returns {string[]} argv tokens
 */
export function parseStartupArgs(content, file = "<startup.args>") {
  const args = [];
  let token = "";
  let quote;
  let escaping = false;
  let lineStart = true;
  let comment = false;

  const push = () => {
    if (token.length > 0) {
      args.push(token);
      token = "";
    }
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (comment) {
      if (char === "\n" || char === "\r") {
        comment = false;
        lineStart = true;
      }
      continue;
    }

    if (escaping) {
      token += char;
      escaping = false;
      lineStart = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      lineStart = false;
      continue;
    }

    if (quote !== void 0) {
      if (char === quote) {
        quote = void 0;
        lineStart = false;
      } else {
        token += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      lineStart = false;
      continue;
    }

    if (char === "#" && lineStart) {
      comment = true;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      push();
      if (char === "\n" || char === "\r") lineStart = true;
      continue;
    }

    token += char;
    lineStart = false;
  }

  push();

  if (quote !== void 0) {
    throw new Error(`dsh-boot: unterminated ${quote} quote in ${file}`);
  }
  return args;
}

/**
 * Reject launcher-owned flags in the user's startup arguments. The file
 * controls the web app's flags only; a launcher flag there would silently
 * override dsh-boot's own `--profile web --patch <overlay>` composition.
 */
export function validateStartupArgs(args, file = paths.startupArgsFile) {
  const forbidden = new Set(["--profile", "--patch", "--dump-config", "--dump-default-config", "-V", "--version"]);
  const first = args[0];
  if (first === "web" || first === "plugin") {
    throw new Error(`dsh-boot: ${file}: startup arguments must be dsh web flags, not the "${first}" subcommand`);
  }
  const found = args.find((argument) => forbidden.has(argument));
  if (found !== void 0) {
    throw new Error(`dsh-boot: ${file}: launcher-owned flag ${JSON.stringify(found)} is not allowed here; use "dsh ${found}" manually if needed`);
  }
  return args;
}

/**
 * Read the effective startup arguments. Every launch path (autostart, icon,
 * web-UI restart) calls this function at spawn time, so edits to the file
 * take effect on the next process start.
 */
export function readStartupArgs() {
  let content;
  try {
    content = readFileSync(paths.startupArgsFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`dsh-boot: failed to read ${paths.startupArgsFile}: ${error.message}`);
  }
  return validateStartupArgs(parseStartupArgs(content, paths.startupArgsFile));
}
