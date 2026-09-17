const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8101;
// CollabBoard 全板清空测试：验证 server case 'clear' —— 双端广播、房间快照清空、
// 落盘持久化、undo 可恢复清空前笔画、迟到者收到空快照、空房间 clear 不崩。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));
const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'clearBd_' + crypto.randomBytes(3).toString('hex');

// 极简 WS 客户端：握手 + 帧收发（掩码发送 / 解析服务端未掩码帧）
function wsClient(room){
  return new Promise((resolve, reject)=>{
    const s = net.connect(PORT, 'localhost');
    const key = crypto.randomBytes(16).toString('base64');
    s.on('connect', ()=> s.write(
      'GET /?room=' + room + ' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    const msgs = [];
    const waiters = [];
    s.buf = Buffer.alloc(0); s.hs = false;
    s.on('data', d=>{
      s.buf = Buffer.concat([s.buf, d]);
      if(!s.hs){
        const i = s.buf.indexOf('\r\n\r\n');
        if(i >= 0){ s.hs = true; s.buf = s.buf.slice(i + 4); }
      }
      for(;;){
        if(s.buf.length < 2) break;
        const b0 = s.buf[0], b1 = s.buf[1], opcode = b0 & 0x0f;
        let len = b1 & 0x7f, off = 2;
        if(len === 126){ if(s.buf.length < 4) break; len = s.buf.readUInt16BE(2); off = 4; }
        else if(len === 127){ if(s.buf.length < 10) break; len = Number(s.buf.readBigUInt64BE(2)); off = 10; }
        if(s.buf.length < off + len) break;
        const payload = s.buf.slice(off, off + len);
        s.buf = s.buf.slice(off + len);
        if(opcode === 0x1){ const m = JSON.parse(payload.toString('utf8')); msgs.push(m); waiters.slice().forEach(w => w()); }
        else if(opcode === 0x8){ s.end(); }
        else if(opcode === 0x9){
          const mask = crypto.randomBytes(4);
          const header = Buffer.from([0x8A, 0x80 | payload.length]);
          const masked = Buffer.alloc(payload.length);
          for(let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
          s.write(Buffer.concat([header, mask, masked]));
        }
      }
    });
    s.on('error', reject);
    s.msgs = msgs;
    s.waitFor = (pred, timeout = 2500)=> new Promise((res)=>{
      const hit = msgs.find(pred);
      if(hit) return res(hit);
      const t = setTimeout(done, timeout);
      function done(){ clearTimeout(t); waiters.splice(waiters.indexOf(w), 1); res(msgs.find(pred)); }
      function w(){ if(msgs.find(pred)) done(); }
      waiters.push(w);
    });
    s.send = (obj)=>{
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const len = payload.length, mask = crypto.randomBytes(4);
      let header;
      if(len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      const masked = Buffer.alloc(len);
      for(let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
      s.write(Buffer.concat([header, mask, masked]));
    };
    s.on('connect', ()=> resolve(s));
  });
}
function httpGet(p){
  return new Promise((resolve, reject)=>{
    const s = net.connect(PORT, 'localhost');
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

(async ()=>{
  const server = spawn(process.execPath, [path.join(dir, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));

  try {
    // ---- 1) 静态：index.html clear 按钮 → send({type:'clear'}) ----
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    ok('客户端 clear 按钮接线存在', /\$\('clear'\)\.onclick/.test(html) && /type:\s*'clear'/.test(html));

    // ---- 2) E2E：双端连接 + A 画一笔 ----
    const A = await wsClient(ROOM);
    await new Promise(r => setTimeout(r, 150));
    const B = await wsClient(ROOM);
    await new Promise(r => setTimeout(r, 150));
    const stroke = { tool:'pen', color:'#fff', width:3, points:[{x:1,y:1},{x:2,y:2}] };
    A.send({ type:'stroke', stroke });
    await new Promise(r => setTimeout(r, 200));
    const before = await httpGet('/api/room?name=' + ROOM);
    ok('清空前房间含 1 笔', before.ok === true && before.strokes.length === 1);

    // ---- 3) A 发 clear → 他人收到广播；发起者不回显（前端点击时已本地自清，broadcast 排除 sock）----
    A.send({ type:'clear' });
    const bClear = await B.waitFor(m => m.type === 'clear');
    ok('他人收到 clear 广播', !!bClear);
    await new Promise(r => setTimeout(r, 300));
    ok('发起者不回显 clear（前端已自清，避免重复清空）', !A.msgs.some(m => m.type === 'clear'));
    const after = await httpGet('/api/room?name=' + ROOM);
    ok('清空后房间 0 笔', after.ok === true && after.strokes.length === 0);

    // ---- 4) 落盘持久化：rooms/<name> 存在且 strokes 为空 ----
    let persisted = false;
    try {
      const files = fs.readdirSync(path.join(dir, 'rooms')).filter(f => f.startsWith(ROOM));
      if(files.length){
        const data = JSON.parse(fs.readFileSync(path.join(dir, 'rooms', files[0]), 'utf8'));
        persisted = Array.isArray(data.strokes) && data.strokes.length === 0;
      }
    } catch(e){}
    ok('清空状态已落盘', persisted);

    // ---- 5) undo 恢复清空前的笔画 ----
    A.send({ type:'undo' });
    const aRep = await A.waitFor(m => m.type === 'replace' && Array.isArray(m.strokes) && m.strokes.length === 1);
    ok('undo 后收到 replace(1 笔)', !!aRep);
    const restored = await httpGet('/api/room?name=' + ROOM);
    ok('undo 后服务端恢复 1 笔', restored.ok === true && restored.strokes.length === 1);

    // ---- 6) 迟到者快照（此刻恢复后的 1 笔）→ 再次 clear → 迟到者拿空快照 ----
    const C = await wsClient(ROOM);
    const cSnap = await C.waitFor(m => m.type === 'snapshot');
    ok('迟到者快照 1 笔', !!cSnap && Array.isArray(cSnap.strokes) && cSnap.strokes.length === 1);
    A.send({ type:'clear' });
    await A.waitFor(m => m.type === 'clear');
    await new Promise(r => setTimeout(r, 200));
    const D = await wsClient(ROOM);
    const dSnap = await D.waitFor(m => m.type === 'snapshot');
    ok('清空后新进者快照 0 笔', !!dSnap && Array.isArray(dSnap.strokes) && dSnap.strokes.length === 0);

    // ---- 7) 空房间再 clear 不崩（服务端存活；B 收到广播）----
    A.send({ type:'clear' });
    await B.waitFor(m => m.type === 'clear');
    const health = await httpGet('/api/health');
    ok('空房间 clear 后服务端存活', health.ok === true && Array.isArray(health.rooms));
  } catch(e){
    fail++; console.log('  FAIL 异常', e.message);
  } finally {
    server.kill();
  }
  console.log(`\n[CollabBoard ClearBoard] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
