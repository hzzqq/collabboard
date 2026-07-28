// _ci424_link_move_test.js — 验证 ci424：link_element 超链接 handler + move 深拷贝修复(撤销栈不被污染)
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, hasFrame, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8148;
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

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const [c1, c2] = await connectAll('ci424_' + Date.now().toString(36), ['c1', 'c2']);

    // 建两个元素：e1(供链接) 与 e2(供移动/撤销)
    wsSend(c1, { type: 'stroke', stroke: { type: 'stroke', id: 'e1', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], color: '#fff' } });
    wsSend(c1, { type: 'stroke', stroke: { type: 'stroke', id: 'e2', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], color: '#0f0' } });
    await wait(250);

    // ---------- R1：link_element ----------
    // 1) 合法 url -> 广播 element_link 且快照含 links[e1]
    wsSend(c1, { type: 'link_element', id: 'e1', url: 'https://example.com/board' });
    await wait(200);
    ok('ci424 广播 element_link(c1->e1)', hasFrame(c2, 'element_link', m => m.id === 'e1' && m.url === 'https://example.com/board'));
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    let snap = latestSnapshot(c1);
    ok('ci424 快照 links[e1] 已写入', snap && snap.links && snap.links.e1 === 'https://example.com/board');

    // 2) 空 url -> 清除链接
    wsSend(c1, { type: 'link_element', id: 'e1', url: '' });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    snap = latestSnapshot(c1);
    ok('ci424 空 url 清除 links[e1]', snap && snap.links && snap.links.e1 === undefined);

    // 3) 非法协议 -> 拒绝且不写入
    wsSend(c1, { type: 'link_element', id: 'e1', url: 'javascript:alert(1)' });
    await wait(200);
    ok('ci424 非法 url 被拒', hasFrame(c1, 'error', m => m.code === 'bad_url'));
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    snap = latestSnapshot(c1);
    ok('ci424 非法 url 未写入 links', snap && snap.links && snap.links.e1 === undefined);

    // 4) 不存在元素 -> 拒绝
    wsSend(c1, { type: 'link_element', id: 'nope', url: 'https://x.com' });
    await wait(200);
    ok('ci424 不存在元素被拒', hasFrame(c1, 'error', m => m.code === 'no_such_element'));

    // ---------- R2：move 深拷贝 -> 撤销恢复原位 ----------
    // 移动 e2 (+5,+5)
    wsSend(c1, { type: 'move', id: 'e2', dx: 5, dy: 5 });
    await wait(200);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    let s2 = latestSnapshot(c1);
    let e2 = s2 && s2.strokes.find(x => x.id === 'e2');
    ok('ci424 move 后 e2 点平移到 (15,15)', e2 && e2.points[0].x === 15 && e2.points[0].y === 15);

    // 撤销 -> 应恢复到 (10,10)
    wsSend(c1, { type: 'undo' });
    await wait(250);
    wsSend(c1, { type: 'request_snapshot' });
    await wait(200);
    let s3 = latestSnapshot(c1);
    let e2b = s3 && s3.strokes.find(x => x.id === 'e2');
    ok('ci424 撤销后 e2 恢复到 (10,10) [修复 move 原地污染撤销栈]', e2b && e2b.points[0].x === 10 && e2b.points[0].y === 10);

    c1.destroy(); c2.destroy();
    console.log(`\nci424 link_element + move-fix: pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ci424 test error:', e);
    process.exit(1);
  }
})();
