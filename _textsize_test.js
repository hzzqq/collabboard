// whiteboard 文字字号完备性单元测试：从 server.js 抽取【真实生产函数】clampTextWidth
// （字号钳制 8..200·取整·NaN→16）烘焙断言边界；另对 SVG 导出 font-size / text op 两处
// 钳制接入 / 客户端滑条字号分支 / 渲染上限钳制做结构守护。
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (n, c)=>{ if(c) pass++; else { fail++; console.log('  FAIL', n); } };

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const ihtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
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
const { clampTextWidth } = new Function(extractFn('clampTextWidth') + '\nreturn { clampTextWidth };')();

// ---- 1) clampTextWidth：钳制边界 ----
ok('正常值原样取整', clampTextWidth(16) === 16 && clampTextWidth(24.7) === 25);
ok('下限 8（负数/0/7 都钳到 8）', clampTextWidth(-5) === 8 && clampTextWidth(0) === 8 && clampTextWidth(7) === 8);
ok('上限 200（10000 巨字/201 钳到 200）', clampTextWidth(10000) === 200 && clampTextWidth(201) === 200);
ok('NaN/Infinity 回退默认 16', clampTextWidth(NaN) === 16 && clampTextWidth(Infinity) === 16);
ok('非数值回退默认 16（字符串/对象/undefined）', clampTextWidth('abc') === 16 && clampTextWidth({}) === 16 && clampTextWidth(undefined) === 16);
ok("数字字符串解析（'80' → 80）", clampTextWidth('80') === 80);
ok('确定性', clampTextWidth(33.3) === clampTextWidth(33.3));

// ---- 2) server.js 结构守护：text op 两处接入 + SVG 导出 ----
ok('server: text op 新建接 clampTextWidth', src.includes('width: clampTextWidth(obj.width), author: sock._cid'));
ok('server: text op 编辑接 clampTextWidth', src.includes('width: obj.width !== undefined ? clampTextWidth(obj.width) : existing.width'));
ok('server: SVG 导出 text 补 font-size + font-family', src.includes('font-family="ui-monospace, monospace" font-size="\'+clampTextWidth(el.width)+\'"'));
ok('server: SVG text 仍走 escapeXml 防注入', /font-size="'\+clampTextWidth\(el\.width\)\+'"?>'\+escapeXml\(el\.text\)/.test(src));

// ---- 3) index.html 结构守护：滑条字号分支 + 渲染钳制 ----
ok('client: 渲染字号钳制 10..200', ihtml.includes('Math.max(10, Math.min(200, s.width))'));
ok('client: 滑条 change 分支（select 工具 + 单选守卫）', /\$\('width'\)\.onchange = e=>\{\s*\n\s*if\(tool !== 'select' \|\| selectedIds\.size !== 1\) return;/.test(ihtml));
ok('client: 分支仅对 text 元素生效', /const el = strokes\.find\(s => s && selectedIds\.has\(s\.id\)\);\s*\n\s*if\(!el \|\| el\.type !== 'text'\) return;/.test(ihtml));
ok('client: 分支钳制 8..200 后走 text 编辑通道', /send\(\{ type:'text', id: el\.id, text: el\.text, x: el\.x, y: el\.y, color: el\.color, width: w \}\);/.test(ihtml));
ok('client: change（非 input）避免拖动狂发 op', ihtml.includes("$('width').onchange = e=>{") && ihtml.split("$('width').oninput").length === 2);

// ---- 4) server.js 语法 ----
try { execSync(`"${process.execPath}" --check "${path.join(__dirname, 'server.js')}"`); ok('server.js 语法 OK', true); }
catch(e){ ok('server.js 语法 OK', false); }

console.log('textsize: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
