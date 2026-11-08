import fs from "node:fs";
import zlib from "node:zlib";
const file = process.argv[2];
const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd]);
const offs = [];
let i = 0;
while (true) { const k = buf.indexOf(MAGIC, i); if (k < 0) break; offs.push(k); i = k + 4; }
let text = "";
for (let n = 0; n < offs.length; n++) {
  const start = offs[n];
  const end = n + 1 < offs.length ? offs[n + 1] : buf.length;
  try { text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8") + "\n"; } catch (e) { /* skip bad frame */ }
}
const lines = text.split("\n").filter(Boolean);
console.log("frames:", offs.length, "lines:", lines.length, "KB:", Math.round(text.length/1024));
const c = (re) => lines.filter(l => re.test(l)).length;
console.log("agentPreset std:", c(/"agentPreset"\s*:\s*"standard"/), "numen preset:", c(/"agentPreset"\s*:\s*"numen"/));
console.log("mcp__numen__lua:", c(/mcp__numen__lua/), "| any numen tool:", c(/mcp__numen__/), "| tree:", c(/mcp__tree__/));
const lastUser = lines.filter(l => /"role"\s*:\s*"user"/).slice(-1)[0] || "";
console.log("最后一条 user:", lastUser.slice(0, 400));