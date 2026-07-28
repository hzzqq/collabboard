// _ci429_visibility_test.js — 验证 ci429：set_element_visibility 元素显隐
// + R2：导出/快照一致(hiddenElements 进快照与导出)；仅房主/作者可切换；整板锁拦截
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
const framesOf = (s, type) => parseFrames(s.buf).filter(m => m && m.type === type);
const latestSnapshot = (s) => { const a = framesOf(s, 'snapshot'); return a.length ? a[a.length - 1] : null; };
const hiddenOf = (s) => { const sn = latestSnapshot(s); return sn && Array.isArray(sn.hiddenElements) ? sn.hiddenElements : []; };

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const [c1, c2] = await connectAll('ci429_' + Date.now().toString(36), ['c1', 'c2']);

    wsSend(c1, { type: 'note', id: 'e1', x: 10, y: 10, w: 100, h: 50, text: 'a' });
    wsSend(c2, { type: 'note', id: 'e2', x: 200, y: 200, w: 80, h: 40, text: 'b' });
    await wait(250);

    // ---------- R1：房主隐藏自己的元素 ----------
    wsSend(c1, { type: 'set_element_visibility', id: 'e1', hidden: true });
    await wait(200);
    ok('ci429 广播 element_visibility(e1,hidden)', hasFrame(c2, 'element_visibility', m => m.id === 'e1' && m.hidden === true));
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci429 快照 hiddenElements 含 e1', hiddenOf(c1).includes('e1'));
    ok('ci429 隐藏后 e1 仍在画板(未删除)', !!latestSnapshot(c1).strokes.find(x => x.id === 'e1'));

    // ---------- R2a：非房主且非作者不可隐藏他人元素 ----------
    wsSend(c2, { type: 'set_element_visibility', id: 'e1', hidden: true });
    await wait(200);
    ok('ci429 他人元素拒绝(not_allowed)', hasFrame(c2, 'error', m => m.code === 'not_allowed'));
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci429 被拒后 hiddenElements 仍仅含 e1', hiddenOf(c1).length === 1 && hiddenOf(c1).includes('e1'));

    // ---------- R2b：元素作者可隐藏自己的元素 ----------
    wsSend(c2, { type: 'set_element_visibility', id: 'e2', hidden: true });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci429 作者隐藏 e2 成功', hiddenOf(c1).includes('e2'));

    // ---------- R1：房主取消隐藏 ----------
    wsSend(c1, { type: 'set_element_visibility', id: 'e1', hidden: false });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci429 取消隐藏 e1 后 hiddenElements 仅含 e2', hiddenOf(c1).length === 1 && hiddenOf(c1).includes('e2') && !hiddenOf(c1).includes('e1'));

    // ---------- R2c：整板锁定后非房主不可切换显隐 ----------
    wsSend(c1, { type: 'lock_board' });
    await wait(150);
    wsSend(c2, { type: 'set_element_visibility', id: 'e2', hidden: false });
    await wait(200);
    ok('ci429 整板锁定非房主被拒(locked)', hasFrame(c2, 'error', m => m.code === 'locked'));
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    ok('ci429 被拒后 e2 仍隐藏', hiddenOf(c1).includes('e2'));
    wsSend(c1, { type: 'lock_board' });   // 解锁恢复
    await wait(150);

    c1.destroy(); c2.destroy();
    console.log(`\nci429 visibility: pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ci429 test error:', e);
    process.exit(1);
  }
})();
