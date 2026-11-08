// 控制 API 快捷调用：node probe/tree-api.mjs <path> [json-file]
// 例：node probe/tree-api.mjs /recipes
//     node probe/tree-api.mjs /task probe/args-task-stockwood.json
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8766';
const [route = '/status', file] = process.argv.slice(2);
const body = file ? fs.readFileSync(file, 'utf8') : undefined;
const res = await fetch(BASE + route, {
  method: body ? 'POST' : 'GET',
  headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
  body,
});
console.log(await res.text());
