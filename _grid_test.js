// CollabBoard 网格对齐 grid.js 单元测试（ci90）
// 忠实测试浏览器绘制与 Node 共用的纯函数 snapPoint / gridLines。
'use strict';
const { snapPoint, gridLines } = require('./grid.js');
let pass = 0, fail = 0;
function ok(name, cond){ if(cond){ pass++; } else { fail++; console.log('  FAIL: ' + name); } }

// snapPoint：吸附到 size 整数倍（四舍五入）
ok('snap 13,7 @10 → 10,10', JSON.stringify(snapPoint(13,7,10)) === '[10,10]');
ok('snap 15,24 @10 → 20,20', JSON.stringify(snapPoint(15,24,10)) === '[20,20]');
ok('snap 5,5 @10 → 10,10', JSON.stringify(snapPoint(5,5,10)) === '[10,10]');
ok('snap 0,0 @10 → 0,0', JSON.stringify(snapPoint(0,0,10)) === '[0,0]');
// size<=0 → 关闭，原样返回
ok('snap size=0 原样', JSON.stringify(snapPoint(13,7,0)) === '[13,7]');
ok('snap size<0 原样', JSON.stringify(snapPoint(13,7,-5)) === '[13,7]');

// gridLines：竖线 x=0/10/20 + 横线 y=0/10/20 = 6 条，端点正确
const g = gridLines(20,20,10);
ok('gridLines 20,20@10 = 6 条', g.length === 6);
ok('含竖线 x=0', g.some(l=>l[0]===0&&l[1]===0&&l[2]===0&&l[3]===20));
ok('含竖线 x=20', g.some(l=>l[0]===20&&l[2]===20));
ok('含横线 y=10', g.some(l=>l[1]===10&&l[3]===10));
ok('gridLines size=0 空', gridLines(20,20,0).length === 0);

console.log(`\n_grid_test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
