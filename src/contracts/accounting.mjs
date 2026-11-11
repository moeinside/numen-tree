const CATEGORIES = ['survival', 'opportunity', 'long_term'];

/**
 * Three-category time shares are DERIVED REPORTING only.
 * A single action can serve multiple categories, so this must not be used as a
 * runtime scheduling field. The caller supplies explicit entries.
 */
export function deriveTimeShares(entries) {
  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const e of entries || []) {
    if (!CATEGORIES.includes(e?.category)) continue;
    totals[e.category] += Math.max(0, Number(e.durationMs) || 0);
  }
  const total = CATEGORIES.reduce((s, c) => s + totals[c], 0);
  const shares = Object.fromEntries(CATEGORIES.map((c) => [c, total > 0 ? totals[c] / total : 0]));
  return { estimated: true, totalMs: total, totalsMs: totals, shares };
}
