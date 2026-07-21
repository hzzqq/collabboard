const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8102;
// CollabBoard 端到端测试：房主设置白板背景色(set_bg) —— 仅房主可设；
// 广播给所有人(含房主)，迟到者加入时也能拿到；非房主被拒；非法颜色被拒。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'bg_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_bg_inline.js');
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
  await new Promise(r=>{
    const found = ws.msgs.find(m=> m.type === 'welcome');
    if(found){ ws.id = found.id; r(); return; }
    ws.onmsg = m=>{ if(m.type==='welcome'){ ws.id = m.id; r(); } };
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

  // 1. 非房主 c2 设背景 → 被拒 not_owner
  let c2err0 = null; c2.onmsg = msg=>{ if(msg.type==='error') c2err0 = msg; };
  c2.send({ type:'set_bg', color:'#00ff00' });
  await sleep(300);
  ok('非房主设背景被拒(error not_owner)', c2err0 && c2err0.code === 'not_owner');

  // 2. 房主 c1 设背景 #ff0000 → c2 收到 bg 广播(含 color + by=房主)
  let c2bg = null; c2.onmsg = msg=>{ if(msg.type==='bg') c2bg = msg; };
  c1.send({ type:'set_bg', color:'#FF0000' });
  await sleep(300);
  ok('房主设背景广播 bg(color=#ff0000 已小写化)', c2bg && c2bg.color === '#ff0000');
  ok('bg 广播携带房主标识 by', c2bg && c2bg.by === c1.id);

  // 3. 房主设非法颜色 #zzz → 被拒 bad_color
  let c1err = null; c1.onmsg = msg=>{ if(msg.type==='error') c1err = msg; };
  c1.send({ type:'set_bg', color:'#zzz' });
  await sleep(300);
  ok('非法颜色被拒(error bad_color)', c1err && c1err.code === 'bad_color');

  // 4. 房主设背景为 #123456 → 广播
  let c2bg2 = null; c2.onmsg = msg=>{ if(msg.type==='bg') c2bg2 = msg; };
  c1.send({ type:'set_bg', color:'#123456' });
  await sleep(300);
  ok('房主设背景广播 bg(color=#123456)', c2bg2 && c2bg2.color === '#123456');

  // 5. 迟到者 c3 加入应收到当前背景(#123456)
  const c3 = await connectId(ROOM);
  let c3bg = c3.msgs.find(m=> m.type === 'bg') || null;   // bg 帧可能已随握手到达，先查缓冲
  c3.onmsg = msg=>{ if(msg.type==='bg') c3bg = msg; };
  await sleep(400);
  ok('迟到者加入收到当前背景(#123456)', c3bg && c3bg.color === '#123456');

  // 6. 房主清空背景(null) → 已连客户端(c2)也收到广播
  let c2bg3 = null; c2.onmsg = msg=>{ if(msg.type==='bg') c2bg3 = msg; };
  c1.send({ type:'set_bg' });   // 无 color → null
  await sleep(300);
  ok('房主清空背景广播 bg(color=null)', c2bg3 && c2bg3.color === null);

  // 6. 源码接线
  const srv = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
  ok("server 有 case 'set_bg'", /case 'set_bg':/.test(srv));
  ok('server set_bg 守卫 not_owner', /只有房主能设置背景/.test(srv));
  ok('server set_bg 校验非法色 bad_color', /bad_color/.test(srv));
  ok('server set_bg 广播 type:bg', /type:'bg'/.test(srv));
  ok('server 房间初始化含 bg:null', /bg: null/.test(srv) || /bg:null/.test(srv));
  const inline = sc ? sc[1] : '';
  ok('index.html 有 setBgBtn', /id="setBgBtn"/.test(html));
  ok('index.html 有 bgColor', /id="bgColor"/.test(html));
  ok('index.html 处理 case \'bg\'', /case 'bg':/.test(inline));
  ok('index.html 将背景写入 cv.style.background', /cv\.style\.background = m\.color/.test(inline));
  ok('index.html 房主专属：setBgBtn 受 me 控制', /getElementById\('setBgBtn'\)\.disabled = !me/.test(inline) || /\$\('setBgBtn'\)\.disabled = !me/.test(inline));

  server.kill();
  console.log(`\n[CollabBoard bg] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
