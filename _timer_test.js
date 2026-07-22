const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 端到端测试：验证 timer（协作倒计时）—— 创建/暂停/重置/停止/快照/每秒 tick。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const ROOM = 'timerR_' + crypto.randomBytes(3).toString('hex');
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

// 1) 内联脚本语法检查
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const sc = html.match(/<script>([\s\S]*?)<\/script>/);
ok('index.html 含内联脚本', !!sc);
if(sc){
  const tmp = path.join(dir, '.wb_timer_inline.js');
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

  const tCreated = [], tUpdated = [], tRemoved = [];
  c2.onmsg = m => { if(m.type==='timer_created') tCreated.push(m);
                    if(m.type==='timer_updated') tUpdated.push(m);
                    if(m.type==='timer_removed') tRemoved.push(m); };

  // c1 创建 30s 倒计时
  c1.send({ type:'create_timer', label:'冲刺', seconds:30 });
  await sleep(300);

  ok('c2 收到 timer_created', tCreated.length >= 1);
  const tc = tCreated[0];
  ok('timer 含 label', tc && tc.timer && tc.timer.label === '冲刺');
  ok('timer total=30', tc && tc.timer.total === 30);
  ok('timer remaining=30', tc && tc.timer.remaining === 30);
  ok('timer 初始 running=true', tc && tc.timer.running === true);
  // 发送者 c1 不收到自己的 timer_created
  ok('发送者 c1 不收到自己的 timer_created', !c1.msgs.some(m => m.type === 'timer_created'));

  const tid = tc.timer.tid;

  // 缺参：无 label => error bad_args，且无新 timer_created
  const before = tCreated.length;
  c1.send({ type:'create_timer', seconds:10 });
  await sleep(250);
  ok('缺 label 返回 bad_args', c1.msgs.some(m => m.type==='error' && m.code==='bad_args'));
  ok('缺 label 不创建计时器', tCreated.length === before);

  // 暂停：running=false，remaining 保持暂停时刻的值（若 tick 已在创建与暂停之间触发，remaining 可能为 29，属正常）
  c1.send({ type:'timer_control', tid, action:'pause' });
  await sleep(250);
  const pu = tUpdated.find(m => m.timer && m.timer.tid === tid);
  ok('暂停后 running=false', pu && pu.timer.running === false);
  const remPaused = pu ? pu.timer.remaining : -1;
  ok('暂停后 remaining 合理(>0)', remPaused > 0);
  // 暂停后等待超过一个 tick（>1s），remaining 应不再变化，验证倒计时已停止
  await sleep(1200);
  const c5 = await connect(ROOM);
  let snapP = null;
  c5.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.timers)) snapP = msg; };
  c5.send({ type:'request_snapshot' });
  await sleep(400);
  if(!snapP) snapP = (c5.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.timers));
  const tmP = snapP && snapP.timers.find(t => t.tid === tid);
  ok('暂停后超过1秒 remaining 不变', tmP && tmP.remaining === remPaused);

  // 重置：remaining 回到 total，running=false
  c1.send({ type:'timer_control', tid, action:'reset' });
  await sleep(250);
  const rs = tUpdated.filter(m => m.timer && m.timer.tid === tid).pop();
  ok('重置后 remaining=total(30)', rs && rs.timer.remaining === 30);
  ok('重置后 running=false', rs && rs.timer.running === false);

  // 停止不存在的计时器 => no_such_timer
  c1.send({ type:'timer_control', tid: 9999, action:'pause' });
  await sleep(200);
  ok('控制不存在计时器返回 no_such_timer', c1.msgs.some(m => m.type==='error' && m.code==='no_such_timer'));

  // 快照应包含该计时器
  const c3 = await connect(ROOM);
  let snap = null;
  c3.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.timers)) snap = msg; };
  c3.send({ type:'request_snapshot' });
  await sleep(400);
  if(!snap) snap = (c3.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.timers));
  const tm = snap && snap.timers.find(t => t.tid === tid);
  ok('快照含计时器', tm && tm.label === '冲刺' && tm.total === 30 && tm.running === false);

  // 停止：广播 timer_removed，快照不再含
  c1.send({ type:'timer_control', tid, action:'stop' });
  await sleep(250);
  ok('停止广播 timer_removed', tRemoved.some(m => m.tid === tid));
  const c4 = await connect(ROOM);
  let snap2 = null;
  c4.onmsg = msg=>{ if(msg.type==='snapshot' && Array.isArray(msg.timers)) snap2 = msg; };
  c4.send({ type:'request_snapshot' });
  await sleep(400);
  if(!snap2) snap2 = (c4.msgs||[]).find(mm=> mm.type==='snapshot' && Array.isArray(mm.timers));
  ok('停止后快照不含该计时器', snap2 && !snap2.timers.some(t => t.tid === tid));

  server.kill();
  console.log(`\n[CollabBoard timer] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
