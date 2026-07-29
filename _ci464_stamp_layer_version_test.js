// _ci464_stamp_layer_version_test.js — ci464 三项隐性修复：
// ① stamp 补入 EDIT_OPS（此前锁定房间非房主可放图章）+ stamp 补 permissions 守卫（host-only/view 可绕过）
// ② clear_layer 补入 EDIT_OPS（此前锁定房间层作者可清空整层）
// ③ load_version 经 commitStrokes 进撤销栈（此前直接赋值，恢复版本后 Ctrl+Z 吞掉恢复的版本）
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 18464;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL', n); } };
const latestSnapshot = (s) => { const a = parseFrames(s.buf).filter(m => m && m.type === 'snapshot'); return a.length ? a[a.length - 1] : null; };
const ids = (s) => { const sn = latestSnapshot(s); return sn ? sn.strokes.filter(Boolean).map(e => e.id) : []; };
const snap = (s) => { wsSend(s, { type: 'request_snapshot' }); };
const lastErr = (s, code) => parseFrames(s.buf).some(m => m && m.type === 'error' && m.code === code);

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    const room = 'ci464_' + Date.now().toString(36);
    const c1 = await wsConnect(room, PORT, 'c1'); // 房主
    await wait(250);
    const c2 = await wsConnect(room, PORT, 'c2'); // 成员
    await wait(250);

    // ---- ① stamp：正常路径可用 ----
    wsSend(c2, { type: 'stamp', id: 'st1', text: '⭐', x: 10, y: 10 });
    await wait(200); snap(c1); await wait(200);
    ok('ci464 正常状态成员可放图章', ids(c1).includes('st1'));

    // 房间锁定后非房主 stamp 被拒（修复 EDIT_OPS 漏列）
    wsSend(c1, { type: 'lock' });
    await wait(200);
    wsSend(c2, { type: 'stamp', id: 'st2', text: '🔥', x: 20, y: 20 });
    await wait(200); snap(c1); await wait(200);
    ok('ci464 锁定房间非房主 stamp 被拒(元素未入库)', !ids(c1).includes('st2'));
    ok('ci464 锁定房间 stamp 收到 locked 错误', lastErr(c2, 'locked'));
    // 房主自身仍可放（锁只限制非房主）
    wsSend(c1, { type: 'stamp', id: 'st3', text: '👑', x: 30, y: 30 });
    await wait(200); snap(c1); await wait(200);
    ok('ci464 锁定房间房主 stamp 仍可用', ids(c1).includes('st3'));
    wsSend(c1, { type: 'unlock' });
    await wait(200);

    // host-only 权限下非房主 stamp 被拒（修复 handler 缺 permissions 守卫）
    wsSend(c1, { type: 'set_permissions', mode: 'host-only' });
    await wait(200);
    wsSend(c2, { type: 'stamp', id: 'st4', text: '🚫', x: 40, y: 40 });
    await wait(200); snap(c1); await wait(200);
    ok('ci464 host-only 非房主 stamp 被拒', !ids(c1).includes('st4'));
    ok('ci464 host-only stamp 收到 no_edit_permission', lastErr(c2, 'no_edit_permission'));
    wsSend(c1, { type: 'set_permissions', mode: 'all' });
    await wait(200);

    // ---- ② clear_layer：层作者在锁定房间被拒 ----
    wsSend(c2, { type: 'stroke', stroke: { id: 'L1', layerId: 'lyA', color: '#111', strokeWidth: 2, points: [[0, 0], [5, 5]] } });
    await wait(200);
    wsSend(c1, { type: 'lock' });
    await wait(200);
    wsSend(c2, { type: 'clear_layer', layerId: 'lyA' });   // c2 是层作者，但房间已锁
    await wait(200); snap(c1); await wait(200);
    ok('ci464 锁定房间层作者 clear_layer 被拒(元素仍在)', ids(c1).includes('L1'));
    wsSend(c1, { type: 'unlock' });
    await wait(200);
    // 解锁后层作者恢复可清（回归验证不误伤）
    wsSend(c2, { type: 'clear_layer', layerId: 'lyA' });
    await wait(200); snap(c1); await wait(200);
    ok('ci464 解锁后层作者 clear_layer 生效', !ids(c1).includes('L1'));

    // ---- ③ load_version 进撤销栈 ----
    // 状态 A：保存版本 verA（含 st1/st3）
    wsSend(c1, { type: 'save_version', name: 'verA' });
    await wait(250); snap(c1); await wait(200);
    const vframes = parseFrames(c1.buf).filter(m => m && (m.type === 'version_saved' || m.type === 'versions'));
    let vid = null;
    for (const f of vframes) {
      if (f.type === 'version_saved' && f.id) vid = f.id;
      if (Array.isArray(f.versions) && f.versions.length) vid = f.versions[f.versions.length - 1].id;
    }
    if (!vid) { // 兜底：list_versions
      wsSend(c1, { type: 'list_versions' });
      await wait(250);
      const lv = parseFrames(c1.buf).filter(m => m && Array.isArray(m.versions)).pop();
      if (lv && lv.versions.length) vid = lv.versions[lv.versions.length - 1].id;
    }
    ok('ci464 版本已保存并取得 id', !!vid);

    // 状态 B：加一个新元素 nb1（load_version 后它应消失）
    wsSend(c1, { type: 'stroke', stroke: { id: 'nb1', color: '#333', strokeWidth: 2, points: [[1, 1], [2, 2]] } });
    await wait(200); snap(c1); await wait(200);
    ok('ci464 状态B含 nb1', ids(c1).includes('nb1'));

    // 恢复 verA → nb1 消失
    wsSend(c1, { type: 'load_version', id: vid });
    await wait(250); snap(c1); await wait(200);
    ok('ci464 load_version 恢复状态A(nb1 消失)', !ids(c1).includes('nb1'));

    // 核心断言：undo 应回到「状态B」（撤销 load 这一步），而非吞掉版本弹回更早状态
    wsSend(c1, { type: 'undo' });
    await wait(250); snap(c1); await wait(200);
    ok('ci464 undo 撤销 load_version 回到状态B(nb1 回来)', ids(c1).includes('nb1'));
    // redo 再次回到版本 A
    wsSend(c1, { type: 'redo' });
    await wait(250); snap(c1); await wait(200);
    ok('ci464 redo 重做 load_version(nb1 再消失)', !ids(c1).includes('nb1'));

    // ---- 源码接线审计：防未来回退 ----
    const src = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
    ok('ci464 EDIT_OPS 含 stamp', /EDIT_OPS = new Set\(\[[^\]]*'stamp'/.test(src));
    ok('ci464 EDIT_OPS 含 clear_layer', /EDIT_OPS = new Set\(\[[^\]]*'clear_layer'/.test(src));
    ok('ci464 load_version 走 commitStrokes', /load_version[\s\S]{0,600}commitStrokes/.test(src));
    ok('ci464 stamp 含 permissions 守卫', /case 'stamp':[\s\S]{0,300}no_edit_permission/.test(src));
  } catch (e) { console.log('  ERR', e && e.message); fail++; }
  await wait(200);
  console.log(`\n_ci464_stamp_layer_version: ${pass} 通过, ${fail} 失败`);
  try { server.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
