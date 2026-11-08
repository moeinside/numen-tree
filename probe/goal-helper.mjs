// 快捷下目标（PowerShell 友好：JSON 走文件，避免引号被吃）
// 用法：node probe/goal-helper.mjs <companion> <skill> <params.json>
import fs from 'node:fs';

const [companion, skill, paramsFile] = process.argv.slice(2);
if (!companion || !skill) {
  console.error('usage: node probe/goal-helper.mjs <companion> <skill> <params.json>');
  process.exit(2);
}
let params = {};
if (paramsFile) {
  try {
    params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
  } catch (e) {
    console.error('params json 读取失败：', e.message);
    process.exit(2);
  }
}
const res = await fetch('http://127.0.0.1:8766/goal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ companion, skill, params }),
});
console.log(await res.text());
