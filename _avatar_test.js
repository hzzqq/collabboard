const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8095;
// CollabBoard 头像设置测试：set_avatar 广播 avatar 帧；presence 含 avatars 列表
const { spawn } = require('child_process');
const net = require('net'); const crypto = require('crypto'); const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }
function wsConnect(room){return new Promise((resolve,reject)=>{const s=net.connect(PORT,'localhost');const key=crypto.randomBytes(16).toString('base64');s.on('connect',()=>s.write('GET /?room='+room+' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));s.buf='';s.on('data',d=>{s.buf+=d.toString('utf8');if(s.buf.includes('\r\n\r\n'))resolve(s);});s.on('error',reject);});}
function wsSend(s,obj){const p=Buffer.from(JSON.stringify(obj),'utf8');const len=p.length,mask=crypto.randomBytes(4);let h;if(len<126)h=Buffer.from([0x81,0x80|len]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(len,2);}const md=Buffer.alloc(len);for(let i=0;i<len;i++)md[i]=p[i]^mask[i&3];s.write(Buffer.concat([h,mask,md]));}
function collect(s, types){const out=[];const seen=new Set();const scan=()=>{const buf=s.buf;let depth=0,start=-1,inStr=false,esc=false;for(let i=0;i<buf.length;i++){const c=buf[i];if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue;}if(c==='"'){inStr=true;continue;}if(c==='{'){if(depth===0)start=i;depth++;}else if(c==='}'){depth--;if(depth===0&&start!==-1){const seg=buf.slice(start,i+1);if(!seen.has(seg)){seen.add(seg);try{const m=JSON.parse(seg);if(types.includes(m.type))out.push(m);}catch(e){} }start=-1;}}}};s.on('data',scan);scan();return out;}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async ()=>{
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await wait(700);
  try {
    const c1 = await wsConnect('avatarRoom');   // 观察者
    const c2 = await wsConnect('avatarRoom');   // 设头像者
    const c1msgs = collect(c1, ['avatar', 'presence']);
    const c2msgs = collect(c2, ['avatar', 'presence']);
    await wait(150);

    wsSend(c2, { type:'set_avatar', avatar:'🦊' });
    await wait(200);
    ok('观察者 c1 收到 avatar 帧', c1msgs.some(m => m.type === 'avatar' && m.avatar === '🦊'));
    ok('avatar 帧含设置者 id', c1msgs.some(m => m.type === 'avatar' && m.id));
    ok('设头像者自身也收到 avatar(广播含自己)', c2msgs.some(m => m.type === 'avatar' && m.avatar === '🦊'));

    // presence 含 avatars 列表（c2 设过头像后，下一次 presence 应带 avatars）
    c1msgs.length = 0;
    wsSend(c1, { type:'set_name', name:'旁观' });   // 触发一次 presence 广播
    await wait(200);
    const pres = c1msgs.find(m => m.type === 'presence' && Array.isArray(m.avatars));
    ok('presence 含 avatars 数组', !!pres);
    ok('avatars 数组长度=在线人数', pres && pres.avatars.length === 2);
    ok('avatars 含 c2 的头像', pres && pres.avatars.includes('🦊'));
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard avatar] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
