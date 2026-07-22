const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 端到端测试：验证 reaction（画布表情反应）—— 瞬时飘心、不进快照、不持久化。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'reactR_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_react_inline.js');
  fs.writeFileSync(tmp, sc[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// 2) 启动服务端
const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }

class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.onmsg=null; this.msgs=[]; }
  feed(d){
    this.buf = Buffer.concat([this.buf, d]);
    if(!this.handshake){ const i=this.buf.indexOf('\r\n\r\n'); if(i<0) return; this.handshake=true; this.buf=this.buf.slice(i+4); }
    while(this.buf.length>=2){
      const op=this.buf[0]&0x0f, masked=(this.buf[1]&0x80)!==0; let len=this.buf[1]&0x7f, p=2;
      if(len===126){ if(this.buf.length<p+2) return; len=this.buf.readUInt16BE(p); p+=2; }
      else if(len===127){ if(this.buf.length<p+8) return; len=Number(this.buf.readBigUInt64BE(p)); p+=8; }
      let mk; if(masked){ if(this.buf.length<p+4) return; mk=this.buf.slice(p,p+4); p+=4; }
      if(this.buf.length<p+len) return;
      let payload=this.buf.slice(p,p+len);
      if(masked){ for(let i=0;i<len;i++) payload[i]^=mk[i&3]; }
      this.buf=this.buf.slice(p+len);
      if(op===0x1){ const msg=JSON.parse(payload.toString('utf8')); this.msgs.push(msg); if(this.onmsg) this.onmsg(msg); }
      else if(op===0x9){ const h=Buffer.from([0x8a,len]); this.sock.write(Buffer.concat([h,payload])); }
    }
  }
  send(obj){
    const payload=Buffer.from(JSON.stringify(obj),'utf8'); const len=payload.length; const mask=crypto.randomBytes(4);
    let header;
    if(len<126) header=Buffer.from([0x81, 0x80|len]);
    else if(len<65536){ header=Buffer.alloc(4); header[0]=0x81; header[1]=0x80|126; header.writeUInt16BE(len,2); }
    else { header=Buffer.alloc(10); header[0]=0x81; header[1]=0x80|127; header.writeBigUInt64BE(BigInt(len),2); }
    const masked=Buffer.alloc(len);
    for(let i=0;i<len;i++) masked[i]=payload[i]^mask[i&3];
    this.sock.write(Buffer.concat([header,mask,masked]));
  }
}
function connect(room){
  return new Promise((res, rej)=>{
    const sock=net.connect(PORT,'localhost');
    const key=crypto.randomBytes(16).toString('base64');
    const ws=new WS(sock);
    sock.on('connect', ()=> sock.write(
      'GET /?room='+encodeURIComponent(room)+' HTTP/1.1\r\nHost: localhost:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'+
      'Sec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d=> ws.feed(d));
    sock.on('error', rej);
    setTimeout(()=> res(ws), 200);
  });
}

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1 = await connect(ROOM);
  const c2 = await connect(ROOM);
  await sleep(300);

  const c2Reactions = [];
  c2.onmsg = m => { if(m.type === 'reaction') c2Reactions.push(m); };

  // c1 发送画布表情反应
  c1.send({ type:'reaction', emoji:'❤️', x:100, y:200 });
  await sleep(300);

  ok('c2 收到 reaction', c2Reactions.length >= 1);
  const r0 = c2Reactions[0];
  ok('reaction 含 emoji', r0 && r0.emoji === '❤️');
  ok('reaction 含 x/y', r0 && r0.x === 100 && r0.y === 200);
  ok('reaction 含 by(作者)', r0 && typeof r0.by === 'string' && r0.by.length > 0);
  ok('reaction 含 name', r0 && typeof r0.name === 'string');
  // 发送者 c1 也收到自己的 reaction（瞬时视觉反馈，broadcast 不排除发送者）
  ok('发送者 c1 收到自己的 reaction', c1.msgs.some(m => m.type === 'reaction' && m.emoji === '❤️'));

  // 多字节 emoji 也能透传
  c1.send({ type:'reaction', emoji:'🔥', x:10, y:20 });
  await sleep(250);
  ok('多字节 emoji 透传', c2Reactions.some(m => m.emoji === '🔥' && m.x === 10 && m.y === 20));

  // 缺 emoji => 忽略，不广播
  const before = c2Reactions.length;
  c1.send({ type:'reaction', x:1, y:1 });
  await sleep(250);
  ok('缺 emoji 不广播', c2Reactions.length === before);

  server.kill();
  console.log(`\n[CollabBoard reaction] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
