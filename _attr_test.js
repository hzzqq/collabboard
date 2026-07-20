// CollabBoard 署名归属测试：服务端对笔画/文字强制盖章 author=连接id、authorColor=连接调色板色，
// 客户端无法伪造（即使恶意提供 author 也会被覆盖）。c1 发送，c2 作为旁观者收到被盖章的数据。
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }

function wsConnect(room, port){
  return new Promise((resolve, reject)=>{
    const s = net.connect(port, 'localhost');
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
// 借一个空闲端口给本次测试专用，避免与其他测试遗留的服务端争用 8080
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
  let header;
  if(len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.alloc(len);
  for(let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  s.write(Buffer.concat([header, mask, masked]));
}
function parseMsgs(buf){
  const out = []; let i = buf.indexOf('{');
  while(i !== -1){
    try { const m = JSON.parse(buf.slice(i)); out.push(m); } catch(e){}
    i = buf.indexOf('{', i + 1);
  }
  return out;
}

(async ()=>{
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, HB: '999999', PORT: String(port) }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const strokes = [];
  try {
    const c1 = await wsConnect('attrRoom', port);
    const c2 = await wsConnect('attrRoom', port);
    c2.on('data', d=>{ for(const m of parseMsgs(d.toString('utf8'))) if(m.type === 'stroke' || m.type === 'text') strokes.push(m); });
    await new Promise(r => setTimeout(r, 200));

    // c1 发送一笔，且恶意伪造 author 试图冒名
    wsSend(c1, { type:'stroke', stroke:{ tool:'pen', color:'#ffffff', width:4, points:[{x:1,y:1},{x:2,y:2}], author:'IMPOSTOR', authorColor:'#000000' } });
    wsSend(c1, { type:'text', text:'hi', x:5, y:5 });
    await new Promise(r => setTimeout(r, 300));

    const st = strokes.find(m => m.type === 'stroke');
    const tx = strokes.find(m => m.type === 'text');
    ok('c2 收到 stroke 广播', !!st);
    ok('服务端重写伪造署名(author!=IMPOSTOR)', st && typeof st.stroke.author === 'string' && st.stroke.author.length > 0 && st.stroke.author !== 'IMPOSTOR');
    ok('stroke 盖服务端调色板色(authorColor=#...)', st && typeof st.stroke.authorColor === 'string' && st.stroke.authorColor.startsWith('#'));
    ok('c2 收到 text 广播', !!tx);
    ok('text 服务端署名(author 有效)', tx && typeof tx.author === 'string' && tx.author.length > 0 && tx.author !== 'IMPOSTOR');
    ok('text 盖服务端调色板色', tx && typeof tx.authorColor === 'string' && tx.authorColor.startsWith('#'));
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard attr] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
