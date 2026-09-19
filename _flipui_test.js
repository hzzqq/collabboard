// whiteboard 翻转入口单元测试：flip 服务端 op（ci460）+ 渲染（十五轮烘焙几何）全就绪，
// 本轮补客户端 UI（水平/垂直翻转按钮）与 H/V 快捷键。从 index.html 内联主脚本抽取
// 【真实生产函数】flipSel / onKeydown 烘焙断言行为（空选 no-op、ids/axis 传递、快捷键守卫），
// 另对按钮/文案/服务端白名单做结构守护。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (n, c)=>{ if(c) pass++; else { fail++; console.log('  FAIL', n); } };

const ihtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const shtml = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const hjs = fs.readFileSync(path.join(__dirname, 'help.js'), 'utf8');

// 主 app 内联脚本 = 含 onKeydown 的那个 <script> 块
const scripts = [...ihtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts.find(s => s.includes('function onKeydown'));
ok('index.html 含主内联脚本', !!app);
if(!app) process.exit(1);
// brace 计数抽取（CRLF 免疫，同 _marquee_test.js 方法）
function extractFn(name){
  const start = app.indexOf('function ' + name + '(');
  if(start < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, i = app.indexOf('{', start);
  for(; i < app.length; i++){
    const c = app[i];
    if(c === '{') depth++;
    else if(c === '}'){ depth--; if(depth === 0) return app.slice(start, i+1); }
  }
  throw new Error('函数 ' + name + ' 括号不匹配');
}
const flipSelRef = new Function('send', 'selectedIds',
  extractFn('flipSel') + '\nreturn flipSel;')(()=>{}, new Set());   // 仅验证抽取/语法可用
const onKeydown = new Function('undo', 'redo', 'selectAll', 'duplicateSel', 'clearSelect', 'deleteSel', 'nudgeSel', 'flipSel', 'selectedIds',
  extractFn('onKeydown') + '\nreturn function(e){ return onKeydown(e); };')(
    ()=>{}, ()=>{}, ()=>{}, ()=>{}, ()=>{}, ()=>{}, ()=>{}, ()=>{}, new Set());

// ---- 1) 结构守护：按钮 / op / 快捷键分支 / 文案 / 服务端白名单 ----
ok('结构: 翻转按钮 flipH/flipV', ihtml.includes('id="flipH"') && ihtml.includes('id="flipV"'));
ok('结构: 面板文案扩为「旋转 / 翻转」', ihtml.includes('旋转 / 翻转（需先选中元素）'));
ok('结构: flipSel 发送 type:flip op', /type:'flip', ids:\[\.\.\.selectedIds\], axis/.test(app));
ok('结构: H/V 分支排除 Ctrl/Cmd 组合', app.includes("!e.ctrlKey && !e.metaKey && (e.key==='h'||e.key==='H'"));
ok('结构: H/V 分支含 INPUT/TEXTAREA 守卫', /!e\.ctrlKey && !e\.metaKey && \(e\.key==='h'[\s\S]{0,260}tagName[\s\S]{0,160}flipSel\(/.test(app));
ok('结构: 按钮绑定 flipSel', app.includes("$('flipH').onclick = ()=> flipSel('h');") && app.includes("$('flipV').onclick = ()=> flipSel('v');"));
ok('结构: help.js 文案同步（翻转 + H/V）', hjs.includes('旋转 / 翻转') && hjs.includes('H / V'));
ok('结构: server.js EDIT_OPS 白名单含 flip', shtml.includes("'flip'"));

// ---- 2) flipSel 行为烘焙（send/selectedIds 经闭包形参注入，调用只传 axis） ----
{
  const calls = [];
  const send = (o)=>calls.push(o);
  const bakedFlip = new Function('send', 'selectedIds',
    extractFn('flipSel') + '\nreturn flipSel;')(send, new Set());
  bakedFlip('h');   // 空选（Set 为空）
  ok('flipSel 空选 no-op', calls.length === 0);
  const bakedIds = new Function('send', 'selectedIds',
    extractFn('flipSel') + '\nreturn flipSel;')(send, new Set(['b', 'a', 'c']));
  bakedIds('h');
  bakedIds('v');
  ok('flipSel ids 展开为数组（3 元素）', calls.length === 2 && Array.isArray(calls[0].ids) && calls[0].ids.length === 3);
  ok('flipSel op type=flip', calls[0].type === 'flip');
  ok('flipSel axis 传递 h/v', calls[0].axis === 'h' && calls[1].axis === 'v');
}

// ---- 3) onKeydown 行为烘焙（依赖经闭包形参注入，选择集可换；参照 _kbd_test mock 模式） ----
{
  const mkCalls = [];
  const bakeKbd = (selSet)=>{
    const deps = {
      undo: ()=>{}, redo: ()=>{}, selectAll: ()=>{}, duplicateSel: ()=>{},
      clearSelect: ()=>{}, deleteSel: ()=>{}, nudgeSel: ()=>{}, flipSel: (axis)=>mkCalls.push(axis)
    };
    const kbd = new Function('undo', 'redo', 'selectAll', 'duplicateSel', 'clearSelect', 'deleteSel', 'nudgeSel', 'flipSel', 'selectedIds',
      extractFn('onKeydown') + '\nreturn function(e){ return onKeydown(e); };')(
        deps.undo, deps.redo, deps.selectAll, deps.duplicateSel, deps.clearSelect, deps.deleteSel, deps.nudgeSel, deps.flipSel, selSet);
    return kbd;
  };
  const pdCount = { n: 0 };
  const mkE = (over)=>Object.assign({
    ctrlKey: false, metaKey: false, shiftKey: false, key: 'h',
    target: { tagName: 'DIV' }, preventDefault: ()=>{ pdCount.n++; }
  }, over || {});
  const run = (kbd, e)=>kbd(mkE(e));
  const kbd = bakeKbd(new Set(['x1']));

  run(kbd, { key: 'h' });
  ok('H 触发水平翻转', mkCalls.length === 1 && mkCalls[0] === 'h');
  run(kbd, { key: 'H', shiftKey: true });
  ok('Shift+H 同样水平翻转', mkCalls.length === 2 && mkCalls[1] === 'h');
  run(kbd, { key: 'v' });
  ok('V 触发垂直翻转', mkCalls.length === 3 && mkCalls[2] === 'v');
  run(kbd, { key: 'V', shiftKey: true });
  ok('Shift+V 同样垂直翻转', mkCalls.length === 4 && mkCalls[3] === 'v');
  ok('翻转触发时 preventDefault 调用', pdCount.n === 4);

  run(kbd, { key: 'h', target: { tagName: 'INPUT' } });
  run(kbd, { key: 'v', target: { tagName: 'TEXTAREA' } });
  ok('输入框内 H/V 不触发（打字优先）', mkCalls.length === 4 && pdCount.n === 4);

  run(kbd, { key: 'h', ctrlKey: true });
  run(kbd, { key: 'v', metaKey: true });
  ok('Ctrl/Cmd+H/V 不触发（防劫持浏览器快捷键）', mkCalls.length === 4 && pdCount.n === 4);

  const kbdEmpty = bakeKbd(new Set());
  run(kbdEmpty, { key: 'h' });
  ok('无选中 H 不触发', mkCalls.length === 4);

  run(kbd, { key: 'g' });
  ok('无关按键不触发翻转', mkCalls.length === 4);
}

// ---- 4) 内联脚本语法 ----
{
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'wb_inline_' + Date.now() + '.js');
  fs.writeFileSync(tmp, app);
  try { execSync(`"${process.execPath}" --check "${tmp}"`); ok('内联脚本语法 OK', true); }
  catch(e){ ok('内联脚本语法 OK', false); }
  fs.unlinkSync(tmp);
}

console.log('flipui: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
