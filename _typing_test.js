const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 「正在输入」广播测试：c1 发送 typing，c2 应收到带 name/on 的 typing 消息。
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
    s.buf = ''; s.msgs = [];
    s.on('data', d=>{
      s.buf += d.toString('utf8');
      if(s.buf.includes('\r\n\r\n')){ resolve(s); }
    });
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

(async ()=>{
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const got = [];
  try {
    const c1 = await wsConnect('typingRoom');
    const c2 = await wsConnect('typingRoom');
    c2.on('data', d=>{
      const s = d.toString('utf8');
      let i = s.indexOf('{');
      while(i !== -1){
        try { const m = JSON.parse(s.slice(i)); if(m.type === 'typing') got.push(m); } catch(e){}
        i = s.indexOf('{', i + 1);
      }
    });
    await new Promise(r => setTimeout(r, 150));
    wsSend(c1, { type:'set_name', name:'阿测' });
    await new Promise(r => setTimeout(r, 100));
    wsSend(c1, { type:'typing', on:true });
    await new Promise(r => setTimeout(r, 200));
    wsSend(c1, { type:'typing', on:false });
    await new Promise(r => setTimeout(r, 200));

    ok('c2 收到 typing on', got.some(m => m.on === true));
    ok('typing 带发送者名', got.some(m => m.name === '阿测'));
    ok('c2 收到 typing off', got.some(m => m.on === false));
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard typing] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
