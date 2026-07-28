// _ci400_416_handlers_test.js — 验证 ci400~ci416 五个 handler（undo/redo、avatar/focus、
// grid_snap、element_template、export_board）及其隐性修复；基于 _wstest.js harness。
// 每个 handler ≥3 组断言，全部 pass；不修改 .workbuddy / state.json / 其他目录。
const fs = require('fs');
const path = require('path');
const { spawnServer, wsConnect, wsSend, hasFrame, parseFrames, wait } = require('./_wstest');

const dir = __dirname;
try { fs.rmSync(path.join(dir, 'rooms'), { recursive: true, force: true }); } catch (e) {}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8137;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log('  FAIL', n); } };

function connectAll(room, cids) {
  // 顺序连接，第一个成为房主(owner)
  return (async () => {
    const socks = [];
    for (const cid of cids) socks.push(await wsConnect(room, PORT, cid));
    await wait(250);
    return socks;
  })();
}
const framesOf = (s, type) => parseFrames(s.buf).filter(m => m && m.type === type);

(async () => {
  const server = spawnServer({ PORT: String(PORT) });
  await wait(700);
  try {
    // ============ ci400 undo/redo + history_change ============
    {
      const [c1, c2] = await connectAll('ci400_' + Date.now().toString(36), ['c1', 'c2']);
      // 1) 空历史时 undo 不广播 history_change（幂等、不报错）
      wsSend(c1, { type: 'undo' });
      await wait(150);
      ok('ci400 空历史 undo 不广播 history_change', !hasFrame(c1, 'history_change'));

      // 画一笔（显式 id 便于后续验证），产生可撤销状态
      wsSend(c1, { type: 'stroke', stroke: { type: 'stroke', id: 's1', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], color: '#fff' } });
      await wait(200);

      // 2) undo：历史栈弹出，广播 history_change{canUndo:false,canRedo:true} 与 replace(空)
      wsSend(c1, { type: 'undo' });
      await wait(200);
      ok('ci400 undo 广播 history_change canRedo=true', hasFrame(c2, 'history_change', m => m.canRedo === true && m.canUndo === false));
      const rep = parseFrames(c2.buf).filter(m => m.type === 'replace').pop();
      ok('ci400 undo 后 replace 笔画数为 0', rep && Array.isArray(rep.strokes) && rep.strokes.length === 0);

      // 3) redo：历史栈前进，广播 history_change{canUndo:true,canRedo:false}
      wsSend(c1, { type: 'redo' });
      await wait(200);
      ok('ci400 redo 广播 history_change canUndo=true', hasFrame(c2, 'history_change', m => m.canUndo === true && m.canRedo === false));
      const rep2 = parseFrames(c2.buf).filter(m => m.type === 'replace').pop();
      ok('ci400 redo 后 replace 笔画数恢复为 1', rep2 && Array.isArray(rep2.strokes) && rep2.strokes.length === 1);
      c1.destroy(); c2.destroy();
    }

    // ============ ci404 set_avatar (member_avatar) + focus_element (focus) ============
    {
      const [c1, c2] = await connectAll('ci404_' + Date.now().toString(36), ['c1', 'c2']);
      // c1 先建一个元素供聚焦
      wsSend(c1, { type: 'note', id: 'n1', text: 'hi', x: 10, y: 10 });
      await wait(150);

      // 1) c2 设头像 → 广播 member_avatar（含请求者），且兼容 avatar 帧仍在
      wsSend(c2, { type: 'set_avatar', avatar: '🦊' });
      await wait(200);
      ok('ci404 广播 member_avatar(cid=c2)', hasFrame(c1, 'member_avatar', m => m.cid === 'c2' && m.avatar === '🦊'));
      ok('ci404 兼容 avatar 帧仍在', hasFrame(c1, 'avatar', m => m.id === 'c2' && m.avatar === '🦊'));

      // 2) 非法头像（非字符串）→ 拒绝 bad_avatar
      wsSend(c2, { type: 'set_avatar', avatar: 12345 });
      await wait(200);
      ok('ci404 非法头像返回 bad_avatar', hasFrame(c2, 'error', m => m.code === 'bad_avatar'));

      // 3) 房主聚焦元素 → 广播 focus{by,elId}（规范帧）+ focus_element_on
      wsSend(c1, { type: 'focus_element', elId: 'n1' });
      await wait(200);
      ok('ci404 广播 focus{by:c1,elId:n1}', hasFrame(c2, 'focus', m => m.by === 'c1' && m.elId === 'n1'));
      ok('ci404 仍广播 focus_element_on', hasFrame(c2, 'focus_element_on', m => m.elId === 'n1'));

      // 4) 非房主聚焦 → 拒绝 not_owner
      wsSend(c2, { type: 'focus_element', elId: 'n1' });
      await wait(200);
      ok('ci404 非房主聚焦返回 not_owner', hasFrame(c2, 'error', m => m.code === 'not_owner'));
      c1.destroy(); c2.destroy();
    }

    // ============ ci408 set_grid + snap_element ============
    {
      const room408 = 'ci408_' + Date.now().toString(36);
      const [c1, c2] = await connectAll(room408, ['c1', 'c2']);
      // 1) 房主设网格参数 → 广播 grid{...}
      wsSend(c1, { type: 'set_grid', grid: { x: 0, y: 0, size: 50 } });
      await wait(200);
      ok('ci408 广播 grid{x:0,y:0,size:50}', hasFrame(c2, 'grid', m => m.x === 0 && m.y === 0 && m.size === 50));

      // 2) 建元素(13,13)后吸附到最近网格点(0,0) → element_snapped 广播给其他人(不含发起者)
      wsSend(c1, { type: 'note', id: 'n1', text: 'x', x: 13, y: 13 });
      await wait(150);
      wsSend(c1, { type: 'snap_element', elId: 'n1' });
      await wait(200);
      ok('ci408 吸附到最近网格点 x=0', hasFrame(c2, 'element_snapped', m => m.elId === 'n1' && m.x === 0 && m.y === 0));

      // 3) 非房主设网格 → 拒绝 not_owner
      wsSend(c2, { type: 'set_grid', grid: { size: 10 } });
      await wait(200);
      ok('ci408 非房主设网格返回 not_owner', hasFrame(c2, 'error', m => m.code === 'not_owner'));

      // 4) 迟到者 c3 在 set_grid 之后加入 → 快照含 gridCfg（一致性/持久化可见）
      const c3 = await wsConnect(room408, PORT, 'c3');
      await wait(250);
      const snap = parseFrames(c3.buf).find(m => m.type === 'snapshot');
      ok('ci408 迟到者快照含 gridCfg.size=50', !!snap && snap.gridCfg && snap.gridCfg.size === 50);
      c1.destroy(); c2.destroy(); c3.destroy();
    }

    // ============ ci412 save_template + list_templates + apply_template ============
    {
      const [c1, c2] = await connectAll('ci412_' + Date.now().toString(36), ['c1', 'c2']);
      // 1) 房主保存模板 → 广播 template_saved
      wsSend(c1, { type: 'save_template', name: 't1', elements: [{ type: 'note', x: 10, y: 10, text: 'a' }, { type: 'frame', x: 0, y: 0, w: 50, h: 50, color: '#fff' }] });
      await wait(200);
      ok('ci412 保存模板广播 template_saved(name=t1)', hasFrame(c2, 'template_saved', m => m.name === 't1'));

      // 2) 列出模板（仅回请求者）含 t1 且含 2 个元素
      wsSend(c1, { type: 'list_templates' });
      await wait(200);
      const tps = framesOf(c1, 'templates').pop();
      ok('ci412 list_templates 含 t1(count=2)', !!tps && Array.isArray(tps.templates) && tps.templates.some(t => t.name === 't1' && t.count === 2));

      // 3) 应用用户模板 → replace 笔画数增加 2
      const before = parseFrames(c1.buf).filter(m => m.type === 'replace').pop();
      const beforeLen = before ? before.strokes.length : 0;
      wsSend(c1, { type: 'apply_template', name: 't1' });
      await wait(200);
      const after = parseFrames(c2.buf).filter(m => m.type === 'replace').pop();
      ok('ci412 应用模板新增 2 个元素', after && Array.isArray(after.strokes) && after.strokes.length === beforeLen + 2);

      // 4) 隐性修复：view 权限下非房主应用模板被拒
      wsSend(c1, { type: 'set_permissions', mode: 'view' });
      await wait(150);
      wsSend(c2, { type: 'apply_template', name: 't1' });
      await wait(200);
      ok('ci412 view 模式非房主应用模板返回 no_edit_permission', hasFrame(c2, 'error', m => m.code === 'no_edit_permission'));
      c1.destroy(); c2.destroy();
    }

    // ============ ci416 export_board（仅回请求者 + 与快照一致） ============
    {
      const [c1, c2] = await connectAll('ci416_' + Date.now().toString(36), ['c1', 'c2']);
      wsSend(c1, { type: 'note', id: 'n1', text: 'star', x: 5, y: 5 });
      await wait(150);
      // 收藏 + 存版本，便于验证导出一致性
      wsSend(c1, { type: 'star_element', elId: 'n1' });
      await wait(150);
      wsSend(c1, { type: 'save_version', name: 'v1' });
      await wait(200);

      // 1) 导出 JSON：仅回请求者，含完整快照字段
      wsSend(c1, { type: 'export_board', format: 'json' });
      await wait(250);
      const ej = framesOf(c1, 'board_export').filter(m => m.format === 'json').pop();
      ok('ci416 收到 json 导出', !!ej && Array.isArray(ej.data.strokes));
      ok('ci416 导出含 stars(含 n1)', ej && ej.data.stars && ej.data.stars.n1 && ej.data.stars.n1.includes('c1'));
      ok('ci416 导出含 versions(>=1)', ej && Array.isArray(ej.data.versions) && ej.data.versions.length >= 1);
      ok('ci416 导出含 members(>=2)', ej && Array.isArray(ej.data.members) && ej.data.members.length >= 2);
      // 2) 不广播：c2 不应收到 board_export
      ok('ci416 导出不广播给 c2', framesOf(c2, 'board_export').length === 0);

      // 3) svg 导出正常
      wsSend(c1, { type: 'export_board', format: 'svg' });
      await wait(250);
      const es = framesOf(c1, 'board_export').filter(m => m.format === 'svg').pop();
      ok('ci416 收到 svg 导出', !!es && typeof es.svg === 'string' && es.svg.startsWith('<svg'));
      c1.destroy(); c2.destroy();
    }
  } catch (e) {
    fail++; console.log('  FAIL 异常', e && e.stack);
  } finally {
    server.kill();
  }

  console.log(`\n[ci400_416_handlers] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
