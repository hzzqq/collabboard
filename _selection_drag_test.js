// CollabBoard 框选后拖拽整体移动 + 方向键微移回归：
// ① 静态接线守卫（marquee 分支按下已选中元素转拖拽 / select 分支多选不坍缩 / onKeydown 方向键分支）
// ② selectionHitAt 纯逻辑（选中集合命中、8px 容差、顶层优先、未选中/无包围盒跳过、空选区）
// ③ nudgeSel（仅平移选中元素 + 一次 move 广播；空选区不发）
// ④ onKeydown 方向键分支（四向 dx/dy、Shift 10px、输入框守卫、空选区、Del 回归不破坏）
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = process.execPath;
const dir = __dirname;
let fail = 0, pass = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

// 0) 内联脚本语法检查（房屋惯例）
const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0];
ok('index.html 含内联脚本', !!m);
if(m){
  const tmp = path.join(dir, '.wb_sd_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// brace 计数抽取（CRLF 免疫）
function extractFn(name){
  const start = html.indexOf('function ' + name + '(');
  if(start < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, i = html.indexOf('{', start);
  for(; i < html.length; i++){
    const c = html[i];
    if(c === '{') depth++;
    else if(c === '}'){ depth--; if(depth === 0) return html.slice(start, i+1); }
  }
  throw new Error('函数 ' + name + ' 括号不匹配');
}

// ---- ① 静态接线守卫 ----
ok('marquee 分支已接 selectionHitAt 转整体拖拽',
  html.includes("if(selectedIds.size && selectionHitAt(p.x, p.y, selectedIds, strokes) != null){"));
ok('marquee 拖拽走 dragGroup 通道', /selectionHitAt\(p\.x, p\.y, selectedIds, strokes\) != null\)[\s\S]{0,200}dragGroup = \[\.\.\.selectedIds\]/.test(html));
ok('select 分支多选点击已选中元素不坍缩',
  html.includes("const keepMulti = !e.shiftKey && selectedIds.size > 1 && selectedIds.has(hit.id);"));
ok('onKeydown 已接方向键分支', html.includes("e.key.indexOf('Arrow') === 0 && selectedIds.size"));

// ---- ② selectionHitAt 纯逻辑 ----
let bboxOf, selectionHitAt, nudgeSel;
try {
  const bake = new Function(
    extractFn('bboxOf') + '\n' + extractFn('selectionHitAt') +
    '\nreturn { bboxOf, selectionHitAt };');
  ({ bboxOf, selectionHitAt } = bake());
  ok('bboxOf/selectionHitAt 抽取成功', true);
} catch(e){ ok('bboxOf/selectionHitAt 抽取成功', false); console.log('  ', e.message); }

if(selectionHitAt && bboxOf){
  const a = { type:'pen', id:'A', points:[{x:10,y:10},{x:30,y:30}] };    // bbox(10,10,20,20)
  const b = { type:'pen', id:'B', points:[{x:100,y:100},{x:110,y:110}] }; // bbox(100,100,10,10)
  const pin = { type:'pin', id:'P', x:200, y:200 };                      // 无包围盒
  const out = { type:'pen', id:'X', points:[{x:500,y:500},{x:520,y:520}] }; // 未选中元素
  const sel = new Set(['A','B','P']);
  const list = [a, b, pin, out];

  ok('选中元素内部命中', selectionHitAt(20, 20, sel, list) === 'A');
  ok('8px 容差(盒外 8 内)命中', selectionHitAt(38, 20, sel, list) === 'A');
  ok('盒外 9 未命中', selectionHitAt(39, 20, sel, list) === null);
  ok('B 内部命中', selectionHitAt(105, 105, sel, list) === 'B');
  ok('未选中元素即使命中也跳过', selectionHitAt(510, 510, sel, list) === null);
  ok('无包围盒选中元素(pin)跳过', selectionHitAt(200, 200, sel, list) === null);
  ok('空白处未命中', selectionHitAt(300, 300, sel, list) === null);
  ok('空选区未命中', selectionHitAt(20, 20, new Set(), list) === null);
  // 顶层优先：两个选中元素包围盒重叠，取列表靠后者；仅 L1 覆盖处返回 L1
  const l1 = { type:'pen', id:'L1', points:[{x:0,y:0},{x:40,y:40}] };     // bbox(0,0,40,40)
  const l2 = { type:'pen', id:'L2', points:[{x:20,y:20},{x:30,y:30}] };   // bbox(20,20,10,10)
  const sel2 = new Set(['L1','L2']);
  ok('重叠处顶层(靠后)优先', selectionHitAt(25, 25, sel2, [l1, l2]) === 'L2' && selectionHitAt(5, 5, sel2, [l1, l2]) === 'L1');
  ok('id 为 null/undefined 的元素跳过', selectionHitAt(20, 20, new Set([null, undefined]), [{type:'pen', points:[{x:0,y:0},{x:9,y:9}]}]) === null);
}

// ---- ③ nudgeSel ----
try {
  const bake = new Function('strokes','selectedIds','send','redraw',
    extractFn('translateLocal') + '\n' + extractFn('nudgeSel') + '\nreturn nudgeSel;');
  const sent = []; let redraws = 0;
  const strokes = [
    { type:'pen', id:'A', points:[{x:1,y:2},{x:3,y:4}] },
    { type:'text', id:'T', x:5, y:6, text:'hi', width:10 },
    { type:'pen', id:'Z', points:[{x:0,y:0},{x:9,y:9}] },
  ];
  nudgeSel = bake(strokes, new Set(['A','T']), (msg)=>sent.push(msg), ()=>redraws++);
  nudgeSel(3, -4);
  ok('nudgeSel 平移选中的 pen points', strokes[0].points[0].x===4 && strokes[0].points[0].y===-2 && strokes[0].points[1].x===6 && strokes[0].points[1].y===0);
  ok('nudgeSel 平移选中的 text x/y', strokes[1].x===8 && strokes[1].y===2);
  ok('未选中元素不动', strokes[2].points[0].x===0 && strokes[2].points[0].y===0);
  ok('一次性 move 广播(带 ids)', sent.length===1 && sent[0].type==='move' && Array.isArray(sent[0].ids) && sent[0].ids.length===2 && sent[0].ids.includes('A') && sent[0].ids.includes('T') && sent[0].dx===3 && sent[0].dy===-4);
  ok('nudgeSel 触发重绘', redraws===1);
  const sent2 = [];
  const nudgeEmpty = bake(strokes, new Set(), (msg)=>sent2.push(msg), ()=>{});
  nudgeEmpty(5, 5);
  ok('空选区不广播', sent2.length===0);
} catch(e){ ok('nudgeSel 抽取与断言', false); console.log('  ', e.message); }

// ---- ④ onKeydown 方向键分支 ----
try {
  const undoCalls=[], redoCalls=[], clearCalls=[], delCalls=[], nudgeCalls=[];
  const bake = new Function('undo','redo','clearSelect','deleteSel','nudgeSel','selectedIds',
    extractFn('onKeydown') + '\nreturn onKeydown;');
  const onKeydown = bake(
    ()=>undoCalls.push(1), ()=>redoCalls.push(1), ()=>clearCalls.push(1), ()=>delCalls.push(1),
    (dx,dy)=>nudgeCalls.push([dx,dy]), new Set(['a']));
  const ev = (k, opt={})=>{ const e = { key:k, ctrlKey:!!opt.ctrl, shiftKey:!!opt.shift, target:{tagName:opt.tag||'DIV'}, pd:false, preventDefault(){ e.pd=true; } }; return e; };

  const e1 = ev('ArrowLeft');  onKeydown(e1); ok('← 微移(-1,0)+阻止默认', nudgeCalls.length===1 && nudgeCalls[0][0]===-1 && nudgeCalls[0][1]===0 && e1.pd);
  const e2 = ev('ArrowRight'); onKeydown(e2); ok('→ 微移(1,0)', nudgeCalls[1][0]===1 && nudgeCalls[1][1]===0 && e2.pd);
  const e3 = ev('ArrowUp');    onKeydown(e3); ok('↑ 微移(0,-1)', nudgeCalls[2][0]===0 && nudgeCalls[2][1]===-1 && e3.pd);
  const e4 = ev('ArrowDown');  onKeydown(e4); ok('↓ 微移(0,1)', nudgeCalls[3][0]===0 && nudgeCalls[3][1]===1 && e4.pd);
  const e5 = ev('ArrowRight',{shift:true}); onKeydown(e5); ok('Shift+→ 粗调(10,0)', nudgeCalls[4][0]===10 && nudgeCalls[4][1]===0);
  const e6 = ev('ArrowUp',{shift:true});    onKeydown(e6); ok('Shift+↑ 粗调(0,-10)', nudgeCalls[5][0]===0 && nudgeCalls[5][1]===-10);
  onKeydown(ev('ArrowLeft',{tag:'INPUT'}));    ok('昵称输入框内方向键不微移', nudgeCalls.length===6);
  onKeydown(ev('ArrowRight',{tag:'TEXTAREA'}));ok('聊天输入框内方向键不微移', nudgeCalls.length===6);
  const bake2 = new Function('undo','redo','clearSelect','deleteSel','nudgeSel','selectedIds',
    extractFn('onKeydown') + '\nreturn onKeydown;');
  const nudgeCalls2 = [];
  const onKeydownEmpty = bake2(()=>{},()=>{},()=>{}, ()=>delCalls.push(1), (dx,dy)=>nudgeCalls2.push([dx,dy]), new Set());
  onKeydownEmpty(ev('ArrowDown'));  ok('空选区方向键不微移', nudgeCalls2.length===0);
  onKeydownEmpty(ev('z'));          ok('空选区其他键不误触(回归)', undoCalls.length===0 && redoCalls.length===0);
  // Del/Backspace 回归（与 _marquee_test 交叉覆盖，防方向键分支破坏既有快捷键）
  const e7 = ev('Delete');          onKeydown(e7); ok('Del 删除选中(回归)', delCalls.length===1 && e7.pd);
  onKeydown(ev('Backspace',{tag:'INPUT'})); ok('输入框内 Backspace 不删(回归)', delCalls.length===1);
  const e8 = ev('z',{ctrl:true});   onKeydown(e8); ok('Ctrl+Z 撤销(回归)', undoCalls.length===1 && e8.pd);
} catch(e){ ok('onKeydown 方向键分支断言', false); console.log('  ', e.message); }

console.log(`[CollabBoard selection-drag] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
