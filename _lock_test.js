// CollabBoard 端到端测试：验证房间锁定（房主锁定后非房主编辑被拒，房主仍可编辑；非房主不可锁定）。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const dir = __dirname;
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m);
if(m){
  const tmp = path.join(dir, '.wb_lock_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, HB: '5000' } });
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }
class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.onmsg=null; this.msgs=[]; this._cid=null; }
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
  const c1 = await connect('lockR');   // 房主
  const c2 = await connect('lockR');   // 普通成员
  await sleep(300);
  const c1id = (c1.msgs.find(x=>x.type==='welcome')||{}).id || null;
  const c2owner = (c2.msgs.find(x=>x.type==='owner')||{}).owner || null;
  ok('房主为首个加入者 c1', c2owner === c1id && c1id != null);

  // 房主锁定
  c1.send({ type:'lock' });
  await sleep(250);
  const c1LockMsg = c1.msgs.find(x=>x.type==='lock' && x.locked===true);
  const c2LockMsg = c2.msgs.find(x=>x.type==='lock' && x.locked===true);
  ok('锁定广播到全体成员', !!c1LockMsg && !!c2LockMsg);

  // 非房主 c2 编辑被拒
  let c1strokeBefore = c1.msgs.filter(m=>m.type==='stroke').length;
  c2.send({ type:'stroke', stroke:{ tool:'rect', color:'#f00', width:3, fill:true, points:[{x:1,y:1},{x:5,y:5}] } });
  await sleep(250);
  let c1strokeAfter = c1.msgs.filter(m=>m.type==='stroke').length;
  ok('锁定后非房主 stroke 被拒(房主未收到)', c1strokeAfter === c1strokeBefore);
  const c2LockedErr = c2.msgs.find(x=>x.type==='error' && x.code==='locked');
  ok('非房主收到 locked 错误', !!c2LockedErr);

  // 房主仍可编辑（其 stroke 应广播给 c2）
  let c2strokeBefore = c2.msgs.filter(m=>m.type==='stroke').length;
  c1.send({ type:'stroke', stroke:{ tool:'rect', color:'#0f0', width:3, fill:false, points:[{x:2,y:2},{x:6,y:6}] } });
  await sleep(250);
  let c2strokeAfter = c2.msgs.filter(m=>m.type==='stroke').length;
  ok('锁定后房主仍可编辑(广播给成员)', c2strokeAfter === c2strokeBefore + 1);

  // 非房主不能锁定
  c2.send({ type:'lock' });
  await sleep(200);
  const c2NotOwnerErr = c2.msgs.find(x=>x.type==='error' && x.code==='not_owner');
  ok('非房主锁定被拒(not_owner)', !!c2NotOwnerErr);

  // 房主解锁
  c1.send({ type:'unlock' });
  await sleep(250);
  const c1UnlockMsg = c1.msgs.find(x=>x.type==='lock' && x.locked===false);
  const c2UnlockMsg = c2.msgs.find(x=>x.type==='lock' && x.locked===false);
  ok('解锁广播到全体成员', !!c1UnlockMsg && !!c2UnlockMsg);

  server.kill();
  console.log(`\n[CollabBoard lock] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
