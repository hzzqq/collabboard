// _ci447_ztoindex_test.js — ci447：ztoindex 任意层级移动 + zorder 补齐 host-only/view 权限与元素锁守卫(隐性修复)
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, hasFrame, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8150;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL', n); } };
const connectAll = (room, cids) => (async () => {
  const socks = [];
  for (const cid of cids) socks.push(await wsConnect(room, PORT, cid));
  await wait(250);
  return socks;
})();
const latestSnapshot = (s) => { const a = parseFrames(s.buf).filter(m => m && m.type === 'snapshot'); return a.length ? a[a.length - 1] : null; };
const idxOf = (s, id) => { const sn = latestSnapshot(s); return sn ? sn.strokes.findIndex(x => x.id === id) : -1; };
const orderOf = (s) => { const sn = latestSnapshot(s); return sn ? sn.strokes.map(x => x.id) : []; };
const snap = (s) => { wsSend(s, { type: 'request_snapshot' }); };

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const [c1, c2] = await connectAll('ci447_' + Date.now().toString(36), ['c1', 'c2']); // c1 房主
    for (const id of ['e1', 'e2', 'e3']) wsSend(c1, { type: 'note', id, x: 10, y: 10, w: 100, h: 50, text: id });
    await wait(300); snap(c1); await wait(200);
    ok('ci447 初始顺序 e1,e2,e3', JSON.stringify(orderOf(c1)) === JSON.stringify(['e1', 'e2', 'e3']));

    // ---------- R1：ztoindex 任意层级 ----------
    wsSend(c1, { type: 'ztoindex', id: 'e3', index: 0 });           // 移到最底
    await wait(200); snap(c1); await wait(200);
    ok('ci447 ztoindex e3→底(idx0)', idxOf(c1, 'e3') === 0);

    wsSend(c1, { type: 'ztoindex', id: 'e1', index: 99 });          // 越界钳到顶
    await wait(200); snap(c1); await wait(200);
    ok('ci447 ztoindex e1→顶(越界钳制)', idxOf(c1, 'e1') === orderOf(c1).length - 1);

    wsSend(c1, { type: 'ztoindex', id: 'e2', index: 0 });           // e2 移到最底
    await wait(200); snap(c1); await wait(200);
    ok('ci447 ztoindex e2→底', idxOf(c1, 'e2') === 0);

    // 批量：把 e1,e3 一起放到 index 1（保持相对顺序）
    wsSend(c1, { type: 'ztoindex', ids: ['e1', 'e3'], index: 1 });
    await wait(200); snap(c1); await wait(200);
    const ord = orderOf(c1);
    ok('ci447 批量 ztoindex 顺序正确', JSON.stringify(ord) === JSON.stringify(['e2', 'e1', 'e3']));

    // 非房主 c2 实时同步
    snap(c2); await wait(200);
    ok('ci447 c2 同步看到 ztoindex 结果', JSON.stringify(orderOf(c2)) === JSON.stringify(['e2', 'e1', 'e3']));

    // 非法 id 被忽略
    wsSend(c1, { type: 'ztoindex', id: 'nope', index: 0 });
    await wait(200); snap(c1); await wait(200);
    ok('ci447 非法 id 被忽略', JSON.stringify(orderOf(c1)) === JSON.stringify(['e2', 'e1', 'e3']));

    // ---------- R2a：zorder 补齐 view 权限守卫(此前漏检) ----------
    wsSend(c1, { type: 'set_permissions', mode: 'view' });
    await wait(150);
    wsSend(c2, { type: 'zorder', id: 'e1', action: 'front' });
    await wait(200);
    ok('ci447 view 下非房主 zorder 被拒(ci447 修复前可改层级)', hasFrame(c2, 'error', m => m.code === 'no_edit_permission'));
    wsSend(c1, { type: 'set_permissions', mode: 'all' });
    await wait(150);

    // ---------- R2b：zorder 补齐元素锁守卫 ----------
    wsSend(c1, { type: 'lock_element', id: 'e1' });
    await wait(200);
    wsSend(c2, { type: 'zorder', id: 'e1', action: 'front' });
    await wait(200);
    ok('ci447 元素锁下非房主 zorder 被拒', hasFrame(c2, 'error', m => m.code === 'element_locked'));

    // ---------- ztoindex 自身权限/锁守卫 ----------
    wsSend(c1, { type: 'set_permissions', mode: 'view' });
    await wait(150);
    wsSend(c2, { type: 'ztoindex', id: 'e2', index: 2 });
    await wait(200);
    ok('ci447 view 下非房主 ztoindex 被拒', hasFrame(c2, 'error', m => m.code === 'no_edit_permission'));
    wsSend(c1, { type: 'set_permissions', mode: 'all' });
    await wait(150);
    wsSend(c2, { type: 'ztoindex', id: 'e1', index: 2 });   // e1 被锁，非房主应拒
    await wait(200);
    ok('ci447 元素锁下非房主 ztoindex 被拒', hasFrame(c2, 'error', m => m.code === 'element_locked'));
    wsSend(c1, { type: 'ztoindex', id: 'e2', index: 2 });   // 房主可改（e2 未锁）
    await wait(200); snap(c1); await wait(200);
    ok('ci447 房主 ztoindex 生效(未越权元素)', idxOf(c1, 'e2') === orderOf(c1).length - 1);

    c1.destroy(); c2.destroy();
    console.log(`\nci447 ztoindex+perm: pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ci447 test error:', e);
    process.exit(1);
  }
})();
