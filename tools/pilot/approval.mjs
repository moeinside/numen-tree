/**
 * 人工批准门
 * - readOnly: observe/get_events/wait 自动
 * - each: 变更类动作逐条确认
 * - auto: --yes，全部自动（仅建议 dry-run/受控）
 */
import readline from 'node:readline/promises';

const READ_ONLY = new Set(['observe', 'get_events', 'wait']);

export function isReadOnly(action) {
  return READ_ONLY.has(action?.action);
}

export async function approveAction(action, { mode = 'each' } = {}) {
  if (isReadOnly(action)) return { ok: true, auto: true };
  if (mode === 'auto') return { ok: true, auto: true };
  if (!process.stdin.isTTY) {
    throw new Error('no TTY for approval; rerun with --yes or use interactive terminal');
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const label =
    action.action === 'lua'
      ? `Lua:\n${String(action.code ?? '').slice(0, 1200)}`
      : JSON.stringify(action);
  const ans = await rl.question(`\nApprove ${action.action}?\n${label}\n[y/N] `);
  rl.close();
  const ok = /^y(es)?$/i.test(ans.trim());
  return { ok, auto: false };
}
