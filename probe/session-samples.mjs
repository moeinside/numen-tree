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
const recs = text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const pick = (t) => recs.filter(r => r.type === t);
for (const t of ["session/title","user/message","tool/call"]) {
  const arr = pick(t);
  console.log(`--- ${t} x${arr.length} ---`);
  for (const r of arr.slice(0, 2)) console.log(JSON.stringify(r).slice(0, 400));
}