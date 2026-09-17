const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8102;
// CollabBoard 自定义昵称颜色测试：验证 server case 'set_nickname_color' 全链路 ——
// 合法 #rgb/#rrggbb 广播 nickname_color + presence 携带 colors；非法/非字符串报
// bad_color 且状态不变；以及客户端入口接线（input#nickColor → send → 持久化 →
// welcome 恢复 → nickname_color/presence 处理 → renderRoster 着色）。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));
const dir = __dirname;
const ROOM = 'nickCol_' + crypto.randomBytes(3).toString('hex');

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
        if(opcode === 0x1){ msgs.push(JSON.parse(payload.toString('utf8'))); waiters.slice().forEach(w => w()); }
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

(async ()=>{
  // ---- 1) 静态：客户端接线（此前三层全断：无入口/无处理器/presence colors 被忽略）----
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const sc = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0];
  ok('index.html 含内联脚本', !!sc);
  if(sc){
    const tmp = path.join(dir, '.chk_nickcolor_inline.js');
    fs.writeFileSync(tmp, sc[1]);
    const { execSync } = require('child_process');
    try { execSync(`"${process.execPath}" --check "${tmp}"`, { stdio: 'pipe' }); ok('内联脚本语法 OK', true); }
    catch(e){ ok('内联脚本语法 OK', false); console.log(e.stderr && e.stderr.toString()); }
    fs.unlinkSync(tmp);
  }
  ok('UI 存在颜色输入 input#nickColor', /id="nickColor"/.test(html));
  ok('onchange 发送 set_nickname_color', /type:\s*'set_nickname_color'/.test(html));
  ok('本地持久化 cboard_nickcolor', /cboard_nickcolor/.test(html));
  ok('welcome 后恢复自定义色', /localStorage\.getItem\(NICKCOLOR_KEY\)/.test(html));
  ok("存在 case 'nickname_color' 处理器", /case\s+'nickname_color'/.test(html));
  ok('presence 消费 m.colors', /m\.colors/.test(html));
  ok('renderRoster 接受 colors 着色', /function renderRoster\(names,\s*colors\)/.test(html));

  // ---- 2) E2E：服务端行为 ----
  const server = spawn(process.execPath, [path.join(dir, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));

  try {
    const A = await wsClient(ROOM);
    const B = await wsClient(ROOM);
    await new Promise(r => setTimeout(r, 200));

    // 合法 6 位：大写输入 → 归一化小写广播
    A.send({ type:'set_nickname_color', color:'#FF0000' });
    const bcA = await A.waitFor(m => m.type === 'nickname_color');
    ok('发起者收到 nickname_color 广播', !!bcA);
    ok('颜色归一化为小写 #ff0000', bcA && bcA.color === '#ff0000');
    const bcB = await B.waitFor(m => m.type === 'nickname_color' && m.id === (bcA && bcA.id));
    ok('他人收到同一广播(同 id 同色)', !!bcB && bcB.color === '#ff0000');
    const presB = await B.waitFor(m => m.type === 'presence' && Array.isArray(m.colors) && m.colors.includes('#ff0000'));
    ok('presence.colors 携带新色', !!presB);

    // 合法 3 位：#0F0 → 接受并转小写
    A.send({ type:'set_nickname_color', color:'#0F0' });
    const bc3 = await A.waitFor(m => m.type === 'nickname_color' && m.color === '#0f0');
    ok('3 位 #0f0 合法并广播', !!bc3);

    // 非法颜色 → error(bad_color)，且无新的 nickname_color 广播
    const countBefore = A.msgs.filter(m => m.type === 'nickname_color').length;
    A.send({ type:'set_nickname_color', color:'red' });
    const err = await A.waitFor(m => m.type === 'error' && m.code === 'bad_color');
    ok('非法颜色报 bad_color', !!err);
    await new Promise(r => setTimeout(r, 200));
    ok('非法颜色不产生 nickname_color 广播', A.msgs.filter(m => m.type === 'nickname_color').length === countBefore);

    // 非字符串颜色 → 同样报 bad_color
    A.send({ type:'set_nickname_color', color: 123 });
    const err2 = await A.waitFor(m => m.type === 'error' && m.code === 'bad_color' && m !== err);
    ok('非字符串颜色报 bad_color', !!err2);

    // 服务端存活
    ok('多次非法输入后服务端存活', A.hs === true && B.hs === true);
  } catch(e){
    fail++; console.log('  FAIL 异常', e.message);
  } finally {
    server.kill();
  }
  console.log(`\n[CollabBoard NickColor] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
