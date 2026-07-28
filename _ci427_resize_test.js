// _ci427_resize_test.js — 验证 ci427：resize 元素缩放 handler
// + R2 隐性修复：view/host-only 权限下非房主不可缩放、元素锁拦截、深拷贝不污染撤销栈
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, hasFrame, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8149;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL', n); } };
const connectAll = (room, cids) => (async () => {
  const socks = [];
  for (const cid of cids) socks.push(await wsConnect(room, PORT, cid));
  await wait(250);
  return socks;
})();
const framesOf = (s, type) => parseFrames(s.buf).filter(m => m && m.type === type);
const latestSnapshot = (s) => { const a = framesOf(s, 'snapshot'); return a.length ? a[a.length - 1] : null; };
const elW = (s, id) => { const sn = latestSnapshot(s); const e = sn && sn.strokes.find(x => x.id === id); return e ? e.w : undefined; };
const elH = (s, id) => { const sn = latestSnapshot(s); const e = sn && sn.strokes.find(x => x.id === id); return e ? e.h : undefined; };

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const [c1, c2] = await connectAll('ci427_' + Date.now().toString(36), ['c1', 'c2']);
    // c1 是房主（首个连接者）

    // 建一个 note 元素 e1（带 w/h），供缩放
    wsSend(c1, { type: 'note', id: 'e1', x: 10, y: 10, w: 100, h: 50, text: 'hi' });
    await wait(250);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 初始 e1=(100,50)', elW(c1, 'e1') === 100 && elH(c1, 'e1') === 50);

    // ---------- R1：resize 改变 w/h ----------
    wsSend(c1, { type: 'resize', id: 'e1', w: 300, h: 120 });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 resize 后 e1=(300,120)', elW(c1, 'e1') === 300 && elH(c1, 'e1') === 120);
    // 非房主 c2 也实时看到缩放（replace 广播）
    wsSend(c2, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 c2 同步看到 e1=(300,120)', elW(c2, 'e1') === 300 && elH(c2, 'e1') === 120);

    // ---------- R2a：撤销恢复缩放前尺寸（深拷贝未污染撤销栈）----------
    wsSend(c1, { type: 'undo' });
    await wait(250);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 撤销后 e1 恢复 (100,50)', elW(c1, 'e1') === 100 && elH(c1, 'e1') === 50);

    // ---------- R2b：view 权限下非房主不可缩放 ----------
    wsSend(c1, { type: 'set_permissions', mode: 'view' });
    await wait(150);
    wsSend(c2, { type: 'resize', id: 'e1', w: 400, h: 200 });
    await wait(200);
    ok('ci427 view 权限下非房主被拒', hasFrame(c2, 'error', m => m.code === 'no_edit_permission'));
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 被拒后 e1 尺寸不变 (100,50)', elW(c1, 'e1') === 100 && elH(c1, 'e1') === 50);
    // 房主自己仍可缩放
    wsSend(c1, { type: 'set_permissions', mode: 'all' });
    await wait(150);
    wsSend(c1, { type: 'resize', id: 'e1', w: 250, h: 80 });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 恢复 all 后房主可缩放 e1=(250,80)', elW(c1, 'e1') === 250 && elH(c1, 'e1') === 80);

    // ---------- R2c：元素锁拦截非房主缩放 ----------
    wsSend(c1, { type: 'lock_element', id: 'e1' });
    await wait(200);
    wsSend(c2, { type: 'resize', id: 'e1', w: 500, h: 300 });
    await wait(200);
    ok('ci427 元素被锁非房主缩放被拒', hasFrame(c2, 'error', m => m.code === 'element_locked'));
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 锁定被拒后 e1 尺寸不变 (250,80)', elW(c1, 'e1') === 250 && elH(c1, 'e1') === 80);

    // ---------- 边界：超大尺寸被钳制到上限(防越界) ----------
    wsSend(c1, { type: 'resize', id: 'e1', w: 999999, h: 80 });
    await wait(150);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci427 超大 w 钳制到 100000 上限', elW(c1, 'e1') === 100000 && elH(c1, 'e1') === 80);

    c1.destroy(); c2.destroy();
    console.log(`\nci427 resize: pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ci427 test error:', e);
    process.exit(1);
  }
})();
