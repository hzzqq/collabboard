// CollabBoard 端到端测试：验证图层顺序 zorder（置顶/置底/上移/下移）。
// 服务端权威重排 strokes 数组、进入撤销栈、广播 replace、落盘；客户端按 replace 重排。
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
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
const m = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!m);
if(m){ const tmp = path.join(dir, '.wb_zo_inline.js'); fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp); }

// 清理残留房间落盘
try { fs.rmSync(path.join(dir, 'rooms'), { recursive:true, force:true }); } catch(e){}

// 2) 启动服务端
const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });

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
// 读取某房间当前 strokes 顺序（id 列表）：连一个新客户端取快照
async function orderOf(room){
  const c = await connect(room);
  let snap = (c.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.strokes));
  c.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.strokes)) snap = msg; };
  await sleep(400);
  return snap ? snap.strokes.map(s=>s.id) : null;
}

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const room = 'zoR_' + crypto.randomBytes(3).toString('hex');
  const c1 = await connect(room);
  await sleep(300);

  c1.send({ type:'stroke', stroke:{ id:'a', tool:'pen', color:'#f00', width:2, points:[{x:1,y:1},{x:2,y:2}] } });
  c1.send({ type:'stroke', stroke:{ id:'b', tool:'pen', color:'#0f0', width:2, points:[{x:3,y:3},{x:4,y:4}] } });
  c1.send({ type:'stroke', stroke:{ id:'c', tool:'pen', color:'#00f', width:2, points:[{x:5,y:5},{x:6,y:6}] } });
  await sleep(300);
  ok('初始顺序 a,b,c', JSON.stringify(await orderOf(room)) === JSON.stringify(['a','b','c']));

  // 置顶 a
  c1.send({ type:'zorder', ids:['a'], action:'front' });
  await sleep(300);
  ok('置顶后 b,c,a', JSON.stringify(await orderOf(room)) === JSON.stringify(['b','c','a']));

  // 置底 c
  c1.send({ type:'zorder', ids:['c'], action:'back' });
  await sleep(300);
  ok('置底后 c,b,a', JSON.stringify(await orderOf(room)) === JSON.stringify(['c','b','a']));

  // 上移 c（从底到中间）
  c1.send({ type:'zorder', ids:['c'], action:'raise' });
  await sleep(300);
  ok('上移后 b,c,a', JSON.stringify(await orderOf(room)) === JSON.stringify(['b','c','a']));

  // 下移 a（从顶到底）
  c1.send({ type:'zorder', ids:['a'], action:'lower' });
  await sleep(300);
  ok('下移后 b,a,c', JSON.stringify(await orderOf(room)) === JSON.stringify(['b','a','c']));

  // 群组置顶（a,b）：选中组保持原相对堆叠序(b 在 a 下)，整体置于顶层 c 之上
  c1.send({ type:'zorder', ids:['a','b'], action:'front' });
  await sleep(300);
  ok('群组置顶后 c,b,a', JSON.stringify(await orderOf(room)) === JSON.stringify(['c','b','a']));

  // 无效动作被忽略（顺序不变）
  c1.send({ type:'zorder', ids:['c'], action:'bogus' });
  await sleep(300);
  ok('无效动作被忽略', JSON.stringify(await orderOf(room)) === JSON.stringify(['c','b','a']));

  server.kill();
  console.log(`\n[CollabBoard zorder] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
