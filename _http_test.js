// CollabBoard HTTP 管理 API 测试：验证 /api/health /api/rooms /api/room 与 404 行为。
// 先启动真实服务端，用原始 net 做 HTTP GET，并用最小 WS 客户端推一笔笔画后回查房间。
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }

function httpGet(p){
  return new Promise((resolve, reject)=>{
    const s = net.connect(8080, 'localhost');
    let buf = '';
    s.on('connect', ()=> s.write('GET ' + p + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    s.on('data', d=> buf += d.toString('utf8'));
    s.on('end', ()=>{
      const i = buf.indexOf('\r\n\r\n');
      try { resolve(JSON.parse(buf.slice(i + 4))); } catch(e){ reject(e); }
    });
    s.on('error', reject);
  });
}
function wsConnect(room){
  return new Promise((resolve, reject)=>{
    const s = net.connect(8080, 'localhost');
    const key = crypto.randomBytes(16).toString('base64');
    s.on('connect', ()=> s.write(
      'GET /?room=' + room + ' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.buf = '';
    s.on('data', d=>{ s.buf += d.toString('utf8'); if(s.buf.includes('\r\n\r\n')) resolve(s); });
    s.on('error', reject);
  });
}
function wsSend(s, obj){
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if(len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.alloc(len);
  for(let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  s.write(Buffer.concat([header, mask, masked]));
}

(async ()=>{
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, HB: '999999' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));

  try {
    const health = await httpGet('/api/health');
    ok('health ok', health.ok === true);
    ok('health 含 rooms', Array.isArray(health.rooms));

    const root = await httpGet('/api');
    ok('root 列出端点', root.ok === true && Array.isArray(root.endpoints) && root.endpoints.includes('/api/room?name=NAME'));

    const nf = await httpGet('/no-such');
    ok('未知路径 404(ok=false)', nf.ok === false);

    // 推一笔笔画到专用房间，再经 HTTP 回查
    const ws = await wsConnect('httpRoomX');
    await new Promise(r => setTimeout(r, 150));
    wsSend(ws, { type:'stroke', stroke:{ tool:'pen', color:'#fff', width:3, points:[{x:1,y:1},{x:2,y:2}] } });
    await new Promise(r => setTimeout(r, 250));
    ws.end();

    const room = await httpGet('/api/room?name=httpRoomX');
    ok('room ok', room.ok === true && room.name === 'httpRoomX');
    ok('room 含刚推送的笔画', Array.isArray(room.strokes) && room.strokes.length >= 1);

    const rooms = await httpGet('/api/rooms');
    ok('rooms 列出 httpRoomX', rooms.ok === true && Array.isArray(rooms.rooms) && rooms.rooms.includes('httpRoomX'));
  } catch(e){
    fail++; console.log('  FAIL 异常', e.message);
  } finally {
    server.kill();
  }

  console.log(`\n[CollabBoard HTTP] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
