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

const icoOut = join(repoRoot, "packaging", "windows", "dsh-boot.ico");
const icnsOut = join(repoRoot, "packaging", "macos", "dsh-boot.icns");
const pngOut = join(repoRoot, "packaging", "linux", "dsh-boot.png");
const svgOut = join(repoRoot, "packaging", "linux", "dsh-boot.svg");

const sharp = require(sharpPath);

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** ICNS PNG chunk types for each pixel size (macOS 10.7+ accepts PNG payloads). */
const ICNS_TYPES = [
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"],
];

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

function icnsFromPngs(images) {
  const chunks = [];
  let total = 8;
  for (const { type, png } of images) {
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, "ascii");
    chunk.writeUInt32BE(8 + png.length, 4);
    png.copy(chunk, 8);
    chunks.push(chunk);
    total += chunk.length;
  }

  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

/** Recreate the official favicon (DeepSeek Harness) with a BOOT badge bottom-right. */
async function renderComposedIcon(size) {
  const favicon = await sharp(await readFileSync(faviconPath))
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const badge = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${Math.round(size * 0.58)}" y="${Math.round(size * 0.68)}" width="${Math.round(size * 0.39)}" height="${Math.round(size * 0.29)}" rx="${Math.round(size * 0.07)}" fill="#1f6feb"/>
  <rect x="${Math.round(size * 0.58)}" y="${Math.round(size * 0.68)}" width="${Math.round(size * 0.39)}" height="${Math.round(size * 0.29)}" rx="${Math.round(size * 0.07)}" fill="none" stroke="#ffffff" stroke-width="${Math.max(2, Math.round(size * 0.016))}"/>
  <text x="${Math.round(size * 0.775)}" y="${Math.round(size * 0.88)}" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(size * 0.133)}" font-weight="700" fill="#ffffff" text-anchor="middle">Boot</text>
</svg>`);

  return sharp(favicon)
    .composite([{ input: badge, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

async function main() {
  // Windows .ico — multi-size PNG-compressed ICO.
  const icoImages = [];
  for (const size of ICO_SIZES) {
    const png = await renderComposedIcon(size);
    icoImages.push({ size, png });
  }
  mkdirSync(dirname(icoOut), { recursive: true });
  writeFileSync(icoOut, icoFromPngs(icoImages));
  console.log(`dsh-boot: wrote ${icoOut}`);

  // macOS .icns — PNG payloads in the standard ICNS container.
  const icnsImages = [];
  for (const [size, type] of ICNS_TYPES) {
    const png = await renderComposedIcon(size);
    icnsImages.push({ type, png });
  }
  mkdirSync(dirname(icnsOut), { recursive: true });
  writeFileSync(icnsOut, icnsFromPngs(icnsImages));
  console.log(`dsh-boot: wrote ${icnsOut}`);

  // Linux — plain PNG (and a copy of the source SVG for distro theming).
  const png = await renderComposedIcon(512);
  mkdirSync(dirname(pngOut), { recursive: true });
  writeFileSync(pngOut, png);
  console.log(`dsh-boot: wrote ${pngOut}`);
  mkdirSync(dirname(svgOut), { recursive: true });
  writeFileSync(svgOut, await readFileSync(faviconPath));
  console.log(`dsh-boot: wrote ${svgOut}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
