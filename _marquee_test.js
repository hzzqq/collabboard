// CollabBoard 框选命中 + 选区快捷键回归：
// ① bboxOf 包围盒语义（text 估宽 / image 尺寸 / points 极值 / 未知类型 null）
// ② marqueePick 命中边界（AABB 含贴边、微矩形防误触、null 包围盒跳过、id 保真）
// ③ onKeydown 快捷键（Ctrl+Z/Y/Shift+Z、Esc、Del/Backspace 删除选中且输入框内不触发）
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
  const tmp = path.join(dir, '.wb_mq_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// brace 计数抽取（CRLF 免疫，同 voxel _brush_test.js 方法）
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

// ---- ① bboxOf + marqueePick 纯逻辑 ----
let bboxOf, marqueePick;
try {
  const bake = new Function(
    extractFn('bboxOf') + '\n' + extractFn('marqueePick') +
    '\nreturn { bboxOf, marqueePick };');
  ({ bboxOf, marqueePick } = bake());
  ok('bboxOf/marqueePick 抽取成功', true);
} catch(e){ ok('bboxOf/marqueePick 抽取成功', false); console.log('  ', e.message); }

if(bboxOf){
  // text：宽 = len*max(10,width)*0.6，高 = max(12,width)*1.2，位置 (x,y)
  const t1 = bboxOf({ type:'text', x:5, y:6, text:'abc', width:10 });
  ok('text 包围盒(正常宽)', t1.x===5 && t1.y===6 && Math.abs(t1.w-18)<1e-9 && Math.abs(t1.h-14.4)<1e-9);
  const t2 = bboxOf({ type:'text', x:0, y:0, text:'a', width:4 });
  ok('text 包围盒(窄字钳制宽>=10 高>=12)', t2.w===6 && Math.abs(t2.h-14.4)<1e-9);
  const t3 = bboxOf({ type:'text', x:1, y:2, text:'', width:20 });
  ok('text 空文本按 1 字估宽', t3.w === 12);
  // image：直接用 s.w/s.h，缺省 0
  const i1 = bboxOf({ type:'image', x:1, y:2, w:30, h:40 });
  ok('image 包围盒', i1.x===1 && i1.y===2 && i1.w===30 && i1.h===40);
  const i2 = bboxOf({ type:'image', x:3, y:4 });
  ok('image 缺尺寸得 0', i2.w===0 && i2.h===0);
  // points：极值包围盒
  const p1 = bboxOf({ type:'pen', points:[{x:3,y:9},{x:1,y:2},{x:7,y:5}] });
  ok('points 包围盒(极值)', p1.x===1 && p1.y===2 && p1.w===6 && p1.h===7);
  const p2 = bboxOf({ type:'pen', points:[] });
  ok('空 points 无包围盒', p2 === null);
  const n1 = bboxOf({ type:'pin', x:0, y:0 });
  ok('pin(无 points) 无包围盒', n1 === null);
}

if(marqueePick && bboxOf){
  const el = { type:'pen', id:'A', points:[{x:10,y:10},{x:30,y:30}] };   // bbox(10,10,20,20)
  const el2 = { type:'pen', id:'B', points:[{x:100,y:100},{x:110,y:110}] }; // bbox(100,100,10,10)
  const pin = { type:'pin', id:'P', x:15, y:15 };                        // 无包围盒
  const list = [el, el2, pin];
  ok('完全覆盖命中', marqueePick(0,0,200,200,list).has('A') && marqueePick(0,0,200,200,list).has('B'));
  ok('部分相交命中', marqueePick(15,15,10,10,list).has('A'));
  ok('贴边相交命中(含边界)', marqueePick(30,10,5,5,list).has('A'));
  ok('整容矩形命中B且不误中A', !marqueePick(100,100,10,10,list).has('A') && marqueePick(100,100,10,10,list).has('B'));
  ok('远离矩形空集', marqueePick(500,500,10,10,list).size === 0);
  ok('微矩形(均<=2)视为点击防误触', marqueePick(15,15,2,2,list).size === 0);
  ok('扁带矩形(宽50高2)是有效框选(闸为或)', marqueePick(15,15,50,2,list).has('A'));
  ok('有效矩形(宽3>2)命中', marqueePick(15,15,3,1,list).has('A'));
  ok('无包围盒元素跳过(pin)', ![...marqueePick(0,0,200,200,list)].includes('P'));
  ok('多元素同时命中', (s=>s.size===2&&s.has('A')&&s.has('B'))(marqueePick(0,0,200,150,list)));
  ok('空列表空集', marqueePick(0,0,100,100,[]).size === 0);
  ok('返回 Set 且 id 保真', marqueePick(0,0,200,200,list) instanceof Set);
}

// ---- ② onKeydown 快捷键 ----
try {
  const undoCalls=[], redoCalls=[], clearCalls=[], delCalls=[];
  const bake = new Function('undo','redo','clearSelect','deleteSel','selectedIds',
    extractFn('onKeydown') + '\nreturn onKeydown;');
  const onKeydown = bake(
    ()=>undoCalls.push(1), ()=>redoCalls.push(1), ()=>clearCalls.push(1), ()=>delCalls.push(1),
    new Set(['a','b']));
  const ev = (k, opt={})=>{ const e = { key:k, ctrlKey:!!opt.ctrl, shiftKey:!!opt.shift, target:{tagName:opt.tag||'DIV'}, pd:false, preventDefault(){ e.pd=true; } }; return e; };

  const e1 = ev('z',{ctrl:true});  onKeydown(e1); ok('Ctrl+Z 撤销+阻止默认', undoCalls.length===1 && e1.pd);
  const e2 = ev('Z',{ctrl:true});  onKeydown(e2); ok('Ctrl+大写 Z 仍撤销', undoCalls.length===2 && e2.pd);
  const e3 = ev('y',{ctrl:true});  onKeydown(e3); ok('Ctrl+Y 重做+阻止默认', redoCalls.length===1 && e3.pd);
  const e4 = ev('z',{ctrl:true,shift:true}); onKeydown(e4); ok('Ctrl+Shift+Z 重做', redoCalls.length===2 && e4.pd);
  const e5 = ev('z');              onKeydown(e5); ok('无 Ctrl 的 z 不触发', undoCalls.length===2 && redoCalls.length===2 && !e5.pd);
  const e6 = ev('Escape');         onKeydown(e6); ok('Esc 清空选区(不阻止默认)', clearCalls.length===1 && !e6.pd);
  const e7 = ev('Delete');         onKeydown(e7); ok('Del 删除选中(非输入框)', delCalls.length===1 && e7.pd);
  const e8 = ev('Backspace',{tag:'CANVAS'}); onKeydown(e8); ok('Backspace 删除选中', delCalls.length===2 && e8.pd);
  onKeydown(ev('Backspace',{tag:'INPUT'}));  ok('聊天输入框内 Backspace 不删元素', delCalls.length===2);
  onKeydown(ev('Delete',{tag:'TEXTAREA'}));  ok('输入框内 Delete 不删元素', delCalls.length===2);
  const bake2 = new Function('undo','redo','clearSelect','deleteSel','selectedIds',
    extractFn('onKeydown') + '\nreturn onKeydown;');
  const onKeydownEmpty = bake2(()=>{},()=>{},()=>{}, ()=>delCalls.push(1), new Set());
  onKeydownEmpty(ev('Delete'));    ok('空选区 Del 不触发删除', delCalls.length===2);
} catch(e){ ok('onKeydown 抽取与断言', false); console.log('  ', e.message); }

console.log(`[CollabBoard marquee] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
