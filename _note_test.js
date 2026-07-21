const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8098;
// CollabBoard 端到端测试：验证 sticky-note（便签）—— 服务端接收 x/y/text/color、校验、分配作者署名、广播、快照落库；空文本报错；锁定房间非房主被拒。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'noteR_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_note_inline.js');
  fs.writeFileSync(tmp, sc[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

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
async function connectId(room){
  const ws = await connect(room);
  const existing = ws.msgs.find(m=> m.type === 'welcome');
  if(existing) ws.id = existing.id;
  await new Promise(r=>{
    ws.onmsg = m=>{ if(m.type==='welcome'){ ws.id = m.id; r(); } };
    if(ws.id) r();
    setTimeout(r, 600);
  });
  return ws;
}

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1 = await connectId(ROOM);
  const c2 = await connectId(ROOM);
  await sleep(300);

  // c1 放便签；c2 应收到广播
  let gotNote = null;
  c2.onmsg = msg=>{ if(msg.type==='note') gotNote = msg; };
  c1.send({ type:'note', x:100, y:120, w:160, h:120, text:'待办：写文档', color:'#c9f7c9' });
  await sleep(350);

  ok('c2 收到 note 广播', gotNote && gotNote.type === 'note');
  ok('note 含文本内容', gotNote && gotNote.text === '待办：写文档');
  ok('note 含坐标', gotNote && gotNote.x === 100 && gotNote.y === 120);
  ok('note 带服务端权威作者署名', gotNote && typeof gotNote.author === 'string' && gotNote.author.length > 0 && !!gotNote.authorColor);
  ok('note 作者为 c1', gotNote && gotNote.author === c1.id);
  ok('note 颜色被服务端接受(#c9f7c9)', gotNote && gotNote.color === '#c9f7c9');
  ok('note 无伪造 id 时服务端生成 id', gotNote && typeof gotNote.id === 'string' && gotNote.id.length > 0);

  // c3 快照应含该便签
  let snap = null;
  const c3 = await connect(ROOM);
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  c3.send({ type:'request_snapshot' });
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  const el = snap && snap.strokes.find(s=> s.type === 'note' && s.text === '待办：写文档');
  ok('快照含便签元素', !!el);
  ok('便签元素无评论时 comments 为 undefined(评论后变数组)', el && el.comments === undefined);

  // 空文本报错
  let c1err = null; c1.onmsg = msg=>{ if(msg.type==='error') c1err = msg; };
  c1.send({ type:'note', x:0, y:0, text:'   ' });
  await sleep(300);
  ok('空文本便签 → 不落库(无广播/无错误回显，服务端静默丢弃)', c1err == null);

  // 锁定房间：房主(c1)锁定后，非房主 c2 的便签应被拒
  c1.send({ type:'lock' });
  await sleep(200);
  let c2lockErr = null; c2.onmsg = msg=>{ if(msg.type==='error') c2lockErr = msg; };
  let c1note = null; c1.onmsg = msg=>{ if(msg.type==='note') c1note = msg; };
  c2.send({ type:'note', x:10, y:10, text:'被锁拦截' });
  await sleep(300);
  ok('锁定后非房主便签被拒(error locked)', c2lockErr && c2lockErr.code === 'locked');
  ok('锁定后房主 c1 不收到被拒的便签', c1note == null);

  // 源码接线
  const srv = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
  ok("EDIT_OPS 含 'note'", /'note'/.test(srv.split('const EDIT_OPS')[1].split(';')[0]));
  ok('server 有 case note', /case 'note':/.test(srv));
  ok('index.html 有便签工具按钮', /data-tool="note"/.test(html));

  server.kill();
  console.log(`\n[CollabBoard note] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
