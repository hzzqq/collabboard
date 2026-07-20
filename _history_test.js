// history.js 单元测试：commit/undo/redo 快照栈 + 清空 + 上限。
const hist = require('./history');
let pass = 0, fail = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

let room = { strokes: [] };
hist.ensureHistory(room);
ok('初始无历史', room.undoStack.length === 0 && room.redoStack.length === 0);

hist.commitStrokes(room, [{ id: 1 }]);
ok('提交后笔画更新', room.strokes.length === 1);
ok('提交后 redo 清空', room.redoStack.length === 0);

hist.commitStrokes(room, [{ id: 1 }, { id: 2 }]);
ok('再次提交', room.strokes.length === 2);

ok('undo 一次', hist.undo(room) === true && room.strokes.length === 1);
ok('undo 后 redo 有内容', room.redoStack.length === 1);

ok('redo 一次', hist.redo(room) === true && room.strokes.length === 2);

// 连续 undo 回到空，再 undo 返回 false
ok('undo 到空',
   hist.undo(room) === true && room.strokes.length === 1 &&
   hist.undo(room) === true && room.strokes.length === 0);
ok('空栈 undo 返回 false', hist.undo(room) === false);

// 提交后清空 redo
hist.commitStrokes(room, [{ id: 9 }]);
ok('提交清空 redo', room.redoStack.length === 0 && room.strokes.length === 1);

// 上限：连续提交超过 200 不爆
for(let i = 0; i < 250; i++) hist.commitStrokes(room, [{ id: i }]);
ok('undo 栈有上限', room.undoStack.length <= 200);

console.log(`\n[history] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
