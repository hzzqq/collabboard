// CollabBoard 测试公共助手：按 WebSocket 协议正确解码服务端->客户端(未掩码)帧。
// 注意：客户端裸缓冲是 WS 帧流(2 字节帧头 + 长度字节 + 负载)，绝不能对原始字节做
// JSON 括号扫描——当某帧负载长度恰好为 34/92/123/125 时，其长度字节(0x22/0x5c/0x7b/0x7d)
// 会被误判为引号/花括号，破坏括号配平并吞掉该帧。必须逐帧按协议解码。
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');

function wsConnect(room, port, cid){
  port = port || (process.env.PORT ? parseInt(process.env.PORT, 10) : 8099);
  return new Promise((resolve, reject)=>{
    const s = net.connect(port, 'localhost');
    const key = crypto.randomBytes(16).toString('base64');
    const path2 = cid ? ('/?room=' + room + '&cid=' + encodeURIComponent(cid)) : ('/?room=' + room);
    s.on('connect', ()=> s.write(
      'GET ' + path2 + ' HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.buf = Buffer.alloc(0);
    s.on('data', d=>{ s.buf = Buffer.concat([s.buf, d]); if(s.buf.indexOf(Buffer.from('\r\n\r\n')) !== -1) resolve(s); });
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
// 按 WS 协议逐帧解码，返回全部顶层 JSON 对象(字节精确，不受长度字节影响)
function parseFrames(buf){
  const out = [];
  const sep = buf.indexOf('\r\n\r\n');
  let i = sep >= 0 ? sep + 4 : 0;
  while(i + 2 <= buf.length){
    const b1 = buf[i + 1];
    let len = b1 & 0x7f;
    let off = 2;
    if(len === 126){ if(i + 4 > buf.length) break; len = (buf[i+2] << 8) | buf[i+3]; off = 4; }
    else if(len === 127){ if(i + 10 > buf.length) break; len = 0; for(let k = 0; k < 8; k++) len = (len << 8) | buf[i+2+k]; off = 10; }
    const start = i + off;
    if(start + len > buf.length) break;
    const seg = buf.slice(start, start + len);
    try { out.push(JSON.parse(seg)); } catch(e){}
    i = start + len;
  }
  return out;
}
function hasFrame(s, type, pred){
  return parseFrames(s.buf).some(m => m && m.type === type && (!pred || pred(m)));
}
// 持续累积：附加一个监听器，把满足 types 的帧推进 out 数组
function collect(s, types){
  const out = [];
  s.on('data', d=>{
    for(const m of parseFrames(d)){ if(m && types.includes(m.type)) out.push(m); }
  });
  return out;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function spawnServer(extraEnv){
  return spawn(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(process.env.PORT ? parseInt(process.env.PORT, 10) : 8099), HB: '999999', ...(extraEnv||{}) }, stdio: 'ignore' });
}
module.exports = { wsConnect, wsSend, parseFrames, hasFrame, collect, wait, spawnServer };
