const PORT = 8093;
// CollabBoard 端到端测试：验证 set_permissions（房主设置编辑权限并广播，非房主受约束）
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'perm_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_perm_inline.js');
  fs.writeFileSync(tmp, sc[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp);
}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }

class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.msgs=[]; }
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
      if(op===0x1){ const msg=JSON.parse(payload.toString('utf8')); this.msgs.push(msg); }
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
  const c1 = await connect(ROOM);   // 首个连接 => 房主
  const c2 = await connect(ROOM);
  await sleep(400);

  // 房主设置 host-only，全员收到 permissions
  c1.send({ type:'set_permissions', mode:'host-only' });
  await sleep(300);
  ok('c2 收到 permissions=host-only', c2.msgs.some(m => m.type==='permissions' && m.permissions==='host-only'));

  // 非房主设置权限被拒
  c2.send({ type:'set_permissions', mode:'all' });
  await sleep(300);
  ok('非房主 set_permissions 收到 not_owner 错误', c2.msgs.some(m => m.type==='error' && m.code==='not_owner'));

  // 非房主在 host-only 下描边被拒，且不广播给房主
  const c1StrokeBefore = c1.msgs.filter(m=>m.type==='stroke').length;
  c2.send({ type:'stroke', stroke:{ x:5, y:5, points:[] } });
  await sleep(300);
  ok('非房主描边收到 no_edit_permission', c2.msgs.some(m => m.type==='error' && m.code==='no_edit_permission'));
  ok('被拒描边未广播给房主', c1.msgs.filter(m=>m.type==='stroke').length === c1StrokeBefore);

  // 房主在 host-only 下描边成功，广播给非房主
  const c2StrokeBefore = c2.msgs.filter(m=>m.type==='stroke').length;
  c1.send({ type:'stroke', stroke:{ x:10, y:10, points:[] } });
  await sleep(300);
  ok('房主描边成功(未被拒)', !c1.msgs.some(m => m.type==='error' && m.code==='no_edit_permission'));
  ok('房主描边广播给非房主', c2.msgs.filter(m=>m.type==='stroke').length === c2StrokeBefore + 1);

  // 房主改回 all
  c1.send({ type:'set_permissions', mode:'all' });
  await sleep(300);
  ok('c2 收到 permissions=all', c2.msgs.some(m => m.type==='permissions' && m.permissions==='all'));

  // 非房主在 all 下描边成功，广播给房主
  const c1StrokeBefore2 = c1.msgs.filter(m=>m.type==='stroke').length;
  const c2ErrBefore = c2.msgs.filter(m=>m.type==='error' && m.code==='no_edit_permission').length;
  c2.send({ type:'stroke', stroke:{ x:7, y:7, points:[] } });
  await sleep(300);
  ok('all 模式下非房主描边未被拒', c2.msgs.filter(m=>m.type==='error' && m.code==='no_edit_permission').length === c2ErrBefore);
  ok('非房主描边广播给房主', c1.msgs.filter(m=>m.type==='stroke').length === c1StrokeBefore2 + 1);

  // 非法 mode 报错
  c1.send({ type:'set_permissions', mode:'whatever' });
  await sleep(300);
  ok('非法 mode 收到 bad_mode 错误', c1.msgs.some(m => m.type==='error' && m.code==='bad_mode'));

  server.kill();
  console.log(`\n[CollabBoard permissions] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
