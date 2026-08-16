import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formulaPath = join(repoRoot, "Formula", "dsh-boot.rb");
const owner = process.argv[2];
const version = process.argv[3] ?? JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

if (owner === void 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(owner)) {
  console.error("usage: node scripts/update-brew-formula.mjs <github-owner/repo> [version]");
  process.exit(1);
}

async function sha256Of(url, filename) {
  const local = join(repoRoot, "dist", filename);
  if (existsSync(local)) {
    process.stderr.write(`using local ${local}\n`);
    return createHash("sha256").update(readFileSync(local)).digest("hex");
  }
  process.stderr.write(`fetching ${url}\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

const armFile = `dsh-boot-${version}-darwin-arm64.tar.gz`;
const x64File = `dsh-boot-${version}-darwin-x64.tar.gz`;
const armUrl = `https://github.com/${owner}/releases/download/v${version}/${armFile}`;
const x64Url = `https://github.com/${owner}/releases/download/v${version}/${x64File}`;
const [armSha, x64Sha] = await Promise.all([sha256Of(armUrl, armFile), sha256Of(x64Url, x64File)]);

let formula = readFileSync(formulaPath, "utf8");
formula = formula.replaceAll("YOUR_GITHUB_OWNER", owner);
formula = formula.replace(/version "[\d.]+"/, `version "${version}"`);
formula = formula.replace("REPLACE_WITH_ARM64_SHA256", armSha);
formula = formula.replace("REPLACE_WITH_X64_SHA256", x64Sha);
writeFileSync(formulaPath, formula);

console.log(`dsh-boot: updated ${formulaPath} for ${owner} v${version}`);
