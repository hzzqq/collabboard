// CollabBoard 端到端测试：验证旋转选中元素 rotate（绕质心 90°整数倍旋转、进撤销栈、
// 广播 replace、落盘；非 90° 整数倍与空 id 被忽略；undo 可还原）。
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
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

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m);
if(m){ const tmp = path.join(dir, '.wb_rot_inline.js'); fs.writeFileSync(tmp, m[1]);
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
  return new Promise((res)=>{
    const sock=net.connect(PORT,'localhost');
    const key=crypto.randomBytes(16).toString('base64');
    const ws=new WS(sock);
    sock.on('connect', ()=> sock.write(
      'GET /?room='+encodeURIComponent(room)+' HTTP/1.1\r\nHost: localhost:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'+
      'Sec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d=> ws.feed(d));
    setTimeout(()=> res(ws), 200);
  });
}
async function snapshotOf(room){
  const c = await connect(room);
  let snap = (c.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  c.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  await sleep(400);
  return snap ? snap.strokes.map(s=>JSON.parse(JSON.stringify(s))) : null;
}

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const room = 'rotR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room);
  await sleep(300);

  const a = { id:'a', tool:'pen', color:'#f00', width:2, points:[{x:0,y:0},{x:10,y:10}] };
  const b = { id:'b', tool:'pen', color:'#0f0', width:2, points:[{x:20,y:20},{x:30,y:30}] };
  c1.send({ type:'stroke', stroke:a });
  c1.send({ type:'stroke', stroke:b });
  await sleep(300);

  let snap = await snapshotOf(room);
  ok('初始 2 个元素', snap && snap.length === 2);

  // 旋转 a 90°：绕质心(5,5) 应得 [(10,0),(0,10)]
  c1.send({ type:'rotate', ids:['a'], deg:90 });
  await sleep(300);
  snap = await snapshotOf(room);
  const ra = snap.find(s=> s.id==='a');
  ok('a 旋转后存在', !!ra);
  ok('a 90° 后点0=(10,0)', ra && ra.points[0].x === 10 && ra.points[0].y === 0);
  ok('a 90° 后点1=(0,10)', ra && ra.points[1].x === 0 && ra.points[1].y === 10);
  // 质心不变（旋转不改变质心）
  const cx = (ra.points[0].x + ra.points[1].x)/2, cy = (ra.points[0].y + ra.points[1].y)/2;
  ok('a 质心仍为 (5,5)', ra && cx === 5 && cy === 5);
  // 线段长度不变
  const len = Math.hypot(ra.points[0].x-ra.points[1].x, ra.points[0].y-ra.points[1].y);
  ok('a 旋转后长度不变(√200)', ra && Math.abs(len - Math.SQRT2*10) < 1e-6);

  // 旋转 -90° 应还原
  c1.send({ type:'rotate', ids:['a'], deg:-90 });
  await sleep(300);
  snap = await snapshotOf(room);
  const ra2 = snap.find(s=> s.id==='a');
  ok('a -90° 还原点0=(0,0)', ra2 && ra2.points[0].x === 0 && ra2.points[0].y === 0);
  ok('a -90° 还原点1=(10,10)', ra2 && ra2.points[1].x === 10 && ra2.points[1].y === 10);

  // 文字旋转：单文字质心=自身锚点，位置不变、rot 累计到 90
  const t = { id:'t', type:'text', x:100, y:100, text:'hi', width:16 };
  c1.send({ type:'text', ...t });
  await sleep(250);
  c1.send({ type:'rotate', ids:['t'], deg:90 });
  await sleep(300);
  snap = await snapshotOf(room);
  const rt = snap.find(s=> s.id==='t');
  ok('文字 rot=90', rt && rt.rot === 90);
  ok('文字位置绕自身旋转不变', rt && rt.x === 100 && rt.y === 100);

  // 非 90° 整数倍被忽略
  let before = (await snapshotOf(room)).length;
  c1.send({ type:'rotate', ids:['a'], deg:45 });
  await sleep(250);
  ok('45° 被忽略(数量不变)', (await snapshotOf(room)).length === before);

  // 空 ids 被忽略
  c1.send({ type:'rotate', ids:[], deg:90 });
  await sleep(250);
  ok('空 ids 被忽略', (await snapshotOf(room)).length === before);

  // 撤销最后一次有效操作（文字 90°）应使文字 rot 归零
  c1.send({ type:'undo' });
  await sleep(300);
  snap = await snapshotOf(room);
  const rt2 = snap.find(s=> s.id==='t');
  ok('撤销后文字 rot 归零(无旋转)', rt2 && (rt2.rot || 0) === 0);

  server.kill();
  console.log(`\n[CollabBoard rotate] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
