/**
 * 战略模块共用小工具。
 */
export function varsOf(r) {
  return r && r.ok ? r.vars || {} : {};
}
