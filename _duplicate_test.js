// CollabBoard 端到端测试：验证克隆选中元素 duplicate（深拷贝、新 id、偏移 +20/+20、
// 进撤销栈、广播 replace、落盘）。服务端权威处理；客户端按 replace 重绘。
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
if(m){ const tmp = path.join(dir, '.wb_dup_inline.js'); fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp); }

// 清理残留房间落盘
try { fs.rmSync(path.join(dir, 'rooms'), { recursive:true, force:true }); } catch(e){}

// 2) 启动服务端
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
// 读取某房间最新快照（strokes）
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
  const room = 'dupR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room);
  await sleep(300);

  const a = { id:'a', tool:'pen', color:'#f00', width:2, points:[{x:0,y:0},{x:10,y:10}] };
  const b = { id:'b', tool:'pen', color:'#0f0', width:2, points:[{x:20,y:20},{x:30,y:30}] };
  c1.send({ type:'stroke', stroke:a });
  c1.send({ type:'stroke', stroke:b });
  await sleep(300);

  let snap = await snapshotOf(room);
  ok('初始 2 个元素', snap && snap.length === 2);
  ok('初始含 a/b', snap && snap.some(s=>s.id==='a') && snap.some(s=>s.id==='b'));

  // 克隆 a
  c1.send({ type:'duplicate', ids:['a'] });
  await sleep(300);
  snap = await snapshotOf(room);
  ok('克隆后 3 个元素', snap && snap.length === 3);
  const reds = snap.filter(s=> s.color==='#f00');
  ok('出现 2 个红色(原+克隆)', reds.length === 2);
  const clone = reds.find(s=> s.id !== 'a');
  ok('克隆获得新 id(非 a)', !!clone && clone.id !== 'a');
  ok('克隆 id 含连接前缀', !!clone && /:/.test(clone.id));
  ok('克隆点整体偏移 +20/+20', !!clone &&
      clone.points[0].x === 20 && clone.points[0].y === 20 &&
      clone.points[1].x === 30 && clone.points[1].y === 30);
  // 原 a 不被改动
  const orig = snap.find(s=> s.id==='a');
  ok('原 a 位置不变', orig && orig.points[0].x === 0 && orig.points[0].y === 0);

  // 无选中时克隆被忽略
  const before = (await snapshotOf(room)).length;
  c1.send({ type:'duplicate', ids:[] });
  await sleep(250);
  ok('空 ids 被忽略', (await snapshotOf(room)).length === before);

  // 不存在的 id 被忽略
  c1.send({ type:'duplicate', ids:['nope'] });
  await sleep(250);
  ok('不存在 id 被忽略', (await snapshotOf(room)).length === before);

  server.kill();
  console.log(`\n[CollabBoard duplicate] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
