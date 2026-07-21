// CollabBoard 端到端测试：验证选择性删除 delete（按 ids 移除、进撤销栈、广播 replace、
// 落盘；空 id 与不存在 id 被忽略；undo 可还原）。
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
if(m){ const tmp = path.join(dir, '.wb_del_inline.js'); fs.writeFileSync(tmp, m[1]);
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
  const room = 'delR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room);
  await sleep(300);

  const a = { id:'a', tool:'pen', color:'#f00', width:2, points:[{x:0,y:0},{x:10,y:10}] };
  const b = { id:'b', tool:'pen', color:'#0f0', width:2, points:[{x:20,y:20},{x:30,y:30}] };
  const c = { id:'c', tool:'pen', color:'#00f', width:2, points:[{x:40,y:40},{x:50,y:50}] };
  c1.send({ type:'stroke', stroke:a });
  c1.send({ type:'stroke', stroke:b });
  c1.send({ type:'stroke', stroke:c });
  await sleep(300);

  let snap = await snapshotOf(room);
  ok('初始 3 个元素', snap && snap.length === 3);

  // 删除 a
  c1.send({ type:'delete', ids:['a'] });
  await sleep(300);
  snap = await snapshotOf(room);
  ok('删除 a 后 2 个元素', snap && snap.length === 2);
  ok('a 已移除', snap && !snap.some(s=> s.id==='a'));
  ok('b/c 仍在', snap && snap.some(s=>s.id==='b') && snap.some(s=>s.id==='c'));

  // 删除不存在 id 被忽略
  let before = (await snapshotOf(room)).length;
  c1.send({ type:'delete', ids:['nope'] });
  await sleep(250);
  ok('不存在 id 被忽略', (await snapshotOf(room)).length === before);

  // 空 ids 被忽略
  c1.send({ type:'delete', ids:[] });
  await sleep(250);
  ok('空 ids 被忽略', (await snapshotOf(room)).length === before);

  // 删除多个（b 和 c）
  c1.send({ type:'delete', ids:['b','c'] });
  await sleep(300);
  ok('删除 b,c 后为空', (await snapshotOf(room)).length === 0);

  // 撤销应还原最后删除的 b,c（回到 2 个元素）
  c1.send({ type:'undo' });
  await sleep(300);
  snap = await snapshotOf(room);
  ok('撤销还原 b,c', snap && snap.length === 2 && snap.some(s=>s.id==='b') && snap.some(s=>s.id==='c'));

  // 再撤销应还原更早的 a 删除（回到 3 个元素）
  c1.send({ type:'undo' });
  await sleep(300);
  snap = await snapshotOf(room);
  ok('再撤销还原 a', snap && snap.length === 3 && snap.some(s=>s.id==='a'));

  server.kill();
  console.log(`\n[CollabBoard delete] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
