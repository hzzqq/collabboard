const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 端到端测试：验证群组移动（框选后按 id 列表平移）—— 服务端平移整组并广播，快照落库。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m);
if(m){
  const tmp = path.join(dir, '.wb_mm_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// 清理残留房间落盘，避免跨运行污染
try { fs.rmSync(path.join(dir, 'rooms'), { recursive:true, force:true }); } catch(e){}

// 2) 启动服务端
const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }

class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.onmsg=null; this.msgs=[]; }
  feed(d){
    this.buf = Buffer.concat([this.buf, d]);
    if(!this.handshake){
      const i=this.buf.indexOf('\r\n\r\n'); if(i<0) return;
      this.handshake=true; this.buf=this.buf.slice(i+4);
    }
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
  const room = 'mmR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room);
  const c2 = await connect(room);
  await sleep(300);
  let gotMove = null;
  c2.onmsg = msg=>{ if(msg.type==='move') gotMove = msg; };

  // c1 画两个元素（自带 id，便于后续群组移动引用）
  c1.send({ type:'stroke', stroke:{ id:'g1', tool:'rect', color:'#f00', width:3, fill:true, points:[{x:1,y:1},{x:5,y:5}] } });
  c1.send({ type:'stroke', stroke:{ id:'g2', tool:'pen', color:'#0f0', width:2, points:[{x:10,y:10},{x:12,y:12}] } });
  await sleep(300);

  // c1 把整组（g1,g2）平移 (5,7)
  c1.send({ type:'move', ids:['g1','g2'], dx:5, dy:7 });
  await sleep(300);
  ok('c2 收到群组 move（ids 数组）', gotMove && gotMove.type==='move' && Array.isArray(gotMove.ids) && gotMove.ids.includes('g1') && gotMove.ids.includes('g2') && gotMove.dx===5 && gotMove.dy===7);

  // 新客户端快照应反映整组已移动后的坐标
  const c3 = await connect(room);
  let snap = null;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  const e1 = snap && snap.strokes.find(s=>s.id==='g1');
  const e2 = snap && snap.strokes.find(s=>s.id==='g2');
  ok('快照 g1 已平移 (6,8)(10,12)', e1 && JSON.stringify(e1.points) === JSON.stringify([{x:6,y:8},{x:10,y:12}]));
  ok('快照 g2 已平移 (15,17)(17,19)', e2 && JSON.stringify(e2.points) === JSON.stringify([{x:15,y:17},{x:17,y:19}]));

  // 兼容性：单 id 移动仍可用
  let gotMove2 = null;
  c2.onmsg = msg=>{ if(msg.type==='move') gotMove2 = msg; };
  c1.send({ type:'stroke', stroke:{ id:'g3', tool:'rect', color:'#00f', width:2, points:[{x:0,y:0},{x:2,y:2}] } });
  await sleep(250);
  c1.send({ type:'move', id:'g3', dx:3, dy:3 });
  await sleep(300);
  ok('单 id 移动仍兼容（id 字段）', gotMove2 && gotMove2.id==='g3' && gotMove2.dx===3 && gotMove2.dy===3);

  server.kill();
  console.log(`\n[CollabBoard multimove] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
