import { distance3, sameLevel, isInsideRegion, atHome } from '../src/space.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${name} = ${JSON.stringify(actual)}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

const home = { x: 123.7, y: 59, z: 187.4 };
check('3D 距离含 Y', Math.round(distance3({ x: 116.7, y: 68, z: 184.9 }, home) * 10) / 10, 11.7);
check('水平 7 垂直 9 不同层', sameLevel({ x: 116.7, y: 68, z: 184.9 }, home, 2), false);
check('同层', sameLevel({ x: 120, y: 60, z: 187 }, home, 2), true);
check('水平近但垂直远不回家', atHome({ x: 120, y: 68, z: 187 }, home, { radius: 12 }), false);
check('屋内才算到家', atHome({ x: 123, y: 59, z: 187 }, home, { radius: 3 }), true);
check('体积包含', isInsideRegion({ x: 123, y: 59, z: 187 }, { center: home, radius: 6, yTolerance: 2 }), true);
check('缺坐标 false', atHome({ x: 1 }, home), false);

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;
