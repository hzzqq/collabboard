// _shape_tools_test.js — CollabBoard 工具栏图元入口：三角形/菱形按钮拖拽绘制走 shape op 全通道。
// 链路：down 特化 current 为 shape 型（预览即用 drawStroke 的 shape 分支）→ move 更新终点并归一化负宽高
// → up 点按过小不落元素、否则乐观 push + send shape op（服务端白名单校验、透传客户端 id、广播排除发起者）
// ① 静态接线守卫（工具栏/拖拽三段/服务端白名单/双导出/help 文案）
// ② shapeNormalize 烘焙行为（正向/反向/缺终点）
// ③ drawStroke 菱形渲染烘焙（四顶点/填充）
// ④ 服务端集成：triangle/diamond 广播与透传 id、bogus 拒绝、fill 校验、export svg polygon
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execSync } = require('child_process');
const NODE = process.execPath;
const dir = __dirname;

let pass = 0, fail = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const svgSrc = fs.readFileSync(path.join(dir, 'svg.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
const helpSrc = fs.readFileSync(path.join(dir, 'help.js'), 'utf8');

// 0) 内联脚本语法检查
const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0];
if(m){
  const tmp = path.join(dir, '.wb_st_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

function extractFn(src, name){
  const start = src.indexOf('function ' + name + '(');
  if(start < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for(; i < src.length; i++){
    const c = src[i];
    if(c === '{') depth++;
    else if(c === '}'){ depth--; if(depth === 0) return src.slice(start, i+1); }
  }
  throw new Error('函数 ' + name + ' 括号不匹配');
}

// ---- ① 静态接线守卫 ----
ok('工具栏含三角形按钮', html.includes('data-tool="triangle"'));
ok('工具栏含菱形按钮', html.includes('data-tool="diamond"'));
ok('down 分支特化 triangle/diamond 为 shape 型', /if\(tool==='triangle'\|\|tool==='diamond'\)\{\s*\n\s*const sp = snapP\(p\);\s*\n\s*current = \{ type:'shape'/.test(html));
ok('move 分支 shape 拖拽更新终点', /else if\(current\.type === 'shape'\)\{ current\._x1 = p2\.x; current\._y1 = p2\.y; shapeNormalize\(current\); \}/.test(html));
ok('up 分支收尾发送 shape op', /send\(\{ type:'shape', kind: current\.shapeKind, id: current\.id, x: current\.x/.test(html));
ok('up 点按过小不落元素', /if\(current\.w >= 2 \|\| current\.h >= 2\)/.test(html));
ok('shapeNormalize 已定义', html.includes('function shapeNormalize(el){'));
ok('drawStroke 已接菱形渲染分支', html.includes("s.shapeKind === 'diamond'"));
ok('服务端白名单含 diamond', serverSrc.includes("['rect','ellipse','line','triangle','diamond']"));
ok('服务端错误消息含 diamond', serverSrc.includes('rect/ellipse/line/triangle/diamond'));
ok('server.js export 已接 diamond polygon', serverSrc.includes("el.shapeKind === 'diamond'"));
ok('svg.js 已接 diamond 导出', svgSrc.includes("s.shapeKind === 'diamond'"));
ok('help.js 工具文案含三角形/菱形', helpSrc.includes('三角形') && helpSrc.includes('菱形'));

// ---- ② shapeNormalize 行为 ----
try {
  const shapeNormalize = new Function('return ' + extractFn(html, 'shapeNormalize'))();
  let el = { _x0:10, _y0:20, _x1:110, _y1:70 };
  shapeNormalize(el);
  ok('正向拖拽归一化 x/y/w/h', el.x===10 && el.y===20 && el.w===100 && el.h===50);
  el = { _x0:110, _y0:70, _x1:10, _y1:20 };
  shapeNormalize(el);
  ok('反向拖拽（右上往左下）归一化为正宽高', el.x===10 && el.y===20 && el.w===100 && el.h===50);
  el = { _x0:5, _y0:6, _x1:2, _y1:30 };
  shapeNormalize(el);
  ok('混合方向（左上、右下）各自归一化', el.x===2 && el.y===6 && el.w===3 && el.h===24);
  el = { _x0:8, _y0:9 };
  shapeNormalize(el);
  ok('缺终点回退起点（w=h=0）', el.x===8 && el.y===9 && el.w===0 && el.h===0);
  ok('shapeNormalize 不污染临时字段', el._x0===8 && el._x1 === undefined);
} catch(e){ ok('shapeNormalize 烘焙', false); console.log('  ', e.message); }

// ---- ③ drawStroke 菱形渲染 ----
function makeCtx(){
  const calls = []; const props = {};
  const ctx = new Proxy({}, {
    get(t, k){ if(k === '__calls') return calls; if(k === '__props') return props; return (...a)=>{ calls.push([k, ...a]); }; },
    set(t, k, v){ props[k] = v; return true; }
  });
  return { ctx, calls, props };
}
try {
  const drawStroke = new Function('ctx', 'dpr', 'imgCache', 'redraw',
    extractFn(html, 'drawStroke') + '\nreturn drawStroke;');
  const draw = el => { const r = makeCtx(); drawStroke(r.ctx, 1, new Map(), ()=>{})(el); return r; };
  const first = (calls, name)=> calls.find(c => c[0] === name);
  let r = draw({ type:'shape', shapeKind:'diamond', x:10, y:20, w:100, h:50, color:'#ff0000' });
  const mv = first(r.calls, 'moveTo'), lts = r.calls.filter(c => c[0] === 'lineTo');
  ok('菱形四顶点起于上顶点', !!mv && mv[1]===60 && mv[2]===20);
  ok('菱形顶点顺序 右→下→左', lts.length===3 && lts[0][1]===110 && lts[0][2]===45 && lts[1][1]===60 && lts[1][2]===70 && lts[2][1]===10 && lts[2][2]===45);
  ok('菱形闭合 + 描边', !!first(r.calls, 'closePath') && !!first(r.calls, 'stroke') && r.props.strokeStyle === '#ff0000');
  r = draw({ type:'shape', shapeKind:'diamond', x:0, y:0, w:40, h:40, color:'#0f0', fill:'#00ff00' });
  ok('菱形有填充走 fill 不 stroke', !!first(r.calls, 'fill') && !first(r.calls, 'stroke') && r.props.fillStyle === '#00ff00');
} catch(e){ ok('drawStroke 菱形烘焙', false); console.log('  ', e.message); }

// ---- ④ 服务端集成 ----
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const PORT = 8163;
const ROOM = 'st_' + crypto.randomBytes(3).toString('hex');
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
      'GET /?room='+encodeURIComponent(room)+' HTTP/1.1\r\nHost: localhost:'+PORT+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'+
      'Sec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d=> ws.feed(d));
    sock.on('error', ()=>{});
    setTimeout(()=> res(ws), 200);
  });
}
const sleep = ms => new Promise(r=> setTimeout(r, ms));
const server = require('child_process').spawn(NODE, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '5000' } });

(async ()=>{
  await new Promise(r=> server.stdout.on('data', d=>{ if(/WS 服务已启动/.test(d.toString())) r(); }));
  await sleep(150);
  const c1 = await connect(ROOM);
  const c2 = await connect(ROOM);
  await sleep(400);

  c1.send({ type:'shape', kind:'triangle', id:'c1:1', x:10, y:20, w:100, h:50, color:'#ff0000' });
  c1.send({ type:'shape', kind:'diamond', id:'c1:2', x:0, y:0, w:40, h:40, color:'#00ff00', fill:'#00ff00' });
  c1.send({ type:'shape', kind:'bogus', x:0, y:0, w:10, h:10 });
  c1.send({ type:'shape', kind:'rect', id:'c1:3', x:0, y:0, w:10, h:10, color:'#fff', fill:true });
  await sleep(400);
  const tri = c2.msgs.find(m => m.type==='shape' && m.shapeKind==='triangle');
  const dia = c2.msgs.find(m => m.type==='shape' && m.shapeKind==='diamond');
  ok('c2 收到 triangle 广播', !!tri && tri.x===10 && tri.y===20 && tri.w===100 && tri.h===50);
  ok('客户端 id 透传持久化一致', !!tri && tri.id==='c1:1' && !!dia && dia.id==='c1:2');
  ok('diamond 广播带 fill 色透传', !!dia && dia.fill==='#00ff00');
  ok('bogus kind 被拒（bad_kind）', c1.msgs.some(m => m.type==='error' && m.code==='bad_kind'));
  const boolFill = c2.msgs.find(m => m.type==='shape' && m.id==='c1:3');
  ok('布尔 fill 被服务端归一为 null', !!boolFill && boolFill.fill === null);

  // 迟到者快照 + export svg
  const c3 = await connect(ROOM);
  await sleep(400);
  const snap = c3.msgs.filter(m => m.type==='snapshot').pop();
  const kinds = snap ? snap.strokes.map(s => s.shapeKind) : [];
  ok('迟到者快照含 triangle/diamond', !!snap && kinds.includes('triangle') && kinds.includes('diamond'));

  c1.send({ type:'export_board', format:'svg' });
  await sleep(400);
  const exp = c1.msgs.filter(m => m.type==='board_export' && m.format==='svg').pop();
  ok('export_board 返回 svg', !!exp && typeof exp.svg === 'string');
  if(exp){
    ok('导出 svg 含 triangle polygon', exp.svg.includes('<polygon points="60,20 10,70 110,70"'));
    ok('导出 svg 含 diamond polygon 四点', exp.svg.includes('<polygon points="20,0 40,20 20,40 0,20"') && exp.svg.includes('fill="#00ff00"'));
  }

  server.kill();
  console.log(`\n[CollabBoard shape tools] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
