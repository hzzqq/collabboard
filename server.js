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
    r = { clients: new Set(), strokes: [], chats: [], polls: [], timers: [], name, owner: null, locked: false, lockedElements: new Set(), muted: new Set(), banned: new Set(), bg: null, title: null, _chatSeq: 0, slowMode: 0, _pollSeq: 0, _timerSeq: 0, _chatAt: {},
          followers: new Map(), views: new Map(), recording: null, _recorded: [], passwordHash: null, announcements: [], _announceAt: 0,
          snapshots: {} };
    const saved = store.loadRoom(name);
    if(saved){
      if(Array.isArray(saved.strokes)) r.strokes = saved.strokes;
      if(Array.isArray(saved.chats)) r.chats = saved.chats;
      if(typeof saved._chatSeq === 'number') r._chatSeq = saved._chatSeq;
      if(typeof saved.bg === 'string') r.bg = saved.bg;
      if(typeof saved.title === 'string') r.title = saved.title;
      if(typeof saved.permissions === 'string') r.permissions = saved.permissions;
      if(typeof saved.grid === 'boolean') r.grid = saved.grid;
      if(typeof saved.snap === 'boolean') r.snap = saved.snap;
      if(saved.lockedElements) r.lockedElements = new Set(saved.lockedElements);
      if(saved.muted) r.muted = new Set(saved.muted);
      if(saved.banned) r.banned = new Set(saved.banned);
      if(Array.isArray(saved.polls)) r.polls = saved.polls;
      if(Array.isArray(saved.timers)) r.timers = saved.timers;
      if(saved.passwordHash) r.passwordHash = saved.passwordHash;
      if(Array.isArray(saved.announcements)) r.announcements = saved.announcements;
      if(saved.snapshots && typeof saved.snapshots === 'object') r.snapshots = saved.snapshots;
    }
    rooms.set(name, r);
    hist.ensureHistory(r);
  }
  return r;
}

function acceptKey(key){ return crypto.createHash('sha1').update(key + GUID).digest('base64'); }
function sendFrame(sock, str){
  if(!sock || sock.destroyed) return;   // 隐性问题：已断开的连接直接跳过，避免 write 抛错
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if(len < 126){ header = Buffer.from([0x81, len]); }
  else if(len < 65536){ header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  try { sock.write(Buffer.concat([header, payload])); }
  catch(e){ try { sock.destroy(); } catch(_){} }
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
// 坐标/数值钳制：NaN/Infinity 归零，超出范围截断（防止非法坐标污染画板状态）
function clampCoord(v, min, max){
  const n = Number(v);
  if(!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}
// XML 转义（导出 SVG 时防止注入/解析失败）
function escapeXml(s){
  return String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c]));
}
// 密码哈希：不存明文，仅存服务端加盐哈希（隐性问题：避免密码明文落盘/泄露）
function hashPassword(pwd){
  return crypto.createHash('sha256').update('collabboard::' + String(pwd)).digest('base64');
}
const MAX_MSG = 1 << 22;   // 单帧上限 4MB，防止超大帧导致内存膨胀(DoS)
function presence(room){
  const names = [...room.clients].map(c => c.name || ('用户' + (c._cid || '?')));
  const ids = [...room.clients].map(c => c._cid);
  const avatars = [...room.clients].map(c => c.avatar || null);
  const statuses = [...room.clients].map(c => c.status || 'online');
  broadcast(room, JSON.stringify({ type:'presence', count: room.clients.size, names, ids, avatars, statuses }));
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
// 投票(协作投票/poll)辅助：统计票数与序列化（不让 voters 明细外泄）
function tallyPoll(poll){
  const n = poll.options.length;
  const counts = new Array(n).fill(0);
  for(const cid in poll.voters){ const i = poll.voters[cid]; if(Number.isInteger(i) && i >= 0 && i < n) counts[i]++; }
  poll.options.forEach((o, i) => { o.votes = counts[i]; });
}
function serializePoll(poll){
  return { pid: poll.pid, question: poll.question, options: poll.options.map(o => ({ text: o.text, votes: o.votes })),
           closed: !!poll.closed, author: poll.author, total: Object.keys(poll.voters).length };
}
function serializeTimer(t){
  return { tid: t.tid, label: t.label, total: t.total, remaining: t.remaining, running: !!t.running, author: t.author };
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
    if(len > MAX_MSG){ try { sock.destroy(); } catch(e){} return buf.slice(off); }   // 超大帧直接断连，防内存膨胀
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
          const EDIT_OPS = new Set(['stroke','text','image','note','move','replace','clear','undo','redo','duplicate','rotate','delete','pin','group','ungroup','align','comment','shape','frame','apply_template']);
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
          if(room.recording && EDIT_OPS.has(obj.type)){
            if(room.recording.ops.length < 5000){
              try { room.recording.ops.push(JSON.parse(JSON.stringify(obj))); } catch(e){}  // 隐性问题：录制长度上限，防内存膨胀
            }
          }
          switch(obj.type){
          case 'stroke':
            if(room.permissions && room.permissions !== 'all' && sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_edit_permission', msg:'当前权限下你无法编辑画板' })); break; }
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
          case 'stamp':   // 图章工具：在画布放置 emoji/短字符装饰（持久化、可撤销、进快照）
            if(typeof obj.text !== 'string' || !obj.text.trim()) break;
            {
              const stamp = { type:'stamp', id: obj.id != null ? obj.id : (sock._cid + ':' + (++strokeSeq)),
                x: +obj.x||0, y: +obj.y||0,
                text: obj.text.slice(0, 8).trim(),
                size: Math.max(8, Math.min(256, +obj.size||48)),
                color: (typeof obj.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.color)) ? obj.color : '#ffffff',
                rotation: Math.max(0, Math.min(360, +obj.rotation||0)),
                author: sock._cid, authorColor: sock.color };
              hist.commitStrokes(room, room.strokes.concat(stamp));
              broadcast(room, JSON.stringify(stamp), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'reaction': {   // 画布表情反应：飘出 emoji（瞬时、不进快照、不持久化），与 chat_react 区分
            const emoji = (typeof obj.emoji === 'string') ? String(obj.emoji).slice(0, 8).trim() : '';
            if(!emoji) break;
            const x = +obj.x || 0, y = +obj.y || 0;
            broadcast(room, JSON.stringify({ type:'reaction', emoji, x, y, by: sock._cid, name: sock.name || '匿名', color: sock.color }));
            break;
          }
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
              // ci336 隐性修复：若被删除元素正是当前演示聚焦元素，自动解除聚焦并广播，避免聚焦悬空
              if(room.elementFocus && set.has(room.elementFocus.elId)){
                const fe = room.elementFocus.elId; room.elementFocus = null;
                broadcast(room, JSON.stringify({ type:'focus_element_off', elId: fe, by: room.owner, reason:'deleted' }));
              }
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
          case 'cursor':
            broadcast(room, msg, sock);
            if(room.followers && room.followers.has(sock._cid)){   // 隐性问题：follow 模式下把光标转发给关注者
              for(const fid of room.followers.get(sock._cid)){
                for(const c of room.clients){ if(c._cid === fid && c !== sock && !c.destroyed) sendFrame(c, msg); }
              }
            }
            break;       // 不存储，仅转发
          case 'cursor_toggle':  // 显示/隐藏自己的光标，广播给他人（含 cid 与新的可见性）
            if(typeof obj.visible === 'boolean'){
              sock._cursorVisible = obj.visible;
              broadcast(room, JSON.stringify({ type:'cursor_toggle', cid: sock._cid, visible: obj.visible }), sock);
            }
            break;
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
          case 'raise_hand':   // 举手(会议场景)：不存储、实时转发给所有人(含发送者)，便于自身/他人都看到举手状态
            broadcast(room, JSON.stringify({ type:'hand', id: sock._cid, name: sock.name || '匿名', on: obj.on !== false }));
            break;
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
          case 'set_status':
            {  // 设置自身在线状态(online/away/busy 或自定义短文本)，更新后广播 presence 给全员
              const st = typeof obj.status === 'string' ? obj.status.trim().slice(0, 16) : '';
              sock.status = st || 'online';
              presence(room); break;
            }
          case 'set_permissions': {   // 房主设置编辑权限：all(默认) / host-only(仅房主可画) / view(仅房主可画，等同只读)
            if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'仅房主可设置编辑权限' })); break; }
            const mode = typeof obj.mode === 'string' ? obj.mode : '';
            if(mode !== 'all' && mode !== 'host-only' && mode !== 'view'){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_mode', msg:'mode 须为 all / host-only / view' })); break; }
            room.permissions = mode;
            broadcast(room, JSON.stringify({ type:'permissions', permissions: mode, by: room.owner }));
            store.saveRoom(room.name, room); break;
          }
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
            const chat = { type:'chat', id: sock._cid || '?', name: sock.name || '匿名', text: obj.text.slice(0, 500), t: Date.now(), mid: ++room._chatSeq, reactions: {} };
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
              if(room.pinnedChat && room.pinnedChat.mid === obj.mid){   // ci328 隐性问题：置顶消息被删除时同步取消置顶，避免悬挂引用
                room.pinnedChat = null;
                broadcast(room, JSON.stringify({ type:'chat_unpinned', mid: obj.mid, by: sock._cid, reason: 'deleted' }));
              }
              store.saveRoom(room.name, room);
            } else {
              sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_chat', msg:'找不到该聊天消息' }));
            }
            break;
          case 'react_chat': {   // 对聊天消息添加表情回应(按 mid 定位)，全员可见(含发送者)
            if(typeof obj.emoji !== 'string' || typeof obj.mid !== 'number'){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_args', msg:'react_chat 需要 emoji 与数值 mid' })); break; }
            const emoji = String(obj.emoji).slice(0, 8);
            if(!emoji) break;
            const ch = room.chats.find(c => c.mid === obj.mid);
            if(!ch){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_chat', msg:'找不到该聊天消息' })); break; }
            ch.reactions = ch.reactions || {};
            ch.reactions[emoji] = (ch.reactions[emoji] || 0) + 1;
            broadcast(room, JSON.stringify({ type:'chat_react', mid: obj.mid, emoji, by: sock._cid, name: sock.name || '匿名', reactions: ch.reactions }));
            store.saveRoom(room.name, room); break;
          }
          case 'edit_chat': {   // 编辑自己的聊天消息：按 mid 定位，仅作者可改，广播 chat_updated
            if(typeof obj.text !== 'string' || typeof obj.mid !== 'number'){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_args', msg:'edit_chat 需要 text 与数值 mid' })); break; }
            const ch = room.chats.find(c => c.mid === obj.mid);
            if(!ch){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_chat', msg:'找不到该聊天消息' })); break; }
            if(ch.id !== sock._cid){ sendFrame(sock, JSON.stringify({ type:'error', code:'forbidden', msg:'只能编辑自己的消息' })); break; }
            ch.text = obj.text.slice(0, 500);
            ch.edited = true;
            broadcast(room, JSON.stringify({ type:'chat_updated', mid: obj.mid, text: ch.text, edited: true, by: sock._cid, name: sock.name || '匿名' }));
            store.saveRoom(room.name, room); break;
          }
          case 'create_poll': {   // 发起协作投票：question + 选项(≥2)，全员可见(含发起者)
            const q = (typeof obj.question === 'string') ? String(obj.question).slice(0, 200) : '';
            const opts = Array.isArray(obj.options) ? obj.options.map(o => String(o).slice(0, 80)).filter(Boolean).slice(0, 10) : [];
            if(!q || opts.length < 2){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_args', msg:'create_poll 需要 question 与至少 2 个选项' })); break; }
            const pid = ++room._pollSeq;
            const poll = { pid, question: q, options: opts.map(t => ({ text: t, votes: 0 })), voters: {}, closed: false, author: sock._cid };
            room.polls.push(poll);
            broadcast(room, JSON.stringify({ type:'poll_created', poll: serializePoll(poll), by: sock._cid, name: sock.name || '匿名' }));
            store.saveRoom(room.name, room); break;
          }
          case 'vote_poll': {     // 投票：按 pid + optionIndex 计票，允许改票(以最后一次为准)，全员可见
            const pid = obj.pid, idx = obj.optionIndex;
            const poll = room.polls.find(p => p.pid === pid);
            if(!poll){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_poll', msg:'找不到该投票' })); break; }
            if(poll.closed){ sendFrame(sock, JSON.stringify({ type:'error', code:'poll_closed', msg:'投票已结束' })); break; }
            if(!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_args', msg:'optionIndex 越界' })); break; }
            poll.voters[sock._cid] = idx;
            tallyPoll(poll);
            broadcast(room, JSON.stringify({ type:'poll_updated', poll: serializePoll(poll) }));
            store.saveRoom(room.name, room); break;
          }
          case 'close_poll': {    // 结束投票：仅发起者可关闭，关闭后不再计票
            const pid = obj.pid;
            const poll = room.polls.find(p => p.pid === pid);
            if(!poll){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_poll', msg:'找不到该投票' })); break; }
            if(poll.author !== sock._cid){ sendFrame(sock, JSON.stringify({ type:'error', code:'forbidden', msg:'只有发起者可结束投票' })); break; }
            poll.closed = true;
            tallyPoll(poll);
            broadcast(room, JSON.stringify({ type:'poll_updated', poll: serializePoll(poll), closed: true }));
            store.saveRoom(room.name, room); break;
          }
          case 'create_timer': {   // 协作倒计时：label + 秒数，服务端权威计时(每秒 tick)，全员可见
            const label = (typeof obj.label === 'string') ? String(obj.label).slice(0, 40).trim() : '';
            const total = Math.max(1, Math.min(3600, Math.trunc(+obj.seconds || 0)));
            if(!label || !total){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_args', msg:'create_timer 需要 label 与正整数 seconds' })); break; }
            const tid = ++room._timerSeq;
            const t = { tid, label, total, remaining: total, running: true, author: sock._cid };
            room.timers.push(t);
            broadcast(room, JSON.stringify({ type:'timer_created', timer: serializeTimer(t), by: sock._cid, name: sock.name || '匿名' }), sock);
            store.saveRoom(room.name, room); break;
          }
          case 'timer_control': {   // 暂停/继续/重置/停止倒计时
            const tid = obj.tid; const t = room.timers.find(x => x.tid === tid);
            if(!t){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_timer', msg:'找不到该计时器' })); break; }
            const action = obj.action;
            if(action === 'pause') t.running = false;
            else if(action === 'resume') t.running = true;
            else if(action === 'reset'){ t.remaining = t.total; t.running = false; }
            else if(action === 'stop'){
              room.timers = room.timers.filter(x => x.tid !== tid);
              broadcast(room, JSON.stringify({ type:'timer_removed', tid }));
              store.saveRoom(room.name, room); break;
            }
            else { sendFrame(sock, JSON.stringify({ type:'error', code:'bad_args', msg:'timer_control 需要 action: pause/resume/reset/stop' })); break; }
            broadcast(room, JSON.stringify({ type:'timer_updated', timer: serializeTimer(t) }));
            store.saveRoom(room.name, room); break;
          }
          case 'request_snapshot': sendFrame(sock, JSON.stringify({ type:'snapshot', strokes: room.strokes, chats: room.chats, polls: room.polls.map(serializePoll), timers: room.timers.map(serializeTimer), bg: room.bg, title: room.title, permissions: room.permissions || 'all', grid: !!room.grid, snap: !!room.snap, locked: !!room.locked, owner: room.owner, stars: room.stars || {}, layerNames: room.layerNames || {} })); break;  // 隐性问题：快照补齐房间元数据(含 ci348 stars / ci352 layerNames)，迟到者/导出一致
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
          case 'save_snapshot':   // 房主把当前画板元素存为命名快照（内存 + 持久化 saveRoom）
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能保存快照' }));
              break;
            }
            { const name = (typeof obj.name === 'string') ? obj.name.trim() : '';
              if(!name){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_name', msg:'save_snapshot 需要 name' })); break; }
              room.snapshots = room.snapshots || {};
              room.snapshots[name] = Array.isArray(room.strokes) ? room.strokes.slice() : [];
              broadcast(room, JSON.stringify({ type:'snapshot_saved', name, count: room.snapshots[name].length, by: room.owner }));
              store.saveRoom(room.name, room); }
            break;
          case 'list_snapshots':   // 返回已有快照名列表（含各快照元素数），任何人可查
            { room.snapshots = room.snapshots || {};
              const names = Object.keys(room.snapshots).map(n => ({ name:n, count:(room.snapshots[n]||[]).length }));
              sendFrame(sock, JSON.stringify({ type:'snapshot_list', snapshots: names })); }
            break;
          case 'voice_signal':   // WebRTC 信令中转：仅转发给 to 指定的客户端，不广播
            { const to = obj.to;
              if(typeof to !== 'string' || !to){
                sendFrame(sock, JSON.stringify({ type:'error', code:'bad_to', msg:'voice_signal 需要 to(目标 cid)' }));
                break;
              }
              let vtarget = null;
              for(const c of room.clients){ if(c._cid === to){ vtarget = c; break; } }
              if(!vtarget){
                sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'voice_signal 目标不在房间内' }));
                break;
              }
              sendFrame(vtarget, JSON.stringify({ type:'voice_signal', from: sock._cid, signal: obj.signal || null })); }
            break;
          case 'mute_user':   // 房主禁言指定用户：room.muted.add(cid)，广播 {type:'muted', cid}
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能禁言' }));
              break;
            }
            { const to = obj.toId;
              if(typeof to !== 'string' || !to){
                sendFrame(sock, JSON.stringify({ type:'error', code:'bad_to', msg:'mute_user 需要 toId' }));
                break;
              }
              if(to === room.owner){
                sendFrame(sock, JSON.stringify({ type:'error', code:'mute_self', msg:'不能禁言房主本人' }));
                break;
              }
              let mt = null; for(const c of room.clients){ if(c._cid === to){ mt = c; break; } }
              if(!mt){
                sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'目标用户不在房间内' }));
                break;
              }
              room.muted.add(to);
              room.muted[to] = true;   // 显式置属性位，兼容按对象访问
              broadcast(room, JSON.stringify({ type:'muted', cid: to, by: room.owner })); }
            break;
          case 'clear_layer':   // 清空指定图层：房主或该层作者可操作，移除 layerId 匹配的元素
            { const layerId = obj.layerId;
              if(typeof layerId !== 'string' || !layerId){
                sendFrame(sock, JSON.stringify({ type:'error', code:'bad_layer', msg:'clear_layer 需要 layerId' }));
                break;
              }
              const authors = new Set(room.strokes.filter(el => el && el.layerId === layerId).map(el => el.author));
              if(sock._cid !== room.owner && !authors.has(sock._cid)){
                sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主或该层作者能清空图层' }));
                break;
              }
              const before = room.strokes.length;
              room.strokes = room.strokes.filter(el => !(el && el.layerId === layerId));
              const removed = before - room.strokes.length;
              if(removed > 0){
                hist.commitStrokes(room, room.strokes);
                broadcast(room, JSON.stringify({ type:'layer_cleared', layerId, by: sock._cid, removed }));
                store.saveRoom(room.name, room);
              } else {
                sendFrame(sock, JSON.stringify({ type:'ok', op:'clear_layer', removed: 0 }));
              } }
            break;
          case 'lock_board':   // 房主切换整板锁定，广播 {type:'board_locked', locked}
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能锁定整板' }));
              break;
            }
            { room.locked = !room.locked;
              broadcast(room, JSON.stringify({ type:'board_locked', locked: room.locked, by: room.owner }));
              store.saveRoom(room.name, room); }
            break;
          case 'lock_layer':   // 房主锁定/解锁某图层：room.lockedLayers Set，广播
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能锁定图层' }));
              break;
            }
            { const layerId = obj.layerId;
              if(typeof layerId !== 'string' || !layerId){
                sendFrame(sock, JSON.stringify({ type:'error', code:'bad_layer', msg:'lock_layer 需要 layerId' }));
                break;
              }
              room.lockedLayers = room.lockedLayers || new Set();
              const locked = obj.locked !== false;   // 默认锁定（locked:false 表示解锁）
              if(locked) room.lockedLayers.add(layerId); else room.lockedLayers.delete(layerId);
              broadcast(room, JSON.stringify({ type:'layer_locked', layerId, locked, by: room.owner })); }
            break;
          case 'grid_toggle':   // 房主切换网格显示：room.grid 布尔，广播
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能切换网格' }));
              break;
            }
            { room.grid = obj.on === true ? true : (obj.on === false ? false : !room.grid);
              broadcast(room, JSON.stringify({ type:'grid_toggle', on: !!room.grid, by: room.owner })); }
            break;
          case 'snap_toggle':   // 房主切换吸附网格：room.snap 布尔，广播
            if(sock._cid !== room.owner){
              sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能切换吸附' }));
              break;
            }
            { room.snap = obj.on === true ? true : (obj.on === false ? false : !room.snap);
              broadcast(room, JSON.stringify({ type:'snap_toggle', on: !!room.snap, by: room.owner })); }
            break;
          case 'shape':   // 矢量图形基本图元：rect/ellipse/line/triangle（持久化、可撤销、受房间锁/元素锁约束）
            {
              const kind = (typeof obj.kind === 'string') ? obj.kind : '';
              if(!['rect','ellipse','line','triangle'].includes(kind)){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_kind', msg:'shape 需要 kind: rect/ellipse/line/triangle' })); break; }
              const x = clampCoord(obj.x, -100000, 100000), y = clampCoord(obj.y, -100000, 100000);
              const w = Math.max(1, Math.min(20000, +obj.w||100));
              const h = Math.max(1, Math.min(20000, +obj.h||100));
              const color = (typeof obj.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.color)) ? obj.color : '#ffffff';
              const fill = (typeof obj.fill === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.fill)) ? obj.fill : null;
              const sh = { type:'shape', shapeKind: kind, id: obj.id != null ? obj.id : (sock._cid + ':' + (++strokeSeq)),
                x, y, w, h, color, fill, author: sock._cid, authorColor: sock.color };
              hist.commitStrokes(room, room.strokes.concat(sh)); broadcast(room, JSON.stringify(sh), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'frame':   // 画布分区/框：带标题的分组容器（持久化、可撤销、受房间锁约束）
            {
              const label = typeof obj.label === 'string' ? obj.label.slice(0, 40).trim() : '';
              if(!label){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_label', msg:'frame 需要 label' })); break; }
              const x = clampCoord(obj.x, -100000, 100000), y = clampCoord(obj.y, -100000, 100000);
              const w = Math.max(20, Math.min(20000, +obj.w||320));
              const h = Math.max(20, Math.min(20000, +obj.h||240));
              const color = (typeof obj.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.color)) ? obj.color : '#82aaff';
              const fr = { type:'frame', id: obj.id != null ? obj.id : (sock._cid + ':' + (++strokeSeq)),
                x, y, w, h, label, color, author: sock._cid, authorColor: sock.color };
              hist.commitStrokes(room, room.strokes.concat(fr)); broadcast(room, JSON.stringify(fr), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'measure':   // 测量两点距离（瞬时、不持久化、不受房间锁限制）
            {
              const ax = +obj.ax, ay = +obj.ay, bx = +obj.bx, by = +obj.by;
              if(!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) break;  // 隐性问题：非法坐标直接忽略，不广播 NaN
              const dist = Math.hypot(bx - ax, by - ay);
              if(!Number.isFinite(dist)) break;
              broadcast(room, JSON.stringify({ type:'measure', from: sock._cid, name: sock.name || '匿名', ax, ay, bx, by, dist: Math.round(dist*100)/100 }), sock);
            }
            break;
          case 'follow':   // 关注某成员：实时转发对方光标（维护 room.followers 映射，离场自动清理）
            {
              const target = (typeof obj.toId === 'string') ? obj.toId : '';
              room.followers = room.followers || new Map();
              for(const [cid, set] of room.followers){ set.delete(sock._cid); if(set.size === 0) room.followers.delete(cid); }  // 先清除旧关注关系
              if(target && target !== sock._cid){
                let t = null; for(const c of room.clients){ if(c._cid === target){ t = c; break; } }
                if(!t){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_user', msg:'follow 目标不在房间内' })); break; }
                if(!room.followers.has(target)) room.followers.set(target, new Set());
                room.followers.get(target).add(sock._cid);
                broadcast(room, JSON.stringify({ type:'follow', from: sock._cid, name: sock.name || '匿名', toId: target }), sock);
              } else {
                broadcast(room, JSON.stringify({ type:'follow_stop', from: sock._cid }), sock);
              }
            }
            break;
          case 'save_view':   // 保存个人视口（x/y/zoom），便于协作跳转；广播给他人
            {
              const x = +obj.x||0, y = +obj.y||0, zoom = Math.max(0.1, Math.min(8, +obj.zoom||1));
              room.views = room.views || new Map();
              room.views.set(sock._cid, { x, y, zoom, name: sock.name || '匿名', t: Date.now() });
              broadcast(room, JSON.stringify({ type:'view_saved', id: sock._cid, name: sock.name || '匿名', x, y, zoom }), sock);
            }
            break;
          case 'load_view':   // 读取某成员(或自己)保存的视口
            {
              const id = (typeof obj.id === 'string') ? obj.id : sock._cid;
              room.views = room.views || new Map();
              const v = room.views.get(id);
              if(!v){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_view', msg:'没有该用户的视图' })); break; }
              sendFrame(sock, JSON.stringify({ type:'view', id, x: v.x, y: v.y, zoom: v.zoom, by: id }));
            }
            break;
          case 'resolve_comment':   // 解决/取消解决某元素的评论（按 index 或整条），广播并持久化
            {
              if(typeof obj.id !== 'string' || !obj.id){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_id', msg:'resolve_comment 需要元素 id' })); break; }
              const idx = (typeof obj.index === 'number') ? obj.index : -1;
              const el = room.strokes.find(s => s && s.id === obj.id);
              if(!el){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_element', msg:'评论的元素不存在' })); break; }
              if(!Array.isArray(el.comments) || el.comments.length === 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_comment', msg:'该元素没有评论' })); break; }
              if(idx >= 0){
                if(idx >= el.comments.length){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_index', msg:'评论索引越界' })); break; }
                el.comments[idx].resolved = obj.resolved !== false;
              } else {
                for(const c of el.comments) c.resolved = obj.resolved !== false;
              }
              broadcast(room, JSON.stringify({ type:'comment_resolved', id: obj.id, index: idx, resolved: obj.resolved !== false }));
              store.saveRoom(room.name, room);
            }
            break;
          case 'board_stats':   // 看板统计：各元素类型计数 + 在线/锁定等（便于观察房间规模与可观测性）
            {
              const count = (t)=> room.strokes.filter(s => s && s.type === t).length;
              const stats = {
                type:'board_stats',
                strokes: room.strokes.length,
                shapes: count('shape'), frames: count('frame'), texts: count('text'),
                notes: count('note'), images: count('image'), pins: count('pin'), stamps: count('stamp'),
                comments: room.strokes.reduce((a,s)=> a + (Array.isArray(s.comments)?s.comments.length:0), 0),
                chats: room.chats.length, polls: room.polls.length, timers: room.timers.length,
                clients: room.clients.size,
                lockedElements: (room.lockedElements && room.lockedElements.size) || 0,
                locked: !!room.locked, password: !!room.passwordHash
              };
              sendFrame(sock, JSON.stringify(stats));
            }
            break;
          case 'apply_template':   // 应用内置模板（白板/四象限），仅允许名单内模板，避免任意元素注入；可撤销
            {
              const name = (typeof obj.name === 'string') ? obj.name : '';
              const TEMPLATES = {
                brain: [ {type:'frame', x:40,y:40,w:360,h:240,label:'想法',color:'#82aaff'},
                         {type:'frame', x:440,y:40,w:360,h:240,label:'方案',color:'#7ee787'},
                         {type:'frame', x:40,y:320,w:360,h:240,label:'风险',color:'#f07178'},
                         {type:'frame', x:440,y:320,w:360,h:240,label:'行动',color:'#ffcb6b'} ],
                grid4: [ {type:'frame', x:40,y:40,w:300,h:200,label:'1',color:'#add7ff'},
                         {type:'frame', x:380,y:40,w:300,h:200,label:'2',color:'#add7ff'},
                         {type:'frame', x:40,y:280,w:300,h:200,label:'3',color:'#add7ff'},
                         {type:'frame', x:380,y:280,w:300,h:200,label:'4',color:'#add7ff'} ]
              };
              const tpl = TEMPLATES[name];
              if(!tpl){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_template', msg:'未知模板：' + name })); break; }
              const news = tpl.map(el => Object.assign({}, el, { id: sock._cid + ':' + (++strokeSeq), author: sock._cid, authorColor: sock.color }));
              hist.commitStrokes(room, room.strokes.concat(news));
              broadcast(room, JSON.stringify({ type:'replace', strokes: room.strokes }), sock);
              store.saveRoom(room.name, room);
            }
            break;
          case 'set_password':   // 房主设置/清除房间密码（仅存哈希，握手阶段校验，不泄露明文）
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能设置密码' })); break; }
              const pwd = (typeof obj.password === 'string') ? obj.password : '';
              if(pwd.length > 0 && pwd.length < 4){ sendFrame(sock, JSON.stringify({ type:'error', code:'weak_password', msg:'密码至少 4 位' })); break; }
              room.passwordHash = pwd ? hashPassword(pwd) : null;
              broadcast(room, JSON.stringify({ type:'password_set', set: !!room.passwordHash, by: room.owner }));
              store.saveRoom(room.name, room);
            }
            break;
          case 'record_start':   // 房主开始录制编辑操作（录制上限 5000 条，防内存膨胀）
            if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能录制' })); break; }
            room.recording = { ops: [], start: Date.now() };
            broadcast(room, JSON.stringify({ type:'record_started', by: room.owner }));
            break;
          case 'record_stop':   // 房主停止录制，保留录制内容用于回放
            if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能停止录制' })); break; }
            if(!room.recording){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_recording', msg:'当前未在录制' })); break; }
            room._recorded = room.recording.ops.slice(0, 5000);
            room.recording = null;
            broadcast(room, JSON.stringify({ type:'record_stopped', count: room._recorded.length, by: room.owner }));
            break;
          case 'playback':   // 房主回放录制：重发录制的编辑操作，便于复盘
            if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能回放' })); break; }
            if(!room._recorded || room._recorded.length === 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'nothing_recorded', msg:'没有可回放的录制' })); break; }
            for(const op of room._recorded) broadcast(room, JSON.stringify(op));
            sendFrame(sock, JSON.stringify({ type:'playback_done', count: room._recorded.length }));
            break;
          case 'announce':   // 房主发布公告（全员可见，限频 1.5s 防刷屏，持久化）
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能发布公告' })); break; }
              if(typeof obj.text !== 'string' || !obj.text.trim()){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_text', msg:'announce 需要文本' })); break; }
              room._announceAt = room._announceAt || 0;
              const now = Date.now();
              if(now - room._announceAt < 1500){ sendFrame(sock, JSON.stringify({ type:'error', code:'rate_limited', msg:'公告过于频繁' })); break; }  // 隐性问题：限频
              room._announceAt = now;
              const a = { type:'announce', text: obj.text.slice(0, 200), by: room.owner, name: sock.name || '匿名', t: now };
              broadcast(room, JSON.stringify(a));
              room.announcements = room.announcements || [];
              room.announcements.push(a);
              if(room.announcements.length > 20) room.announcements.shift();
              store.saveRoom(room.name, room);
            }
            break;
          case 'export_board':   // 导出整板：json 或 svg 格式，含完整房间元数据（一致性校验）
            {
              const fmt = (typeof obj.format === 'string') ? obj.format : 'json';
              if(fmt !== 'json' && fmt !== 'svg'){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_format', msg:'export 仅支持 json/svg' })); break; }
              if(fmt === 'json'){
                const data = { name: room.name, bg: room.bg, title: room.title, permissions: room.permissions || 'all',
                  grid: !!room.grid, snap: !!room.snap, locked: !!room.locked,
                  strokes: room.strokes, chats: room.chats,
                  polls: room.polls.map(serializePoll), timers: room.timers.map(serializeTimer) };
                sendFrame(sock, JSON.stringify({ type:'board_export', format:'json', data }));
              } else {
                let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">';
                if(room.bg) svg += '<rect width="100%" height="100%" fill="'+room.bg+'"/>';
                for(const el of room.strokes){
                  if(el.type === 'frame' || el.shapeKind === 'rect' || el.shapeKind === 'triangle'){ svg += '<rect x="'+clampCoord(el.x,0,1e6)+'" y="'+clampCoord(el.y,0,1e6)+'" width="'+clampCoord(el.w,0,1e6)+'" height="'+clampCoord(el.h,0,1e6)+'" fill="'+(el.fill||'none')+'" stroke="'+el.color+'"/>'; }
                  else if(el.shapeKind === 'ellipse'){ svg += '<ellipse cx="'+(clampCoord(el.x,0,1e6)+clampCoord(el.w,0,1e6)/2)+'" cy="'+(clampCoord(el.y,0,1e6)+clampCoord(el.h,0,1e6)/2)+'" rx="'+(clampCoord(el.w,0,1e6)/2)+'" ry="'+(clampCoord(el.h,0,1e6)/2)+'" fill="none" stroke="'+el.color+'"/>'; }
                  else if(el.type === 'text'){ svg += '<text x="'+clampCoord(el.x,0,1e6)+'" y="'+clampCoord(el.y,0,1e6)+'" fill="'+el.color+'">'+escapeXml(el.text)+'</text>'; }
                }
                svg += '</svg>';
                sendFrame(sock, JSON.stringify({ type:'board_export', format:'svg', svg, length: svg.length }));
              }
            }
            break;
          case 'pin_message':   // ci328 房主置顶聊天消息：按 mid 定位，存 room.pinnedChat 并持久化，广播全员
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能置顶消息' })); break; }
              if(typeof obj.mid !== 'number'){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_mid', msg:'pin_message 需要数值 mid' })); break; }
              const target = room.chats.find(c => c.mid === obj.mid);
              if(!target){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_message', msg:'消息不存在或已删除' })); break; }
              room.pinnedChat = { mid: target.mid, text: target.text, name: target.name, id: target.id, t: target.t, pinnedBy: sock._cid, pinnedAt: Date.now() };
              broadcast(room, JSON.stringify({ type:'chat_pinned', pinned: room.pinnedChat }));
              store.saveRoom(room.name, room);
            }
            break;
          case 'unpin_message':   // ci328 房主取消置顶：清空 pinnedChat，广播全员（无置顶时报错，幂等提示）
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能取消置顶' })); break; }
              if(!room.pinnedChat){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_pinned', msg:'当前没有置顶消息' })); break; }
              const prev = room.pinnedChat.mid;
              room.pinnedChat = null;
              broadcast(room, JSON.stringify({ type:'chat_unpinned', mid: prev, by: sock._cid }));
              store.saveRoom(room.name, room);
            }
            break;
          case 'spotlight':   // ci332 房主聚光灯：将某成员设为全员焦点（演示模式），广播 spotlight_on
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能开启聚光灯' })); break; }
              if(typeof obj.cid !== 'string' || obj.cid.length === 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_cid', msg:'spotlight 需要有效的 cid' })); break; }
              const target = [...room.clients].find(c => c._cid === obj.cid);
              if(!target){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_member', msg:'该成员不在房间内' })); break; }
              room.spotlight = { cid: target._cid, name: target.name || ('用户' + target._cid), by: sock._cid, at: Date.now() };
              broadcast(room, JSON.stringify({ type:'spotlight_on', spotlight: room.spotlight }));
            }
            break;
          case 'spotlight_off':   // ci332 房主关闭聚光灯：清空 room.spotlight，广播 spotlight_off（无聚光灯时报错）
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能关闭聚光灯' })); break; }
              if(!room.spotlight){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_spotlight', msg:'当前没有聚光灯' })); break; }
              const prev = room.spotlight.cid;
              room.spotlight = null;
              broadcast(room, JSON.stringify({ type:'spotlight_off', cid: prev, by: sock._cid }));
            }
            break;
          case 'focus_element':   // ci336 房主演示聚焦某元素：将某元素设为全员视图中心(演示模式)，广播 focus_element_on
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能聚焦元素' })); break; }
              if(typeof obj.elId !== 'string' || obj.elId.length === 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_elId', msg:'focus_element 需要有效的 elId' })); break; }
              const el = room.strokes.find(s => s && s.id === obj.elId);
              if(!el){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_element', msg:'该元素不存在' })); break; }
              room.elementFocus = { elId: el.id, by: sock._cid, at: Date.now() };
              broadcast(room, JSON.stringify({ type:'focus_element_on', elId: el.id, by: sock._cid }));
            }
            break;
          case 'focus_element_off':   // ci336 房主关闭元素聚焦：清空 room.elementFocus，广播 focus_element_off（无聚焦时报错）
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能关闭元素聚焦' })); break; }
              if(!room.elementFocus){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_focus', msg:'当前没有元素聚焦' })); break; }
              const prev = room.elementFocus.elId;
              room.elementFocus = null;
              broadcast(room, JSON.stringify({ type:'focus_element_off', elId: prev, by: sock._cid }));
            }
            break;
          case 'poke':   // ci340 戳一戳：任意成员定向提醒另一成员(仅目标收到 poked, 发送者收 poke_sent 回执)；限频 3s
            {
              if(typeof obj.cid !== 'string' || obj.cid.length === 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_cid', msg:'poke 需要有效的 cid' })); break; }
              if(obj.cid === sock._cid){ sendFrame(sock, JSON.stringify({ type:'error', code:'self_poke', msg:'不能戳自己' })); break; }
              const now = Date.now();
              if(sock._lastPokeAt && now - sock._lastPokeAt < 3000){ sendFrame(sock, JSON.stringify({ type:'error', code:'poke_too_fast', msg:'戳一戳太频繁，请稍后再试' })); break; }
              const target = [...room.clients].find(c => c._cid === obj.cid);
              if(!target){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_member', msg:'该成员不在房间内' })); break; }
              sock._lastPokeAt = now;
              sendFrame(target, JSON.stringify({ type:'poked', from: sock._cid, name: sock.name || ('用户' + sock._cid), at: now }));
              sendFrame(sock, JSON.stringify({ type:'poke_sent', cid: target._cid, at: now }));
            }
            break;
          case 'list_members':   // ci344 成员名册：仅回给请求者（cid/name/avatar/status/isOwner），只读、不广播、不落库
            {
              const members = [...room.clients].map(c => ({
                cid: c._cid,
                name: c.name || ('用户' + (c._cid || '?')),
                avatar: c.avatar || null,
                status: c.status || 'online',
                isOwner: c._cid === room.owner
              }));
              sendFrame(sock, JSON.stringify({ type:'member_list', members, count: members.length, owner: room.owner || null }));
            }
            break;
          case 'star_element':   // ci348 元素收藏(toggle)：任意成员对存在的元素加/取消星标，room.stars = {elId:[cid,...]}，广播含最新计数并持久化
            {
              if(typeof obj.elId !== 'string' || obj.elId.length === 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_elId', msg:'star_element 需要有效的 elId' })); break; }
              const el = room.strokes.find(s => s && s.id === obj.elId);
              if(!el){ sendFrame(sock, JSON.stringify({ type:'error', code:'no_such_element', msg:'该元素不存在' })); break; }
              if(!room.stars || typeof room.stars !== 'object') room.stars = {};
              const arr = Array.isArray(room.stars[el.id]) ? room.stars[el.id] : [];
              const i = arr.indexOf(sock._cid);
              let starred;
              if(i === -1){ arr.push(sock._cid); starred = true; } else { arr.splice(i, 1); starred = false; }
              if(arr.length) room.stars[el.id] = arr; else delete room.stars[el.id];
              broadcast(room, JSON.stringify({ type: starred ? 'element_starred' : 'element_unstarred', elId: el.id, by: sock._cid, count: arr.length }));
              store.saveRoom(room.name, room);
            }
            break;
          case 'set_layer_name':   // ci352 房主命名图层：room.layerNames = {layerId: name}，name 空则删除命名；广播 layer_name 并持久化
            {
              if(sock._cid !== room.owner){ sendFrame(sock, JSON.stringify({ type:'error', code:'not_owner', msg:'只有房主能命名图层' })); break; }
              if(typeof obj.layerId !== 'string' || obj.layerId.length === 0){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_layerId', msg:'set_layer_name 需要有效的 layerId' })); break; }
              const nm = typeof obj.name === 'string' ? obj.name.trim().slice(0, 32) : '';
              if(!room.layerNames || typeof room.layerNames !== 'object') room.layerNames = {};
              if(nm) room.layerNames[obj.layerId] = nm; else delete room.layerNames[obj.layerId];
              broadcast(room, JSON.stringify({ type:'layer_name', layerId: obj.layerId, name: nm || null, by: sock._cid }));
              store.saveRoom(room.name, room);
            }
            break;
          case 'board_search':   // ci356 整板文本搜索：在 text/note/pin/stamp/comment 的文字里不区分大小写查找，仅回给请求者(最多 50 条)，只读
            {
              const q = typeof obj.q === 'string' ? obj.q.trim() : '';
              if(!q){ sendFrame(sock, JSON.stringify({ type:'error', code:'bad_query', msg:'board_search 需要非空关键词 q' })); break; }
              const needle = q.toLowerCase().slice(0, 80);
              const results = [];
              for(const el of room.strokes){
                if(!el || results.length >= 50) continue;
                let hay = null;
                if(typeof el.text === 'string') hay = el.text;              // text/note/stamp
                else if(typeof el.label === 'string') hay = el.label;       // pin
                if(hay && hay.toLowerCase().includes(needle)){
                  results.push({ elId: el.id, type: el.type, snippet: hay.slice(0, 60), x: el.x, y: el.y });
                  continue;
                }
                if(Array.isArray(el.comments)){                             // 元素评论
                  const hit = el.comments.find(c => c && typeof c.text === 'string' && c.text.toLowerCase().includes(needle));
                  if(hit) results.push({ elId: el.id, type: el.type, snippet: ('评论: ' + hit.text).slice(0, 60), x: el.x, y: el.y });
                }
              }
              sendFrame(sock, JSON.stringify({ type:'search_results', q, results, count: results.length }));
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
        sock._pwd = u.searchParams.get('pwd') || '';
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
      if(room.passwordHash){                  // 隐性问题：密码房需在握手阶段校验，未带/错误密码拒绝加入
        if(hashPassword(sock._pwd || '') !== room.passwordHash){
          sendFrame(sock, JSON.stringify({ type:'error', code:'unauthorized', msg:'房间已设置密码' }));
          sock.end(); return;
        }
      }
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
    if(room.followers){                       // 隐性问题：清理离开者的 follow 关系，避免悬空引用
      room.followers.delete(s._cid);
      for(const set of room.followers.values()) set.delete(s._cid);
    }
    if(room.views) room.views.delete(s._cid);
    if(room.spotlight && room.spotlight.cid === s._cid){   // ci332 隐性问题：被聚焦成员离场时自动关闭聚光灯，避免全员盯着空位
      room.spotlight = null;
      broadcast(room, JSON.stringify({ type:'spotlight_off', cid: s._cid, reason:'left' }));
    }
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

// 倒计时驱动：每秒递减运行中的计时器剩余时间并广播 timer_tick；归零时停表并广播 timer_updated(finished)
function tickTimers(){
  for(const room of rooms.values()){
    let changed = false;
    for(const t of room.timers){
      if(t.running && t.remaining > 0){
        t.remaining--;
        broadcast(room, JSON.stringify({ type:'timer_tick', tid: t.tid, remaining: t.remaining }));
        changed = true;
        if(t.remaining <= 0){ t.running = false; broadcast(room, JSON.stringify({ type:'timer_updated', timer: serializeTimer(t), finished: true })); }
      }
    }
    if(changed) store.saveRoom(room.name, room);
  }
}
setInterval(tickTimers, 1000);
