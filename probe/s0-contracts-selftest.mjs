import {
  validateCommitment, defaultConsent, applyConsentRefusal,
  validateMethod, validateResultEvent, validateDeathEvent,
  canTransition, canComplete, assertWriter, deriveTimeShares,
} from '../src/contracts/index.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); }
}
function ok(name, v) { check(name, v.ok, true); if (!v.ok) console.log('    ' + v.errors.join(', ')); }
function bad(name, v) { check(name, v.ok, false); }

const commitment = {
  id: 'c1', kind: 'survival', source: 'auto', requiresConsent: false,
  consentState: 'policy_pre_authorized', consentScope: 'per_action',
  predicate: 'has_food', predicateSource: 'L0',
  deadlineWindow: { windowType: 'day', remainingSec: 120 },
  status: 'active', evidenceRef: 'inv:food',
  basis: { snapshotSeq: 1, gameTick: 10 }, ttl: 5000, retryBudget: 2,
  createdAt: 1, updatedAt: 1,
};
ok('valid commitment', validateCommitment(commitment));
bad('missing basis', validateCommitment({ ...commitment, basis: null }));
bad('bad kind', validateCommitment({ ...commitment, kind: 'fun' }));

check('auto outside owner region → policy_pre_authorized',
  defaultConsent('auto', { ownerRegion: false }), 'policy_pre_authorized');
check('auto in owner region → pending',
  defaultConsent('auto', { ownerRegion: true }), 'pending');
check('external/player → pending', defaultConsent('player'), 'pending');
check('refusal writes denied',
  applyConsentRefusal(commitment, 'owner_placed_block').consentState, 'denied');

const method = {
  id: 'm1', version: 1, domain: 'survival', tier: 'reversible',
  preconditions: ['has_tool:pickaxe'], requiredToolTier: 'wood',
  stationRef: null, requiredDimension: null, needsLoadedChunk: false,
  expectedProgress: 0.5, cost: 1, estimatedTimeMs: 2000, risk: 0.1,
  reversibility: 0.8, successPredicate: 'has_food', fallback: 'seek',
  evidenceRef: 'method:m1',
};
ok('valid method', validateMethod(method));
bad('method missing preconditions', validateMethod({ ...method, preconditions: undefined }));

const event = {
  eventSeq: 1, txId: 't1', atomId: 'a1', commitmentId: 'c1', gameTick: 10,
  methodId: 'm1', status: 'ok', kind: 'ok', durationMs: 100,
  paramsHash: 'abc', snapshotSeqBefore: 1, snapshotSeqAfter: 2,
  postcheck: { blockBefore: 'stone', blockAfter: 'air' }, evidenceSeq: 3,
  source: 'numen',
};
ok('valid result event', validateResultEvent(event));
bad('event missing paramsHash', validateResultEvent({ ...event, paramsHash: null }));
bad('event missing postcheck', validateResultEvent({ ...event, postcheck: null }));
ok('death production subset', validateDeathEvent({
  eventSeq: 1, gameTick: 10, pos: { x: 0, y: 64, z: 0 },
  dimension: 'minecraft:overworld', lastCommitmentId: 'c1', source: 'numen',
}));
bad('death cause requires groundtruth', validateDeathEvent({
  eventSeq: 1, gameTick: 10, pos: { x: 0, y: 64, z: 0 },
  dimension: 'minecraft:overworld', lastCommitmentId: 'c1', source: 'numen', cause: 'fall',
}));

check('proposed→active', canTransition('proposed', 'active'), true);
check('done→active blocked', canTransition('done', 'active'), false);
check('completion requires matching ok+postcheck', canComplete(commitment, event), true);
check('completion rejects failed event',
  canComplete(commitment, { ...event, status: 'failed' }), false);
check('only ledger writes', [assertWriter('ledger'), assertWriter('scoring')], [true, false]);

const shares = deriveTimeShares([
  { category: 'survival', durationMs: 600 },
  { category: 'opportunity', durationMs: 300 },
  { category: 'long_term', durationMs: 100 },
]);
check('shares estimated', shares.estimated, true);
check('shares sum to 1', Number((shares.shares.survival + shares.shares.opportunity + shares.shares.long_term).toFixed(6)), 1);

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;
