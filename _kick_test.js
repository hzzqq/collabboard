// ci128 CollabBoard 房主踢人 kick —— 端到端测试（房主可踢出成员；非房主/踢自己/踢不存在均被拒）。
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8096;
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

// 内联脚本语法检查（与仓库其他 e2e 测试一致）
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m0 = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m0);
if(m0){ const tmp = path.join(dir, '.wb_kick_inline.js'); fs.writeFileSync(tmp, m0[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp); }

try { fs.rmSync(path.join(dir, 'rooms'), { recursive:true, force:true }); } catch(e){}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.onmsg=null; this._cid=null; this._snap=null; this.closed=false;
    sock.on('close', ()=> this.closed = true); sock.on('error', ()=> this.closed = true); }
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
      if(op===0x1){ const msg=JSON.parse(payload.toString('utf8')); if(msg.type==='welcome') this._cid = msg.id; if(msg.type==='snapshot') this._snap = msg; if(this.onmsg) this.onmsg(msg); }
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

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const room = 'kickR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room); await sleep(300);   // 首个加入者 => 房主
  let ownerGot = null;
  c1.onmsg = m => { if(m.type === 'owner') ownerGot = m.owner; };   // 提前挂上，捕获 c2/c3 入房时的 owner 广播
  const c2 = await connect(room); await sleep(300);
  const c3 = await connect(room); await sleep(300);

  const c1id = c1._cid, c2id = c2._cid, c3id = c3._cid;
  ok('c1/c2/c3 id 已获得', c1id && c2id && c3id && c1id !== c2id && c2id !== c3id);

  // 确认 c1 是房主
  await sleep(150);
  ok('c1 是房主', ownerGot === c1id);

  // 房主踢出 c2
  let c1kicked = null, c3kicked = null;
  c1.onmsg = m => { if(m.type === 'kicked') c1kicked = m; };
  c3.onmsg = m => { if(m.type === 'kicked') c3kicked = m; };
  c1.send({ type:'kick', toId: c2id });
  await sleep(500);
  ok('被踢者 c2 连接已断开', c2.closed === true);
  ok('房主收到 kicked 广播', c1kicked && c1kicked.id === c2id && c1kicked.by === c1id);
  ok('其他成员(c3)收到 kicked 广播', c3kicked && c3kicked.id === c2id && c3kicked.by === c1id);

  // 非房主不能踢人
  let c3err = null;
  c3.onmsg = m => { if(m.type === 'error') c3err = m; };
  c3.send({ type:'kick', toId: c1id });
  await sleep(350);
  ok('非房主踢人 => not_owner 错误', c3err && c3err.code === 'not_owner');

  // 房主不能踢自己
  let selfErr = null;
  c1.onmsg = m => { if(m.type === 'error') selfErr = m; };
  c1.send({ type:'kick', toId: c1id });
  await sleep(350);
  ok('房主踢自己 => kick_self 错误', selfErr && selfErr.code === 'kick_self');

  // 踢不存在的用户
  let noUser = null;
  c1.onmsg = m => { if(m.type === 'error') noUser = m; };
  c1.send({ type:'kick', toId: 'nope_xyz' });
  await sleep(350);
  ok('踢不存在用户 => no_such_user 错误', noUser && noUser.code === 'no_such_user');

  server.kill();
  console.log(`\n[CollabBoard kick] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
