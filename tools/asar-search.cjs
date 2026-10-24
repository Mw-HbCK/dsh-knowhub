const fs = require("fs");
const archive = process.argv[2];
const needles = process.argv.slice(3).map(s => Buffer.from(s, "utf8"));
const buf = fs.readFileSync(archive);
const headerPickleSize = buf.readUInt32LE(4);
const headerBuf = buf.subarray(8, 8 + headerPickleSize);
const strLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.subarray(8, 8 + strLen).toString("utf8"));
const base = 8 + headerPickleSize;
const entries = [];
function walk(node, rel) {
  if (node.files) { for (const [k, v] of Object.entries(node.files)) walk(v, rel + "/" + k); return; }
  if (node.unpacked) return;
  const start = base + parseInt(node.offset, 10);
  entries.push({ path: rel, start, end: start + node.size });
}
walk(header, "");
const byExt = entries.filter(e => /\.(js|mjs|cjs|json|html)$/.test(e.path));
console.error("entries " + entries.length + " js-like " + byExt.length);
const out = [];
for (const e of byExt) {
  if (e.end - e.start > 12_000_000) continue;
  const slice = buf.subarray(e.start, e.end);
  for (let i = 0; i < needles.length; i++) {
    const idx = slice.indexOf(needles[i]);
    if (idx >= 0) out.push(needles[i].toString("utf8") + "\t" + e.path);
  }
}
console.log(out.join("\n"));
