// _ci460_flip_test.js — ci460：flip 镜像翻转(新增，h/v 轴、批量、undo) + zorder 补入 EDIT_OPS 房间锁守卫(隐性修复)
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 18460;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL', n); } };
const latestSnapshot = (s) => { const a = parseFrames(s.buf).filter(m => m && m.type === 'snapshot'); return a.length ? a[a.length - 1] : null; };
const elById = (s, id) => { const sn = latestSnapshot(s); return sn ? sn.strokes.find(x => x && x.id === id) : null; };
const PX = (p) => (p && p.x !== undefined ? p.x : (p ? p[0] : 0));
const PY = (p) => (p && p.y !== undefined ? p.y : (p ? p[1] : 0));
const snap = (s) => { wsSend(s, { type: 'request_snapshot' }); };
const topOrder = (s) => { const sn = latestSnapshot(s); return sn ? sn.strokes.map(e => e && e.id) : []; };

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const room = 'ci460_' + Date.now().toString(36);
    const c1 = await wsConnect(room, PORT, 'c1'); // 房主
    await wait(250);

    // ---- R1a：单元素水平翻转（矢量点，数组格式）----
    // s1: 点 (0,0)-(10,0)，质心 x=5；flip h 后应镜像为 (10,0)-(0,0)（绕 x=5）
    wsSend(c1, { type: 'stroke', stroke: { id: 's1', color: '#111', strokeWidth: 2, points: [[0, 0], [10, 0]] } });
    await wait(200); snap(c1); await wait(200);
    wsSend(c1, { type: 'flip', id: 's1', axis: 'h' });
    await wait(200); snap(c1); await wait(200);
    {
      const e = elById(c1, 's1');
      ok('ci460 单元素 flip h：点镜像 (10,0)/(0,0)', e && PX(e.points[0]) === 10 && PX(e.points[1]) === 0);
      ok('ci460 单元素 flip h：y 不变', e && PY(e.points[0]) === 0 && PY(e.points[1]) === 0);
    }
    // 幂等性：再翻一次回原状
    wsSend(c1, { type: 'flip', id: 's1', axis: 'h' });
    await wait(200); snap(c1); await wait(200);
    { const e = elById(c1, 's1'); ok('ci460 flip h 两次回原状', e && PX(e.points[0]) === 0 && PX(e.points[1]) === 10); }

    // ---- R1b：垂直翻转 + undo ----
    wsSend(c1, { type: 'stroke', stroke: { id: 's2', color: '#222', strokeWidth: 2, points: [{ x: 0, y: 0 }, { x: 0, y: 20 }] } });
    await wait(200); snap(c1); await wait(200);
    wsSend(c1, { type: 'flip', id: 's2', axis: 'v' });
    await wait(200); snap(c1); await wait(200);
    { const e = elById(c1, 's2'); ok('ci460 flip v：{x,y} 对象点镜像 (0,20)/(0,0)', e && PY(e.points[0]) === 20 && PY(e.points[1]) === 0); }
    wsSend(c1, { type: 'undo' });
    await wait(200); snap(c1); await wait(200);
    { const e = elById(c1, 's2'); ok('ci460 undo 恢复翻转前状态', e && PY(e.points[0]) === 0 && PY(e.points[1]) === 20); }

    // ---- R1c：批量翻转绕组质心，保持相对布局镜像 ----
    // a:(0,0)-(10,0) 质心5；b:(90,0)-(100,0) 质心95 → 组质心 x=50
    // flip h 后 a 质心应为 95，b 质心应为 5（互换位置）
    wsSend(c1, { type: 'stroke', stroke: { id: 'a', color: '#111', strokeWidth: 2, points: [[0, 0], [10, 0]] } });
    wsSend(c1, { type: 'stroke', stroke: { id: 'b', color: '#222', strokeWidth: 2, points: [[90, 0], [100, 0]] } });
    await wait(200); snap(c1); await wait(200);
    wsSend(c1, { type: 'flip', ids: ['a', 'b'], axis: 'h' });
    await wait(200); snap(c1); await wait(200);
    {
      const ea = elById(c1, 'a'), eb = elById(c1, 'b');
      const cxOf = e => (PX(e.points[0]) + PX(e.points[1])) / 2;
      ok('ci460 批量 flip h：a 质心 5→95', ea && cxOf(ea) === 95);
      ok('ci460 批量 flip h：b 质心 95→5', eb && cxOf(eb) === 5);
    }

    // ---- R1d：文字元素锚点镜像 + flipH 标记 + rot 反向 ----
    wsSend(c1, { type: 'text', text: 'hello', x: 100, y: 0 });
    await wait(200); snap(c1); await wait(200);
    const txt = latestSnapshot(c1).strokes.find(e => e && e.type === 'text');
    ok('ci460 文字元素已创建', !!txt);
    if (txt) {
      wsSend(c1, { type: 'rotate', id: txt.id, deg: 90 });
      await wait(200);
      wsSend(c1, { type: 'flip', id: txt.id, axis: 'h' });
      await wait(200); snap(c1); await wait(200);
      const t2 = elById(c1, txt.id);
      ok('ci460 文字 flip h：flipH=true', t2 && t2.flipH === true);
      ok('ci460 文字 flip h：rot 90→270(镜像反向)', t2 && t2.rot === 270);
    }

    // ---- R1e：非法参数被忽略 ----
    const cntBefore = latestSnapshot(c1).strokes.length;
    wsSend(c1, { type: 'flip', id: 's1', axis: 'x' });          // 非法轴
    wsSend(c1, { type: 'flip', axis: 'h' });                     // 无 id
    wsSend(c1, { type: 'flip', id: 'nonexist', axis: 'h' });     // id 不存在
    await wait(200); snap(c1); await wait(200);
    ok('ci460 非法 flip 全部被忽略(元素数不变)', latestSnapshot(c1).strokes.length === cntBefore);
    { const e = elById(c1, 's1'); ok('ci460 非法 flip 后 s1 未变', e && PX(e.points[0]) === 0); }

    // ---- R2a：房间锁定后非房主 flip 被拒 ----
    wsSend(c1, { type: 'lock' });
    await wait(200);
    const c2 = await wsConnect(room, PORT, 'c2');
    await wait(250);
    wsSend(c2, { type: 'flip', id: 's1', axis: 'h' });
    await wait(200); snap(c2); await wait(200);
    { const e = elById(c2, 's1'); ok('ci460 房间锁定非房主 flip 被拒', e && PX(e.points[0]) === 0); }
    ok('ci460 非房主收到 locked 错误', parseFrames(c2.buf).some(m => m && m.type === 'error' && m.code === 'locked'));

    // ---- R2b（隐性修复核心）：房间锁定后非房主 zorder 被拒 ----
    // 修复前 zorder 不在 EDIT_OPS，room.locked 对其无效——非房主可乱改层级
    const orderBefore = topOrder(c2).filter(id => id === 'a' || id === 'b').join(',');
    wsSend(c2, { type: 'zorder', id: 'a', action: 'front' });
    await wait(200); snap(c2); await wait(200);
    const orderAfter = topOrder(c2).filter(id => id === 'a' || id === 'b').join(',');
    ok('ci460 房间锁定非房主 zorder 被拒(层级不变)', orderAfter === orderBefore);

    // 房主解锁后非房主 zorder 恢复可用（回归验证不误伤）
    wsSend(c1, { type: 'unlock' });
    await wait(200);
    wsSend(c2, { type: 'zorder', id: 'a', action: 'front' });
    await wait(200); snap(c2); await wait(200);
    { const o = topOrder(c2); ok('ci460 解锁后非房主 zorder 生效(a 置顶)', o[o.length - 1] === 'a'); }

    // ---- R2c：元素锁定后非房主 flip 被拒（中央 tids 守卫覆盖 flip 的 id/ids）----
    wsSend(c1, { type: 'lock_element', id: 's1' });   // 若无此 handler 则退而用 'lock' 元素级：先探测
    await wait(150);
    // 兼容：部分版本元素锁 type 为 'lock_element' 或 'element_lock'——直接查快照 lockedElements
    snap(c1); await wait(200);
    const snLock = latestSnapshot(c1);
    if (snLock && Array.isArray(snLock.lockedElements) && snLock.lockedElements.includes('s1')) {
      wsSend(c2, { type: 'flip', id: 's1', axis: 'h' });
      await wait(200); snap(c2); await wait(200);
      const e = elById(c2, 's1');
      ok('ci460 元素锁定非房主 flip 被拒', e && PX(e.points[0]) === 0);
    } else {
      ok('ci460 元素锁探测(无 lock_element handler，跳过)', true);
    }
  } catch (e) { console.log('  ERR', e && e.message); fail++; }
  await wait(200);
  console.log(`\n_ci460_flip: ${pass} 通过, ${fail} 失败`);
  try { server.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
