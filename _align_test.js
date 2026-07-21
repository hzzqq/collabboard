// CollabBoard 端到端测试：验证对齐 align（左/中/右/上/中/下；单元素/非法 how 被忽略；
// 服务端权威重定位、广播 replace、落盘）。
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8092;
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const dir = __dirname;
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m);
if(m){ const tmp = path.join(dir, '.wb_aln_inline.js'); fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp); }
try { fs.rmSync(path.join(dir, 'rooms'), { recursive:true, force:true }); } catch(e){}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
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
  send(obj){ const payload=Buffer.from(JSON.stringify(obj),'utf8'); const len=payload.length; const mask=crypto.randomBytes(4);
    let header; if(len<126) header=Buffer.from([0x81, 0x80|len]);
    else if(len<65536){ header=Buffer.alloc(4); header[0]=0x81; header[1]=0x80|126; header.writeUInt16BE(len,2); }
    else { header=Buffer.alloc(10); header[0]=0x81; header[1]=0x80|127; header.writeBigUInt64BE(BigInt(len),2); }
    const masked=Buffer.alloc(len); for(let i=0;i<len;i++) masked[i]=payload[i]^mask[i&3]; this.sock.write(Buffer.concat([header,mask,masked])); }
}
function connect(room){ return new Promise((res)=>{ const sock=net.connect(PORT,'localhost'); const key=crypto.randomBytes(16).toString('base64'); const ws=new WS(sock);
  sock.on('connect', ()=> sock.write('GET /?room='+encodeURIComponent(room)+' HTTP/1.1\r\nHost: localhost:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  sock.on('data', d=> ws.feed(d)); setTimeout(()=> res(ws), 200); }); }
async function snapshotOf(room){ const c = await connect(room); let snap=(c.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes)); c.onmsg=msg=>{ if(msg.type==='snapshot'&&Array.isArray(msg.strokes)) snap=msg; }; await sleep(400); return snap? snap.strokes.map(s=>JSON.parse(JSON.stringify(s))):null; }

const mk = (id,x0,y0,x1,y1)=>({ id, tool:'pen', color:'#000', width:2, points:[{x:x0,y:y0},{x:x1,y:y1}] });
const bbox = el => { let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity; for(const p of el.points){ x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y);} return {x0,y0,x1,y1}; };

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const room = 'alnR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room);
  await sleep(300);

  async function reset(){ c1.send({ type:'replace', strokes:[ mk('a',0,0,10,10), mk('b',20,20,30,30), mk('c',40,40,50,50) ] }); await sleep(250); }
  async function snap(){ return await snapshotOf(room); }

  await reset();
  c1.send({ type:'align', ids:['a','b','c'], how:'left' }); await sleep(250);
  let s = await snap();
  ok('左对齐：a 仍 minX=0', bbox(s.find(e=>e.id==='a')).x0 === 0);
  ok('左对齐：b 移到 minX=0', bbox(s.find(e=>e.id==='b')).x0 === 0);
  ok('左对齐：c 移到 minX=0', bbox(s.find(e=>e.id==='c')).x0 === 0);

  await reset();
  c1.send({ type:'align', ids:['a','b','c'], how:'right' }); await sleep(250);
  s = await snap();
  ok('右对齐：a 移到 maxX=50', bbox(s.find(e=>e.id==='a')).x1 === 50);
  ok('右对齐：b 移到 maxX=50', bbox(s.find(e=>e.id==='b')).x1 === 50);
  ok('右对齐：c maxX=50', bbox(s.find(e=>e.id==='c')).x1 === 50);

  await reset();
  c1.send({ type:'align', ids:['a','b','c'], how:'center' }); await sleep(250);
  s = await snap();
  const cx = [bbox(s.find(e=>e.id==='a')),bbox(s.find(e=>e.id==='b')),bbox(s.find(e=>e.id==='c'))].map(b=>(b.x0+b.x1)/2);
  ok('居中对齐：三元素中心 x 相等(=25)', cx[0]===cx[1] && cx[1]===cx[2] && cx[0]===25);

  await reset();
  c1.send({ type:'align', ids:['a','b','c'], how:'top' }); await sleep(250);
  s = await snap();
  ok('顶对齐：三元素 minY=0', bbox(s.find(e=>e.id==='a')).y0===0 && bbox(s.find(e=>e.id==='b')).y0===0 && bbox(s.find(e=>e.id==='c')).y0===0);

  await reset();
  c1.send({ type:'align', ids:['a','b','c'], how:'bottom' }); await sleep(250);
  s = await snap();
  ok('底对齐：三元素 maxY=50', bbox(s.find(e=>e.id==='a')).y1===50 && bbox(s.find(e=>e.id==='b')).y1===50 && bbox(s.find(e=>e.id==='c')).y1===50);

  await reset();
  c1.send({ type:'align', ids:['a','b','c'], how:'middle' }); await sleep(250);
  s = await snap();
  const cy = [bbox(s.find(e=>e.id==='a')),bbox(s.find(e=>e.id==='b')),bbox(s.find(e=>e.id==='c'))].map(b=>(b.y0+b.y1)/2);
  ok('中对齐：三元素中心 y 相等(=25)', cy[0]===cy[1] && cy[1]===cy[2] && cy[0]===25);

  // 单元素对齐被忽略
  await reset(); const before = (await snap()).length;
  c1.send({ type:'align', ids:['a'], how:'left' }); await sleep(200);
  ok('单元素对齐被忽略', (await snap()).length === before);
  // 非法 how 被忽略
  c1.send({ type:'align', ids:['a','b'], how:'diagonal' }); await sleep(200);
  ok('非法 how 被忽略', (await snap()).length === before);

  server.kill();
  console.log(`\n[CollabBoard align] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
