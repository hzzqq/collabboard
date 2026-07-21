const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// CollabBoard 导出测试：验证 strokesToSVG 生成合法 SVG，覆盖各元素类型与转义。
const { strokesToSVG } = require('./svg.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('  FAIL', name); } }
function has(s, sub) { return s.indexOf(sub) >= 0; }

// 样例 strokes（与客户端/落盘结构一致）
const pen = { tool: 'pen', color: '#ff0000', width: 4, points: [{ x: 10, y: 10 }, { x: 50, y: 60 }, { x: 90, y: 20 }] };
const line = { tool: 'line', color: '#00aa00', width: 2, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] };
const rect = { tool: 'rect', color: '#0000ff', width: 3, points: [{ x: 5, y: 5 }, { x: 45, y: 35 }] };
const rectF = { tool: 'rect', color: '#0000ff', width: 3, fill: true, points: [{ x: 5, y: 5 }, { x: 45, y: 35 }] };
const ell = { tool: 'ellipse', color: '#8800ff', width: 2, points: [{ x: 0, y: 0 }, { x: 80, y: 40 }] };
const ellF = { tool: 'ellipse', color: '#8800ff', width: 2, fill: true, points: [{ x: 0, y: 0 }, { x: 80, y: 40 }] };
const text = { type: 'text', text: 'Hi<&>', x: 12, y: 30, color: '#222', width: 20 };
const img = { type: 'image', id: 'i1', src: 'data:image/png;base64,AAAA', x: 100, y: 100, w: 50, h: 40 };
const erase = { tool: 'eraser', erase: true, color: '#ff0000', width: 6, points: [{ x: 1, y: 1 }, { x: 9, y: 9 }] };

const W = 1280, H = 720;
const svgAll = strokesToSVG([pen, line, rect, rectF, ell, ellF, text, img, erase], W, H);

// 1. 结构合法
ok('以 <svg 开头', svgAll.trim().startsWith('<svg'));
ok('以 </svg> 结尾', svgAll.trim().endsWith('</svg>'));
ok('含 xmlns', has(svgAll, 'xmlns="http://www.w3.org/2000/svg"'));
ok('viewBox 匹配', has(svgAll, `viewBox="0 0 ${W} ${H}"`));
ok('width/height 属性匹配', has(svgAll, `width="${W}"`) && has(svgAll, `height="${H}"`));
ok('含白色背景 rect', has(svgAll, '<rect x="0" y="0" width="'));

// 2. 各类型映射
ok('pen → polyline 含坐标', has(svgAll, '<polyline points="10,10 50,60 90,20"'));
ok('pen 描边色正确', has(svgAll, 'stroke="#ff0000"'));
ok('line → <line', has(svgAll, '<line x1="0" y1="0" x2="100" y2="100"'));
ok('rect 无填充 → fill="none"', has(svgAll, '<rect x="5" y="5" width="40" height="30" fill="none" stroke="#0000ff"'));
ok('rect 填充 → fill 有值', has(svgAll, '<rect x="5" y="5" width="40" height="30" fill="#0000ff"'));
ok('ellipse 无填充', has(svgAll, '<ellipse cx="40" cy="20" rx="40" ry="20" fill="none" stroke="#8800ff"'));
ok('ellipse 填充', has(svgAll, '<ellipse cx="40" cy="20" rx="40" ry="20" fill="#8800ff"'));
ok('text → <text 且内容转义', has(svgAll, '<text x="12" y="50" fill="#222"') && has(svgAll, '>Hi&lt;&amp;&gt;</text>'));
ok('image → <image href+x/y/w/h', has(svgAll, '<image href="data:image/png;base64,AAAA" x="100" y="100" width="50" height="40"'));
ok('橡皮擦渲染为浅灰 #cccccc', has(svgAll, 'stroke="#cccccc"'));

// 3. 边界：空 strokes
const svgEmpty = strokesToSVG([], W, H);
ok('空 strokes 仍合法', svgEmpty.trim().startsWith('<svg') && svgEmpty.trim().endsWith('</svg>') && !has(svgEmpty, '<polyline'));
ok('空 strokes 仅含背景', (svgEmpty.match(/<rect/g) || []).length === 1);

// 4. 尺寸默认
const svgDef = strokesToSVG([pen]);
ok('未传尺寸用默认 1280x720', has(svgDef, 'viewBox="0 0 1280 720"'));

console.log(`\n[CollabBoard export] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
