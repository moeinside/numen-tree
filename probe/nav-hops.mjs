#!/usr/bin/env node
/**
 * 小步导航接力：长距离 go_to 会绕山/乱跳，改成 3~4 格一跳的 go_to，等空闲再下一跳。
 * 用法：node probe/nav-hops.mjs <companion> <x1,z1> <x2,z2> ...
 * 例：node probe/nav-hops.mjs bigWhale -70,84 -67,86 ...
 */
const BASE = 'http://127.0.0.1:8766';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json().catch(() => ({}))) ?? {};
}

async function main() {
  const [companion, ...hops] = process.argv.slice(2);
  if (!companion || !hops.length) {
    console.error('用法：node probe/nav-hops.mjs <companion> <x1,z1> ...');
    process.exit(2);
  }
  for (const hop of hops) {
    const [x, z] = hop.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    // 等空闲（无在途动作 & 无计划）
    for (let i = 0; i < 40; i++) {
      const st = await api('/status');
      const c = st.companions?.find((x2) => x2.name === companion);
      if (c && c.busy === false && !c.current && !c.plan && !(c.goals || []).some((g) => g.status === 'pending')) break;
      await sleep(1000);
    }
    await api('/goal', 'POST', {
      companion,
      skill: 'go_to',
      priority: 50,
      params: { target: { x, y: 64, z }, range: 1 },
    });
    let last = '';
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const st = await api('/status');
      const c = st.companions?.find((x2) => x2.name === companion);
      if (!c) break;
      const pos = c.pos ? `${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}` : '?';
      if (pos !== last) last = pos;
      const pending = (c.goals || []).some((g) => g.status === 'pending' || g.status === 'running');
      if (!c.busy && !c.current && !pending && !c.plan) break;
    }
    const st = await api('/status');
    const c = st.companions?.find((x2) => x2.name === companion);
    const pos = c?.pos ? `${Math.round(c.pos.x)},${Math.round(c.pos.y)},${Math.round(c.pos.z)}` : '?';
    console.log(`hop ${hop} -> pos ${pos}${c?.slotBlocked ? ` slotBlocked=${c.slotBlocked}` : ''}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
