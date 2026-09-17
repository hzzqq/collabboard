// 画布指针事件绑定回归测试
//
// 背景：b917f96 / 2cc8fc6 两次修「画布点击无响应」，改的都是 index.html 里的事件绑定层，
// 但当时没有任何自动化验证。本测试把 index.html 里 @pointer-binding 标记之间的**真实代码**
// 抽出来，在一个最小假 DOM 上跑，锁住以下行为，防止再次回归：
//   1. 一次 pointerdown 只产生一次 down 回调（不会一次点击画两笔）
//   2. 未按下的悬停 move 仍然转发（他人光标同步 / 激光笔跟手依赖它）
//   3. pointerId === 0（Firefox 鼠标）也能拿到 setPointerCapture（拖出画布不丢事件）
//   4. 非画布区域（状态条 / 重连条 / 工具栏）不触发绘制
//   5. up 之后的 move 不再驱动绘制；多点触控不会两指同时驱动一笔
//   6. 无 PointerEvent 的旧 WebView 走 mouse/touch 回退分支，且同样只触发一次
//
// 运行：node _ci465_pointer_binding_test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const START = '/* @pointer-binding:start';
const END = '/* @pointer-binding:end */';
const s = html.indexOf(START);
const e = html.indexOf(END);
assert.ok(s !== -1 && e !== -1 && e > s, 'index.html 里找不到 @pointer-binding 标记区间');
const bindingCode = html.slice(html.indexOf('*/', s) + 2, e);

// ---- 最小假 DOM ----
function makeEl(id) {
  return {
    id,
    _h: { capture: {}, bubble: {} },
    addEventListener(type, fn, opt) {
      const cap = opt === true || (opt && opt.capture);
      const bag = cap ? this._h.capture : this._h.bubble;
      (bag[type] = bag[type] || []).push(fn);
    },
    fire(type, ev) {
      for (const fn of (this._h.capture[type] || [])) fn(ev);
      for (const fn of (this._h.bubble[type] || [])) fn(ev);
    },
    has(type) {
      return (this._h.capture[type] || []).length + (this._h.bubble[type] || []).length;
    },
  };
}

// 建一套全新的绑定环境；hasPointerEvent=false 用来测旧 WebView 回退分支
function setup(hasPointerEvent) {
  const stage = makeEl('stage');
  const cv = makeEl('cv');
  const win = makeEl('window');
  win.PointerEvent = hasPointerEvent ? function PointerEvent() {} : undefined;
  const calls = { down: [], move: [], up: [], capture: [] };
  cv.setPointerCapture = (id) => calls.capture.push(id);

  const onPointerDown = (ev) => calls.down.push(ev);
  const onPointerMove = (ev) => calls.move.push(ev);
  const onPointerUp = (ev) => calls.up.push(ev);

  // 注意：绑定代码里的 window.addEventListener 要落到假 window 上
  new Function('stage', 'cv', 'window', 'onPointerDown', 'onPointerMove', 'onPointerUp', bindingCode)(
    stage, cv, win, onPointerDown, onPointerMove, onPointerUp
  );
  return { stage, cv, win, calls };
}

const ev = (o) => Object.assign({ button: 0, clientX: 10, clientY: 10 }, o);
const onCv = (o) => ev(Object.assign({ target: { id: 'cv' } }, o));

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

console.log('画布指针事件绑定回归测试');

// --- Pointer Events 环境 ---
t('一次 pointerdown 只触发一次 down（无重复绑定 / 不会画两笔）', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 1 }));
  assert.strictEqual(calls.down.length, 1);
});

t('down/move/up 全链路各触发一次', () => {
  const { stage, win, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 1 }));
  stage.fire('pointermove', onCv({ pointerId: 1, clientX: 20 }));
  win.fire('pointerup', onCv({ pointerId: 1 }));
  assert.deepStrictEqual([calls.down.length, calls.move.length, calls.up.length], [1, 1, 1]);
});

t('未按下的悬停 move 仍然转发（他人光标同步 / 激光笔不失效）', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointermove', onCv({ pointerId: 1 }));
  assert.strictEqual(calls.move.length, 1, '悬停 move 被吞会导致协作光标停止广播');
});

t('画布外的悬停 move 不转发', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointermove', ev({ pointerId: 1, target: { id: 'reconnectBar' } }));
  assert.strictEqual(calls.move.length, 0);
});

t('pointerId === 0（Firefox 鼠标）也会 setPointerCapture', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 0 }));
  assert.deepStrictEqual(calls.capture, [0], 'pid 用真值判断会漏掉 0，导致拖出画布丢事件');
});

t('非画布目标（状态条 / 按钮）不触发绘制', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointerdown', ev({ pointerId: 1, target: { id: 'status' } }));
  stage.fire('pointerdown', ev({ pointerId: 1, target: { id: 'reconnectNow' } }));
  assert.strictEqual(calls.down.length, 0);
});

t('右键 / 中键不触发绘制', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 1, button: 2 }));
  assert.strictEqual(calls.down.length, 0);
});

t('未按下时的 pointerup 不触发 up', () => {
  const { win, calls } = setup(true);
  win.fire('pointerup', onCv({ pointerId: 1 }));
  assert.strictEqual(calls.up.length, 0);
});

t('up 之后的 move 不再驱动绘制路径（避免松手仍在画）', () => {
  const { stage, win, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 1 }));
  win.fire('pointerup', onCv({ pointerId: 1 }));
  stage.fire('pointermove', ev({ pointerId: 1, target: { id: 'status' } }));
  assert.strictEqual(calls.move.length, 0);
});

t('多点触控：非主指针的 move 被忽略（不会两指驱动同一笔）', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 1 }));
  stage.fire('pointermove', onCv({ pointerId: 7, clientX: 99 }));
  assert.strictEqual(calls.move.length, 0);
  stage.fire('pointermove', onCv({ pointerId: 1, clientX: 20 }));
  assert.strictEqual(calls.move.length, 1);
});

t('pointercancel 也能收尾（笔画不会卡住）', () => {
  const { stage, win, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 1 }));
  win.fire('pointercancel', onCv({ pointerId: 1 }));
  assert.strictEqual(calls.up.length, 1);
});

t('丢失 up 后再次按下仍可绘制（画布不会被永久锁死）', () => {
  const { stage, calls } = setup(true);
  stage.fire('pointerdown', onCv({ pointerId: 1 }));   // 这一笔的 up 丢了
  stage.fire('pointerdown', onCv({ pointerId: 2 }));
  stage.fire('pointermove', onCv({ pointerId: 2 }));
  assert.strictEqual(calls.down.length, 2);
  assert.strictEqual(calls.move.length, 1);
});

t('up 事件绑在 window 上（指针滑出画布也能收笔）', () => {
  const { win } = setup(true);
  assert.ok(win.has('pointerup') > 0 && win.has('pointercancel') > 0);
});

// --- 旧 WebView：无 PointerEvent，走 mouse/touch 回退 ---
t('无 PointerEvent 时不绑 pointer 事件，改绑 mouse/touch', () => {
  const { stage, win } = setup(false);
  assert.strictEqual(stage.has('pointerdown'), 0);
  assert.ok(stage.has('mousedown') > 0 && stage.has('touchstart') > 0);
  assert.ok(win.has('mouseup') > 0 && win.has('touchend') > 0);
});

t('回退分支：mousedown/mousemove/mouseup 各触发一次', () => {
  const { stage, win, calls } = setup(false);
  stage.fire('mousedown', onCv({}));
  stage.fire('mousemove', onCv({ clientX: 20 }));
  win.fire('mouseup', onCv({}));
  assert.deepStrictEqual([calls.down.length, calls.move.length, calls.up.length], [1, 1, 1]);
});

t('回退分支：单指 touchstart 只触发一次 down 且带坐标', () => {
  const { stage, calls } = setup(false);
  const target = { id: 'cv' };
  stage.fire('touchstart', {
    target, shiftKey: false, preventDefault() {},
    touches: [{ clientX: 30, clientY: 40, identifier: 3 }],
  });
  assert.strictEqual(calls.down.length, 1);
  assert.strictEqual(calls.down[0].clientX, 30);
  assert.strictEqual(calls.down[0].clientY, 40);
});

t('回退分支：touchend / touchcancel 都能收笔', () => {
  for (const type of ['touchend', 'touchcancel']) {
    const { stage, win, calls } = setup(false);
    const target = { id: 'cv' };
    const touch = { clientX: 30, clientY: 40, identifier: 3 };
    stage.fire('touchstart', { target, preventDefault() {}, touches: [touch] });
    win.fire(type, { target, changedTouches: [touch] });
    assert.strictEqual(calls.up.length, 1, type + ' 未能收笔');
  }
});

t('回退分支：双指 touchstart 不触发绘制', () => {
  const { stage, calls } = setup(false);
  const target = { id: 'cv' };
  stage.fire('touchstart', {
    target, preventDefault() {},
    touches: [{ clientX: 1, clientY: 1, identifier: 1 }, { clientX: 2, clientY: 2, identifier: 2 }],
  });
  assert.strictEqual(calls.down.length, 0);
});

console.log('\n全部通过：' + passed + ' 项');
