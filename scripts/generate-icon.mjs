import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sharpPath =
  process.env.DSH_BOOT_SHARP ??
  join(repoRoot, "dist", "runtime-win32-x64", "node_modules", "sharp");
const faviconPath =
  process.env.DSH_BOOT_FAVICON ??
  join(
    repoRoot,
    "dist",
    "runtime-win32-x64",
    "node_modules",
    "@deepseek-ai",
    "dsh-web-frontend",
    "dist",
    "favicon.svg",
  );
const outFile = join(repoRoot, "packaging", "windows", "dsh-boot.ico");

const sharp = require(sharpPath);

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function icoFromPngs(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function main() {
  const favicon = await sharp(await readFileSync(faviconPath))
    .resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const badge = Buffer.from(`<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <rect x="148" y="174" width="100" height="74" rx="18" fill="#1f6feb"/>
  <rect x="148" y="174" width="100" height="74" rx="18" fill="none" stroke="#ffffff" stroke-width="4"/>
  <text x="198" y="225" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">Boot</text>
</svg>`);

  const composed = await sharp(favicon)
    .composite([{ input: badge, top: 0, left: 0 }])
    .png()
    .toBuffer();

  const images = [];
  for (const size of SIZES) {
    const png = await sharp(composed)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    images.push({ size, png });
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, icoFromPngs(images));
  console.log(`dsh-boot: wrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
