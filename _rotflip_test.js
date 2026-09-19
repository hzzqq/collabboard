// whiteboard 旋转/翻转几何正确性单元测试：从 server.js 抽取【真实生产函数】
// rotateElement/flipElement（{x,y,w,h} 系 AABB 烘焙语义：90° 交换 w/h、翻转 x'=2cx−x−w、
// line 反对角 flag、triangle 纯 rot 编码、image rot/flip、点锚元素保持旧路径），
// 另对质心盒中心化与客户端/SVG 渲染变体做结构守护。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (n, c)=>{ if(c) pass++; else { fail++; console.log('  FAIL', n); } };

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const ihtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// brace 计数抽取（CRLF 免疫，同 _marquee_test.js 方法）
function extractFn(name){
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
const { rotateElement, flipElement } =
  new Function(extractFn('rotateElement') + '\n' + extractFn('flipElement') +
    '\nreturn { rotateElement, flipElement };')();

// ---- 1) rotateElement：{x,y,w,h} 系 AABB 烘焙 ----
{
  const r = rotateElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50, color:'#fff' }, 90, 60, 45);
  ok('rect 90° 绕自身中心：w/h 交换', r.w === 50 && r.h === 100);
  ok('rect 90° 绕自身中心：原位重定位', r.x === 35 && r.y === -5);
  ok('rect 90°：无 rot 残留（自对称烘焙）', !r.rot);
  const r2 = rotateElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 180, 60, 45);
  ok('rect 180°：包围盒不变', r2.x === 10 && r2.y === 20 && r2.w === 100 && r2.h === 50);
  const r3 = rotateElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 270, 0, 0);
  ok('rect 270° 绕外枢轴：盒中心公转+交换', r3.x === 20 && r3.y === -110 && r3.w === 50 && r3.h === 100);
  const r4 = rotateElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 90, 0, 0);
  ok('rect 90° 与 270° 公转方向相反', r4.x === -70 && r4.y === 10);
  const rb = rotateElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 90, 60, 45);
  rotateElement(rb, 270, 60, 45);
  ok('rect 90°+270° 往返还原（整数精确）', rb.x === 10 && rb.y === 20 && rb.w === 100 && rb.h === 50);
}
{
  const t = rotateElement({ type:'shape', shapeKind:'triangle', x:10, y:20, w:100, h:50 }, 90, 60, 45);
  ok('triangle 90°：AABB 交换 + rot=90', t.w === 50 && t.h === 100 && t.x === 35 && t.rot === 90);
  const t2 = rotateElement({ type:'shape', shapeKind:'triangle', x:10, y:20, w:100, h:50 }, 180, 60, 45);
  ok('triangle 180°：AABB 不变 + rot=180', t2.w === 100 && t2.h === 50 && t2.x === 10 && t2.rot === 180);
  const t3 = rotateElement({ type:'shape', shapeKind:'triangle', x:0, y:0, w:100, h:50 }, 270, 50, 25);
  ok('triangle 270°：rot=270', t3.rot === 270);
}
{
  const l = rotateElement({ type:'shape', shapeKind:'line', x:0, y:0, w:100, h:50 }, 90, 50, 25);
  ok('line 90°：anti 置位 + AABB 交换', l.anti === true && l.w === 50 && l.h === 100 && l.x === 25 && l.y === -25);
  rotateElement(l, 180, 25, 25);
  ok('line 180°：anti 不变（主↔反对角等价）', l.anti === true);
  rotateElement(l, 270, 25, 25);
  ok('line 270°：anti 复位', l.anti === false);
  const lb = rotateElement({ type:'shape', shapeKind:'line', x:0, y:0, w:100, h:50 }, 90, 50, 25);
  rotateElement(lb, 270, 25, -25);
  ok('line 90°+270° 往返还原', lb.anti === false && lb.w === 100 && lb.h === 50);
}
{
  const d = rotateElement({ type:'shape', shapeKind:'diamond', x:0, y:0, w:100, h:50 }, 90, 50, 25);
  ok('diamond 90°：AABB 交换无 rot（4 折自对称）', d.w === 50 && d.h === 100 && !d.rot);
  const e = rotateElement({ type:'shape', shapeKind:'ellipse', x:0, y:0, w:100, h:50 }, 90, 50, 25);
  ok('ellipse 90°：AABB 交换无 rot', e.w === 50 && e.h === 100 && !e.rot);
  const f = rotateElement({ type:'frame', x:0, y:0, w:300, h:200, label:'x' }, 90, 150, 100);
  ok('frame 90°：AABB 交换无 rot', f.w === 200 && f.h === 300 && f.x === 50 && f.y === -50 && !f.rot);
  const n = rotateElement({ type:'note', x:0, y:0, w:300, h:200 }, 90, 150, 100);
  ok('note 90°：AABB 交换无 rot', n.w === 200 && n.h === 300 && !n.rot);
  const im = rotateElement({ type:'image', x:0, y:0, w:300, h:200, src:'a.png' }, 90, 150, 100);
  ok('image 90°：AABB 交换 + rot=90（内容旋转）', im.w === 200 && im.h === 300 && im.rot === 90);
  rotateElement(im, 180, 100, 150);
  ok('image 再转 180°：rot=270', im.rot === 270);
}
{
  const tx = rotateElement({ type:'text', x:100, y:100 }, 90, 100, 100);
  ok('text 点锚路径保持：锚点原位 + rot 累计', tx.x === 100 && tx.y === 100 && tx.rot === 90);
  const st = rotateElement({ type:'stroke', points:[{x:0,y:0},{x:10,y:10}] }, 90, 5, 5);
  ok('points 路径保持：逐点旋转', st.points[0].x === 10 && st.points[0].y === 0 && st.points[1].x === 0 && st.points[1].y === 10);
  const keep = rotateElement({ type:'shape', shapeKind:'rect', x:0, y:0, w:10, h:10, color:'#abc', id:'x1' }, 90, 5, 5);
  ok('旋转保留其余字段（color/id）', keep.color === '#abc' && keep.id === 'x1');
}

// ---- 2) flipElement：AABB 整盒镜像 ----
{
  const r = flipElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 'h', 60, 45);
  ok('flipH 绕自身中心：原位镜像（x 不动）', r.x === 10 && r.w === 100 && !r.flipH);
  const r2 = flipElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 'h', 200, 45);
  ok('flipH 外轴：x=2cx−x−w', r2.x === 290 && r2.w === 100);
  const r3 = flipElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 'v', 60, 100);
  ok('flipV 外轴：y=2cy−y−h', r3.y === 130 && r3.h === 50);
  const rb = flipElement({ type:'shape', shapeKind:'rect', x:10, y:20, w:100, h:50 }, 'h', 200, 45);
  flipElement(rb, 'h', 200, 45);
  ok('flipH 两次往返还原', rb.x === 10);
}
{
  const l = flipElement({ type:'shape', shapeKind:'line', x:0, y:0, w:100, h:50 }, 'h', 50, 25);
  ok('line flipH：anti 置位', l.anti === true);
  flipElement(l, 'v', 25, 25);
  ok('line flipV：anti 复位（两次镜像还原）', l.anti === false);
  const l2 = flipElement({ type:'shape', shapeKind:'line', x:0, y:0, w:100, h:50 }, 'h', 100, 25);
  ok('line flipH 外轴：x=2cx−x−w', l2.x === 100);
}
{
  // 等腰三角形镜像 = 顶点朝向纯旋转：flipH rot→−rot；flipV rot→180−rot
  const mk = r => ({ type:'shape', shapeKind:'triangle', x:0, y:0, w:100, h:50, rot:r });
  ok('triangle 0° flipH → 0°', flipElement(mk(0), 'h', 50, 25).rot === 0);
  ok('triangle 0° flipV → 180°', flipElement(mk(0), 'v', 50, 25).rot === 180);
  ok('triangle 90° flipH → 270°', flipElement(mk(90), 'h', 50, 25).rot === 270);
  ok('triangle 90° flipV → 90°（右顶点垂直自对称）', flipElement(mk(90), 'v', 50, 25).rot === 90);
  ok('triangle 180° flipV → 0°', flipElement(mk(180), 'v', 50, 25).rot === 0);
  ok('triangle 270° flipH → 90°', flipElement(mk(270), 'h', 50, 25).rot === 90);
  const t = flipElement(mk(90), 'h', 100, 25);
  ok('triangle flipH 外轴：AABB 镜像', t.x === 100 && t.w === 100);
  const im = flipElement({ type:'image', x:0, y:0, w:100, h:50 }, 'h', 50, 25);
  ok('image flipH：flag 置位', im.flipH === true && !im.flipV);
  flipElement(im, 'h', 50, 25);
  ok('image flipH 两次复位', im.flipH === false);
  const im2 = flipElement({ type:'image', x:0, y:0, w:100, h:50 }, 'v', 50, 25);
  ok('image flipV：flag 置位', im2.flipV === true);
}
{
  const tx = flipElement({ type:'text', x:100, y:50 }, 'h', 100, 50);
  ok('text 点锚路径保持：锚点原位 + flipH 累计', tx.x === 100 && tx.flipH === true);
  const st = flipElement({ type:'stroke', points:[{x:0,y:0},{x:10,y:10}] }, 'h', 5, 5);
  ok('points 路径保持：逐点镜像', st.points[0].x === 10 && st.points[1].x === 0);
  const d = flipElement({ type:'shape', shapeKind:'diamond', x:0, y:0, w:100, h:50 }, 'h', 50, 25);
  ok('diamond flipH：镜像自对称无 flag', d.x === 0 && !d.flipH && !d.anti);
}

// ---- 3) 结构守护：质心盒中心化 + 渲染变体接线 ----
{
  const m = src.match(/el\.w\/2; sy \+= \(el\.y\|\|0\) \+ el\.h\/2/g) || [];
  ok('server: rotate/flip 质心均改用盒中心（2 处）', m.length === 2);
}
ok('server: SVG 导出 line 反对角变体', src.includes("el.anti ? '<line x1=\"'+x1+'\" y1=\"'+y2+'\""));
ok('server: SVG 导出 triangle rot 变体（90/270）', src.includes('r===90 ?') && src.includes('r===270 ?'));
ok('client: line 反对角渲染', ihtml.includes('if(s.anti){ ctx.beginPath(); ctx.moveTo(x+w, y); ctx.lineTo(x, y+h); }'));
ok('client: image flip 缩放渲染', ihtml.includes('if(s.flipH || s.flipV) ctx.scale(s.flipH?-1:1, s.flipV?-1:1);   // 位图内容镜像'));
try { execSync(`"${process.execPath}" --check "${path.join(__dirname, 'server.js')}"`); ok('server.js 语法 OK', true); }
catch(e){ ok('server.js 语法 OK', false); }

console.log('rotflip: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
