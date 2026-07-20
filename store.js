// CollabBoard 房间持久化：把房间的笔画/聊天落盘到 JSON，便于服务端重启后恢复。
// 独立成模块，便于单元测试（不依赖 WebSocket / 网络）。
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
  const payload = {
    strokes: Array.isArray(data.strokes) ? data.strokes : [],
    chats:   Array.isArray(data.chats)   ? data.chats   : []
  };
  fs.writeFileSync(f, JSON.stringify(payload));
  return payload;
}
function loadRoom(name){
  const f = roomFile(name);
  if(!fs.existsSync(f)) return null;
  try {
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { strokes: Array.isArray(o.strokes) ? o.strokes : [], chats: Array.isArray(o.chats) ? o.chats : [] };
  } catch(e){ return null; }
}
function deleteRoom(name){
  const f = roomFile(name);
  if(fs.existsSync(f)) fs.unlinkSync(f);
}
module.exports = { saveRoom, loadRoom, deleteRoom, roomFile, DIR };
