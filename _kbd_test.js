// CollabBoard 键盘快捷键接线测试：Ctrl+A 全选 / Ctrl+D 克隆 + 既有快捷键回归。
// ① 静态接线守卫（onKeydown 两个新分支 + 输入框守卫 + help.js 文案同步）
// ② onKeydown 行为（抽取真实函数，mock 依赖，注入 selectedIds）：
//    Ctrl+A/Ctrl+D 命中与大小写等价、INPUT/TEXTAREA 不劫持、Ctrl+D 空选 no-op 仍拦截、
//    Ctrl+Z/Y/Shift+Z、Esc、Del/Backspace、方向键（含 Shift 10px 与输入框守卫）回归
// ③ 真 selectAll 语义（收集全部 id，跳过 null / 无 id 元素）
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const NODE = process.execPath;
const dir = __dirname;
let pass = 0, fail = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const helpSrc = fs.readFileSync(path.join(dir, 'help.js'), 'utf8');

// 0) 内联脚本语法检查（房屋惯例）
const m = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].sort((a, b) => b[1].length - a[1].length)[0];
ok('index.html 含内联脚本', !!m);
if(m){
  const tmp = path.join(dir, '.wb_kbd_inline.js');
  fs.writeFileSync(tmp, m[1]);
  try { execSync(`"${NODE}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); console.log(e.stdout?.toString(), e.stderr?.toString()); }
  fs.unlinkSync(tmp);
}

// brace 计数抽取（CRLF 免疫）
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
ok('onKeydown 已接 Ctrl+A 全选分支', html.includes("e.ctrlKey && (e.key==='a'||e.key==='A')"));
ok('onKeydown 已接 Ctrl+D 克隆分支', html.includes("e.ctrlKey && (e.key==='d'||e.key==='D')"));
ok('Ctrl+A 分支走 selectAll', /e\.key==='a'\|\|e\.key==='A'\)\)\{[\s\S]{0,160}selectAll\(\)/.test(html));
ok('Ctrl+D 分支走 duplicateSel', /e\.key==='d'\|\|e\.key==='D'\)\)\{[\s\S]{0,160}duplicateSel\(\)/.test(html));
ok('两个新分支均有输入框守卫',
  (html.match(/if\(tg !== 'INPUT' && tg !== 'TEXTAREA'\)\{ e\.preventDefault\(\); (selectAll|duplicateSel)\(\); \}/g) || []).length === 2);
ok('help.js 文案含 Ctrl+A', helpSrc.includes('Ctrl+A'));
ok('help.js 文案含 Ctrl+D', helpSrc.includes('Ctrl+D'));
ok('help.js 文案含 Del / Backspace', helpSrc.includes('Del / Backspace'));

// ---- ② onKeydown 行为 ----
let onKeydown = null;
try {
  onKeydown = new Function('undo','redo','clearSelect','deleteSel','nudgeSel','selectAll','duplicateSel','selectedIdsRef',
    'let selectedIds = selectedIdsRef;\n' + extractFn(html, 'onKeydown') + '\nreturn onKeydown;');
  ok('onKeydown 抽取烘焙成功', typeof onKeydown === 'function');
} catch(e){ ok('onKeydown 抽取烘焙成功', false); console.log('  ', e.message); }

if(onKeydown){
  // 模拟按键：mods 合并进事件对象，selected 作为 selectedIds 注入；返回 mock 调用计数
  function press(mods, selected){
    const calls = { undo:0, redo:0, clearSelect:0, deleteSel:0, nudge:[], selectAll:0, duplicateSel:0, pd:0 };
    const deps = {
      undo(){ calls.undo++; },
      redo(){ calls.redo++; },
      clearSelect(){ calls.clearSelect++; },
      deleteSel(){ calls.deleteSel++; },
      nudgeSel(dx, dy){ calls.nudge.push([dx, dy]); },
      selectAll(){ calls.selectAll++; },
      duplicateSel(){ calls.duplicateSel++; }
    };
    const e = Object.assign({
      ctrlKey:false, shiftKey:false, key:'', target:{ tagName:'CANVAS' },
      preventDefault(){ calls.pd++; }
    }, mods);
    onKeydown(deps.undo, deps.redo, deps.clearSelect, deps.deleteSel, deps.nudgeSel,
      deps.selectAll, deps.duplicateSel, selected || new Set())(e);
    return calls;
  }
  const IN = { tagName:'INPUT' }, TA = { tagName:'TEXTAREA' };

  // Ctrl+A 全选
  let c = press({ ctrlKey:true, key:'a' }, new Set());
  ok('Ctrl+A 触发全选', c.selectAll === 1);
  ok('Ctrl+A 拦截浏览器默认全选', c.pd === 1);
  c = press({ ctrlKey:true, key:'A' }, new Set());
  ok('Ctrl+Shift 无关·大写 A 等价命中', c.selectAll === 1 && c.pd === 1);
  c = press({ ctrlKey:true, key:'a', target:IN });
  ok('Ctrl+A 输入框内不劫持（保留全选文本）', c.selectAll === 0 && c.pd === 0);
  c = press({ ctrlKey:true, key:'a', target:TA });
  ok('Ctrl+A TEXTAREA 内不劫持', c.selectAll === 0 && c.pd === 0);
  c = press({ ctrlKey:true, key:'a', target:null });
  ok('Ctrl+A target 缺失仍生效', c.selectAll === 1);

  // Ctrl+D 克隆
  c = press({ ctrlKey:true, key:'d' }, new Set([1, 2]));
  ok('Ctrl+D 有选中触发克隆', c.duplicateSel === 1 && c.pd === 1);
  c = press({ ctrlKey:true, key:'D' }, new Set([1]));
  ok('大写 D 等价命中', c.duplicateSel === 1 && c.pd === 1);
  c = press({ ctrlKey:true, key:'d' }, new Set());
  ok('Ctrl+D 空选仍拦截（不弹浏览器书签，no-op 由 duplicateSel 空选守卫兜底）', c.duplicateSel === 1 && c.pd === 1);
  c = press({ ctrlKey:true, key:'d', target:IN }, new Set([1]));
  ok('Ctrl+D 输入框内不触发', c.duplicateSel === 0 && c.pd === 0);

  // 无 ctrl 的普通按键不误触
  c = press({ key:'a' });
  ok('普通 a 键不触发全选', c.selectAll === 0);
  c = press({ key:'d' }, new Set([1]));
  ok('普通 d 键不触发克隆', c.duplicateSel === 0);

  // 既有快捷键回归
  c = press({ ctrlKey:true, key:'z' });
  ok('Ctrl+Z 仍走 undo', c.undo === 1 && c.redo === 0);
  c = press({ ctrlKey:true, key:'y' });
  ok('Ctrl+Y 仍走 redo', c.redo === 1 && c.undo === 0);
  c = press({ ctrlKey:true, shiftKey:true, key:'z' });
  ok('Ctrl+Shift+Z 仍走 redo', c.redo === 1 && c.undo === 0);
  c = press({ key:'Escape' });
  ok('Esc 仍清空选区', c.clearSelect === 1);
  c = press({ key:'Delete' }, new Set([1]));
  ok('Del 有选中仍删除', c.deleteSel === 1 && c.pd === 1);
  c = press({ key:'Backspace' }, new Set([1]));
  ok('Backspace 等价删除', c.deleteSel === 1);
  c = press({ key:'Delete' });
  ok('Del 空选不删', c.deleteSel === 0);
  c = press({ key:'Delete', target:IN }, new Set([1]));
  ok('Del 输入框内不删画板元素', c.deleteSel === 0 && c.pd === 0);
  c = press({ key:'ArrowLeft' }, new Set([1]));
  ok('ArrowLeft 仍微移 (-1,0)', c.nudge.length === 1 && c.nudge[0][0] === -1 && c.nudge[0][1] === 0);
  c = press({ key:'ArrowRight', shiftKey:true }, new Set([1]));
  ok('Shift+ArrowRight 粗调 (10,0)', c.nudge.length === 1 && c.nudge[0][0] === 10 && c.nudge[0][1] === 0);
  c = press({ key:'ArrowUp', target:TA }, new Set([1]));
  ok('方向键 TEXTAREA 内不微移', c.nudge.length === 0);
}

// ---- ③ 真 selectAll / 真 duplicateSel 语义 ----
try {
  const box = new Function('strokes','redraw','updateLockUI',
    'let selectedIds;\n' + extractFn(html, 'selectAll') +
    '\nreturn { run(){ selectAll(); return selectedIds; } };')(
    [null, { id:5 }, { id:7 }, { x:1 }], ()=>{}, ()=>{});
  const got = box.run();
  ok('真 selectAll 收集全部 id', got instanceof Set && got.size === 2 && got.has(5) && got.has(7));
  ok('真 selectAll 跳过 null / 无 id 元素', !got.has(null) && !got.has(undefined));
  const box2 = new Function('strokes','redraw','updateLockUI',
    'let selectedIds;\n' + extractFn(html, 'selectAll') +
    '\nreturn { run(){ selectAll(); return selectedIds; } };')([], ()=>{}, ()=>{});
  ok('真 selectAll 空画布得空集', box2.run().size === 0);

  // 真 duplicateSel：空选不发消息，有选发 {type:'duplicate', ids}（形参须用源码同名 send）
  const dupBox = new Function('send',
    'let selectedIds;\n' + extractFn(html, 'duplicateSel') +
    '\nreturn { set(s){ selectedIds = s; }, run(){ duplicateSel(); } };')(
    o=>{ dupBox.sent = o; });
  dupBox.sent = null;
  dupBox.set(new Set());
  dupBox.run();
  ok('真 duplicateSel 空选不发消息', dupBox.sent === null);
  dupBox.set(new Set([3, 9]));
  dupBox.run();
  ok('真 duplicateSel 有选发 ids 数组', dupBox.sent && dupBox.sent.type === 'duplicate' &&
    dupBox.sent.ids.length === 2 && dupBox.sent.ids.includes(3) && dupBox.sent.ids.includes(9));
} catch(e){ ok('真 selectAll/duplicateSel 语义', false); console.log('  ', e.message); }

console.log(`[CollabBoard kbd] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
