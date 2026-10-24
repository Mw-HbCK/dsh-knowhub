
const fs = require("fs");
const path = require("path");
const archive = process.argv[2];
const outDir = process.argv[3];
const pkgList = fs.readFileSync(process.argv[4], "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const buf = fs.readFileSync(archive);
const headerPickleSize = buf.readUInt32LE(4);
const headerBuf = buf.subarray(8, 8 + headerPickleSize);
const strLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.subarray(8, 8 + strLen).toString("utf8"));
const base = 8 + headerPickleSize;
let written = 0, bytes = 0, missing = [];
const wantFile = (rel) => {
  if (/\/package\.json$/.test(rel)) return true;
  if (/\/README[^/]*\.md$/.test(rel)) return true;
  if (/\/dsh\.plugin\.json$/.test(rel)) return true;
  if (/\/cordis\.patch\.yml$/.test(rel)) return true;
  if (/\/lib\/types\/[^/]+\.d\.ts$/.test(rel)) return true;
  if (/\/lib\/[^/]+\.js$/.test(rel)) return true;
  return false;
};
function walk(node, rel) {
  if (node.files) { for (const [k, v] of Object.entries(node.files)) walk(v, rel + "/" + k); return; }
  if (node.unpacked) return;
  if (!wantFile(rel)) return;
  const off = base + parseInt(node.offset, 10);
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf.subarray(off, off + node.size));
  written++; bytes += node.size;
}
const pkgsNode = header.files.dsh.files.node_modules.files["@deepseek-ai"].files;
for (const pkg of pkgList) {
  const node = pkgsNode[pkg];
  if (!node) { missing.push(pkg); continue; }
  walk(node, pkg);
}
console.log(JSON.stringify({ written, bytes, missing, outDir }));
