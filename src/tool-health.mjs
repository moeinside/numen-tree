/**
 * 工具健康（纯状态，不读写世界）。
 * 目的：工具坏了不能继续被 hasTools 当成可用；触发补工具/换工具。
 */
export const TOOL_KIND = Object.freeze({ PICKAXE: 'pickaxe', AXE: 'axe', WEAPON: 'weapon' });

export function createToolHealth() {
  return { pickaxe: null, axe: null, weapon: null };
}

export function markToolFailure(state, { tool, kind = 'failed', broken = true, now = Date.now() } = {}) {
  state.toolHealth ??= createToolHealth();
  const t = String(tool ?? 'pickaxe');
  const prev = state.toolHealth[t];
  const suspectCount = Number(prev?.suspectCount ?? 0) + 1;
  const isBroken = broken === true || suspectCount >= 2;
  state.toolHealth[t] = {
    state: isBroken ? 'broken' : 'suspect',
    kind: String(kind),
    at: now,
    suspectCount,
  };
  return state.toolHealth[t];
}

export function isToolBroken(state, tool) {
  return state?.toolHealth?.[String(tool)]?.state === 'broken';
}

export function clearToolFailure(state, tool) {
  if (!state?.toolHealth) return;
  state.toolHealth[String(tool)] = null;
}

export function toolHealthView(state) {
  return state?.toolHealth ? JSON.parse(JSON.stringify(state.toolHealth)) : null;
}
