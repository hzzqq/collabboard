// CollabBoard 端到端测试：验证 move（拖拽移动）操作 —— 服务端按 id 平移元素并广播，快照落库。
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
  const tmp = path.join(dir, '.wb_move_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// 2) 启动服务端
const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, HB: '5000' } });
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
    const sock=net.connect(8080,'localhost');
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
  const c1 = await connect('moveR');
  const c2 = await connect('moveR');
  await sleep(300);
  let gotStroke=null, gotMove=null;
  c2.onmsg = msg=>{ if(msg.type==='stroke') gotStroke=msg; if(msg.type==='move') gotMove=msg; };

  // c1 画一个矩形（服务端分配 id）
  c1.send({ type:'stroke', stroke:{ tool:'rect', color:'#f00', width:3, fill:true, points:[{x:1,y:1},{x:5,y:5}] } });
  await sleep(300);
  ok('c2 收到 stroke 且含 id', gotStroke && gotStroke.stroke && gotStroke.stroke.id != null);
  const id = gotStroke.stroke.id;
  ok('初始坐标正确', JSON.stringify(gotStroke.stroke.points) === JSON.stringify([{x:1,y:1},{x:5,y:5}]));

  // c1 把该元素平移 (10,20)
  c1.send({ type:'move', id, dx:10, dy:20 });
  await sleep(300);
  ok('c2 收到 move 消息', gotMove && gotMove.type==='move' && gotMove.id===id && gotMove.dx===10 && gotMove.dy===20);

  // 新客户端快照应反映已移动后的坐标
  const c3 = await connect('moveR');
  let snap=null;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap=msg; };
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));  // 快照可能在 onmsg 赋值前已到达
  const el = snap && snap.strokes.find(s=>s.id===id);
  ok('快照含移动后坐标(11,21)(15,25)', el && JSON.stringify(el.points) === JSON.stringify([{x:11,y:21},{x:15,y:25}]));

  server.kill();
  console.log(`\n[CollabBoard move] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
