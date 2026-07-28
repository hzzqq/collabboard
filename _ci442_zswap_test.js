// _ci442_zswap_test.js — 验证 ci442：zswap 两两交换层级 + move/rotate 补齐 host-only/view 权限守卫(隐性修复)
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
// 返回元素在 strokes 数组里的次序索引（数组末 = 最上层）；用于验证层级交换
const idxOf = (s, id) => { const sn = latestSnapshot(s); return sn ? sn.strokes.findIndex(x => x.id === id) : -1; };

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const [c1, c2] = await connectAll('ci442_' + Date.now().toString(36), ['c1', 'c2']);
    // c1 房主

    // 建两个 note：e1 在前(底层)、e2 在后(上层)
    wsSend(c1, { type: 'note', id: 'e1', x: 10, y: 10, w: 100, h: 50, text: 'A' });
    await wait(120);
    wsSend(c1, { type: 'note', id: 'e2', x: 200, y: 10, w: 100, h: 50, text: 'B' });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci442 初始 e1 在 e2 之下(次序 e1<e2)', idxOf(c1, 'e1') >= 0 && idxOf(c1, 'e1') < idxOf(c1, 'e2'));

    // ---------- R1：zswap 两两交换层级 ----------
    wsSend(c1, { type: 'zswap', idA: 'e1', idB: 'e2' });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci442 zswap 后 e2 在 e1 之下(次序交换)', idxOf(c1, 'e2') < idxOf(c1, 'e1'));
    // 非房主 c2 也实时看到交换(replace 广播)
    wsSend(c2, { type: 'request_snapshot' });
    await wait(200);
    ok('ci442 c2 同步看到 zswap', idxOf(c2, 'e2') < idxOf(c2, 'e1'));

    // 再交换回来，确认可重复
    wsSend(c1, { type: 'zswap', idA: 'e2', idB: 'e1' });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci442 zswap 可逆(恢复 e1<e2)', idxOf(c1, 'e1') < idxOf(c1, 'e2'));

    // ---------- 边界：任一 id 不存在被忽略 ----------
    wsSend(c1, { type: 'zswap', idA: 'e1', idB: 'nope' });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci442 不存在 id 被忽略(次序不变)', idxOf(c1, 'e1') < idxOf(c1, 'e2'));

    // ---------- R2a：view 权限下非房主 zswap 被拒 ----------
    wsSend(c1, { type: 'set_permissions', mode: 'view' });
    await wait(150);
    wsSend(c2, { type: 'zswap', idA: 'e1', idB: 'e2' });
    await wait(200);
    ok('ci442 view 下非房主 zswap 被拒', hasFrame(c2, 'error', m => m.code === 'no_edit_permission'));
    // 房间锁也能拦截 zswap（中央守卫）
    wsSend(c1, { type: 'set_permissions', mode: 'all' });
    await wait(120);
    wsSend(c1, { type: 'lock_board' });
    await wait(120);
    wsSend(c2, { type: 'zswap', idA: 'e1', idB: 'e2' });
    await wait(200);
    ok('ci442 房间锁下非房主 zswap 被拒', hasFrame(c2, 'error', m => m.code === 'locked'));
    wsSend(c1, { type: 'lock_board' });
    await wait(120);

    // ---------- R2b：元素锁拦截 zswap ----------
    wsSend(c1, { type: 'lock_element', id: 'e1' });
    await wait(200);
    wsSend(c2, { type: 'zswap', idA: 'e1', idB: 'e2' });
    await wait(200);
    ok('ci442 元素锁下非房主 zswap 被拒', hasFrame(c2, 'error', m => m.code === 'element_locked'));

    // ---------- R2c：move / rotate 补齐权限守卫(此前漏检) ----------
    wsSend(c1, { type: 'set_permissions', mode: 'view' });
    await wait(150);
    wsSend(c2, { type: 'move', id: 'e1', dx: 5, dy: 0 });
    await wait(200);
    ok('ci442 view 下非房主 move 被拒(ci442 修复前可移动)', hasFrame(c2, 'error', m => m.code === 'no_edit_permission'));
    wsSend(c2, { type: 'rotate', id: 'e1', deg: 90 });
    await wait(200);
    ok('ci442 view 下非房主 rotate 被拒(ci442 修复前可旋转)', hasFrame(c2, 'error', m => m.code === 'no_edit_permission'));
    // 恢复 all 后房主 move 正常
    wsSend(c1, { type: 'set_permissions', mode: 'all' });
    await wait(150);
    const beforeX = (() => { const sn = latestSnapshot(c1); const e = sn.strokes.find(x => x.id === 'e1'); return e ? e.x : null; })();
    wsSend(c1, { type: 'move', id: 'e1', dx: 30, dy: 0 });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    const afterX = (() => { const sn = latestSnapshot(c1); const e = sn.strokes.find(x => x.id === 'e1'); return e ? e.x : null; })();
    ok('ci442 all 下房主 move 生效(dx=30)', afterX === beforeX + 30);

    c1.destroy(); c2.destroy();
    console.log(`\nci442 zswap+perm: pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ci442 test error:', e);
    process.exit(1);
  }
})();
