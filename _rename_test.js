const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8094;
// CollabBoard 房间重命名测试：owner 可重命名(内存重键+广播+room_list 更新)；新名可加入同一房间；非 owner/非法名报错
const { spawn } = require('child_process');
const net = require('net'); const crypto = require('crypto'); const path = require('path'); const fs = require('fs');
const store = require('./store');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }
function wsConnect(room){return new Promise((resolve,reject)=>{const s=net.connect(PORT,'localhost');const key=crypto.randomBytes(16).toString('base64');s.on('connect',()=>s.write('GET /?room='+room+' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));s.buf='';s.on('data',d=>{s.buf+=d.toString('utf8');if(s.buf.includes('\r\n\r\n'))resolve(s);});s.on('error',reject);});}
function wsSend(s,obj){const p=Buffer.from(JSON.stringify(obj),'utf8');const len=p.length,mask=crypto.randomBytes(4);let h;if(len<126)h=Buffer.from([0x81,0x80|len]);else{h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(len,2);}const md=Buffer.alloc(len);for(let i=0;i<len;i++)md[i]=p[i]^mask[i&3];s.write(Buffer.concat([h,mask,md]));}
function collect(s, types){const out=[];const seen=new Set();const scan=()=>{const buf=s.buf;let depth=0,start=-1,inStr=false,esc=false;for(let i=0;i<buf.length;i++){const c=buf[i];if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue;}if(c==='"'){inStr=true;continue;}if(c==='{'){if(depth===0)start=i;depth++;}else if(c==='}'){depth--;if(depth===0&&start!==-1){const seg=buf.slice(start,i+1);if(!seen.has(seg)){seen.add(seg);try{const m=JSON.parse(seg);if(types.includes(m.type))out.push(m);}catch(e){} }start=-1;}}}};s.on('data',scan);scan();return out;}
const wait = ms => new Promise(r => setTimeout(r, ms));
function cleanup(){ for(const n of ['renameOld','renameNew','renameOld2']){ const f = store.roomFile(n); try{ if(fs.existsSync(f)) fs.unlinkSync(f); }catch(e){} } }

(async ()=>{
  cleanup();
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await wait(700);
  try {
    const c1 = await wsConnect('renameOld');   // 房主
    const c2 = await wsConnect('renameOld');
    const c1msgs = collect(c1, ['room_renamed', 'error']);
    await wait(150);

    // 先发一条聊天作为房间身份标记
    wsSend(c1, { type:'chat', text:'marker' });
    await wait(150);

    // 1. 房主重命名
    wsSend(c1, { type:'rename', name:'renameNew' });
    await wait(200);
    ok('房主收到 room_renamed(to=renameNew)', c1msgs.some(m => m.type === 'room_renamed' && m.to === 'renameNew' && m.from === 'renameOld'));
    ok('c2 也收到 room_renamed', c2.buf.includes('"type":"room_renamed"'));

    // 2. room_list 含新名、不含旧名
    const c3 = await wsConnect('renameNew');   // 用新名加入，应进入同一房间
    await wait(150);
    const c3snap = (()=>{ const buf=c3.buf; let depth=0,start=-1,inStr=false,esc=false; for(let i=0;i<buf.length;i++){const c=buf[i];if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue;}if(c==='"'){inStr=true;continue;}if(c==='{'){if(depth===0)start=i;depth++;}else if(c==='}'){depth--;if(depth===0&&start!==-1){const seg=buf.slice(start,i+1);try{const m=JSON.parse(seg);if(m.type==='snapshot')return m;}catch(e){}start=-1;}}} return null; })();
    ok('新名加入拿到快照', !!c3snap);
    ok('快照 room 字段=renameNew', c3snap && c3snap.room === 'renameNew');
    ok('新名加入的是同一房间(含 marker 聊天)', c3snap && Array.isArray(c3snap.chats) && c3snap.chats.some(ch => ch.text === 'marker'));

    // 3. 非法名 → 报错
    const c1err = collect(c1, ['error']);
    wsSend(c1, { type:'rename', name:'' });
    await wait(150);
    ok('空名返回 bad_name', c1err.some(m => m.type === 'error' && m.code === 'bad_name'));

    // 4. 非房主重命名 → 报错
    const c2err = collect(c2, ['error']);
    wsSend(c2, { type:'rename', name:'renameOld2' });
    await wait(150);
    ok('非房主 rename 返回 not_owner', c2err.some(m => m.type === 'error' && m.code === 'not_owner'));
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { cleanup(); server.kill(); }

  console.log(`\n[CollabBoard rename] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
