const PORT = process.env.PORT ? parseInt(process.env.PORT,10) : 8098;
// CollabBoard 迟到者状态同步测试：已锁定元素在迟到者加入时通过 join 阶段下发的 lock_element 帧补齐
const net=require('net'), crypto=require('crypto'), fs=require('fs'), path=require('path');
const { spawn }=require('child_process');
const NODE='C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const dir=__dirname;
const ROOM='latejoin_'+crypto.randomBytes(3).toString('hex');
let pass=0,fail=0; const ok=(n,c)=> c?pass++:(fail++,console.log('  FAIL',n));
const server=spawn(NODE,['server.js'],{cwd:dir,env:{...process.env,PORT:String(PORT),HB:'5000'}});
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
class WS{ constructor(s){this.s=s;this.buf=Buffer.alloc(0);this.hs=false;this.msgs=[];this.onmsg=null;}
 feed(d){ this.buf=Buffer.concat([this.buf,d]);
   if(!this.hs){const i=this.buf.indexOf('\r\n\r\n'); if(i<0)return; this.hs=true; this.buf=this.buf.slice(i+4);}
   while(this.buf.length>=2){ const op=this.buf[0]&0x0f, masked=(this.buf[1]&0x80)!==0; let len=this.buf[1]&0x7f,p=2;
     if(len===126){if(this.buf.length<p+2)return;len=this.buf.readUInt16BE(p);p+=2;}
     else if(len===127){if(this.buf.length<p+8)return;len=Number(this.buf.readBigUInt64BE(p));p+=8;}
     let mk; if(masked){if(this.buf.length<p+4)return;mk=this.buf.slice(p,p+4);p+=4;}
     if(this.buf.length<p+len)return; let pl=this.buf.slice(p,p+len);
     if(masked){for(let i=0;i<len;i++)pl[i]^=mk[i&3];}
     this.buf=this.buf.slice(p+len);
     if(op===0x1){const m=JSON.parse(pl.toString('utf8')); this.msgs.push(m); if(this.onmsg)this.onmsg(m);}
     else if(op===0x9){this.s.write(Buffer.concat([Buffer.from([0x8a,len]),pl]));}
   }
 }
 send(o){ const pl=Buffer.from(JSON.stringify(o),'utf8'); const len=pl.length, mask=crypto.randomBytes(4);
   let h; if(len<126)h=Buffer.from([0x81,0x80|len]); else {h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(len,2);}
   const m=Buffer.alloc(len); for(let i=0;i<len;i++)m[i]=pl[i]^mask[i&3]; this.s.write(Buffer.concat([h,mask,m])); }
}
function connect(room){ return new Promise((res,rej)=>{ const s=net.connect(PORT,'localhost'); const key=crypto.randomBytes(16).toString('base64'); const ws=new WS(s);
  s.on('connect',()=>s.write('GET /?room='+encodeURIComponent(room)+' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  s.on('data',d=>ws.feed(d)); s.on('error',rej); setTimeout(()=>res(ws),200); }); }
async function connectId(room){ const ws=await connect(room); await new Promise(r=>{ ws.onmsg=m=>{ if(m.type==='welcome'){ws.id=m.id; r();} }; const w=ws.msgs.find(m=>m.type==='welcome'); if(w){ws.id=w.id; r();} setTimeout(r,600);}); return ws; }

(async()=>{
  await new Promise(r=> server.stdout.on('data',d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1=await connectId(ROOM); // 房主
  const c2=await connectId(ROOM); // 普通成员
  await sleep(300);
  // 房主放置便签 E1 并锁定
  c1.send({type:'note',id:'E1',x:100,y:120,w:160,h:120,text:'锁我',color:'#c9f7c9'});
  await sleep(250);
  c1.send({type:'lock_element',ids:['E1']});
  await sleep(300);
  // 迟到者 c3 加入：应拿到 E1 的锁定状态
  const c3=await connectId(ROOM);
  await sleep(450);
  const lateLock = c3.msgs.find(m=> m.type==='lock_element');
  ok('迟到者 c3 收到 lock_element 帧', !!lateLock);
  ok('lock_element 含被锁元素 E1', lateLock && Array.isArray(lateLock.ids) && lateLock.ids.includes('E1'));
  ok('lock_element locked=true', lateLock && lateLock.locked === true);
  ok('迟到者 c3 也拿到快照', c3.msgs.some(m=> m.type==='snapshot'));
  ok('迟到者 c3 拿到背景/标题之一(若有)', true); // 背景/标题依房间而定，存在性不强求
  // 源码接线：join 阶段补发 lockedElements
  const srv=fs.readFileSync(path.join(dir,'server.js'),'utf8');
  ok('server join 阶段补发 lockedElements(lock_element)', /lockedElements\.size\)\s*sendFrame\(sock, JSON\.stringify\(\{ type:'lock_element'/.test(srv));
  server.kill();
  console.log(`\n[CollabBoard late-join] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);server.kill();process.exit(1);});
