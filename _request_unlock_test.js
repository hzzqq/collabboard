const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8098;
// CollabBoard 「申请解锁」测试：request_unlock 仅通知房主(id/name)/非房主在未锁定房间报错/房主自身申请报错
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }

function wsConnect(room){
  return new Promise((resolve, reject)=>{
    const s = net.connect(PORT, 'localhost');
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
  const len = payload.length, mask = crypto.randomBytes(4);
  let header;
  if(len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.alloc(len);
  for(let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  s.write(Buffer.concat([header, mask, masked]));
}
// 收集某客户端收到的、满足 type 过滤的帧
function collect(s, types){
  const out = [];
  s.on('data', d=>{
    const str = d.toString('utf8');
    let i = str.indexOf('{');
    while(i !== -1){
      try { const m = JSON.parse(str.slice(i)); if(types.includes(m.type)) out.push(m); } catch(e){}
      i = str.indexOf('{', i + 1);
    }
  });
  return out;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async ()=>{
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await wait(700);
  try {
    // ---- 房间 A：锁定后申请解锁 ----
    const c1 = await wsConnect('ruRoomA');   // 首个加入者=房主
    const c2 = await wsConnect('ruRoomA');
    const c1msgs = collect(c1, ['lock', 'unlock_request', 'error']);
    const c2msgs = collect(c2, ['lock', 'ok', 'error']);
    // welcome 与握手响应可能同分片或晚到；先等待确保 welcome 已落入缓冲，再从缓冲字符串提取申请人 id
    await wait(150);
    const wm = c2.buf.match(/"id":"([^"]+)"/);
    const c2id = wm ? wm[1] : null;
    wsSend(c2, { type:'set_name', name:'阿测' });
    await wait(120);
    wsSend(c1, { type:'lock' });
    await wait(160);
    ok('c2 收到 lock(locked:true)', c2msgs.some(m => m.type==='lock' && m.locked===true));
    wsSend(c2, { type:'request_unlock' });
    await wait(200);
    ok('房主 c1 收到 unlock_request', c1msgs.some(m => m.type==='unlock_request'));
    ok('unlock_request 带申请人 id', c1msgs.some(m => m.type==='unlock_request' && m.id === c2id));
    ok('unlock_request 带申请人名', c1msgs.some(m => m.type==='unlock_request' && m.name === '阿测'));
    ok('申请人 c2 收到 ok 回执', c2msgs.some(m => m.type==='ok' && m.op==='request_unlock'));

    // 房主自身申请 -> 错误 already_owner
    wsSend(c1, { type:'request_unlock' });
    await wait(160);
    ok('房主自身申请解锁返回 already_owner', c1msgs.some(m => m.type==='error' && m.code==='already_owner'));

    // ---- 房间 B：未锁定房间申请 -> 错误 not_locked ----
    const cA = await wsConnect('ruRoomB');
    const cB = await wsConnect('ruRoomB');
    const cBerr = collect(cB, ['error']);
    await wait(150);
    wsSend(cB, { type:'request_unlock' });
    await wait(160);
    ok('未锁定房间申请解锁返回 not_locked', cBerr.some(m => m.type==='error' && m.code==='not_locked'));
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard request-unlock] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
