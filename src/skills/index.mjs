import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 技能注册表 —— 自动发现 src/skills/*.mjs
 *
 * 扩展方式：往 src/skills/ 里丢一个新的 .mjs，默认导出：
 *   { id, title, params, build(ctx, params) -> { code, timeoutMs } }
 * 不需要改这里，也不需要改树的核心。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['index.mjs', 'prelude.mjs']);

const registry = new Map();

export async function loadSkills({ bust = false } = {}) {
  const files = fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !SKIP.has(f))
    .sort();

  for (const file of files) {
    // bust=true 时给 URL 加时间戳，破除 ESM 模块缓存（热重载必须用这个）
    const spec = bust ? `./${file}?t=${Date.now()}` : `./${file}`;
    const mod = await import(spec);
    const skill = mod.default;
    if (!skill || !skill.id || typeof skill.build !== 'function') {
      throw new Error(`技能文件 ${file} 缺少 id/build`);
    }
    if (registry.has(skill.id)) {
      throw new Error(`技能 id 重复：${skill.id}（${file}）`);
    }
    registry.set(skill.id, skill);
  }
  return registry;
}

export function getSkill(id) {
  return registry.get(id) || null;
}

export function listSkills() {
  return [...registry.values()].map((s) => ({
    id: s.id,
    title: s.title,
    params: s.params,
  }));
}

/** 运行时注册（供测试或未来插件用）。 */
export function registerSkill(skill) {
  registry.set(skill.id, skill);
}

/**
 * 开发用：清空注册表重新发现一遍（改完技能卡不用重启树进程）。
 * 只影响"下一次下发"，在途的动作仍用已生成的 Lua 代码，安全。
 */
export async function reloadSkills() {
  registry.clear();
  // 必须 bust ESM 缓存，否则 import 拿回的是旧模块（实测踩过：热重载后还是旧文案）
  return loadSkills({ bust: true });
}
