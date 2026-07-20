// CollabBoard 断线重连测试：客户端断开后重连，服务端下发 snapshot 同步最新房间状态。
// 全部笔画来自同一连接（顺序绘制后断开再重连），避免跨客户端时序竞态，结果确定。
// 关键修正：
//   1) 服务端广播时排除发送者自身，因此发送方不会收到自己画的 stroke；
//      验证"服务端已接收"改为同一连接绘制后 request_snapshot 回查。
//   2) 房间名带随机后缀，避免 store.saveRoom 落盘的 rooms/<name>.json 跨运行残留污染。
//   3) 测试客户端做真正的 WebSocket 帧解析（处理 7/16/64 位长度、无掩码服务端帧、
//      跨 TCP chunk 拼包），避免多帧合并时 JSON 扫描只解析到最后一帧的竞态。
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }

// 真正的 WS 帧解码：服务端下发的是无掩码帧(opcode=0x1 文本)。累积字节流，跨 chunk 拼包。
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
    // 0x8 close / 0x9 ping / 0xA pong 等控制帧忽略
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
        s.bytes = s.bytes.slice(idx + 4);   // 去掉握手响应残留
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
// index: 取连接后第几个 snapshot（连接时服务端先发一份 connect-time snapshot，
// 之后 request_snapshot 的回包为 index=1；重连时 connect-time snapshot 即权威状态，取 index=0）
function findSnapshot(s, index){
  return s.msgs.filter(m => m.type === 'snapshot')[index] || null;
}
function waitSnapshot(s, index, timeoutMs){
  return new Promise((resolve)=>{
    const found = findSnapshot(s, index);
    if(found){ resolve(found); return; }
    const t0 = Date.now();
    const iv = setInterval(()=>{
      const m = findSnapshot(s, index);
      if(m || Date.now() - t0 > timeoutMs){ clearInterval(iv); resolve(m || null); }
    }, 30);
  });
}

(async ()=>{
  const room = 'rec_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, HB: '999999', PORT: String(port) }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  try {
    // 同一连接 c1 顺序画两笔（不同颜色做标记）
    const c1 = await wsConnect(room, port);
    await new Promise(r => setTimeout(r, 200));
    wsSend(c1, { type: 'stroke', stroke: { tool: 'pen', color: '#a1a1a1', width: 4, points: [{ x: 1, y: 1 }] } });
    await new Promise(r => setTimeout(r, 150));
    wsSend(c1, { type: 'stroke', stroke: { tool: 'pen', color: '#b2b2b2', width: 4, points: [{ x: 2, y: 2 }] } });
    await new Promise(r => setTimeout(r, 150));

    // 验证服务端已接收并存储（发送方不回显自身，故用 request_snapshot 回查）
    wsSend(c1, { type: 'request_snapshot' });
    const s1 = await waitSnapshot(c1, 1, 3000);
    ok('服务端收到并存储两笔(回查 snapshot)', !!s1 && Array.isArray(s1.strokes) && s1.strokes.length === 2);
    ok('回查含第一笔(#a1a1a1)', !!s1 && s1.strokes.some(st => st.color === '#a1a1a1'));
    ok('回查含第二笔(#b2b2b2)', !!s1 && s1.strokes.some(st => st.color === '#b2b2b2'));

    // 断开
    c1.destroy();
    await new Promise(r => setTimeout(r, 250));

    // 重连同一房间：服务端下发 snapshot 同步最新房间状态（笔画应保留）
    const c2 = await wsConnect(room, port);
    const s2 = await waitSnapshot(c2, 0, 3000);
    ok('重连收到 snapshot', !!s2);
    const strokes = (s2 && Array.isArray(s2.strokes)) ? s2.strokes : [];
    if(strokes.length !== 2){
      console.log('  DEBUG snap.strokes.length=', strokes.length, 'colors=', strokes.map(s=>s.color));
      console.log('  DEBUG c2.msgs types=', c2.msgs.map(m=>m.type).join(','));
    }
    ok('snapshot 含全部笔画(2 笔)', strokes.length === 2);
    ok('snapshot 含第一笔(#a1a1a1)', strokes.some(s => s.color === '#a1a1a1'));
    ok('snapshot 含第二笔(#b2b2b2)', strokes.some(s => s.color === '#b2b2b2'));
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard reconnect] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
