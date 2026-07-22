// CollabBoard — 零依赖 WebSocket 服务端 (RFC 6455 手写实现)
// 增强：按房间(room)命名空间隔离广播、在线人数、光标转发。
// 不依赖任何 npm 包：自己处理握手、帧解析、掩码、广播。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
    r = { clients: new Set(), strokes: [], chats: [], name, owner: null, locked: false, lockedElements: new Set(), muted: new Set(), banned: new Set(), bg: null, title: null, _chatSeq: 0, slowMode: 0, _chatAt: {} };
    const saved = store.loadRoom(name);
    if(saved){ r.strokes = saved.strokes; r.chats = saved.chats; if(typeof saved._chatSeq === 'number') r._chatSeq = saved._chatSeq; }
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
// 绕质心 (cx,cy) 将元素旋转 deg 度（仅 90° 整数倍，原地修改并返回）。
// 矢量：旋转每个点；文字/图片：旋转锚点(x,y)并累计 rot 字段供客户端渲染。
function rotateElement(el, deg, cx, cy){
  if(!el || typeof el !== 'object') return el;
  const rad = (deg % 360) * Math.PI / 180;
  const cos = Math.round(Math.cos(rad)), sin = Math.round(Math.sin(rad)); // 90°整数倍→整数
  const rot = (px, py)=>{
    const x = px - cx, y = py - cy;
    return [ x*cos - y*sin + cx, x*sin + y*cos + cy ];
  };
  if(Array.isArray(el.points)){
    for(const p of el.points){ const [nx, ny] = rot(p.x||0, p.y||0); p.x = nx; p.y = ny; }
  } else if(el.x != null || el.y != null){
    const [nx, ny] = rot(el.x||0, el.y||0); el.x = nx; el.y = ny;
    el.rot = ((el.rot||0) + deg) % 360;
  }
  return el;
}
function presence(room){
  const names = [...room.clients].map(c => c.name || ('用户' + (c._cid || '?')));
  const ids = [...room.clients].map(c => c._cid);
  const avatars = [...room.clients].map(c => c.avatar || null);
  broadcast(room, JSON.stringify({ type:'presence', count: room.clients.size, names, ids, avatars }));
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
          const EDIT_OPS = new Set(['stroke','text','image','note','move','replace','clear','undo','redo','duplicate','rotate','delete','pin','group','ungroup','align','comment']);
          if(EDIT_OPS.has(obj.type)){
            if(room.locked && sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'locked', msg:'房间已锁定，仅房主可编辑' }));
              obj = { type:'__noop__' };
            } else {
              // 元素级锁定：目标元素(支持 obj.id 或 obj.ids)被锁且非房主 → 拒绝(房间锁与元素锁独立)
              const tids = obj.id != null ? [obj.id] : (Array.isArray(obj.ids) ? obj.ids : (obj.stroke && obj.stroke.id != null ? [obj.stroke.id] : null));
              if(tids && tids.some(id => room.lockedElements.has(id)) && sock._cid !== room.owner){
                sendFrame(sock, JSON.stringify({ type:'error', code:'element_locked', msg:'该元素已被锁定，仅房主可编辑' }));
                obj = { type:'__noop__' };
              }
            }
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
              // 编辑已有文字：若提供了已存在的 text 元素 id，则原地更新其字段（保留 id/author）
              const existing = (obj.id != null) ? room.strokes.find(el => el && el.id === obj.id) : null;
              if(existing && existing.type === 'text'){
                const idx = room.strokes.indexOf(existing);
                const updated = Object.assign({}, existing, {
                  text: obj.text.slice(0, 200),
                  x: obj.x !== undefined ? (+obj.x || 0) : existing.x,
                  y: obj.y !== undefined ? (+obj.y || 0) : existing.y,
                  width: obj.width !== undefined ? (+obj.width || 16) : existing.width
                });
                if(typeof obj.color === 'string') updated.color = obj.color;
                const newArr = room.strokes.slice();
                newArr[idx] = updated;
                hist.commitStrokes(room, newArr);   // 旧状态进撤销栈，room.strokes 变 newArr（沿用 ci79 修复后的正确顺序）
                broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
                store.saveRoom(room.name, room);
                break;
              }
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
          case 'note':
            if(typeof obj.text !== 'string' || !obj.text.trim()) break;
            {
              const note = { type:'note', id: obj.id != null ? obj.id : (sock._cid + ':' + (++strokeSeq)),
                x: +obj.x||0, y: +obj.y||0,
                w: Math.max(40, Math.min(640, +obj.w||160)),
                h: Math.max(30, Math.min(480, +obj.h||120)),
                text: obj.text.slice(0, 280).trim(),
                color: (typeof obj.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.color)) ? obj.color : '#ffe066',
                author: sock._cid, authorColor: sock.color };
              hist.commitStrokes(room, room.strokes.concat(note));
              broadcast(room, JSON.stringify(note), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'pin':
            if(obj.x == null || obj.y == null) break;
            {
              const pin = { type:'pin', id: obj.id != null ? obj.id : (sock._cid + ':' + (++strokeSeq)),
                x: +obj.x||0, y: +obj.y||0,
                label: typeof obj.label === 'string' ? obj.label.slice(0,30) : '',
                author: sock._cid, authorColor: sock.color };
              hist.commitStrokes(room, room.strokes.concat(pin));
              broadcast(room, JSON.stringify(pin), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'comment':
            if(typeof obj.id !== 'string' || !obj.id) break;
            if(typeof obj.text !== 'string' || !obj.text.trim()) break;
            {
              const el = room.strokes.find(s => s && s.id === obj.id);
              if(!el){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_element', msg:'评论的元素不存在' })); break; }
              const comment = { author: sock._cid, authorColor: sock.color, text: obj.text.slice(0,200).trim(), ts: Date.now() };
              if(!Array.isArray(el.comments)) el.comments = [];
              el.comments.push(comment);                         // el 是 room.strokes 中元素的引用，原地追加即可持久化
              broadcast(room, JSON.stringify({ type:'comment', id: obj.id, comment }), sock);
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
          case 'zorder':
            {
              const ids = (obj.ids && Array.isArray(obj.ids)) ? obj.ids : (obj.id != null ? [obj.id] : null);
              const action = obj.action;
              if(!ids || ids.length === 0) break;
              if(!['front','back','raise','lower'].includes(action)) break;
              const set = new Set(ids);
              const sel = room.strokes.filter(el => el && set.has(el.id));
              if(sel.length === 0) break;                 // 没有命中任何 id 则忽略
              let arr = room.strokes.slice();
              if(action === 'front')      arr = arr.filter(el => !(el && set.has(el.id))).concat(sel);          // 置顶（数组末尾 = 最上层）
              else if(action === 'back')  arr = sel.concat(arr.filter(el => !(el && set.has(el.id))));          // 置底（数组开头 = 最底层）
              else if(action === 'raise'){
                for(let i = arr.length - 1; i >= 0; i--){
                  if(set.has(arr[i].id)){
                    let j = i + 1; while(j < arr.length && set.has(arr[j].id)) j++;
                    if(j < arr.length){ const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
                  }
                }
              } else { // lower
                for(let i = 0; i < arr.length; i++){
                  if(set.has(arr[i].id)){
                    let j = i - 1; while(j >= 0 && set.has(arr[j].id)) j--;
                    if(j >= 0){ const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
                  }
                }
              }
              hist.commitStrokes(room, arr);   // 传新数组，commitStrokes 内部 push 旧 strokes 进撤销栈
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }));
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
          case 'duplicate':
            {
              const ids = (obj.ids && Array.isArray(obj.ids)) ? obj.ids
                        : (obj.id != null ? [obj.id] : null);
              if(!ids || ids.length === 0) break;
              const set = new Set(ids);
              const news = [];
              for(const el of room.strokes){
                if(el && set.has(el.id)){
                  const c = JSON.parse(JSON.stringify(el));   // 深拷贝，断开引用
                  c.id = sock._cid + ':' + (++strokeSeq);    // 服务端权威新 id
                  c.author = sock._cid; c.authorColor = sock.color;
                  if(c.type === 'text'){ c.x = (c.x||0) + 20; c.y = (c.y||0) + 20; }
                  else if(Array.isArray(c.points)){ for(const p of c.points){ p.x = (p.x||0) + 20; p.y = (p.y||0) + 20; } }
                  else if(c.x != null || c.y != null){ c.x = (c.x||0) + 20; c.y = (c.y||0) + 20; }
                  news.push(c);
                }
              }
              if(news.length === 0) break;
              hist.commitStrokes(room, room.strokes.concat(news));   // 传新数组，旧状态进撤销栈
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'rotate':
            {
              const ids = (obj.ids && Array.isArray(obj.ids)) ? obj.ids
                        : (obj.id != null ? [obj.id] : null);
              let deg = Math.round(+obj.deg || 0);
              if(!ids || ids.length === 0 || deg === 0) break;
              if(deg % 90 !== 0) break;                       // 仅支持 90° 整数倍
              deg = ((deg % 360) + 360) % 360;                // 归一化到 [0,360)
              const set = new Set(ids);
              const sel = room.strokes.filter(el => el && set.has(el.id));
              if(sel.length === 0) break;                    // 没命中任何 id 则忽略
              // 组质心：所有选中元素锚点（points 平均 / x,y）的均值
              let sx = 0, sy = 0, cnt = 0;
              for(const el of sel){
                if(Array.isArray(el.points)){ for(const p of el.points){ sx += (p.x||0); sy += (p.y||0); cnt++; } }
                else { sx += (el.x||0); sy += (el.y||0); cnt++; }
              }
              const cx = cnt ? sx / cnt : 0, cy = cnt ? sy / cnt : 0;
              // 深拷贝选中元素后再旋转，避免原地修改污染撤销栈快照（历史需保留旋转前状态）
              const arr = room.strokes.map(el => {
                if(!set.has(el.id)) return el;
                const c = JSON.parse(JSON.stringify(el));
                return rotateElement(c, deg, cx, cy);
              });
              hist.commitStrokes(room, arr);                   // 传新数组，旧状态进撤销栈
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'delete':
            {
              const ids = (obj.ids && Array.isArray(obj.ids)) ? obj.ids
                        : (obj.id != null ? [obj.id] : null);
              if(!ids || ids.length === 0) break;
              const set = new Set(ids);
              for(const id of ids) room.lockedElements.delete(id);   // 删除同时解除元素锁定
              const before = room.strokes.length;
              const arr = room.strokes.filter(el => !(el && set.has(el.id)));
              if(arr.length === before) break;                 // 无命中任何 id 则忽略
              hist.commitStrokes(room, arr);                   // 传新数组，旧状态进撤销栈
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'group':
            {
              const ids = Array.isArray(obj.ids) ? obj.ids : null;
              const gid = obj.group;
              if(!ids || ids.length === 0 || typeof gid !== 'string' || !gid) break;
              const set = new Set(ids);
              let changed = 0;
              const arr = room.strokes.map(el => {
                if(el && set.has(el.id) && !el.group){ const c = JSON.parse(JSON.stringify(el)); c.group = gid; changed++; return c; }
                return el;
              });
              if(changed === 0) break;
              hist.commitStrokes(room, arr);
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'ungroup':
            {
              const ids = Array.isArray(obj.ids) ? obj.ids : null;
              if(!ids || ids.length === 0) break;
              const set = new Set(ids);
              let changed = 0;
              const arr = room.strokes.map(el => {
                if(el && set.has(el.id) && el.group){ const c = JSON.parse(JSON.stringify(el)); delete c.group; changed++; return c; }
                return el;
              });
              if(changed === 0) break;
              hist.commitStrokes(room, arr);
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'align':
            {
              const ids = Array.isArray(obj.ids) ? obj.ids : null;
              const how = obj.how;
              const HORIZ = new Set(['left','center','right']), VERT = new Set(['top','middle','bottom']);
              if(!ids || ids.length === 0 || (!HORIZ.has(how) && !VERT.has(how))) break;
              const set = new Set(ids);
              const sel = room.strokes.filter(el => el && set.has(el.id));
              if(sel.length === 0) break;
              // 单元素对齐无意义
              if(sel.length === 1) break;
              // 元素包围盒
              const bboxOf = (el) => {
                if(Array.isArray(el.points) && el.points.length){
                  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
                  for(const p of el.points){ x0=Math.min(x0,p.x||0); y0=Math.min(y0,p.y||0); x1=Math.max(x1,p.x||0); y1=Math.max(y1,p.y||0); }
                  return { x0, y0, x1, y1 };
                }
                const x = el.x||0, y = el.y||0; return { x0:x, y0:y, x1:x, y1:y };
              };
              // 选区整体包围盒
              let sX0=Infinity,sY0=Infinity,sX1=-Infinity,sY1=-Infinity;
              for(const el of sel){ const b = bboxOf(el); sX0=Math.min(sX0,b.x0); sY0=Math.min(sY0,b.y0); sX1=Math.max(sX1,b.x1); sY1=Math.max(sY1,b.y1); }
              const sCx = (sX0+sX1)/2, sCy = (sY0+sY1)/2;
              const translate = (el, dx, dy) => {
                const c = JSON.parse(JSON.stringify(el));
                if(Array.isArray(c.points)){ for(const p of c.points){ p.x=(p.x||0)+dx; p.y=(p.y||0)+dy; } }
                else { c.x=(c.x||0)+dx; c.y=(c.y||0)+dy; }
                return c;
              };
              const arr = room.strokes.map(el => {
                if(!set.has(el.id)) return el;
                const b = bboxOf(el);
                let dx = 0, dy = 0;
                if(HORIZ.has(how)){
                  if(how === 'left') dx = sX0 - b.x0;
                  else if(how === 'right') dx = sX1 - b.x1;
                  else dx = sCx - (b.x0+b.x1)/2;            // center
                }
                if(VERT.has(how)){
                  if(how === 'top') dy = sY0 - b.y0;
                  else if(how === 'bottom') dy = sY1 - b.y1;
                  else dy = sCy - (b.y0+b.y1)/2;            // middle
                }
                return translate(el, dx, dy);
              });
              hist.commitStrokes(room, arr);
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'cursor':  broadcast(room, msg, sock); break;       // 不存储，仅转发
          case 'ping':    // 元素提醒：广播给其他人（带作者名/色），不落库、不受房间锁限制
            if(typeof obj.id === 'string' && obj.id){
              broadcast(room, JSON.stringify({ type:'ping', id: obj.id, author: sock._cid, name: sock.name || '匿名', color: sock.color }), sock);
            }
            break;
          case 'select':  // 选区在场：广播当前选择给他人（不落库、不受锁限制），便于看到协作者的选择
            if(Array.isArray(obj.ids)){
              broadcast(room, JSON.stringify({ type:'select', ids: obj.ids, author: sock._cid, name: sock.name || '匿名', color: sock.color }), sock);
            }
            break;
          case 'laser':   // 临时激光笔：不存储、不入库、不受房间锁限制，仅实时转发给他人
            if(typeof obj.x === 'number' && typeof obj.y === 'number'){
              broadcast(room, JSON.stringify({ type:'laser', x: obj.x, y: obj.y, color: sock.color, author: sock._cid, name: sock.name || '匿名' }), sock);
            }
            break;
          case 'laser_end':
            broadcast(room, JSON.stringify({ type:'laser_end', author: sock._cid }), sock);
            break;
          case 'typing':
            broadcast(room, JSON.stringify({ type:'typing', id: sock._cid, name: sock.name || '匿名', on: obj.on !== false }), sock);
            break;                                      // 不存储，仅转发
          case 'react':
            { // 即时表情回应(👍🎉…)：不落库、不受房间锁限制、不回显给发送者，仅实时转发给他人
              const emoji = (typeof obj.emoji === 'string') ? String(obj.emoji).slice(0, 8) : '';
              if(!emoji) break;
              broadcast(room, JSON.stringify({ type:'react', id: sock._cid, name: sock.name || '匿名', color: sock.color || '#888', emoji }), sock);
            }
            break;
          case 'set_name':
            sock.name = String(obj.name || '').slice(0, 24) || sock.name;
            presence(room); break;
          case 'set_avatar':
            sock.avatar = String(obj.avatar || '').slice(0, 8) || sock.avatar;
            broadcast(room, JSON.stringify({ type:'avatar', id: sock._cid, avatar: sock.avatar }));  // 广播头像给他人(不落库)
            break;
          case 'set_bg':
            if(room.owner && sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能设置背景' })); break; }
            const raw = obj.color;
            let color = null;
            if(raw){ const s = String(raw).trim(); if(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) color = s.toLowerCase(); else { sendFrame(sock, JSON.stringify({ type:'error', code:'bad_color', msg:'背景色需为 #rgb 或 #rrggbb' })); break; } }
            room.bg = color;
            broadcast(room, JSON.stringify({ type:'bg', color, by: room.owner }));   // 广播给所有人(含房主)以服务端为准
            break;
          case 'set_title':
            if(room.owner && sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能设置看板标题' })); break; }
            const rawTitle = obj.title;
            let title = null;
            if(rawTitle != null){ const s = String(rawTitle).trim().slice(0, 80); title = s.length ? s : null; }
            room.title = title;
            broadcast(room, JSON.stringify({ type:'title', title, by: room.owner }));   // 广播给所有人(含房主)
            break;
          case 'slow_mode': {   // 房主设置慢速模式：聊天最短间隔 seconds(0=关闭)，服务端在 chat 时强制限频
            if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'仅房主可设置慢速模式' })); break; }
            const s = Math.max(0, Math.min(3600, (obj.seconds|0) || 0));
            room.slowMode = s; room._chatAt = {};
            broadcast(room, JSON.stringify({ type:'slow_mode', seconds: s, by: room.owner }));
            store.saveRoom(room.name, room); break;
          }
          case 'whisper': {   // 私聊：仅把消息发给指定 cid 的成员(服务端定向转发，不广播)
            if(typeof obj.text !== 'string') break;
            const to = obj.to;
            if(!to){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_target', msg:'whisper 需要目标 cid' })); break; }
            let found = null;
            for(const c of room.clients){ if(c._cid === to){ found = c; break; } }
            if(!found){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_client', msg:'找不到该成员' })); break; }
            const wmsg = { type:'whisper', from: sock._cid || '?', name: sock.name || '匿名', text: obj.text.slice(0, 500), t: Date.now() };
            sendFrame(found, JSON.stringify(wmsg));   // 仅发给目标成员
            break;
          }
          case 'chat':
            if(typeof obj.text !== 'string') break;
            if(room.muted.has(sock._cid)){ sendFrame(sock, JSON.stringify({ type:'error', code:'muted', msg:'你已被房主禁言' })); break; }
            if(room.slowMode > 0){
              const now = Date.now();
              const last = room._chatAt[sock._cid] || 0;
              const gap = room.slowMode * 1000 - (now - last);
              if(gap > 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'slow_mode', msg:'发言过于频繁，请 ' + Math.ceil(gap/1000) + 's 后再试' })); break; }
              room._chatAt[sock._cid] = now;
            }
            const chat = { type:'chat', id: sock._cid || '?', name: sock.name || '匿名', text: obj.text.slice(0, 500), t: Date.now(), mid: ++room._chatSeq };
            room.chats.push(chat);
            if(room.chats.length > 50) room.chats.shift();
            broadcast(room, JSON.stringify(chat), sock);   // 仅转发给他人
            store.saveRoom(room.name, room); break;
          case 'clear_chat':   // 清空房间聊天记录（任何人可触发，常用于清屏刷屏内容）
            room.chats = [];
            broadcast(room, JSON.stringify({ type:'clear_chat', by: sock._cid, name: sock.name || '匿名' }));
            store.saveRoom(room.name, room); break;
          case 'delete_chat':  // 删除单条聊天（按 mid 定位，仅删除存在的消息）
            if(typeof obj.mid !== 'number'){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_mid', msg:'delete_chat 需要数值 mid' })); break; }
            const before = room.chats.length;
            room.chats = room.chats.filter(c => c.mid !== obj.mid);
            if(room.chats.length !== before){
              broadcast(room, JSON.stringify({ type:'chat_deleted', mid: obj.mid, by: sock._cid }));
              store.saveRoom(room.name, room);
            } else {
              sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_chat', msg:'找不到该聊天消息' }));
            }
            break;
          case 'request_snapshot': sendFrame(sock, JSON.stringify({ type:'snapshot', strokes: room.strokes, chats: room.chats })); break;
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
          case 'request_unlock':  // 非房主向房主申请解锁房间（仅通知房主，不直接改状态）
            if(sock._cid === room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'already_owner', msg:'你就是房主，可直接解锁' }));
              break;
            }
            if(!room.locked){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_locked', msg:'房间未锁定，无需申请解锁' }));
              break;
            }
            let ownerSock = null;
            for(const c of room.clients){ if(c._cid === room.owner){ ownerSock = c; break; } }
            if(ownerSock) sendFrame(ownerSock, JSON.stringify({ type:'unlock_request', id: sock._cid, name: sock.name || '匿名' }));
            sendFrame(sock, JSON.stringify({ type:'ok', op:'request_unlock' }));
            break;
          case 'lock_element':
            if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能锁定元素' })); break; }
            { const lids = (Array.isArray(obj.ids) && obj.ids.length) ? obj.ids : (obj.id != null ? [obj.id] : null);
              if(!lids){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_id', msg:'缺少元素 id' })); break; }
              for(const id of lids) room.lockedElements.add(id);
              broadcast(room, JSON.stringify({ type:'lock_element', ids: lids, locked:true, by: room.owner }));
              store.saveRoom(room.name, room); }
            break;
          case 'unlock_element':
            if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能解锁元素' })); break; }
            { const lids = (Array.isArray(obj.ids) && obj.ids.length) ? obj.ids : (obj.id != null ? [obj.id] : null);
              if(!lids){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_id', msg:'缺少元素 id' })); break; }
              for(const id of lids) room.lockedElements.delete(id);
              broadcast(room, JSON.stringify({ type:'lock_element', ids: lids, locked:false, by: room.owner }));
              store.saveRoom(room.name, room); }
            break;
          case 'transfer':
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能转让房主' }));
              break;
            }
            if(typeof obj.toId !== 'string' || obj.toId.length === 0){
              sendFrame(sock, JSON.stringify({ type:'error', code:'bad_to', msg:'transfer 需要有效的 toId' }));
              break;
            }
            let found = false;
            for(const c of room.clients){ if(c._cid === obj.toId){ found = true; break; } }
            if(!found){
              sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'目标用户不在房间内' }));
              break;
            }
            room.owner = obj.toId;
            broadcast(room, JSON.stringify({ type:'owner', owner: room.owner, locked: !!room.locked }));
            break;
          case 'kick':    // 房主踢人：关闭目标连接并广播通知（被踢者不回显）
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能踢人' }));
              break;
            }
            if(typeof obj.toId !== 'string' || obj.toId.length === 0){
              sendFrame(sock, JSON.stringify({ type:'error', code:'bad_to', msg:'kick 需要有效的 toId' }));
              break;
            }
            if(obj.toId === room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'kick_self', msg:'不能踢出房主本人' }));
              break;
            }
            let target = null;
            for(const c of room.clients){ if(c._cid === obj.toId){ target = c; break; } }
            if(!target){
              sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'目标用户不在房间内' }));
              break;
            }
            broadcast(room, JSON.stringify({ type:'kicked', id: obj.toId, by: room.owner }), target);
            target.destroy();   // 关闭被踢者连接（触发 onLeave，更新 presence/房间列表）
            break;
          case 'mute':     // 房主禁言：将目标加入 muted 集合，chat 时服务端拦截
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能禁言' }));
              break;
            }
            if(typeof obj.toId !== 'string' || obj.toId.length === 0){
              sendFrame(sock, JSON.stringify({ type:'error', code:'bad_to', msg:'mute 需要有效的 toId' }));
              break;
            }
            if(obj.toId === room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'mute_self', msg:'不能禁言房主本人' }));
              break;
            }
            { let mt = null; for(const c of room.clients){ if(c._cid === obj.toId){ mt = c; break; } }
              if(!mt){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'目标用户不在房间内' })); break; }
              room.muted.add(obj.toId);
              broadcast(room, JSON.stringify({ type:'muted', id: obj.toId, by: room.owner }));
              sendFrame(mt, JSON.stringify({ type:'you_muted', by: room.owner }));
            }
            break;
          case 'unmute':   // 房主解禁：从 muted 集合移除目标
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能解禁' }));
              break;
            }
            if(typeof obj.toId !== 'string' || obj.toId.length === 0){
              sendFrame(sock, JSON.stringify({ type:'error', code:'bad_to', msg:'unmute 需要有效的 toId' }));
              break;
            }
            { let mu = null; for(const c of room.clients){ if(c._cid === obj.toId){ mu = c; break; } }
              if(!mu){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'目标用户不在房间内' })); break; }
              room.muted.delete(obj.toId);
              broadcast(room, JSON.stringify({ type:'unmuted', id: obj.toId, by: room.owner }));
              sendFrame(mu, JSON.stringify({ type:'you_unmuted', by: room.owner }));
            }
            break;
          case 'mute_all':   // 房主全员禁言：将所有非房主成员加入 muted 集合并分别通知
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能全员禁言' }));
              break;
            }
            for(const c of room.clients){
              if(c._cid === room.owner) continue;
              room.muted.add(c._cid);
              sendFrame(c, JSON.stringify({ type:'you_muted', by: room.owner }));
            }
            broadcast(room, JSON.stringify({ type:'muted_all', by: room.owner }));
            break;
          case 'unmute_all':   // 房主全员解禁：清空 muted 集合并广播
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能全员解禁' }));
              break;
            }
            room.muted.clear();
            broadcast(room, JSON.stringify({ type:'unmuted_all', by: room.owner }));
            break;
          case 'rename':    // 房主重命名房间：内存重键 + 广播 + 尽力重命名持久化文件
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能重命名房间' }));
              break;
            }
            const rawName = (typeof obj.name === 'string') ? obj.name.trim() : '';
            if(rawName.length === 0 || rawName.length > 40 || /[\/\\]/.test(rawName) || rawName.includes('..')){
              sendFrame(sock, JSON.stringify({ type:'error', code:'bad_name', msg:'房间名需为 1-40 字符且不含 / \\ ..' }));
              break;
            }
            if(rawName === room.name){ sendFrame(sock, JSON.stringify({ type:'error', code:'same_name', msg:'新名称与当前相同' })); break; }
            if(rooms.has(rawName)){ sendFrame(sock, JSON.stringify({ type:'error', code:'name_taken', msg:'该房间名已被占用' })); break; }
            { const oldName = room.name;
              rooms.delete(oldName);
              room.name = rawName;
              rooms.set(rawName, room);
              for(const c of room.clients){ c.roomName = rawName; }   // 同步各客户端记录的房间名
              try { const of = store.roomFile(oldName), nf = store.roomFile(rawName); if(fs.existsSync(of)) fs.renameSync(of, nf); } catch(e){ /* 持久化失败不阻断内存重命名 */ }
              broadcast(room, JSON.stringify({ type:'room_renamed', from: oldName, to: rawName, by: room.owner }));
              broadcastRoomList();
            }
            break;
          case 'ban':      // 房主封禁：加入 banned 集合，广播通知，断开目标连接（同身份重连将被拒绝）
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能封禁' }));
              break;
            }
            if(typeof obj.toId !== 'string' || obj.toId.length === 0){
              sendFrame(sock, JSON.stringify({ type:'error', code:'bad_to', msg:'ban 需要有效的 toId' }));
              break;
            }
            if(obj.toId === room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'ban_self', msg:'不能封禁房主本人' }));
              break;
            }
            { let b = null; for(const c of room.clients){ if(c._cid === obj.toId){ b = c; break; } }
              if(!b){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'目标用户不在房间内' })); break; }
              room.banned.add(obj.toId);
              broadcast(room, JSON.stringify({ type:'banned', ids:[...room.banned], by: room.owner }));
              try { b.destroy(); } catch(e){}
            }
            break;
          case 'clear_room':   // 房主清空房间：清掉所有笔画与聊天记录，并重置撤销栈
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能清空房间' }));
              break;
            }
            room.strokes = [];
            room.chats = [];
            room.undoStack = [];
            room.redoStack = [];
            broadcast(room, JSON.stringify({ type:'room_cleared', by: room.owner }));
            store.saveRoom(room.name, room);
            break;
          case 'kick_all':   // 房主踢出除自己外的全部成员
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能踢出所有人' }));
              break;
            }
            broadcast(room, JSON.stringify({ type:'kicked_all', by: room.owner }));
            for(const c of [...room.clients]){
              if(c._cid === room.owner) continue;
              try { c.destroy(); } catch(e){}
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
      const _rc = (head.match(/[?&]cid=([a-z0-9]{1,12})/i) || [])[1];
      sock._cid = _rc || Math.random().toString(36).slice(2, 8);
      sock.name = null;
      sock.color = PALETTE[(connSeq++) % PALETTE.length];
      sock.alive = true;
      if(room.banned && room.banned.has(sock._cid)){ sendFrame(sock, JSON.stringify({ type:'error', code:'banned', msg:'你已被房主封禁' })); sock.end(); return; }
      room.clients.add(sock);
      if(room.owner == null) room.owner = sock._cid;          // 首个加入者成为房主
      broadcast(room, JSON.stringify({ type:'owner', owner: room.owner, locked: !!room.locked }));
      sock.room = room;
      sock.roomName = roomName;
      buffer = buffer.slice(idx + 4);
      sendFrame(sock, JSON.stringify({ type:'welcome', id: sock._cid, color: sock.color, room: roomName }));
      sendFrame(sock, JSON.stringify({ type:'snapshot', strokes: room.strokes, chats: room.chats, room: roomName }));
      if(room.bg) sendFrame(sock, JSON.stringify({ type:'bg', color: room.bg, by: room.owner }));  // 迟到者也能拿到当前背景
      if(room.title) sendFrame(sock, JSON.stringify({ type:'title', title: room.title, by: room.owner }));  // 迟到者也能拿到当前标题
      if(room.lockedElements.size) sendFrame(sock, JSON.stringify({ type:'lock_element', ids: [...room.lockedElements], locked:true, by: room.owner }));  // 迟到者也能拿到已锁定元素集合
      if(room.muted.size) sendFrame(sock, JSON.stringify({ type:'muted_list', ids: [...room.muted], by: room.owner }));  // 迟到者也能拿到已禁言名单
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
