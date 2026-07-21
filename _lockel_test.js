const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8099;
// CollabBoard 端到端测试：元素级锁定(lock_element/unlock_element) —— 房主可锁/解锁元素；
// 被锁元素对非房主的所有编辑类操作(move/delete/...)返回 error element_locked；房主不受限。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'lockEl_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_lockel_inline.js');
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
  const c1 = await connectId(ROOM);   // 房主
  const c2 = await connectId(ROOM);   // 非房主
  await sleep(300);

  // c1 放置一个带显式 id 的便签 E1
  let gotNote = null; c2.onmsg = msg=>{ if(msg.type==='note') gotNote = msg; };
  c1.send({ type:'note', id:'E1', x:100, y:120, w:160, h:120, text:'锁我试试', color:'#c9f7c9' });
  await sleep(350);
  ok('c2 收到 E1 便签广播', gotNote && gotNote.id === 'E1');

  // 健全性：未锁定时，非房主 c2 移动 E1 应成功(c1 收到 move 广播，无错误)
  let c1move = null; c1.onmsg = msg=>{ if(msg.type==='move' && msg.id === 'E1') c1move = msg; };
  let c2err0 = null; c2.onmsg = msg=>{ if(msg.type==='error') c2err0 = msg; };
  c2.send({ type:'move', id:'E1', dx:2, dy:2 });
  await sleep(300);
  ok('未锁定时非房主可移动 E1(c1 收到 move)', c1move && c1move.dx === 2);
  ok('未锁定时移动无错误', c2err0 == null);

  // 非房主尝试锁定 E1 → 应被拒 not_owner
  let c2lockErr = null; c2.onmsg = msg=>{ if(msg.type==='error') c2lockErr = msg; };
  c2.send({ type:'lock_element', ids:['E1'] });
  await sleep(300);
  ok('非房主锁定元素被拒(error not_owner)', c2lockErr && c2lockErr.code === 'not_owner');

  // 房主 c1 锁定 E1 → c2 收到 lock_element 广播
  let c2lock = null; c2.onmsg = msg=>{ if(msg.type==='lock_element') c2lock = msg; };
  c1.send({ type:'lock_element', ids:['E1'] });
  await sleep(300);
  ok('房主锁定 E1 广播 lock_element(locked:true)', c2lock && c2lock.locked === true && Array.isArray(c2lock.ids) && c2lock.ids.includes('E1'));

  // 锁定后：非房主 c2 移动 E1 → 应被拒 element_locked，且 c1 不应收到 move
  let c1moveAfter = null; c1.onmsg = msg=>{ if(msg.type==='move' && msg.id === 'E1') c1moveAfter = msg; };
  let c2lockErr2 = null; c2.onmsg = msg=>{ if(msg.type==='error') c2lockErr2 = msg; };
  c2.send({ type:'move', id:'E1', dx:5, dy:5 });
  await sleep(300);
  ok('锁定后非房主移动被拒(error element_locked)', c2lockErr2 && c2lockErr2.code === 'element_locked');
  ok('锁定后房主 c1 不收到被拒的移动', c1moveAfter == null);

  // 锁定后：非房主 c2 删除 E1 → 应被拒 element_locked
  let c2lockErr3 = null; c2.onmsg = msg=>{ if(msg.type==='error') c2lockErr3 = msg; };
  c2.send({ type:'delete', ids:['E1'] });
  await sleep(300);
  ok('锁定后非房主删除被拒(error element_locked)', c2lockErr3 && c2lockErr3.code === 'element_locked');

  // 房主 c1 删除 E1（不受元素锁限制）→ 成功；广播给其他人(c2 收到 replace，发送者不回显)
  let c2del = null; c2.onmsg = msg=>{ if(msg.type==='replace') c2del = msg; };
  c1.send({ type:'delete', ids:['E1'] });
  await sleep(300);
  ok('房主可删除被锁元素(c2 收到 replace 且 E1 已移除)', c2del && Array.isArray(c2del.strokes) && !c2del.strokes.find(s=> s.id === 'E1'));

  // 源码接线
  const srv = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
  ok("server 有 case 'lock_element'", /case 'lock_element':/.test(srv));
  ok("server 有 case 'unlock_element'", /case 'unlock_element':/.test(srv));
  ok('server 元素锁守卫返回 element_locked', /element_locked/.test(srv));
  ok('server 房间初始化含 lockedElements', /lockedElements: new Set\(\)/.test(srv) || /lockedElements:new Set\(\)/.test(srv));
  ok('index.html 有锁定选中按钮', /id="lockElBtn"/.test(html));
  ok('index.html 有解锁选中按钮', /id="unlockElBtn"/.test(html));

  server.kill();
  console.log(`\n[CollabBoard lock-element] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
