// _ci451_paste_style_test.js — ci451：paste_style 视觉样式复制 + duplicate 补齐 host-only/view 权限守卫(隐性修复)
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8151;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL', n); } };
const latestSnapshot = (s) => { const a = parseFrames(s.buf).filter(m => m && m.type === 'snapshot'); return a.length ? a[a.length - 1] : null; };
const elById = (s, id) => { const sn = latestSnapshot(s); return sn ? sn.strokes.find(x => x.id === id) : null; };
const colorOf = (s, id) => { const e = elById(s, id); return e ? e.color : undefined; };
const snap = (s) => { wsSend(s, { type: 'request_snapshot' }); };

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const room = 'ci451_' + Date.now().toString(36);
    const c1 = await wsConnect(room, PORT, 'c1'); // 房主
    await wait(250);

    wsSend(c1, { type: 'stroke', stroke: { id: 's1', color: '#ff0000', strokeWidth: 5, points: [[0, 0], [10, 10]] } });
    wsSend(c1, { type: 'stroke', stroke: { id: 's2', color: '#00ff00', strokeWidth: 2, points: [[0, 0], [20, 20]] } });
    await wait(200); snap(c1); await wait(200);
    ok('ci451 初始 s1 红', colorOf(c1, 's1') === '#ff0000');
    ok('ci451 初始 s2 绿', colorOf(c1, 's2') === '#00ff00');

    // ---- R1：单目标 paste_style ----
    wsSend(c1, { type: 'paste_style', from: 's1', ids: ['s2'] });
    await wait(200); snap(c1); await wait(200);
    ok('ci451 复制后 s2 变红', colorOf(c1, 's2') === '#ff0000');
    ok('ci451 复制后 s2 笔宽=5', elById(c1, 's2').strokeWidth === 5);
    ok('ci451 复制后 s2 几何(points)不变', JSON.stringify(elById(c1, 's2').points) === JSON.stringify([[0, 0], [20, 20]]));
    ok('ci451 复制后 s1 不变', colorOf(c1, 's1') === '#ff0000');

    // undo 恢复（深拷贝进撤销栈）
    wsSend(c1, { type: 'undo' });
    await wait(200); snap(c1); await wait(200);
    ok('ci451 undo 后 s2 恢复绿', colorOf(c1, 's2') === '#00ff00');

    // ---- R1：批量复制 + 源缺失兜底 ----
    wsSend(c1, { type: 'stroke', stroke: { id: 's3', color: '#0000ff', strokeWidth: 1, points: [[5, 5], [15, 15]] } });
    await wait(150); snap(c1); await wait(150);
    wsSend(c1, { type: 'paste_style', from: 's1', ids: ['s2', 's3'] });
    await wait(150); snap(c1); await wait(150);
    ok('ci451 批量复制 s3 变红', colorOf(c1, 's3') === '#ff0000');
    ok('ci451 批量复制 s3 笔宽=5', elById(c1, 's3').strokeWidth === 5);

    const beforeBad = latestSnapshot(c1).strokes.length;
    wsSend(c1, { type: 'paste_style', from: 'nope', ids: ['s2'] });
    await wait(150); snap(c1); await wait(150);
    ok('ci451 源不存在不崩溃且数量不变', latestSnapshot(c1).strokes.length === beforeBad);

    // 回退两次（批量 + 单目标）回到基准态，供权限测试使用
    wsSend(c1, { type: 'undo' });
    await wait(120); snap(c1); await wait(120);
    wsSend(c1, { type: 'undo' });
    await wait(120); snap(c1); await wait(120);
    ok('ci451 回退后 s2 绿', colorOf(c1, 's2') === '#00ff00');

    // ---- R2：host-only 房间非房主被拒 ----
    wsSend(c1, { type: 'set_permissions', mode: 'host-only' });
    await wait(150);
    const c2 = await wsConnect(room, PORT, 'c2');
    await wait(250);
    const nBefore = parseFrames(c2.buf).filter(m => m && m.type === 'snapshot').pop().strokes.length;

    wsSend(c2, { type: 'duplicate', ids: ['s1'] });
    await wait(250); snap(c2); await wait(200);
    ok('ci451 host-only 非房主 duplicate 被拒(数量不变)', parseFrames(c2.buf).filter(m => m && m.type === 'snapshot').pop().strokes.length === nBefore);

    wsSend(c2, { type: 'paste_style', from: 's1', ids: ['s2'] });
    await wait(250); snap(c2); await wait(200);
    ok('ci451 host-only 非房主 paste_style 被拒(s2 仍绿)', colorOf(c2, 's2') === '#00ff00');

    wsSend(c1, { type: 'duplicate', ids: ['s1'] });
    await wait(250); snap(c1); await wait(200);
    ok('ci451 房主 duplicate 仍生效(+1)', parseFrames(c1.buf).filter(m => m && m.type === 'snapshot').pop().strokes.length === nBefore + 1);
  } catch (e) { console.log('  ERR', e && e.message); fail++; }
  await wait(200);
  console.log(`\n_ci451_paste_style: ${pass} 通过, ${fail} 失败`);
  try { server.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
