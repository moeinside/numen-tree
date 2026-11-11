import { baseRegions, isInsideBase } from '../src/base-guard.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

const places = {
  list: () => [
    { id: 'p1', name: '家', pos: { x: 150, y: 61, z: 200 } },
    { id: 'p2', name: '测试基地', pos: { x: 120, y: 66, z: 180 } },
  ],
};
const regions = baseRegions(places);
check('两条基地', regions.length, 2);
check('家内', isInsideBase({ x: 150, y: 61, z: 200 }, regions), true);
check('家垂直外', isInsideBase({ x: 150, y: 70, z: 200 }, regions), false);
check('基地内', isInsideBase({ x: 125, y: 66, z: 185 }, regions), true);
check('基地外', isInsideBase({ x: 200, y: 66, z: 200 }, regions), false);
check('无地点不误伤', isInsideBase({ x: 0, y: 0, z: 0 }, []), false);

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;
