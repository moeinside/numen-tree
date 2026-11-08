#!/usr/bin/env node
/**
 * 僵尸锁外部清理客户端自测（不连游戏）：
 * 起一个本地假补丁 HTTP 服务，验证 src/lockfix.mjs 的协议/降级行为。
 *
 * 用法：node probe/lockfix-selftest.mjs
 */

import http from 'node:http';
import { LockFixClient } from '../src/lockfix.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function startFakePatch() {
  const state = { statusCalls: 0, unlockCalls: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.method === 'GET' && url.pathname === '/status') {
      state.statusCalls += 1;
      send({ ok: true, patch: '1.1.0', foundClass: true, port: state.port, count: 1, running: [{ key: 'k1', program: 'ext-9', companion: 'c1', owner: 'o1' }] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/unlock') {
      const uuid = url.searchParams.get('uuid');
      const all = url.searchParams.get('all');
      state.unlockCalls.push({ uuid, all });
      if (!uuid && all !== '1') return send({ ok: false, error: 'need uuid / all=1' });
      send({ ok: true, patch: '1.1.0', cleared: uuid ? 1 : 3 });
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      resolve({ server, state });
    });
  });
}

async function main() {
  const { server, state } = await startFakePatch();
  try {
    const client = new LockFixClient({ port: state.port, timeoutMs: 2000 });
    const st = await client.status();
    check('status ok', st.ok === true, JSON.stringify(st));
    check('status 带补丁版本', st.patch === '1.1.0', String(st.patch));
    check('status 报告找到反射目标类', st.foundClass === true, String(st.foundClass));
    check('status 带锁条目数量', st.count === 1, String(st.count));
    check('status 命中 /status 接口', state.statusCalls === 1, `calls=${state.statusCalls}`);

    const one = await client.unlock({ uuid: '11111111-2222-3333-4444-555555555555' });
    check('按 UUID 清锁成功', one.ok === true && one.cleared === 1, JSON.stringify(one));
    check('请求带上了 uuid', state.unlockCalls[0]?.uuid === '11111111-2222-3333-4444-555555555555', JSON.stringify(state.unlockCalls[0]));

    const all = await client.unlock({ all: true });
    check('清全部锁成功', all.ok === true && all.cleared === 3, JSON.stringify(all));
    check('all=1 参数正确', state.unlockCalls[1]?.all === '1', JSON.stringify(state.unlockCalls[1]));

    const bad = await client.unlock({});
    check('无 uuid 且非 all → 客户端拒绝（不发请求）', bad.ok === false && /需要 uuid/.test(String(bad.error)), JSON.stringify(bad));
    check('拒绝时没有多发请求', state.unlockCalls.length === 2, `calls=${state.unlockCalls.length}`);

    // 端口没人监听 → 优雅失败
    const dead = new LockFixClient({ port: 1, timeoutMs: 500 });
    const deadSt = await dead.status();
    check('补丁不在线 → ok:false 且带 error', deadSt.ok === false && !!deadSt.error, JSON.stringify(deadSt));
    check('补丁不在线的错误文案可读', /连不上|超时/.test(String(deadSt.error)), String(deadSt.error));
  } finally {
    server.close();
  }

  console.log(`僵尸锁客户端自测：${pass}/${pass + fail} 通过`);
  if (fail) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过（status / unlock uuid / unlock all / 参数校验 / 补丁不在线降级）');
  }
}

main().catch((e) => {
  console.error('自测崩溃：', e);
  process.exit(1);
});
