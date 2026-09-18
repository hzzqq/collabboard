// _ghost_shapes_test.js — CollabBoard 幽灵图元收编：服务端 shape/frame/stamp 三类元素客户端全链路支持。
// 缺陷背景：服务端 shape(4 kinds)/frame/stamp API 持久化+广播，但客户端 WS 分派无 case、drawStroke 无渲染
// 分支、bboxOf/hitTest/translateLocal 不识别 → 真实 UI 里不可见/不可选/不可移动；两条 SVG 导出路径同样漏导，
// 且 triangle 在服务端内联导出中被误导出为 <rect>。
// ① 静态接线守卫（WS 分派/渲染分支/几何泛化/双导出路径）
// ② drawStroke 行为（抽取真实函数 + mock ctx）：shape 四种 kind（fill/rot/flip）、frame 虚线+标签、
//    stamp 居中文字+角度还原
// ③ 几何行为（bboxOf/hitTest/translateLocal）：三类元素可选/可框选/可移动 + 既有类型回归
// ④ svg.js strokesToSVG：三类导出 + 既有类型回归
// ⑤ 服务端集成：shape line/stamp/frame 广播到达、迟到者快照可见、export_board svg 含三类且 triangle 为 polygon
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

// 0) 内联脚本语法检查（房屋惯例）
const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0];
ok('index.html 含内联脚本', !!m);
if(m){
  const tmp = path.join(dir, '.wb_ghost_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// brace 计数抽取（CRLF 免疫，沿用 _kbd_test 惯用法）
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
ok('WS 分派已接 shape', html.includes("case 'shape':"));
ok('WS 分派已接 frame', html.includes("case 'frame':"));
ok('WS 分派已接 stamp', html.includes("case 'stamp':"));
ok('drawStroke 已接 shape 渲染分支', html.includes("if(s.type === 'shape'){"));
ok('shape 分支覆盖 ellipse/line/triangle',
  html.includes("s.shapeKind === 'ellipse'") && html.includes("s.shapeKind === 'line'") && html.includes("s.shapeKind === 'triangle'"));
ok('drawStroke 已接 frame 渲染分支', html.includes("if(s.type === 'frame'){"));
ok('drawStroke 已接 stamp 渲染分支', html.includes("if(s.type === 'stamp'){"));
ok('translateLocal 有锚点元素泛化分支', html.includes('el.x = (el.x||0) + dx'));
ok('hitTest 复用 bboxOf', /function hitTest\(x, y\)\{[\s\S]{0,400}const bb = bboxOf\(s\);/.test(html));
ok('bboxOf 已接 stamp 尺寸分支', /function bboxOf\(s\)\{[\s\S]{0,400}s\.type === 'stamp'/.test(html));
ok('bboxOf 已接锚点+尺寸泛化分支', /function bboxOf\(s\)\{[\s\S]{0,600}s\.x != null && s\.w != null/.test(html));
ok('svg.js 已接 shape/frame/stamp 导出',
  svgSrc.includes("s.type === 'shape'") && svgSrc.includes("s.type === 'frame'") && svgSrc.includes("s.type === 'stamp'"));
ok('svg.js triangle 导出为 polygon', svgSrc.includes('<polygon points='));
ok('server.js export_board 已补 line/stamp 导出', serverSrc.includes("el.shapeKind === 'line'") && serverSrc.includes("el.type === 'stamp'"));
ok('server.js triangle 不再误导出为 rect', !serverSrc.includes("el.type === 'frame' || el.shapeKind === 'rect' || el.shapeKind === 'triangle'"));

// ---- ② drawStroke 行为（mock ctx 记录调用与属性） ----
function makeCtx(){
  const calls = []; const props = {};
  const ctx = new Proxy({}, {
    get(t, k){ if(k === '__calls') return calls; if(k === '__props') return props; return (...a)=>{ calls.push([k, ...a]); }; },
    set(t, k, v){ props[k] = v; return true; }
  });
  return { ctx, calls, props };
}
let drawStroke = null;
try {
  drawStroke = new Function('ctx', 'dpr', 'imgCache', 'redraw',
    extractFn(html, 'drawStroke') + '\nreturn drawStroke;');
  ok('drawStroke 抽取烘焙成功', typeof drawStroke === 'function');
} catch(e){ ok('drawStroke 抽取烘焙成功', false); console.log('  ', e.message); }

if(drawStroke){
  const D = 2;   // 用非 1 的 dpr 验证缩放换算
  function draw(el){
    const { ctx, calls, props } = makeCtx();
    drawStroke(ctx, D, new Map(), ()=>{})(el);
    return { calls, props };
  }
  const first = (calls, name)=> calls.find(c => c[0] === name);
  const all = (calls, name)=> calls.filter(c => c[0] === name);

  // shape rect：无 fill → strokeRect + strokeStyle=color
  let r = draw({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50, color:'#ff0000' });
  let c = first(r.calls, 'strokeRect');
  ok('shape rect 无填充 → strokeRect(10,20,100,50)·dpr 换算', !!c && c[1]===10*D && c[2]===20*D && c[3]===100*D && c[4]===50*D);
  ok('shape rect 描边色取 color', r.props.strokeStyle === '#ff0000');
  ok('shape rect 无填充不调 fillRect', !first(r.calls, 'fillRect'));

  // shape rect：有 fill → fillRect + fillStyle=fill
  r = draw({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50, color:'#ff0000', fill:'#00ff00' });
  c = first(r.calls, 'fillRect');
  ok('shape rect 有填充 → fillRect 同几何', !!c && c[1]===10*D && c[4]===50*D);
  ok('shape rect 填充色取 fill', r.props.fillStyle === '#00ff00');

  // shape ellipse：中心/半径
  r = draw({ type:'shape', shapeKind:'ellipse', x:10, y:20, w:100, h:50, color:'#00f' });
  c = first(r.calls, 'ellipse');
  ok('shape ellipse → ellipse(cx=60,cy=45,rx=50,ry=25)', !!c && c[1]===60*D && c[2]===45*D && c[3]===50*D && c[4]===25*D);
  ok('shape ellipse 无填充走 stroke', !!first(r.calls, 'stroke') && !first(r.calls, 'fill'));

  // shape line：对角线
  r = draw({ type:'shape', shapeKind:'line', x:10, y:20, w:100, h:50, color:'#00f' });
  const mv = first(r.calls, 'moveTo'), lt = first(r.calls, 'lineTo');
  ok('shape line → moveTo(10,20)→lineTo(110,70)', !!mv && mv[1]===10*D && mv[2]===20*D && !!lt && lt[1]===110*D && lt[2]===70*D);

  // shape triangle：顶点(60,20)/(10,70)/(110,70)
  r = draw({ type:'shape', shapeKind:'triangle', x:10, y:20, w:100, h:50, color:'#00f' });
  const tMv = all(r.calls, 'moveTo'), tLt = all(r.calls, 'lineTo');
  ok('shape triangle 顶点顺序正确', tMv.length===1 && tMv[0][1]===60*D && tMv[0][2]===20*D &&
    tLt.length>=2 && tLt[0][1]===10*D && tLt[0][2]===70*D && tLt[1][1]===110*D && tLt[1][2]===70*D);
  ok('shape triangle 闭合路径', !!first(r.calls, 'closePath'));

  // rot / flip
  r = draw({ type:'shape', shapeKind:'rect', x:0, y:0, w:40, h:40, rot:90, color:'#00f' });
  c = first(r.calls, 'rotate');
  ok('shape rot=90 → rotate(π/2)', !!c && Math.abs(c[1] - Math.PI/2) < 1e-9);
  r = draw({ type:'shape', shapeKind:'rect', x:0, y:0, w:40, h:40, flipH:true, color:'#00f' });
  c = first(r.calls, 'scale');
  ok('shape flipH → scale(-1,1)', !!c && c[1]===-1 && c[2]===1);

  // frame：虚线 + 边框 + 标签
  r = draw({ type:'frame', x:5, y:6, w:200, h:120, label:'分组A', color:'#82aaff' });
  c = first(r.calls, 'setLineDash');
  ok('frame 虚线段 [8,5]·dpr 换算', !!c && c[1][0]===8*D && c[1][1]===5*D);
  c = first(r.calls, 'strokeRect');
  ok('frame 边框几何正确', !!c && c[1]===5*D && c[2]===6*D && c[3]===200*D && c[4]===120*D);
  c = first(r.calls, 'fillText');
  ok('frame 标签文本绘制', !!c && c[1]==='分组A');
  ok('frame 结束后恢复实线', all(r.calls, 'setLineDash').length >= 2 && all(r.calls, 'setLineDash')[1][1].length === 0);

  // stamp：居中文字 + 原生角度 + textAlign 还原
  r = draw({ type:'stamp', x:100, y:80, text:'通过', size:48, color:'#ffffff' });
  c = first(r.calls, 'fillText');
  ok('stamp 文本以锚点居中绘制', !!c && c[1]==='通过' && c[2]===0 && c[3]===0);
  ok('stamp 字号进 font', new RegExp((48*D)+'px').test(r.props.font || ''));
  ok('stamp textAlign 居中后还原 start', r.props.textAlign === 'start');
  r = draw({ type:'stamp', x:0, y:0, text:'x', rotation:30, color:'#fff' });
  c = first(r.calls, 'rotate');
  ok('stamp rotation=30 → rotate(π/6)', !!c && Math.abs(c[1] - Math.PI/6) < 1e-9);
  r = draw({ type:'stamp', x:0, y:0, text:'x', rotation:30, rot:60, color:'#fff' });
  c = first(r.calls, 'rotate');
  ok('stamp rotation+rot 叠加 → rotate(π/2)', !!c && Math.abs(c[1] - Math.PI/2) < 1e-9);
}

// ---- ③ 几何行为（bboxOf / hitTest / translateLocal） ----
let bboxOf = null, hitTest = null, translateLocal = null;
try {
  bboxOf = new Function('return ' + extractFn(html, 'bboxOf'))();
  translateLocal = new Function('return ' + extractFn(html, 'translateLocal'))();
  hitTest = new Function('strokes', 'bboxOf', extractFn(html, 'hitTest') + '\nreturn hitTest;');
  ok('bboxOf/translateLocal/hitTest 抽取烘焙成功', typeof bboxOf==='function' && typeof translateLocal==='function' && typeof hitTest==='function');
} catch(e){ ok('bboxOf/translateLocal/hitTest 抽取烘焙成功', false); console.log('  ', e.message); }

if(bboxOf && translateLocal && hitTest){
  const shape = { type:'shape', shapeKind:'rect', id:'s1', x:10, y:20, w:100, h:50, color:'#f00' };
  const frame = { type:'frame', id:'f1', x:0, y:0, w:200, h:120, label:'A' };
  const stamp = { type:'stamp', id:'st1', x:100, y:80, text:'OK', size:48 };
  let b = bboxOf(shape);
  ok('bboxOf(shape) 精确包围盒', b.x===10 && b.y===20 && b.w===100 && b.h===50);
  b = bboxOf(frame);
  ok('bboxOf(frame) 精确包围盒', b.x===0 && b.y===0 && b.w===200 && b.h===120);
  b = bboxOf(stamp);
  ok('bboxOf(stamp) 用 size 作边长', b.x===100 && b.y===80 && b.w===48 && b.h===48);
  b = bboxOf({ type:'stamp', x:0, y:0, text:'', size:4 });
  ok('bboxOf(stamp) size 下限钳制 8', b.w===8 && b.h===8);
  b = bboxOf({ type:'note', x:5, y:6, w:160, h:120, text:'n' });
  ok('bboxOf(note) 泛化分支可框选', b && b.x===5 && b.w===160);
  b = bboxOf({ type:'text', text:'ab', x:3, y:4, width:20 });
  ok('bboxOf(text) 既有公式回归', b.w === 2*20*0.6 && b.h === Math.max(12,20)*1.2);
  b = bboxOf({ tool:'pen', points:[{x:1,y:2},{x:9,y:8}] });
  ok('bboxOf(pen points) 既有 AABB 回归', b.x===1 && b.y===2 && b.w===8 && b.h===6);
  ok('bboxOf(未知元素) 仍为 null', bboxOf({ foo:1 }) === null);

  // hitTest：命中/容差/顶层优先/空板（bboxOf 作为依赖注入）
  const HT = (list)=> (x, y)=> hitTest(list, bboxOf)(x, y);
  let hit = HT([shape])(60, 45);
  ok('hitTest 命中 shape 中心', !!hit && hit.id === 's1');
  hit = HT([shape])(4, 20);   // 左边界外 6px < 8px 容差
  ok('hitTest 8px 容差贴边命中', !!hit && hit.id === 's1');
  hit = HT([shape])(200, 200);
  ok('hitTest 远点不命中', hit === null);
  hit = HT([shape, stamp])(100, 80);
  ok('hitTest 命中 stamp', !!hit && hit.id === 'st1');
  const s2 = { type:'shape', shapeKind:'rect', id:'s2', x:50, y:40, w:100, h:60, color:'#0f0' };
  hit = HT([shape, s2])(60, 45);   // 两 shape 重叠，数组末尾（顶层）优先
  ok('hitTest 重叠时顶层优先', !!hit && hit.id === 's2');
  ok('hitTest 空板返回 null', HT([])(0, 0) === null);
  const imgEl = { type:'image', id:'i1', x:0, y:0, w:100, h:80, src:'data:image/png;base64,AA' };
  hit = HT([imgEl])(50, 40);
  ok('hitTest 现可点选 image（漂移收编）', !!hit && hit.id === 'i1');

  // translateLocal：锚点元素 / 点集 / 文字 / 空值安全
  const mv = JSON.parse(JSON.stringify(shape));
  translateLocal(mv, 5, 7);
  ok('translateLocal 平移 shape', mv.x===15 && mv.y===27);
  const ms = JSON.parse(JSON.stringify(stamp));
  translateLocal(ms, -10, 3);
  ok('translateLocal 平移 stamp', ms.x===90 && ms.y===83);
  const mi = { type:'image', x:1, y:2 };
  translateLocal(mi, 4, 5);
  ok('translateLocal 平移 image', mi.x===5 && mi.y===7);
  const mp = { tool:'pen', points:[{x:0,y:0},{x:2,y:3}] };
  translateLocal(mp, 1, 1);
  ok('translateLocal 平移点集回归', mp.points[1].x===3 && mp.points[1].y===4);
  const mt = { type:'text', x:9, y:9, text:'t', width:16 };
  translateLocal(mt, 1, -1);
  ok('translateLocal 平移 text 回归', mt.x===10 && mt.y===8);
  const mx = { type:'shape', shapeKind:'rect', w:10 };   // 无 x/y 的畸形元素与服务端同语义：跳过不造 NaN
  translateLocal(mx, 2, 3);
  ok('translateLocal 缺 x/y 安全跳过', mx.x === undefined && mx.y === undefined && mx.w === 10);
}

// ---- ④ svg.js strokesToSVG 导出 ----
try {
  const { strokesToSVG } = require('./svg.js');
  const W = 1280, H = 720;
  const svg = strokesToSVG([
    { type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50, color:'#ff0000' },
    { type:'shape', shapeKind:'rect', x:0, y:0, w:40, h:40, color:'#f00', fill:'#00ff00' },
    { type:'shape', shapeKind:'ellipse', x:10, y:20, w:100, h:50, color:'#00f' },
    { type:'shape', shapeKind:'line', x:10, y:20, w:100, h:50, color:'#00f' },
    { type:'shape', shapeKind:'triangle', x:10, y:20, w:100, h:50, color:'#00f', fill:'#0000ff' },
    { type:'frame', x:5, y:6, w:200, h:120, label:'分组<1>', color:'#82aaff' },
    { type:'stamp', x:100, y:80, text:'通过', size:48, color:'#fff' },
    { tool:'pen', color:'#f00', width:4, points:[{x:1,y:1},{x:9,y:9}] }
  ], W, H);
  const has = (s, sub)=> s.indexOf(sub) >= 0;
  ok('svg: shape rect 无填充 fill="none"', has(svg, '<rect x="10" y="20" width="100" height="50" fill="none" stroke="#ff0000"'));
  ok('svg: shape rect 有填充', has(svg, 'fill="#00ff00"'));
  ok('svg: shape ellipse 几何', has(svg, '<ellipse cx="60" cy="45" rx="50" ry="25"'));
  ok('svg: shape line 对角线', has(svg, '<line x1="10" y1="20" x2="110" y2="70"'));
  ok('svg: shape triangle 为 polygon', has(svg, '<polygon points="60,20 10,70 110,70"'));
  ok('svg: frame 虚线框 + 标签转义', has(svg, 'stroke-dasharray="8 5"') && has(svg, '分组&lt;1&gt;'));
  ok('svg: stamp 居中大字', has(svg, 'font-size="48" text-anchor="middle"') && has(svg, '>通过</text>'));
  ok('svg: 既有 pen polyline 回归', has(svg, '<polyline points="1,1 9,9"'));
  const svgEmpty = strokesToSVG([], W, H);
  ok('svg: 空 strokes 仍合法', svgEmpty.trim().startsWith('<svg') && svgEmpty.trim().endsWith('</svg>'));
} catch(e){ ok('svg.js 导出行为', false); console.log('  ', e.message); }

// ---- ⑤ 服务端集成（广播到达 / 迟到者快照 / export_board svg） ----
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch(e){}
const PORT = 8162;
const ROOM = 'ghost_' + crypto.randomBytes(3).toString('hex');
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

  c1.send({ type:'shape', kind:'line', x:10, y:20, w:100, h:50, color:'#ff0000' });
  c1.send({ type:'stamp', x:100, y:80, text:'通过', size:48, color:'#ffffff' });
  c1.send({ type:'frame', x:0, y:0, w:200, h:120, label:'区域A', color:'#82aaff' });
  await sleep(400);
  ok('c2 收到 shape(line) 广播', c2.msgs.some(m => m.type==='shape' && m.shapeKind==='line'));
  ok('c2 收到 stamp 广播', c2.msgs.some(m => m.type==='stamp' && m.text==='通过'));
  ok('c2 收到 frame 广播', c2.msgs.some(m => m.type==='frame' && m.label==='区域A'));

  // 迟到者快照：三类元素均已持久化并进入 snapshot
  const c3 = await connect(ROOM);
  await sleep(400);
  const snap = c3.msgs.filter(m => m.type==='snapshot').pop();
  const kinds = snap ? snap.strokes.map(s => s.type) : [];
  ok('迟到者快照含 shape/stamp/frame', !!snap && kinds.includes('shape') && kinds.includes('stamp') && kinds.includes('frame'));

  // export_board svg：三类元素入 SVG，triangle 为 polygon
  c1.send({ type:'shape', kind:'triangle', x:10, y:20, w:100, h:50, color:'#ff0000' });
  await sleep(300);
  c1.send({ type:'export_board', format:'svg' });
  await sleep(400);
  const exp = c1.msgs.filter(m => m.type==='board_export' && m.format==='svg').pop();
  ok('export_board 返回 svg', !!exp && typeof exp.svg === 'string');
  if(exp){
    ok('导出 svg 含 shape line', exp.svg.includes('<line x1="10" y1="20" x2="110" y2="70"'));
    ok('导出 svg 含 triangle polygon（不再是 rect）', exp.svg.includes('<polygon points="60,20 10,70 110,70"'));
    ok('导出 svg 含 stamp 文字', exp.svg.includes('font-size="48"') && exp.svg.includes('>通过</text>'));
    ok('导出 svg 含 frame 虚线框与标签', exp.svg.includes('stroke-dasharray="8 5"') && exp.svg.includes('>区域A</text>'));
  }

  server.kill();
  console.log(`\n[CollabBoard ghost shapes] pass=${pass} fail=${fail}`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); server.kill(); process.exit(1); });
