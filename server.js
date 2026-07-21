// CollabBoard — 零依赖 WebSocket 服务端 (RFC 6455 手写实现)
// 增强：按房间(room)命名空间隔离广播、在线人数、光标转发。
// 不依赖任何 npm 包：自己处理握手、帧解析、掩码、广播。
const net = require('net');
const crypto = require('crypto');
const store = require('./store');
const hist = require('./history');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 连接调色板（服务端为每个连接分配唯一颜色）+ 心跳间隔
const PALETTE = ['#f78c6c','#7ee787','#82aaff','#c792ea','#ffcb6b','#f07178','#add7ff','#ffd9e0'];
let connSeq = 0;
let strokeSeq = 0;   // 元素唯一 id 序列（服务端权威署名，客户端带 id 则保留）
const HB = process.env.HB ? Math.max(200, +process.env.HB) : 30000;

// rooms: name -> { clients:Set<sock>, strokes:[], chats:[] }
const rooms = new Map();
function getRoom(name){
  let r = rooms.get(name);
  if(!r){
    r = { clients: new Set(), strokes: [], chats: [], name, owner: null, locked: false };
    const saved = store.loadRoom(name);
    if(saved){ r.strokes = saved.strokes; r.chats = saved.chats; }
    rooms.set(name, r);
    hist.ensureHistory(r);
  }
  return r;
}

function acceptKey(key){ return crypto.createHash('sha1').update(key + GUID).digest('base64'); }
function sendFrame(sock, str){
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if(len < 126){ header = Buffer.from([0x81, len]); }
  else if(len < 65536){ header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  sock.write(Buffer.concat([header, payload]));
}
function broadcast(room, str, except){
  for(const c of room.clients){ if(c !== except && !c.destroyed) sendFrame(c, str); }
}
// 按 (dx,dy) 平移一个元素（原地修改并返回）：文字平移 x/y，矢量平移 points；同时兼容带 x/y 的矩形/文本
function translateElement(el, dx, dy){
  if(!el || typeof el !== 'object') return el;
  if(el.type === 'text'){ el.x = (el.x||0) + dx; el.y = (el.y||0) + dy; return el; }
  if(Array.isArray(el.points)){
    for(const p of el.points){ p.x = (p.x||0) + dx; p.y = (p.y||0) + dy; }
    return el;
  }
  if(el.x != null || el.y != null){ el.x = (el.x||0) + dx; el.y = (el.y||0) + dy; }
  return el;
}
function presence(room){
  const names = [...room.clients].map(c => c.name || ('用户' + (c._cid || '?')));
  broadcast(room, JSON.stringify({ type:'presence', count: room.clients.size, names }));
}
// 全局房间列表负载：所有房间名 + 笔画数 + 在线人数（供大厅展示活跃房间）
function roomListPayload(){
  const out = [];
  for(const [name, r] of rooms) out.push({ name, strokes: r.strokes.length, clients: r.clients.size });
  return out;
}
// 向所有房间的所有客户端广播最新房间列表（任一房间有人加入/离开时调用）
function broadcastRoomList(){
  const payload = JSON.stringify({ type: 'room_list', rooms: roomListPayload() });
  for(const room of rooms.values()) broadcast(room, payload);
}

// ---- 极简 HTTP 管理 API（非 WS 的 GET 请求走这里）----
function httpServe(head, sock){
  const reqLine = head.match(/^GET\s+(\S+)/);
  const path = reqLine ? reqLine[1].split('?')[0] : '/';
  const u = reqLine ? new URL(reqLine[1], 'http://x') : new URL('http://x/');
  let body;
  if(path === '/api/health'){
    body = { ok:true, rooms:[...rooms.keys()], ts:Date.now() };
  } else if(path === '/api/rooms'){
    const counts = {}; for(const [k,r] of rooms) counts[k] = r.strokes.length;
    body = { ok:true, rooms:[...rooms.keys()], counts };
  } else if(path === '/api/room'){
    const name = u.searchParams.get('name') || 'main';
    const r = getRoom(name);
    body = { ok:true, name, strokes:r.strokes, chats:r.chats };
  } else if(path === '/' || path === '/api'){
    body = { ok:true, service:'CollabBoard', endpoints:['/api/health','/api/rooms','/api/room?name=NAME'] };
  } else {
    body = { ok:false, error:'not found' };
  }
  const payload = JSON.stringify(body);
  sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: '
    + Buffer.byteLength(payload) + '\r\nConnection: close\r\n\r\n' + payload);
  sock.end();
}

function handleData(sock, buf, room){
  let off = 0;
  while(off + 2 <= buf.length){
    const b0 = buf[off], b1 = buf[off+1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if(len === 126){ if(p+2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if(len === 127){ if(p+8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let maskKey;
    if(masked){ if(p+4 > buf.length) break; maskKey = buf.slice(p, p+4); p += 4; }
    if(p + len > buf.length) break;
    let payload = buf.slice(p, p+len);
    if(masked){ for(let i=0;i<len;i++) payload[i] ^= maskKey[i&3]; }
    off = p + len;

    if(opcode === 0x8){ sock.end(); return buf.slice(off); }      // close
    if(opcode === 0x9){                                           // ping -> pong
      const h = Buffer.from([0x8a, len]); sock.write(Buffer.concat([h, payload])); continue;
    }
    if(opcode === 0xA){ sock.alive = true; continue; }            // pong -> 标记存活
      if(opcode === 0x1){                                           // text
        const msg = payload.toString('utf8');
        try{
          let obj = JSON.parse(msg);
          // 房间锁定时，非房主的编辑类操作被拒绝（仅回错误给发起者，不广播、不入栈）
          const EDIT_OPS = new Set(['stroke','text','image','move','replace','clear','undo','redo']);
          if(EDIT_OPS.has(obj.type) && room.locked && sock._cid !== room.owner){
            sendFrame(sock, JSON.stringify({ type:'error', code:'locked', msg:'房间已锁定，仅房主可编辑' }));
            obj = { type:'__noop__' };
          }
          switch(obj.type){
          case 'stroke':
            if(obj.stroke && typeof obj.stroke === 'object'){
              if(obj.stroke.id == null) obj.stroke.id = sock._cid + ':' + (++strokeSeq);  // 保留客户端 id；否则服务端生成
              obj.stroke.author = sock._cid;          // 服务端权威署名，覆盖客户端伪造
              obj.stroke.authorColor = sock.color;
            }
            hist.commitStrokes(room, room.strokes.concat(obj.stroke)); broadcast(room, JSON.stringify(obj), sock); store.saveRoom(room.name, room); break;
          case 'text':
            if(typeof obj.text !== 'string') break;
            {
              const t = { type:'text', id: obj.id != null ? obj.id : (sock._cid + ':' + (++strokeSeq)),
                x: +obj.x||0, y: +obj.y||0,
                text: obj.text.slice(0, 200), color: typeof obj.color==='string'?obj.color:'#ffffff',
                width: +obj.width||16, author: sock._cid, authorColor: sock.color };
              hist.commitStrokes(room, room.strokes.concat(t)); broadcast(room, JSON.stringify(t), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'image':
            if(typeof obj.src !== 'string' || !obj.src) break;
            {
              const img = { type:'image', id: obj.id != null ? obj.id : (sock._cid + ':' + (++strokeSeq)),
                x: +obj.x||0, y: +obj.y||0,
                w: Math.max(8, Math.min(1024, +obj.w||160)),
                h: Math.max(8, Math.min(1024, +obj.h||120)),
                src: obj.src.slice(0, 4000000),   // 限制 base64 体积（~3MB）
                author: sock._cid, authorColor: sock.color };
              hist.commitStrokes(room, room.strokes.concat(img));
              broadcast(room, JSON.stringify(img), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'move':
            {
              const dx = +obj.dx||0, dy = +obj.dy||0;
              const ids = (obj.ids && Array.isArray(obj.ids)) ? obj.ids
                        : (obj.id != null ? [obj.id] : null);
              if(!ids || ids.length === 0 || (dx === 0 && dy === 0)) break;
              let found = false;
              const moved = room.strokes.map(el => {
                if(el && ids.includes(el.id)){ found = true; return translateElement(el, dx, dy); }
                return el;
              });
              if(!found) break;                         // 没找到任何 id 直接忽略
              hist.commitStrokes(room, moved);          // 进入撤销栈，支持 Ctrl+Z
              // 单 id 移动沿用 {id} 字段以兼容旧客户端；群组移动用 {ids} 数组
              const out = (obj.ids && Array.isArray(obj.ids)) ? { type:'move', ids, dx, dy } : { type:'move', id: obj.id, dx, dy };
              broadcast(room, JSON.stringify(out), sock);  // 对端按 delta 平移
              store.saveRoom(room.name, room);
            }
            break;
          case 'replace': hist.commitStrokes(room, obj.strokes || []); broadcast(room, msg, sock); store.saveRoom(room.name, room); break;
          case 'clear':   hist.commitStrokes(room, []); broadcast(room, msg, sock); store.saveRoom(room.name, room); break;
          case 'undo':
            if(hist.undo(room)){
              const rmsg = JSON.stringify({ type:'replace', strokes: room.strokes });
              broadcast(room, rmsg); store.saveRoom(room.name, room);
            }
            break;
          case 'redo':
            if(hist.redo(room)){
              const rmsg = JSON.stringify({ type:'replace', strokes: room.strokes });
              broadcast(room, rmsg); store.saveRoom(room.name, room);
            }
            break;
          case 'cursor':  broadcast(room, msg, sock); break;       // 不存储，仅转发
          case 'typing':
            broadcast(room, JSON.stringify({ type:'typing', id: sock._cid, name: sock.name || '匿名', on: obj.on !== false }), sock);
            break;                                      // 不存储，仅转发
          case 'set_name':
            sock.name = String(obj.name || '').slice(0, 24) || sock.name;
            presence(room); break;
          case 'chat':
            if(typeof obj.text !== 'string') break;
            const chat = { type:'chat', id: sock._cid || '?', name: sock.name || '匿名', text: obj.text.slice(0, 500), t: Date.now() };
            room.chats.push(chat);
            if(room.chats.length > 50) room.chats.shift();
            broadcast(room, JSON.stringify(chat), sock);   // 仅转发给他人
            store.saveRoom(room.name, room); break;
          case 'request_snapshot': sendFrame(sock, JSON.stringify({ type:'snapshot', strokes: room.strokes })); break;
          case 'room_list': sendFrame(sock, JSON.stringify({ type:'room_list', rooms: roomListPayload() })); break;
          case 'lock':
            if(sock._cid === room.owner){
              room.locked = true;
              broadcast(room, JSON.stringify({ type:'lock', locked:true, by: room.owner }));
            } else {
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能锁定房间' }));
            }
            break;
          case 'unlock':
            if(sock._cid === room.owner){
              room.locked = false;
              broadcast(room, JSON.stringify({ type:'lock', locked:false, by: room.owner }));
            } else {
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能解锁房间' }));
            }
            break;
        }
      }catch(e){ /* ignore */ }
    }
  }
  return buf.slice(off);
}

const server = net.createServer(sock=>{
  let handshakeDone = false;
  let buffer = Buffer.alloc(0);
  let roomName = 'main';
  sock.on('data', data=>{
    if(!handshakeDone){
      buffer = Buffer.concat([buffer, data]);
      const idx = buffer.indexOf('\r\n\r\n');
      if(idx === -1) return;
      const head = buffer.slice(0, idx).toString();
      const reqLine = head.match(/^GET\s+(\S+)/);
      const isWs = /upgrade:\s*websocket/i.test(head);
      if(!isWs){ httpServe(head, sock); return; }
      if(reqLine){
        const u = new URL(reqLine[1], 'http://x');
        roomName = u.searchParams.get('room') || 'main';
      }
      const m = head.match(/Sec-WebSocket-Key:\s*(.+)\r\n/);
      if(!m){ sock.end(); return; }
      const accept = acceptKey(m[1].trim());
      sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
      handshakeDone = true;
      const room = getRoom(roomName);
      sock._cid = Math.random().toString(36).slice(2, 8);
      sock.name = null;
      sock.color = PALETTE[(connSeq++) % PALETTE.length];
      sock.alive = true;
      room.clients.add(sock);
      if(room.owner == null) room.owner = sock._cid;          // 首个加入者成为房主
      broadcast(room, JSON.stringify({ type:'owner', owner: room.owner, locked: !!room.locked }));
      sock.room = room;
      sock.roomName = roomName;
      buffer = buffer.slice(idx + 4);
      sendFrame(sock, JSON.stringify({ type:'welcome', id: sock._cid, color: sock.color, room: roomName }));
      sendFrame(sock, JSON.stringify({ type:'snapshot', strokes: room.strokes, chats: room.chats, room: roomName }));
      presence(room);
      broadcastRoomList();
      if(buffer.length) buffer = handleData(sock, buffer, room);
      return;
    }
    buffer = handleData(sock, Buffer.concat([buffer, data]), sock.room);
  });
  function onLeave(s){
    const room = s.room; if(!room) return;
    room.clients.delete(s);
    // 房主离开则提拔下一位客户端为房主并解锁，避免房间被永久锁死
    if(room.owner === s._cid && room.clients.size > 0){
      room.owner = room.clients.values().next().value._cid;
      room.locked = false;
      broadcast(room, JSON.stringify({ type:'lock', locked:false, by: room.owner }));
      broadcast(room, JSON.stringify({ type:'owner', owner: room.owner, locked:false }));
    }
    presence(room); broadcastRoomList();
  }
  sock.on('close', ()=> onLeave(sock));
  sock.on('error', ()=> onLeave(sock));
});

server.listen(PORT, ()=> console.log('CollabBoard WS 服务已启动: ws://localhost:' + PORT + '  (房间通过 ?room=NAME 区分)'));

// 心跳：定期 ping，未在下一轮回 pong 的死连接直接销毁
function heartbeat(){
  for(const room of rooms.values()){
    for(const c of room.clients){
      if(c.destroyed) continue;
      if(c.alive === false){ c.destroy(); continue; }
      c.alive = false;
      c.write(Buffer.from([0x89, 0x00]));   // ping 帧
    }
  }
}
setInterval(heartbeat, HB);
