import fs from "node:fs";
import zlib from "node:zlib";
const file = process.argv[2];
const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd]);
const offs = []; let i = 0;
while (true) { const k = buf.indexOf(MAGIC, i); if (k < 0) break; offs.push(k); i = k + 4; }
let text = "";
for (let n = 0; n < offs.length; n++) {
  const s = offs[n], e = n + 1 < offs.length ? offs[n+1] : buf.length;
  try { text += zlib.zstdDecompressSync(buf.subarray(s,e)).toString("utf8") + "\n"; } catch {}
}
const lines = text.split("\n").filter(Boolean);
const types = {};
for (const l of lines) { try { const o = JSON.parse(l); types[o.type] = (types[o.type]||0)+1; } catch {} }
console.log("记录类型:", JSON.stringify(types, null, 0));
console.log("--- 前 6 条 ---");
for (const l of lines.slice(0, 6)) console.log(l.slice(0, 220));