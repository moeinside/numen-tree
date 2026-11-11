/**
 * 恢复演练用：拿锁后持续 heartbeat；被 SIGKILL 时不会释放锁。
 * 只用于 drill，不连接游戏。
 */
import { acquire, heartbeat } from './lock.mjs';

const owner = process.env.PILOT_DRILL_OWNER || `drill-holder-${process.pid}`;
const r = acquire({
  owner,
  runId: process.env.PILOT_DRILL_RUN || 'drill',
  mode: 'reference-pilot',
  ttlMs: 60_000,
});
if (!r.ok) {
  console.error(JSON.stringify(r));
  process.exit(1);
}
console.log(JSON.stringify({ ready: true, owner, pid: process.pid }));
const timer = setInterval(() => {
  heartbeat({ owner, ttlMs: 60_000 });
}, 2000);
timer.unref();
// 故意不挂 SIGTERM/SIGKILL，验证崩溃后锁残留。
