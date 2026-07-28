// _ci455_distribute_test.js — ci455：distribute 均匀分布(新增) + align 补齐 host-only/view 权限守卫(隐性修复)
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8155;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL', n); } };
const latestSnapshot = (s) => { const a = parseFrames(s.buf).filter(m => m && m.type === 'snapshot'); return a.length ? a[a.length - 1] : null; };
const elById = (s, id) => { const sn = latestSnapshot(s); return sn ? sn.strokes.find(x => x.id === id) : null; };
const PX = (p) => (p && p.x !== undefined ? p.x : (p ? p[0] : 0));
const PY = (p) => (p && p.y !== undefined ? p.y : (p ? p[1] : 0));
const cx = (s, id) => { const e = elById(s, id); if (!e) return null; if (Array.isArray(e.points) && e.points.length) { let m = 0; for (const p of e.points) m += PX(p); return m / e.points.length; } return e.x || 0; };
const cy = (s, id) => { const e = elById(s, id); if (!e) return null; if (Array.isArray(e.points) && e.points.length) { let m = 0; for (const p of e.points) m += PY(p); return m / e.points.length; } return e.y || 0; };
const snap = (s) => { wsSend(s, { type: 'request_snapshot' }); };

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const room = 'ci455_' + Date.now().toString(36);
    const c1 = await wsConnect(room, PORT, 'c1'); // 房主
    await wait(250);

    // 三个横向点元素：中心 5 / 55 / 205（不均等）
    wsSend(c1, { type: 'stroke', stroke: { id: 'h1', color: '#111', strokeWidth: 2, points: [[0, 0], [10, 0]] } });
    wsSend(c1, { type: 'stroke', stroke: { id: 'h2', color: '#222', strokeWidth: 2, points: [[50, 0], [60, 0]] } });
    wsSend(c1, { type: 'stroke', stroke: { id: 'h3', color: '#333', strokeWidth: 2, points: [[200, 0], [210, 0]] } });
    await wait(200); snap(c1); await wait(200);
    ok('ci455 初始中心 5/55/205', cx(c1, 'h1') === 5 && cx(c1, 'h2') === 55 && cx(c1, 'h3') === 205);

    // ---- R1：横向均匀分布 ----
    wsSend(c1, { type: 'distribute', ids: ['h1', 'h2', 'h3'], how: 'h' });
    await wait(200); snap(c1); await wait(200);
    ok('ci455 横向均布后中心 5/105/205', cx(c1, 'h1') === 5 && cx(c1, 'h2') === 105 && cx(c1, 'h3') === 205);
    ok('ci455 横向间距相等(100/100)', Math.abs((105 - 5) - (205 - 105)) < 1e-9);

    // undo 恢复
    wsSend(c1, { type: 'undo' });
    await wait(200); snap(c1); await wait(200);
    ok('ci455 undo 后 h2 回 55', cx(c1, 'h2') === 55);

    // ---- R1：纵向均匀分布 ----
    wsSend(c1, { type: 'stroke', stroke: { id: 'v1', color: '#111', strokeWidth: 2, points: [[0, 0], [0, 10]] } });
    wsSend(c1, { type: 'stroke', stroke: { id: 'v2', color: '#222', strokeWidth: 2, points: [[0, 40], [0, 50]] } });
    wsSend(c1, { type: 'stroke', stroke: { id: 'v3', color: '#333', strokeWidth: 2, points: [[0, 200], [0, 210]] } });
    await wait(200); snap(c1); await wait(200);
    ok('ci455 初始纵向中心 5/45/205', cy(c1, 'v1') === 5 && cy(c1, 'v2') === 45 && cy(c1, 'v3') === 205);
    wsSend(c1, { type: 'distribute', ids: ['v1', 'v2', 'v3'], how: 'v' });
    await wait(200); snap(c1); await wait(200);
    ok('ci455 纵向均布后中心 5/105/205', cy(c1, 'v1') === 5 && cy(c1, 'v2') === 105 && cy(c1, 'v3') === 205);

    // ---- R1：元素不足 3 个被忽略 ----
    const beforeCount = latestSnapshot(c1).strokes.length;
    const h2BeforeFew = cx(c1, 'h2');   // 当前应为 55（经前述 undo）
    wsSend(c1, { type: 'distribute', ids: ['h1', 'h2'], how: 'h' });
    await wait(180); snap(c1); await wait(180);
    ok('ci455 仅 2 个元素时分布被忽略(数量不变)', latestSnapshot(c1).strokes.length === beforeCount);
    ok('ci455 仅 2 个元素时 h2 位置不变', cx(c1, 'h2') === h2BeforeFew);

    // 回退纵向分布，回到基准态
    wsSend(c1, { type: 'undo' });
    await wait(150); snap(c1); await wait(150);
    ok('ci455 undo 后 v2 回 45', cy(c1, 'v2') === 45);

    // ---- R2：host-only 房间非房主对齐/分布被拒 ----
    wsSend(c1, { type: 'set_permissions', mode: 'host-only' });
    await wait(150);
    const c2 = await wsConnect(room, PORT, 'c2');
    await wait(250);
    const snapBefore = parseFrames(c2.buf).filter(m => m && m.type === 'snapshot').pop();
    const h2Before = cxSnap(snapBefore, 'h2');

    // 非房主尝试 align（ci455 修复点）
    wsSend(c2, { type: 'align', ids: ['h1', 'h2', 'h3'], how: 'left' });
    await wait(200); snap(c2); await wait(200);
    ok('ci455 host-only 非房主 align 被拒(h2 中心不变)', cx(c2, 'h2') === h2Before);

    // 非房主尝试 distribute（R1 一致性守卫）
    wsSend(c2, { type: 'distribute', ids: ['h1', 'h2', 'h3'], how: 'h' });
    await wait(200); snap(c2); await wait(200);
    ok('ci455 host-only 非房主 distribute 被拒(h2 中心不变)', cx(c2, 'h2') === h2Before);

    // 房主仍可执行 distribute
    wsSend(c1, { type: 'distribute', ids: ['h1', 'h2', 'h3'], how: 'h' });
    await wait(200); snap(c1); await wait(200);
    ok('ci455 房主 distribute 生效(h2=105)', cx(c1, 'h2') === 105);
  } catch (e) { console.log('  ERR', e && e.message); fail++; }
  await wait(200);
  console.log(`\n_ci455_distribute: ${pass} 通过, ${fail} 失败`);
  try { server.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();

function cxSnap(sn, id) { const e = sn.strokes.find(x => x.id === id); if (!e) return null; if (Array.isArray(e.points) && e.points.length) { let m = 0; for (const p of e.points) m += PX(p); return m / e.points.length; } return e.x || 0; }
