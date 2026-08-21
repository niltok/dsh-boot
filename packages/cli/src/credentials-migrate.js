// dsh 0.1.0-rc.6 tightened the credentials document: the root must be a flat
// mapping of credential ref -> string value. Older documents carried a
// `version: 1` line plus a `refs:` wrapper; rc.6 rejects them at boot with
// "the value for ... must be a string" and dsh itself ships no migration.
// dsh-boot lifts the refs block once (keeping a .bak of the original) right
// before spawning dsh, so an upgrade never strands the user's credentials.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function credentialsFilePath() {
  return join(homedir(), ".dsh", ".credentials.yaml");
}

export function migrateLegacyCredentialsFile() {
  const file = credentialsFilePath();
  if (!existsSync(file)) return false;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  // An encrypted or otherwise binary store must never be rewritten.
  if (text.includes("\0")) return false;
  const lines = text.split(/\r?\n/);
  if (!lines.some((line) => /^refs:\s*$/.test(line))) return false; // already flat
  const out = [];
  let lifted = 0;
  for (const line of lines) {
    if (/^version:\s*/.test(line) || /^refs:\s*$/.test(line)) continue;
    const indented = /^\s+(\S.*)$/.exec(line);
    if (indented) {
      out.push(indented[1]); // dedent the refs block
      lifted += 1;
    } else {
      out.push(line);
    }
  }
  if (lifted === 0) return false;
  try {
    copyFileSync(file, `${file}.bak`);
    writeFileSync(file, `${out.join("\n").replace(/\n+$/, "")}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
