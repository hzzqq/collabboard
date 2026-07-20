// CollabBoard 房间列表测试：服务端支持 WS `room_list` 消息（返回所有活跃房间名+笔画数+人数），
// 并在任意房间有人加入/离开时向所有客户端广播最新房间列表。使用唯一房间名避免跨运行残留。
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }

function extractFrames(sock){
  let buf = sock.bytes;
  while(buf.length >= 2){
    const b0 = buf[0], b1 = buf[1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let offset = 2;
    if(len === 126){ if(buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
    else if(len === 127){ if(buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    const masked = (b1 & 0x80) !== 0;
    if(masked) offset += 4;
    if(buf.length < offset + len) break;
    const payload = buf.slice(offset, offset + len);
    buf = buf.slice(offset + len);
    if(opcode === 0x1){ try { const m = JSON.parse(payload.toString('utf8')); sock.msgs.push(m); } catch(e){} }
  }
  sock.bytes = buf;
}
function wsConnect(room, port){
  return new Promise((resolve, reject)=>{
    const s = net.connect(port, 'localhost');
    const key = crypto.randomBytes(16).toString('base64');
    s.bytes = Buffer.alloc(0); s.msgs = []; s.open = false;
    s.on('data', d=>{
      s.bytes = Buffer.concat([s.bytes, d]);
      if(!s.open){
        const idx = s.bytes.indexOf('\r\n\r\n');
        if(idx === -1) return;
        s.open = true; s.bytes = s.bytes.slice(idx + 4); extractFrames(s); resolve(s);
      } else { extractFrames(s); }
    });
    s.on('connect', ()=> s.write(
      'GET /?room=' + room + ' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.on('error', reject);
  });
}
function freePort(){
  return new Promise((resolve, reject)=>{
    const tmp = net.createServer();
    tmp.listen(0, 'localhost', ()=>{ const p = tmp.address().port; tmp.close(()=> resolve(p)); });
    tmp.on('error', reject);
  });
}
function wsSend(s, obj){
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length, mask = crypto.randomBytes(4);
  let header = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.alloc(4);
  if(len >= 126){ header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.alloc(len);
  for(let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  s.write(Buffer.concat([header, mask, masked]));
}
function findRoom(list, name){ return Array.isArray(list) ? list.find(r => r.name === name) : null; }

(async ()=>{
  const suffix = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const roomA = 'A_' + suffix, roomB = 'B_' + suffix;
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, HB: '999999', PORT: String(port) }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  try {
    const c1 = await wsConnect(roomA, port);
    await new Promise(r => setTimeout(r, 150));
    const c2 = await wsConnect(roomA, port);
    await new Promise(r => setTimeout(r, 150));
    const c3 = await wsConnect(roomB, port);   // 触发广播
    await new Promise(r => setTimeout(r, 250));

    // 主动请求 room_list
    c1.msgs = [];  // 清掉 connect-time 消息，只看本次响应
    wsSend(c1, { type: 'room_list' });
    let resp = null;
    for(let i = 0; i < 40 && !resp; i++){ await new Promise(r => setTimeout(r, 50)); resp = c1.msgs.find(m => m.type === 'room_list'); }

    ok('收到 room_list 响应', !!resp);
    const ra = resp && findRoom(resp.rooms, roomA);
    const rb = resp && findRoom(resp.rooms, roomB);
    ok('含房间 A', !!ra);
    ok('含房间 B', !!rb);
    ok('房间 A 在线 2 人', ra && ra.clients === 2);
    ok('房间 B 在线 1 人', rb && rb.clients === 1);

    // 广播验证：新连接加入会触发 c1 收到 room_list 广播
    const before = c1.msgs.filter(m => m.type === 'room_list').length;
    const c4 = await wsConnect(roomB, port);
    await new Promise(r => setTimeout(r, 250));
    const after = c1.msgs.filter(m => m.type === 'room_list').length;
    ok('加入房间触发 room_list 广播', after > before);
    const last = c1.msgs.filter(m => m.type === 'room_list').pop();
    const rb2 = last && findRoom(last.rooms, roomB);
    ok('广播后房间 B 在线 2 人', rb2 && rb2.clients === 2);
    c4.destroy();
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard roomlist] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
