// CollabBoard 端到端测试：选区在场 select（服务端转发 {ids,author,color,name} 给他人，不落库；
// 发起方不回显；空 ids 表示清空；锁定房间下仍转发）。
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8095;
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
if(m0){ const tmp = path.join(dir, '.wb_sel_inline.js'); fs.writeFileSync(tmp, m0[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp); }

try { fs.rmSync(path.join(dir, 'rooms'), { recursive:true, force:true }); } catch(e){}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.onmsg=null; this._cid=null; this._snap=null; }
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
  const room = 'selR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room); await sleep(300);
  const c2 = await connect(room); await sleep(300);

  const c1id = c1._cid, c2id = c2._cid;
  ok('c1/c2 id 已获得', c1id && c2id && c1id !== c2id);

  // c1 选中 ['a'] -> c2 收到（含 author/color/name），c1 自己不回显
  let got=null; c2.onmsg = msg=>{ if(msg.type==='select') got = msg; };
  let selfGot=false; c1.onmsg = msg=>{ if(msg.type==='select') selfGot = true; };
  c1.send({ type:'select', ids:['a','b'] });
  await sleep(350);
  ok('c2 收到 select 广播', !!got);
  ok('select 含 ids=[a,b]', got && JSON.stringify(got.ids) === JSON.stringify(['a','b']));
  ok('select 含 author(=c1 id)', got && got.author === c1id);
  ok('select 含 color', got && typeof got.color === 'string');
  ok('select 含 name', got && typeof got.name === 'string');
  ok('发起方 c1 不回显 select', selfGot === false);

  // c1 发送空 ids -> c2 收到清空信号
  let got2=null; c2.onmsg = msg=>{ if(msg.type==='select') got2 = msg; };
  c1.send({ type:'select', ids:[] });
  await sleep(350);
  ok('空 ids 表示清空（c2 收到）', got2 && Array.isArray(got2.ids) && got2.ids.length === 0);

  // 不落库：snapshot 不含 select 元素
  const sc = await connect(room); await sleep(400);
  const snap = sc._snap;
  ok('snapshot 无 select 类型元素', snap && Array.isArray(snap.strokes) && !snap.strokes.some(x=> x && x.type === 'select'));

  // 锁定房间下 select 仍转发（控制类，不受锁限制）
  c1.send({ type:'lock', locked:true }); await sleep(200);
  const c3 = await connect(room); await sleep(150);
  let c3got=null; c3.onmsg = msg=>{ if(msg.type==='select') c3got = msg; };
  c1.send({ type:'select', ids:['z'] });
  await sleep(400);
  ok('锁定房间下 select 仍被转发', c3got && JSON.stringify(c3got.ids) === JSON.stringify(['z']) && c3got.author === c1id);

  server.kill();
  console.log(`\n[CollabBoard select-presence] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
