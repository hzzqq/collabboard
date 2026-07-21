const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8091;
// CollabBoard 端到端测试：验证激光笔（laser）—— 服务端实时转发给他人、不回显自己、
// 不落库（不产生 stroke）、不受房间锁限制、laser_end 正确广播。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'laser_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查（确认 index.html 的激光笔改动语法正确）
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m);
if(m){
  const tmp = path.join(dir, '.wb_laser_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}
// 验证关键接线确实存在
ok('含激光笔按钮', /data-tool="laser"/.test(html));
ok('pointermove 含 laser 分支', /tool === 'laser'/.test(html));
ok('drawCursors 渲染 remoteLasers', /remoteLasers/.test(html) && /shadowBlur/.test(html));
ok('onmessage 处理 laser', /case 'laser':/.test(html));

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

  // c1 的激光笔应转发到 c2
  let gotLaser = null;
  c2.onmsg = msg=>{ if(msg.type==='laser') gotLaser = msg; };
  c1.send({ type:'laser', x: 123, y: 456 });
  await sleep(300);
  ok('c2 收到 laser 广播', gotLaser && gotLaser.type === 'laser');
  ok('laser 坐标正确', gotLaser && gotLaser.x === 123 && gotLaser.y === 456);
  ok('laser 带 author', gotLaser && typeof gotLaser.author === 'string' && gotLaser.author.length > 0);
  ok('laser 带 name', gotLaser && typeof gotLaser.name === 'string');

  // 自己不应收到自己发出的 laser（回显排除发送者）
  let c1Echo = null;
  c1.onmsg = msg=>{ if(msg.type==='laser') c1Echo = msg; };
  c1.send({ type:'laser', x: 1, y: 2 });
  await sleep(250);
  ok('c1 收到自己 laser 回显? 应为否', c1Echo === null);

  // laser_end 广播
  let gotEnd = null;
  c2.onmsg = msg=>{ if(msg.type==='laser_end') gotEnd = msg; };
  c1.send({ type:'laser_end' });
  await sleep(250);
  ok('c2 收到 laser_end', gotEnd && gotEnd.type === 'laser_end' && typeof gotEnd.author === 'string');

  // 不落库：连接第三客户端，快照应无 stroke（激光笔不产生持久元素）
  const c3 = await connect(ROOM);
  let snap = null;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  ok('快照无持久 stroke（laser 不落库）', snap && snap.strokes.length === 0);

  // 不受房间锁限制：c1 锁定后，c2 的激光笔仍应转发给 c3
  let c3laser = null;
  c3.onmsg = msg=>{ if(msg.type==='laser') c3laser = msg; };
  let c2err = null;
  c2.onmsg = msg=>{ if(msg.type==='error') c2err = msg; };
  c1.send({ type:'lock' });
  await sleep(250);
  c2.send({ type:'laser', x: 77, y: 88 });
  await sleep(300);
  ok('锁定后 c2 激光笔仍广播给 c3', c3laser && c3laser.x === 77 && c3laser.y === 88);
  ok('锁定后激光笔不被拒 (无 locked 错误)', c2err === null);

  server.kill();
  console.log(`\n[CollabBoard laser] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
