const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 端到端测试：验证 stamp（图章/emoji 装饰）—— 服务端接收坐标+emoji、分配 id、广播、快照落库；
// 缺 text 时静默忽略(无广播)；size/rotation 钳制；color 缺省白；多字节 emoji 正常。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'stampR_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_stamp_inline.js');
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
const stampsOf = ws => (ws.msgs||[]).filter(m => m && m.type === 'stamp');

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1 = await connect(ROOM);
  const c2 = await connect(ROOM);
  await sleep(300);

  // c1 放置 emoji 图章（服务端分配 id、权威署名、转发给他人）
  c1.send({ type:'stamp', x: 100, y: 120, text: '🔥', size: 64, color: '#ff0000', rotation: 15 });
  await sleep(300);

  const got = stampsOf(c2);
  ok('c2 收到 stamp 广播', got.length >= 1);
  const s = got[0];
  ok('stamp 含服务端分配 id', s && s.id != null);
  ok('stamp 坐标正确', s && s.x === 100 && s.y === 120);
  ok('stamp emoji 正确', s && s.text === '🔥');
  ok('stamp size 正确', s && s.size === 64);
  ok('stamp color 正确', s && s.color === '#ff0000');
  ok('stamp rotation 正确', s && s.rotation === 15);
  ok('stamp 带服务端权威署名', s && typeof s.author === 'string' && s.author.length > 0 && !!s.authorColor);
  // 发送者 c1 不应收到自己发出的 stamp（广播排除发送者）
  ok('发送者 c1 不收到自己的 stamp', stampsOf(c1).length === 0);

  // 多字节 emoji 正常
  c1.send({ type:'stamp', x: 50, y: 50, text: '🎉' });
  await sleep(250);
  ok('多字节 emoji 图章正常', stampsOf(c2).some(m => m.text === '🎉'));

  // 缺 text：静默忽略，c2 不再收到新 stamp（用计数比对）
  const before = stampsOf(c1).length;
  c2.send({ type:'stamp', x: 10, y: 10 });
  await sleep(250);
  ok('缺 text 的 stamp 被忽略(无广播)', stampsOf(c1).length === before);

  // size 钳制：超大 → 256；过小 → 8
  c1.send({ type:'stamp', x: 1, y: 1, text: 'A', size: 9999 });
  await sleep(200);
  ok('size 超大钳制到 256', stampsOf(c2).some(m => m.size === 256));
  c1.send({ type:'stamp', x: 2, y: 2, text: 'B', size: 1 });
  await sleep(200);
  ok('size 过小钳制到 8', stampsOf(c2).some(m => m.size === 8));

  // color 缺省白
  c1.send({ type:'stamp', x: 3, y: 3, text: 'C' });
  await sleep(200);
  ok('缺 color 默认 #ffffff', stampsOf(c2).some(m => m.color === '#ffffff'));

  // 第三客户端快照应含已放置的图章
  const c3 = await connect(ROOM);
  let snap = null;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  const stamp = snap && snap.strokes.find(s=> s.type === 'stamp');
  ok('快照含 stamp 元素', stamp && stamp.text === '🔥' && stamp.x === 100 && stamp.y === 120);

  server.kill();
  console.log(`\n[CollabBoard stamp] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
