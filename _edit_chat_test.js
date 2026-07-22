const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8091;
// CollabBoard 端到端测试：验证 edit_chat（编辑自己的聊天消息）
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'editchat_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_editchat_inline.js');
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

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1 = await connect(ROOM);
  const c2 = await connect(ROOM);
  await sleep(300);

  // c1 发消息，c2 捕获 mid（chat 仅转发给他人，c1 收不到自己的）
  let mid = null;
  c2.onmsg = m => { if(m.type === 'chat' && typeof m.mid === 'number') mid = m.mid; };
  c1.send({ type:'chat', text:'原始消息' });
  await sleep(300);
  ok('c2 收到 c1 的聊天并拿到 mid', mid !== null);

  // c1 编辑自己的消息
  c1.send({ type:'edit_chat', mid, text:'编辑后的消息' });
  await sleep(300);
  ok('c2 收到 chat_updated', c2.msgs.some(m => m.type === 'chat_updated' && m.mid === mid && m.text === '编辑后的消息' && m.edited === true));
  ok('发送者 c1 也收到 chat_updated', c1.msgs.some(m => m.type === 'chat_updated' && m.mid === mid && m.text === '编辑后的消息'));
  ok('chat_updated 含 by(作者cid)', c2.msgs.some(m => m.type === 'chat_updated' && m.mid === mid && typeof m.by === 'string'));

  // 编辑不存在的 mid => no_such_chat
  const beforeErr = c1.msgs.filter(m => m.type === 'error').length;
  c1.send({ type:'edit_chat', mid: 999999, text:'x' });
  await sleep(250);
  ok('编辑不存在消息 => no_such_chat', c1.msgs.some(m => m.type === 'error' && m.code === 'no_such_chat'));

  // 参数缺失 => bad_args
  c1.send({ type:'edit_chat', text:'x' });
  await sleep(200);
  ok('缺少 mid => bad_args', c1.msgs.some(m => m.type === 'error' && m.code === 'bad_args'));

  // 他人消息不可编辑 => forbidden（c2 尝试编辑 c1 的消息）
  const beforeF = c2.msgs.filter(m => m.type === 'error').length;
  c2.send({ type:'edit_chat', mid, text:'恶意的编辑' });
  await sleep(250);
  ok('编辑他人消息 => forbidden', c2.msgs.some(m => m.type === 'error' && m.code === 'forbidden'));
  // 且内容未被改动（c2 仍只见原编辑文本）
  ok('他人编辑未生效', !c2.msgs.some(m => m.type === 'chat_updated' && m.mid === mid && m.text === '恶意的编辑'));

  server.kill();
  console.log(`\n[CollabBoard edit_chat] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
