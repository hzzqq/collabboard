const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 端到端测试：验证 arrow（箭头，作为 stroke 的 tool 变体）—— 服务端接收、广播、快照落库、锁定保护。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'arrR_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查（确认 index.html 的箭头改动语法正确）
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m);
if(m){
  const tmp = path.join(dir, '.wb_arr_inline.js');
  fs.writeFileSync(tmp, m[1]);
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

  let gotArrow = null;
  c2.onmsg = msg=>{ if(msg.type==='stroke' && msg.stroke && msg.stroke.tool==='arrow') gotArrow = msg; };

  const arrowStroke = { tool:'arrow', color:'#ff5a5a', width:3, points:[{x:10,y:10},{x:220,y:130}] };
  c1.send({ type:'stroke', stroke: arrowStroke });
  await sleep(300);

  ok('c2 收到 arrow 广播', gotArrow && gotArrow.type === 'stroke' && gotArrow.stroke.tool === 'arrow');
  ok('arrow 坐标正确', gotArrow && gotArrow.stroke.points[0].x === 10 && gotArrow.stroke.points[1].x === 220);
  ok('arrow 颜色保留', gotArrow && gotArrow.stroke.color === '#ff5a5a');
  ok('arrow 带服务端权威署名', gotArrow && typeof gotArrow.stroke.author === 'string' && gotArrow.stroke.author.length > 0 && gotArrow.stroke.authorColor);

  // 第三客户端快照应含该箭头
  const c3 = await connect(ROOM);
  let snap = null;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  const arr = snap && snap.strokes.find(s=> s.tool === 'arrow');
  ok('快照含 arrow 元素', arr && arr.points[1].x === 220 && arr.color === '#ff5a5a');

  // 锁定保护：owner(c1) 锁定后，非房主(c2) 的 arrow 应被拒
  let c2err = null;
  c2.onmsg = msg=>{ if(msg.type==='error') c2err = msg; };
  let c1arrow2 = null;
  c1.onmsg = msg=>{ if(msg.type==='stroke' && msg.stroke && msg.stroke.tool==='arrow') c1arrow2 = msg; };
  c1.send({ type:'lock' });
  await sleep(200);
  const arrow2 = { tool:'arrow', color:'#00d4ff', width:2, points:[{x:5,y:5},{x:50,y:50}] };
  c2.send({ type:'stroke', stroke: arrow2 });
  await sleep(300);
  ok('锁定后非房主 arrow 被拒 (error locked)', c2err && c2err.code === 'locked');
  ok('房主未收到非房主 arrow', c1arrow2 === null);

  server.kill();
  console.log(`\n[CollabBoard arrow] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
