import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [runtimeArg, outputArg] = process.argv.slice(2);
if (!runtimeArg || !outputArg) {
  console.error("usage: node scripts/generate-wix-components.mjs <runtime-dir> <output.wxs>");
  process.exit(1);
}

const runtimeDir = resolve(runtimeArg);
const output = resolve(outputArg);

function hashOf(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/** Deterministic v5-style GUID so one directory = one stable component. */
function guidFor(value) {
  const digest = createHash("sha1").update(`dsh-boot:${value}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** { absolute dir, rel dir, dirId, children[], files[] } */
function collectTree() {
  const root = {
    abs: runtimeDir,
    rel: "",
    dirId: "APPLICATIONFOLDER",
    children: [],
    files: [],
  };

  const walk = (node) => {
    for (const entry of readdirSync(node.abs).sort()) {
      const abs = join(node.abs, entry);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const rel = node.rel === "" ? entry : `${node.rel}/${entry}`;
        const child = { abs, rel, dirId: `dir${hashOf(rel)}`, children: [], files: [] };
        node.children.push(child);
        walk(child);
      } else if (stat.isFile()) {
        node.files.push({ abs, rel: node.rel === "" ? entry : `${node.rel}/${entry}` });
      }
      // Symlinks and reparse points are skipped: the packaged runtime has no
      // junction/symlink that needs to be installed.
    }
  };

  walk(root);
  return root;
}

function renderDirectoryTree(node, indent = "      ") {
  const pad = `${indent}  `;
  const children = node.children
    .map((child) => {
      const inner = renderDirectoryTree(child, `${indent}  `);
      return `${indent}<Directory Id="${child.dirId}" Name="${xmlEscape(basename(child.rel))}">${child.children.length > 0 ? `\n${inner}${indent}` : ""}</Directory>`;
    })
    .join("\n");
  return children;
}

function renderComponents(nodes) {
  const lines = [];
  const visit = (node) => {
    const directory = node.rel === "" ? "APPLICATIONFOLDER" : node.dirId;
    if (node.files.length > 0) {
      const componentId = `cmp${hashOf(node.rel || "<root>")}`;
      lines.push(`      <Component Id="${componentId}" Directory="${directory}" Guid="${guidFor(node.rel || "<root>")}">`);
      for (const file of node.files) {
        const rel = file.rel.replaceAll("/", "\\");
        const fileId = `fil${hashOf(file.rel)}`;
        lines.push(`        <File Id="${fileId}" Source="$(var.SourceDir)\\${xmlEscape(rel)}" />`);
      }
      lines.push("      </Component>");
    }
    for (const child of node.children) visit(child);
  };
  visit(nodes[0]);
  return lines.join("\n");
}

const tree = collectTree();
const nodes = [tree];
const directoryTree = renderDirectoryTree(tree);
const components = renderComponents(nodes);

function countFiles(node) {
  return node.files.length + node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

const xml = `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="APPLICATIONFOLDER">${directoryTree ? `\n${directoryTree}\n    ` : ""}</DirectoryRef>
    <ComponentGroup Id="RuntimeComponents">
${components}
    </ComponentGroup>
  </Fragment>
</Wix>
`;

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, xml, "utf8");
console.log(`dsh-boot: generated ${output} (${countFiles(tree)} files)`);
