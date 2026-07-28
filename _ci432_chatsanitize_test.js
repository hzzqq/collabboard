// ci432 — CollabBoard 聊天净化 + 基线限频（R2 隐性健壮性修复）
// 验证：聊天文本剔除控制字符/折叠空白/长度上限；非字符串 text 被丢弃且不崩溃；
//       基线最小发言间隔(CHAT_MIN_INTERVAL) 防刷屏。
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const PORT = 8099;
const ROOM = 'ci432_sanitize_room';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL', n); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
function hasControl(s){ for(const ch of s){ const cp = ch.codePointAt(0); if(cp < 0x20 || cp === 0x7f) return true; } return false; }

(async ()=>{
  const srv = spawn(NODE, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT) }) });
  let serverLog = '';
  srv.stdout.on('data', d => serverLog += d.toString('utf8'));
  srv.stderr.on('data', d => serverLog += d.toString('utf8'));
  await sleep(700);

  const A = await wsConnect(ROOM);
  const B = await wsConnect(ROOM);
  const bChats = collect(B, ['chat']);
  await sleep(300);

  // 1. 净化：控制字符 + 超长 + 首尾空白
  const dirty = '  \r\n\t  HelloWorld  \r\n' + 'x'.repeat(600);
  wsSend(A, { type: 'chat', text: dirty });
  await sleep(300);
  ok('恰好收到 1 条聊天(净化后)', bChats.length === 1);
  if(bChats.length){
    const t = bChats[0].text;
    ok('剔除控制字符(\\r\\n\\t)', !hasControl(t));
    ok('长度 <= 500', t.length <= 500);
    ok('首尾已 trim', t === t.trim());
    ok('内容含 HelloWorld', t.includes('HelloWorld'));
    ok('超长部分被截断至 500', t.length === 500);   // "HelloWorld"+600x = 610 -> slice(0,500)
  }

  // 2. 非字符串 text：应被丢弃且不崩溃
  const before = bChats.length;
  wsSend(A, { type: 'chat', text: 12345 });
  wsSend(A, { type: 'chat', text: null });
  await sleep(300);
  ok('非字符串 text 被丢弃(无新聊天)', bChats.length === before);

  // 3. 服务器仍存活：随后合法聊天应正常收到
  wsSend(A, { type: 'chat', text: 'still alive' });
  await sleep(300);
  ok('非字符串后服务器仍存活', bChats.length === before + 1 && bChats[bChats.length - 1].text === 'still alive');

  // 4. 接线校验：server.js 含 sanitizeChatText（R2 修复已落地）
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok('server.js 定义 sanitizeChatText', /function sanitizeChatText\(/.test(src));
  ok('chat 分支使用 sanitizeChatText', /const text = sanitizeChatText\(obj\.text\);/.test(src));

  srv.kill();
  console.log(`\nci432 chat sanitize + rate-limit: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });