// _set_password_test.js — CollabBoard set_password（房主设密码 + 握手阶段校验）
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const PORT = 8138;
const ROOM = 'pw_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_pw_inline.js');
  fs.writeFileSync(tmp, sc[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }
class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.msgs=[]; this.errs=0; }
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
      if(op===0x1){ const msg=JSON.parse(payload.toString('utf8')); this.msgs.push(msg); if(msg.type==='error') this.errs++; }
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
function connect(room, extra){
  return new Promise((res)=>{
    const sock=net.connect(PORT,'localhost');
    const key=crypto.randomBytes(16).toString('base64');
    const ws=new WS(sock);
    const q = extra ? '&'+extra : '';
    sock.on('connect', ()=> sock.write(
      'GET /?room='+encodeURIComponent(room)+q+' HTTP/1.1\r\nHost: localhost:'+PORT+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'+
      'Sec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d=> ws.feed(d));
    sock.on('error', ()=>{});
    setTimeout(()=> res(ws), 200);
  });
}

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1 = await connect(ROOM);
  const c2 = await connect(ROOM);
  await sleep(400);
  const ids = c2.msgs.filter(m => m.type === 'presence').pop().ids;
  ok('拿到两名客户端 cid', ids.length >= 2);

  // 房主设密码
  c1.send({ type:'set_password', password:'secret' });
  await sleep(300);
  const ps = c2.msgs.filter(m => m.type==='password_set').pop();
  ok('c2 收到 password_set', !!ps);
  ok('set=true', ps && ps.set === true);

  // 无密码加入 -> 拒绝（隐性问题：握手阶段必须校验密码）
  const c3 = await connect(ROOM);
  await sleep(300);
  ok('无密码连接被拒(unauthorized)', c3.msgs.some(m => m.type==='error' && m.code==='unauthorized'));
  ok('无密码连接无 welcome', !c3.msgs.some(m => m.type==='welcome'));

  // 正确密码加入 -> 成功
  const c3b = await connect(ROOM, 'pwd=secret');
  await sleep(300);
  ok('正确密码连接拿到 welcome', c3b.msgs.some(m => m.type==='welcome'));

  // 弱密码 -> error
  const beforeErr = c1.errs;
  c1.send({ type:'set_password', password:'abc' });
  await sleep(300);
  const weak = c1.msgs.filter(m=>m.type==='error').slice(beforeErr).pop();
  ok('弱密码报错 weak_password', weak && weak.code === 'weak_password');

  // 清空密码
  c1.send({ type:'set_password', password:'' });
  await sleep(300);
  const clr = c2.msgs.filter(m => m.type==='password_set').pop();
  ok('清空密码 set=false', clr && clr.set === false);

  server.kill();
  console.log(`\n[CollabBoard set_password] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
