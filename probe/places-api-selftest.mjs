// 地点簿控制 API 自测（record / find 模糊 / list / forget）
const BASE = 'http://127.0.0.1:8766';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function get(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

const out = [];
out.push(['record 家(here)', await post('/place', { action: 'record', name: '家', pos: 'here', companion: 'tyrander' })]);
out.push(['record 矿洞(explicit)', await post('/place', { action: 'record', name: '矿洞入口', pos: '-120,40,80', note: '有铁', companion: 'tyrander' })]);
out.push(['record 死亡点', await post('/place', { action: 'record', name: '死亡点', kind: 'death', pos: '-168,63,53', companion: 'tyrander' })]);
out.push(['find 基地', await post('/place', { action: 'find', query: '基地', companion: 'tyrander' })]);
out.push(['find 上次死的地方', await post('/place', { action: 'find', query: '上次死的地方', companion: 'tyrander' })]);
out.push(['find 主人在哪', await post('/place', { action: 'find', query: '主人在哪', companion: 'tyrander' })]);
out.push(['find 矿洞', await post('/place', { action: 'find', query: '矿洞', companion: 'tyrander' })]);
out.push(['get /places?query=基地', await get('/places?query=' + encodeURIComponent('基地') + '&companion=tyrander')]);
out.push(['forget 矿洞', await post('/place', { action: 'forget', query: '矿洞' })]);
out.push(['list', await post('/place', { action: 'list' })]);

for (const [label, r] of out) {
  console.log(`\n## ${label}`);
  console.log(JSON.stringify(r, null, 1).slice(0, 700));
}
