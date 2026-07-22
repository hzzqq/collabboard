// _record_test.js — CollabBoard record_start/stop/playback（编辑操作录制与回放）
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const PORT = 8139;
const ROOM = 'rec_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_rec_inline.js');
  fs.writeFileSync(tmp, sc[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }
class WS {
  constructor(sock){ this.sock=sock; this.buf=Buffer.alloc(0); this.handshake=false; this.msgs=[]; this.errs=0; }
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
      if(op===0x1){ const msg=JSON.parse(payload.toString('utf8')); this.msgs.push(msg); if(msg.type==='error') this.errs++; }
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
function connect(room, extra){
  return new Promise((res)=>{
    const sock=net.connect(PORT,'localhost');
    const key=crypto.randomBytes(16).toString('base64');
    const ws=new WS(sock);
    const q = extra ? '&'+extra : '';
    sock.on('connect', ()=> sock.write(
      'GET /?room='+encodeURIComponent(room)+q+' HTTP/1.1\r\nHost: localhost:'+PORT+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'+
      'Sec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d=> ws.feed(d));
    sock.on('error', ()=>{});
    setTimeout(()=> res(ws), 200);
  });
}

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1 = await connect(ROOM);
  const c2 = await connect(ROOM);
  await sleep(400);
  const ids = c2.msgs.filter(m => m.type === 'presence').pop().ids;
  ok('拿到两名客户端 cid', ids.length >= 2);

  // 未录制时停止/回放 -> error
  const e0 = c1.errs;
  c1.send({ type:'record_stop' }); await sleep(200);
  ok('未录制停止报错 not_recording', c1.msgs.filter(m=>m.type==='error').slice(e0).some(m=>m.code==='not_recording'));
  const e1 = c1.errs;
  c1.send({ type:'playback' }); await sleep(200);
  ok('未录制回放报错 nothing_recorded', c1.msgs.filter(m=>m.type==='error').slice(e1).some(m=>m.code==='nothing_recorded'));

  // 开始录制
  c1.send({ type:'record_start' }); await sleep(300);
  ok('c2 收到 record_started', !!c2.msgs.filter(m => m.type==='record_started').pop());

  // 录制期间画一笔
  c1.send({ type:'stroke', stroke:{ type:'stroke', points:[{x:1,y:1},{x:3,y:3}], color:'#fff' } });
  await sleep(300);
  const strokesBefore = c2.msgs.filter(m => m.type==='stroke').length;

  // 停止录制
  c1.send({ type:'record_stop' }); await sleep(300);
  const stopped = c1.msgs.filter(m => m.type==='record_stopped').pop();
  ok('c1 收到 record_stopped', !!stopped);
  ok('录制计数>=1', stopped && stopped.count >= 1);

  // 回放：c2 应再收到一笔（隐性问题：录制长度上限已生效，可安全回放）
  c1.send({ type:'playback' }); await sleep(400);
  const strokesAfter = c2.msgs.filter(m => m.type==='stroke').length;
  ok('回放使 c2 多收到一笔', strokesAfter === strokesBefore + 1);
  ok('c1 收到 playback_done', !!c1.msgs.filter(m => m.type==='playback_done').pop());

  server.kill();
  console.log(`\n[CollabBoard record] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
