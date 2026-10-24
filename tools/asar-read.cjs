
const fs = require("fs");
const archive = process.argv[2];
const target = process.argv[3] || "";
const buf = fs.readFileSync(archive);
const headerPickleSize = buf.readUInt32LE(4);
const headerBuf = buf.subarray(8, 8 + headerPickleSize);
const strLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.subarray(8, 8 + strLen).toString("utf8"));
const dataBase = 8 + headerPickleSize;
function getNode(p) {
  let n = header;
  for (const part of p.split("/").filter(Boolean)) {
    if (!n.files) return undefined;
    n = n.files[part];
    if (!n) return undefined;
  }
  return n;
}
const node = getNode(target);
if (!node) { console.log("NOT_FOUND"); process.exit(2); }
if (node.files) { console.log(JSON.stringify(Object.keys(node.files))); }
else if (node.unpacked) { console.log("UNPACKED " + node.size); }
else {
  const off = dataBase + parseInt(node.offset, 10);
  process.stdout.write(buf.subarray(off, off + node.size).toString("utf8"));
}
