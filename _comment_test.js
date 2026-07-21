const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8097;
// CollabBoard 端到端测试：验证 elementComment（元素评论）—— 服务端接收 id+文本、校验元素存在、分配作者署名、广播、快照落库；不存在元素报错；锁定房间时非房主被拒。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'commentR_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_comment_inline.js');
  fs.writeFileSync(tmp, sc[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// 2) 启动服务端
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

// 连接后抓取 welcome 中的 id（welcome 可能在 onmsg 设置前已到达，故同时检查已收 msgs）
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

  // c1 放置一个带已知 id 的笔画（服务端保留 id 并署名）
  c1.send({ type:'stroke', stroke:{ type:'pen', id:'s1', points:[{x:10,y:10},{x:60,y:60}], color:'#ffffff', width:4 } });
  await sleep(300);

  // c2 对 s1 评论
  let gotComment = null;
  const c3 = await connect(ROOM);
  c3.onmsg = msg=>{ if(msg.type==='comment') gotComment = msg; };
  c2.send({ type:'comment', id:'s1', text:'这是一条评论' });
  await sleep(350);

  ok('c3 收到 comment 广播', gotComment && gotComment.type === 'comment');
  ok('comment 含目标 id', gotComment && gotComment.id === 's1');
  ok('comment 含文本内容', gotComment && gotComment.comment && gotComment.comment.text === '这是一条评论');
  ok('comment 带服务端权威作者署名', gotComment && typeof gotComment.comment.author === 'string' && gotComment.comment.author.length > 0 && !!gotComment.comment.authorColor);
  ok('comment 作者为 c2', gotComment && gotComment.comment.author === c2.id);

  // 第三客户端请求最新快照（c3 初连时评论尚未发生，需主动拉取最新快照）
  let snap = null;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  c3.send({ type:'request_snapshot' });
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  const el = snap && snap.strokes.find(s=> s.id === 's1');
  ok('快照含元素 s1', !!el);
  ok('元素 s1 的 comments 含该评论', el && Array.isArray(el.comments) && el.comments.some(c=> c.text === '这是一条评论' && c.author === c2.id));

  // 不存在的元素报错
  let c2err = null; c2.onmsg = msg=>{ if(msg.type==='error') c2err = msg; };
  c2.send({ type:'comment', id:'nope', text:'x' });
  await sleep(300);
  ok('评论不存在元素 → error(no_such_element)', c2err && c2err.code === 'no_such_element');

  // 锁定房间：房主(c1)锁定后，非房主 c2 的评论应被拒
  c1.send({ type:'lock' });
  await sleep(200);
  let c2lockErr = null; c2.onmsg = msg=>{ if(msg.type==='error') c2lockErr = msg; };
  let c1comment = null; c1.onmsg = msg=>{ if(msg.type==='comment') c1comment = msg; };
  c2.send({ type:'comment', id:'s1', text:'被锁拦截' });
  await sleep(300);
  ok('锁定后非房主评论被拒(error locked)', c2lockErr && c2lockErr.code === 'locked');
  ok('锁定后房主 c1 不收到被拒的评论', c1comment == null);

  server.kill();
  console.log(`\n[CollabBoard comment] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
