// CollabBoard 端到端测试：房主转让 transfer（仅房主可发起；目标须在线；
// 非房主拒绝；转让后 owner 广播更新；目标离线返回 no_such_user）。
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8094;
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
const m0 = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m0);
if(m0){ const tmp = path.join(dir, '.wb_tr_inline.js'); fs.writeFileSync(tmp, m0[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp); }

try { fs.rmSync(path.join(dir, 'rooms'), { recursive:true, force:true }); } catch(e){}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.onmsg=null; this._owner=null; this._cid=null; }
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
      if(op===0x1){ const msg=JSON.parse(payload.toString('utf8')); if(msg.type==='owner') this._owner = msg.owner; if(msg.type==='welcome') this._cid = msg.id; if(this.onmsg) this.onmsg(msg); }
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
  const room = 'trR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room); await sleep(300);
  const c2 = await connect(room); await sleep(150);
  const c3 = await connect(room); await sleep(150);

  // 捕获各自的 _cid（来自 welcome 消息，已在 WS 类中持久记录）
  await sleep(400);
  const c1id = c1._cid, c2id = c2._cid, c3id = c3._cid;
  ok('c1/c2/c3 各自 id 已获得', c1id && c2id && c3id && c1id !== c2id && c2id !== c3id);
  ok('c1 为房主（与广播 owner 一致）', c1._owner === c1id);

  // 房主 c1 转让给 c2
  let gotOwner=null; c2.onmsg = msg=>{ if(msg.type==='owner') gotOwner = msg.owner; };
  let c3gotOwner=null; c3.onmsg = msg=>{ if(msg.type==='owner') c3gotOwner = msg.owner; };
  c1.send({ type:'transfer', toId: c2id });
  await sleep(400);
  ok('转让后 owner 广播给 c2', gotOwner === c2id);
  ok('转让后 owner 广播给 c3', c3gotOwner === c2id);

  // 非房主 c3 尝试转让 -> 被拒绝
  let err=null; c3.onmsg = msg=>{ if(msg.type==='error') err = msg; };
  c3.send({ type:'transfer', toId: c1id });
  await sleep(400);
  ok('非房主转让被拒绝 (not_owner)', err && err.code === 'not_owner');

  // 房主 c2 转让给不存在的用户 -> no_such_user
  let err2=null; c2.onmsg = msg=>{ if(msg.type==='error') err2 = msg; };
  c2.send({ type:'transfer', toId: 'zzz_noone' });
  await sleep(400);
  ok('转让给离线用户被拒绝 (no_such_user)', err2 && err2.code === 'no_such_user');

  server.kill();
  console.log(`\n[CollabBoard transfer] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
