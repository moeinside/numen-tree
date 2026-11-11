import { profileToCandidate, candidateFromIntent, withFactDefaults, validateProfile } from '../src/contracts.mjs';
import { factsOf } from '../src/facts.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('契约自测：');

const good = {
  schemaVersion: 1,
  id: 'food_security',
  intents: ['food_low'],
  steps: [],
  acceptance: 'hunger >= 16',
  scoreHints: { base: 60, timePhase: { night: 5 } },
  commitment: { minRunSeconds: 15, switchCost: 10 },
};
check('合法 profile 通过校验', validateProfile(good).ok);
check('缺 id 被拒绝', !validateProfile({ ...good, id: '' }).ok);

const c = profileToCandidate(good, { timePhase: 'day' });
check('candidate id/intent', c.id === 'food_security' && c.intentKey === 'food_low');
check('base score', c.score({ timePhase: 'day' }).total === 60);
check('timePhase bonus', c.score({ timePhase: 'night' }).total === 65);
check('commitment 映射', c.minRunSeconds === 15 && c.switchCost === 10);

const intentCandidate = candidateFromIntent({ id: 'safety_hold', priority: 75, switchCost: 8 });
check('intent → candidate', intentCandidate.id === 'safety_hold' && intentCandidate.score().total === 75);

const facts = withFactDefaults({ hunger: 6, hasWeapon: true, timePhase: 'dusk' });
check('fact defaults + override', facts.hunger === 6 && facts.hasWeapon === true && facts.hasPickaxe === false);

const derived = factsOf({ hp: 10, maxHp: 20, hunger: 4, weapon: 'minecraft:wooden_sword', timePhase: 'night' });
check('factsOf 派生', derived.hpPct === 50 && derived.hasWeapon === true && derived.timePhase === 'night');

console.log(`契约自测：${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);
