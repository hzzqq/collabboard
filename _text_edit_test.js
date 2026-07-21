const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 端到端测试：验证「按 id 编辑已有文字」——原地更新 + 广播 replace + 撤销还原。
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
  const tmp = path.join(dir, '.wb_inline_check.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

const ROOM = 'editTxt_' + Date.now();
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

  let createdId = null;
  c2.onmsg = msg=>{ if(msg.type==='text' && msg.id) createdId = msg.id; };
  // 新建文字
  c1.send({ type:'text', text:'v1', x:10, y:20, color:'#ffffff', width:16 });
  await sleep(250);
  ok('新建文字被对端收到并含 id', !!createdId);

  // 按 id 原地编辑为 v2 —— 服务端应广播 replace 且含更新后的文字
  let editReplace = null;
  c2.onmsg = msg=>{ if(msg.type==='replace' && Array.isArray(msg.strokes)){ const f = msg.strokes.find(s=> s.id===createdId); if(f && f.text==='v2') editReplace = f; } };
  c1.send({ type:'text', id: createdId, text:'v2', x:10, y:20, color:'#ffffff', width:16 });
  await sleep(300);
  ok('按 id 编辑后广播 replace 含更新文字(v2)', !!editReplace && editReplace.id===createdId);

  // 第三客户端快照应包含 v2
  const c3 = await connect(ROOM);
  let snapV2=false;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes) && msg.strokes.some(s=> s.id===createdId && s.text==='v2')) snapV2=true; };
  await sleep(400);
  if(!snapV2) snapV2 = (c3.msgs||[]).some(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes) && mm.strokes.some(s=> s.id===createdId && s.text==='v2'));
  ok('新客户端快照含编辑后文字(v2)', snapV2);

  // 撤销：文字应还原为 v1
  let undoV1=false;
  c2.onmsg = msg=>{ if(msg.type==='replace' && Array.isArray(msg.strokes)){ const f = msg.strokes.find(s=> s.id===createdId); if(f && f.text==='v1') undoV1=true; } };
  c1.send({ type:'undo' });
  await sleep(300);
  ok('撤销后文字还原为 v1', undoV1);

  server.kill();
  console.log(`\n[CollabBoard text-edit] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
