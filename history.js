// CollabBoard 撤销/重做：对房间笔画状态做快照栈管理（纯逻辑，便于单元测试，不依赖网络）。
// 语义：每次变更提交一个完整笔画数组；undo 回退到上一快照，redo 前进一步。
function ensureHistory(room){
  if(!room.undoStack) room.undoStack = [];
  if(!room.redoStack) room.redoStack = [];
}
// 记录一次变更：把当前笔画压入 undo 栈、清空 redo 栈，再写入新笔画。
function commitStrokes(room, newStrokes){
  ensureHistory(room);
  room.undoStack.push(room.strokes);
  if(room.undoStack.length > 200) room.undoStack.shift();   // 防止无限增长
  room.redoStack = [];
  room.strokes = newStrokes;
}
function undo(room){
  ensureHistory(room);
  if(!room.undoStack.length) return false;
  room.redoStack.push(room.strokes);
  room.strokes = room.undoStack.pop();
  return true;
}
function redo(room){
  ensureHistory(room);
  if(!room.redoStack.length) return false;
  room.undoStack.push(room.strokes);
  room.strokes = room.redoStack.pop();
  return true;
}
module.exports = { ensureHistory, commitStrokes, undo, redo };
