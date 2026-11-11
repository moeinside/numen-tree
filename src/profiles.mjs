/**
 * 现有战略包（STRATEGIES）→ Profile/Candidate 的桥。
 *
 * 目的：优先度 MVP 可以先消费统一的 Candidate，不必一次重写所有战略。
 * 后续把战略按领域拆到 src/strategies/* 时，这里逐步改成显式 profile 表。
 */
import { STRATEGIES } from './strategy.mjs';
import { profileToCandidate, withFactDefaults, validateProfile } from './contracts.mjs';

/** 把一个内部战略元数据映射成 profile（默认值补齐）。 */
export function routineProfile(id) {
  const s = STRATEGIES?.[id];
  if (!s) return null;
  return {
    schemaVersion: 1,
    id: `routine.${id}`,
    kind: 'routine',
    intents: [id],
    // 现有战略没有单独的 requires 元数据；先用空数组（默认 eligible=true）
    requires: [],
    acceptance: s.acceptance ?? null,
    steps: [],
    scoreHints: { base: Number(s.defaultPriority ?? 50) },
    commitment: {
      minRunSeconds: 10,
      switchCost: 5,
      cooldownSeconds: 0,
    },
    legacyStrategyId: id,
    title: s.title,
  };
}

export function listRoutineProfiles() {
  return Object.keys(STRATEGIES || {})
    .map((id) => routineProfile(id))
    .filter(Boolean);
}

export function allRoutineCandidates(facts = {}) {
  const f = withFactDefaults(facts);
  return listRoutineProfiles()
    .filter((p) => validateProfile(p).ok)
    .map((p) => profileToCandidate(p, f));
}

export function routineCandidate(id, facts = {}) {
  const p = routineProfile(id);
  if (!p || !validateProfile(p).ok) return null;
  return profileToCandidate(p, withFactDefaults(facts));
}
