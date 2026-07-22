const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8097;
// CollabBoard 「聊天管理」测试：clear_chat 清空 / delete_chat 按 mid 删除 / mid 自增 / 错误分支 / 迟到者快照一致性
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }

function wsConnect(room){
  return new Promise((resolve, reject)=>{
    const s = net.connect(PORT, 'localhost');
    const key = crypto.randomBytes(16).toString('base64');
    s.on('connect', ()=> s.write(
      'GET /?room=' + room + ' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.buf = '';
    s.on('data', d=>{ s.buf += d.toString('utf8'); if(s.buf.includes('\r\n\r\n')) resolve(s); });
    s.on('error', reject);
  });
}
function wsSend(s, obj){
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = payload.length, mask = crypto.randomBytes(4);
  let header;
  if(len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.alloc(len);
  for(let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  s.write(Buffer.concat([header, mask, masked]));
}
// 收集某客户端收到的、满足 type 过滤且 m 匹配的帧
function collect(s, types){
  const out = [];
  s.on('data', d=>{
    const str = d.toString('utf8');
    let i = str.indexOf('{');
    while(i !== -1){
      try { const m = JSON.parse(str.slice(i)); if(types.includes(m.type)) out.push(m); } catch(e){}
      i = str.indexOf('{', i + 1);
    }
  });
  return out;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async ()=>{
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await wait(700);
  try {
    const c1 = await wsConnect('chatRoom');
    const c2 = await wsConnect('chatRoom');
    const c2chat = collect(c2, ['chat', 'clear_chat', 'chat_deleted']);
    const c1echo = collect(c1, ['clear_chat', 'chat_deleted', 'error']);
    const c3snap = [];
    await wait(150);

    wsSend(c1, { type:'chat', text:'alpha' });
    await wait(150);
    wsSend(c1, { type:'chat', text:'beta' });
    await wait(150);

    const mids = c2chat.filter(m => m.type === 'chat').map(m => m.mid);
    ok('c2 收到两条 chat', mids.length === 2);
    ok('chat 携带自增 mid(数字)', mids.every(x => typeof x === 'number'));
    ok('mid 严格递增', mids.length === 2 && mids[1] === mids[0] + 1);
    const mid1 = mids[0];

    // delete_chat：c2 删除 mid1
    wsSend(c2, { type:'delete_chat', mid: mid1 });
    await wait(180);
    ok('c2 收到 chat_deleted(mid1)', c2chat.some(m => m.type === 'chat_deleted' && m.mid === mid1));
    ok('c1 也收到 chat_deleted(广播含发送者)', c1echo.some(m => m.type === 'chat_deleted' && m.mid === mid1));

    // delete_chat 不存在的 mid -> 仅发送者收 error
    wsSend(c1, { type:'delete_chat', mid: 999999 });
    await wait(150);
    ok('删除不存在消息返回 no_such_chat', c1echo.some(m => m.type === 'error' && m.code === 'no_such_chat'));

    // delete_chat mid 非数字 -> bad_mid
    wsSend(c1, { type:'delete_chat', mid: 'x' });
    await wait(150);
    ok('mid 非数字返回 bad_mid', c1echo.some(m => m.type === 'error' && m.code === 'bad_mid'));

    // clear_chat：c1 清空
    wsSend(c1, { type:'clear_chat' });
    await wait(180);
    ok('c2 收到 clear_chat', c2chat.some(m => m.type === 'clear_chat'));
    ok('c1 自身也收到 clear_chat(广播含发送者)', c1echo.some(m => m.type === 'clear_chat'));

    // 迟到者 c3 加入，其 snapshot.chats 应为空（已被 clear；且 mid1 已被删）
    c3snap.length = 0;
    const c3 = await wsConnect('chatRoom');
    await wait(250);
    // snapshot 常与 welcome/握手同分片到达，post-connect 的 data 监听器会漏掉；
    // wsConnect 的内部监听器已把全部帧累积进 c3.buf，这里用括号配平解析器稳健抽取 snapshot 帧
    {
      const buf = c3.buf;
      let depth = 0, start = -1, inStr = false, esc = false;
      for(let i = 0; i < buf.length; i++){
        const c = buf[i];
        if(inStr){ if(esc) esc = false; else if(c === '\\') esc = true; else if(c === '"') inStr = false; continue; }
        if(c === '"'){ inStr = true; continue; }
        if(c === '{'){ if(depth === 0) start = i; depth++; }
        else if(c === '}'){ depth--; if(depth === 0 && start !== -1){ try { const m = JSON.parse(buf.slice(start, i + 1)); if(m.type === 'snapshot') c3snap.push(m); } catch(e){} start = -1; } }
      }
    }
    const snap = c3snap.find(m => Array.isArray(m.chats));
    ok('迟到者快照包含 chats 字段', !!snap);
    ok('clear_chat 后快照 chats 为空', snap && Array.isArray(snap.chats) && snap.chats.length === 0);
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard chat-mgmt] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
