// CollabBoard 房间持久化：把房间的笔画/聊天落盘到 JSON，便于服务端重启后恢复。
// 独立成模块，便于单元测试（不依赖 WebSocket / 网络）。
// 增强(自驱迭代)：持久化更多房间元数据（背景/标题/权限/网格/吸附/锁定/投票/计时器/快照/密码哈希等），
// 修复此前仅保存 strokes/chats 导致房间状态重启丢失的隐性问题。
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'rooms');

function roomFile(name){
  const safe = String(name).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) || 'main';
  if(!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  return path.join(DIR, safe + '.json');
}
function saveRoom(name, data){
  const f = roomFile(name);
  const toArr = (s)=> (s && typeof s === 'object' && typeof s.forEach === 'function') ? [...s] : (Array.isArray(s) ? s : []);
  const payload = {
    strokes: Array.isArray(data.strokes) ? data.strokes : [],
    chats:   Array.isArray(data.chats)   ? data.chats   : [],
    bg: (typeof data.bg === 'string') ? data.bg : null,
    title: (typeof data.title === 'string') ? data.title : null,
    permissions: (typeof data.permissions === 'string') ? data.permissions : null,
    grid: !!data.grid,
    snap: !!data.snap,
    locked: !!data.locked,
    lockedElements: toArr(data.lockedElements),
    muted: toArr(data.muted),
    banned: toArr(data.banned),
    polls: Array.isArray(data.polls) ? data.polls : [],
    timers: Array.isArray(data.timers) ? data.timers : [],
    passwordHash: (typeof data.passwordHash === 'string') ? data.passwordHash : null,
    announcements: Array.isArray(data.announcements) ? data.announcements : [],
    snapshots: (data.snapshots && typeof data.snapshots === 'object') ? data.snapshots : {},
    _chatSeq: (typeof data._chatSeq === 'number') ? data._chatSeq : 0
  };
  fs.writeFileSync(f, JSON.stringify(payload));
  return payload;
}
function loadRoom(name){
  const f = roomFile(name);
  if(!fs.existsSync(f)) return null;
  try {
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      strokes: Array.isArray(o.strokes) ? o.strokes : [],
      chats:   Array.isArray(o.chats)   ? o.chats   : [],
      bg: (typeof o.bg === 'string') ? o.bg : null,
      title: (typeof o.title === 'string') ? o.title : null,
      permissions: (typeof o.permissions === 'string') ? o.permissions : null,
      grid: !!o.grid,
      snap: !!o.snap,
      locked: !!o.locked,
      lockedElements: Array.isArray(o.lockedElements) ? o.lockedElements : [],
      muted: Array.isArray(o.muted) ? o.muted : [],
      banned: Array.isArray(o.banned) ? o.banned : [],
      polls: Array.isArray(o.polls) ? o.polls : [],
      timers: Array.isArray(o.timers) ? o.timers : [],
      passwordHash: (typeof o.passwordHash === 'string') ? o.passwordHash : null,
      announcements: Array.isArray(o.announcements) ? o.announcements : [],
      snapshots: (o.snapshots && typeof o.snapshots === 'object') ? o.snapshots : {},
      _chatSeq: (typeof o._chatSeq === 'number') ? o._chatSeq : 0
    };
  } catch(e){ return null; }
}
function deleteRoom(name){
  const f = roomFile(name);
  if(fs.existsSync(f)) fs.unlinkSync(f);
}
module.exports = { saveRoom, loadRoom, deleteRoom, roomFile, DIR };
