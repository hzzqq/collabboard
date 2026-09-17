// CollabBoard ci467：屏幕坐标 → 画布逻辑坐标（pos）在「界面缩放」下的正确性回归。
//
// 背景：settings.js 的「界面缩放」用 document.body.style.zoom 实现。CSS zoom 会放大
// getBoundingClientRect() 的返回值，但不改变 stage.clientWidth（画布逻辑尺寸由它决定）。
// 旧实现 pos() 直接用 clientX - rect.left，缩放 150% 时落笔位置是光标位置的 1.5 倍，
// 且右/下半边的点会算到画布外被丢弃。已在真实 Chrome 中复现并修复。
//
// 本测试从 index.html 抽出真实的 pos() 源码执行，不做任何复制粘贴，防止实现漂移。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ok ', n)) : (fail++, console.log('  FAIL', n));
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// 抽取全部内联 <script> 段（index.html 顶部还有一段错误条 bootstrap，只取第一段会抽错）
function allInline(h) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  const out = [];
  let m;
  while ((m = re.exec(h))) out.push(m[1]);
  return out;
}
const blocks = allInline(html);
ok('index.html 含多段内联脚本（顶部 bootstrap + 主逻辑）', blocks.length >= 2);

const inline = blocks.join('\n;\n');
const src = inline.match(/function pos\(e\)\{[\s\S]*?\n\}/);
ok('抽到 pos() 定义', !!src);
if (!src) { console.log('\n[CollabBoard ci467 zoom-pos] pass=' + pass + ' fail=' + fail); process.exit(1); }

ok('pos() 已按 rect→逻辑 比例换算（不再裸用 clientX-left）', /r\.width/.test(src[0]) && /cv\.width/.test(src[0]));

// 在受控环境里执行真实的 pos()：伪造 cv 与 dpr
function makePos(logicalW, logicalH, dprVal, zoom, rectLeft, rectTop) {
  const cv = {
    width: logicalW * dprVal,
    height: logicalH * dprVal,
    getBoundingClientRect() {
      return { left: rectLeft, top: rectTop, width: logicalW * zoom, height: logicalH * zoom };
    }
  };
  const dpr = dprVal;
  // eslint-disable-next-line no-new-func
  return new Function('cv', 'dpr', src[0] + '; return pos;')(cv, dpr);
}

// 1) 缩放 100%：必须与旧行为逐值一致（零回归）
{
  const pos = makePos(800, 600, 1, 1, 40, 10);
  const p = pos({ clientX: 340, clientY: 210, pressure: 0.7 });
  ok('zoom=100% 恒等：x 与 clientX-left 一致', near(p.x, 300));
  ok('zoom=100% 恒等：y 与 clientY-top 一致', near(p.y, 200));
  ok('zoom=100% 压力值透传', near(p.p, 0.7));
}

// 2) 缩放 150%：光标落在画布视觉中心 → 应得到逻辑中心
{
  const pos = makePos(800, 600, 1, 1.5, 0, 0);
  const p = pos({ clientX: 800 * 1.5 / 2, clientY: 600 * 1.5 / 2 });
  ok('zoom=150% 画布中心 → 逻辑中心 x=400', near(p.x, 400));
  ok('zoom=150% 画布中心 → 逻辑中心 y=300', near(p.y, 300));
}

// 3) 缩放 150% + 画布有偏移：右下角必须正好落在逻辑右下角，不会溢出被丢弃
{
  const pos = makePos(800, 600, 1, 1.5, 240, 60);
  const p = pos({ clientX: 240 + 800 * 1.5, clientY: 60 + 600 * 1.5 });
  ok('zoom=150% 右下角 → 逻辑 (800,600) 不溢出', near(p.x, 800) && near(p.y, 600));
  const q = pos({ clientX: 240, clientY: 60 });
  ok('zoom=150% 左上角 → 逻辑 (0,0)', near(q.x, 0) && near(q.y, 0));
}

// 4) 缩小 80%
{
  const pos = makePos(800, 600, 1, 0.8, 0, 0);
  const p = pos({ clientX: 800 * 0.8, clientY: 600 * 0.8 });
  ok('zoom=80% 右下角 → 逻辑 (800,600)', near(p.x, 800) && near(p.y, 600));
}

// 5) 高 DPI 屏（dpr=2）下逻辑尺寸取 cv.width/dpr，不能被 backing store 尺寸带偏
{
  const pos = makePos(800, 600, 2, 1, 0, 0);
  const p = pos({ clientX: 400, clientY: 300 });
  ok('dpr=2 zoom=100% 中心 → 逻辑 (400,300) 而非 backing (800,600)', near(p.x, 400) && near(p.y, 300));
  const pz = makePos(800, 600, 2, 1.5, 0, 0)({ clientX: 800 * 1.5 / 2, clientY: 600 * 1.5 / 2 });
  ok('dpr=2 zoom=150% 中心 → 逻辑 (400,300)', near(pz.x, 400) && near(pz.y, 300));
}

// 6) 退化情形：画布尚未布局（rect 宽高为 0）时不得产生 NaN/Infinity
{
  const cv = { width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
  const pos = new Function('cv', 'dpr', src[0] + '; return pos;')(cv, 1);
  const p = pos({ clientX: 100, clientY: 50 });
  ok('rect 宽高为 0 时不产生 NaN/Infinity', Number.isFinite(p.x) && Number.isFinite(p.y));
  ok('rect 宽高为 0 时退化为 1:1', near(p.x, 100) && near(p.y, 50));
}

// 7) 无 pressure 的鼠标事件回退到 0.5
{
  const pos = makePos(800, 600, 1, 1, 0, 0);
  ok('无 pressure 时回退 0.5', near(pos({ clientX: 1, clientY: 1 }).p, 0.5));
}

console.log('\n[CollabBoard ci467 zoom-pos] pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
