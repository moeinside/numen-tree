/**
 * Phase C：真实 priority trace 审计（只读）。
 * node probe/priority-trace-audit.mjs [traceFile] [storeFile]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const traceFile = process.argv[2] ?? path.join(root, 'logs', 'trace-20261110.jsonl');
const storeFile = process.argv[3] ?? path.join(root, 'runs', 'priority-state.json');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function readStore(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const events = readJsonl(traceFile).filter((e) => e.kind === 'priority_decision');
const decisions = events.map((e) => {
  try { return JSON.parse(e.note); } catch { return null; }
}).filter(Boolean);
const codes = {};
const incoming = {};
let missingReason = 0;
let missingGoal = 0;
let missingAtom = 0;
let missingTx = 0;
let missingWorld = 0;
let preempted = 0;
let legacy = 0;
for (const d of decisions) {
  codes[d.code] = (codes[d.code] ?? 0) + 1;
  incoming[d.incomingConsequence ?? '(none)'] = (incoming[d.incomingConsequence ?? '(none)'] ?? 0) + 1;
  if (!d.reason) missingReason += 1;
  if (!d.goalId) missingGoal += 1;
  if (!d.atomId) missingAtom += 1;
  if (!d.txId) missingTx += 1;
  if (!d.world) missingWorld += 1;
  if (d.code === 'preempt') preempted += 1;
  if (d.code === 'legacy_undeclared') legacy += 1;
}
const store = readStore(storeFile);
const stats = store?.payload?.stats ?? null;
const result = {
  suite: 'priority-trace-audit',
  phase: 'C',
  traceFile,
  storeFile,
  decisions: decisions.length,
  codes,
  incomingConsequence: incoming,
  preempted,
  legacy,
  reasonCoverage: decisions.length ? (decisions.length - missingReason) / decisions.length : null,
  missing: { reason: missingReason, goalId: missingGoal, atomId: missingAtom, txId: missingTx, world: missingWorld },
  store: stats,
  storeWorldId: store?.payload?.worldId ?? null,
  storeEpoch: store?.payload?.worldEpoch ?? null,
  verdict: {
    hasRealDecisions: decisions.length > 0,
    hasAllowedPreempt: preempted > 0,
    hasTxMetadata: missingGoal === 0 && missingAtom === 0 && missingTx === 0,
    hasWorldSnapshot: missingWorld === 0,
    reasonComplete: missingReason === 0,
    legacyZero: legacy === 0 && (stats?.legacy ?? 0) === 0,
  },
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(root, 'logs', 'priority-trace-audit.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
