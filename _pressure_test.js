const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 画笔压感测试：笔画点携带 p(pressure)，服务端原样转发并在 snapshot 中保留。
// 测试客户端做真正的 WebSocket 帧解析，避免多帧合并时只解析到最后一帧的竞态；
// 房间名带随机后缀，避免 rooms/<name>.json 跨运行残留污染。
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
        s.open = true;
        s.bytes = s.bytes.slice(idx + 4);
        extractFrames(s);
        resolve(s);
      } else {
        extractFrames(s);
      }
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

(async ()=>{
  const room = 'pr_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999', PORT: String(port) }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  try {
    const c1 = await wsConnect(room, port);
    const c2 = await wsConnect(room, port);
    await new Promise(r => setTimeout(r, 200));

    // c1 发送一笔，点携带压感 p
    wsSend(c1, { type: 'stroke', stroke: { tool: 'pen', color: '#fff', width: 4,
      points: [{ x: 1, y: 1, p: 0.9 }, { x: 2, y: 2, p: 0.3 }, { x: 3, y: 3, p: 0.6 }] } });
    await new Promise(r => setTimeout(r, 250));

    const st = c2.msgs.find(m => m.type === 'stroke' && m.stroke && Array.isArray(m.stroke.points));
    ok('c2 收到带压感笔画', !!st);
    ok('首点 p 透传(0.9)', st && typeof st.stroke.points[0].p === 'number' && st.stroke.points[0].p === 0.9);
    ok('次点 p 透传(0.3)', st && st.stroke.points[1].p === 0.3);
    ok('末点 p 透传(0.6)', st && st.stroke.points[2].p === 0.6);

    // 重连后 snapshot 仍保留压感（取 connect-time snapshot）
    c1.destroy();
    await new Promise(r => setTimeout(r, 150));
    const c1b = await wsConnect(room, port);
    let snap = null;
    for(let i = 0; i < 40 && !snap; i++){ await new Promise(r => setTimeout(r, 50)); snap = c1b.msgs.find(m => m.type === 'snapshot'); }
    const sp = snap && Array.isArray(snap.strokes) ? snap.strokes.find(s => Array.isArray(s.points) && s.points[0] && typeof s.points[0].p === 'number') : null;
    if(!(!!sp && sp.points[0].p === 0.9)){
      console.log('  DEBUG snap?', !!snap, 'strokes.len=', snap && snap.strokes && snap.strokes.length);
    }
    ok('snapshot 保留压感', !!sp && sp.points[0].p === 0.9);
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard pressure] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
