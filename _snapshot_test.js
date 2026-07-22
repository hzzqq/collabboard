// _snapshot_test.js — CollabBoard save_snapshot / list_snapshots（房主存命名快照 + 列名）
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const PORT = 8094;
const ROOM = 'snap_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_snap_inline.js');
  fs.writeFileSync(tmp, sc[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// 2) 服务端
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
  const c1 = await connect(ROOM);
  const c2 = await connect(ROOM);
  await sleep(400);

  const ids = c2.msgs.filter(m => m.type === 'presence').pop().ids;
  const c1cid = ids[0], c2cid = ids[1];
  ok('拿到两名客户端 cid', ids.length >= 2);
  ok('c1 为房主', c1cid !== c2cid);

  // 先放一个元素，便于快照含内容
  c1.send({ type:'stroke', stroke:{ type:'stroke', layerId:'L0', points:[{x:1,y:1},{x:2,y:2}], color:'#fff' } });
  await sleep(250);

  // 房主存命名快照
  c1.send({ type:'save_snapshot', name:'snap1' });
  await sleep(300);
  const saved = c2.msgs.filter(m => m.type === 'snapshot_saved' && m.name === 'snap1').pop();
  ok('c2 收到 snapshot_saved(snap1)', !!saved && saved.count >= 1);
  ok('发送者 c1 也收到 snapshot_saved', c1.msgs.some(m => m.type === 'snapshot_saved' && m.name === 'snap1'));

  // 列名（房主）
  c1.send({ type:'list_snapshots' });
  await sleep(250);
  const list1 = c1.msgs.filter(m => m.type === 'snapshot_list').pop();
  ok('房主 list_snapshots 含 snap1', list1 && Array.isArray(list1.snapshots) && list1.snapshots.some(s => s.name === 'snap1'));

  // 列名（非房主也能查）
  c2.send({ type:'list_snapshots' });
  await sleep(250);
  const list2 = c2.msgs.filter(m => m.type === 'snapshot_list').pop();
  ok('非房主也能 list_snapshots', list2 && list2.snapshots && list2.snapshots.some(s => s.name === 'snap1'));

  // 非房主存快照 => 报错 not_owner
  const beforeErr = c2.msgs.filter(m => m.type === 'error').length;
  c2.send({ type:'save_snapshot', name:'hack' });
  await sleep(250);
  const err = c2.msgs.filter(m => m.type === 'error').slice(beforeErr).pop();
  ok('非房主 save_snapshot 报错 not_owner', err && err.code === 'not_owner');

  // 缺 name => bad_name
  const beforeBad = c1.msgs.filter(m => m.type === 'error').length;
  c1.send({ type:'save_snapshot', name:'' });
  await sleep(250);
  const bad = c1.msgs.filter(m => m.type === 'error').slice(beforeBad).pop();
  ok('缺 name 报错 bad_name', bad && bad.code === 'bad_name');

  server.kill();
  console.log(`\n[CollabBoard snapshot] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
