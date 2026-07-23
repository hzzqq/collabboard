// _ci380_396_handlers_test.js — ci380/ci384/ci388/ci392/ci396 五个 handler 端到端验证
// 每个 cycle 一个 handler，独立房间，≥3 组断言；同时覆盖校验拒绝、广播范围、快照/持久化一致。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');

let pass = 0, fail = 0;
const ok = (n, c) => { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
process.env.PORT = '8166';
const PORT = 8166;
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const framesOf = (s, type, pred) =>
  parseFrames(s.buf).filter(m => m && m.type === type && (!pred || pred(m)));

(async () => {
  const srv = spawnServer({ PORT: String(PORT) });
  await wait(400);

  // ============ ci380 lock_element ============
  {
    const room = 'ci380_' + Date.now();
    const c1 = await wsConnect(room, PORT, 'c1');   // 房主
    await wait(150);
    const c2 = await wsConnect(room, PORT, 'c2');   // 非房主
    await wait(150);
    wsSend(c1, { type: 'note', id: 'E1', x: 10, y: 10, w: 80, h: 80, text: '锁我', color: '#fff' });
    await wait(200);

    // 非房主锁定被拒
    wsSend(c2, { type: 'lock_element', ids: ['E1'] });
    await wait(250);
    ok('ci380 非房主锁定 → error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));

    // 房主锁定 → 广播 lock_element + element_locked
    wsSend(c1, { type: 'lock_element', ids: ['E1'] });
    await wait(300);
    ok('ci380 房主锁定广播 lock_element(locked:true,ids含E1)', hasFrame(c2, 'lock_element', m => m.locked === true && Array.isArray(m.ids) && m.ids.includes('E1')));
    ok('ci380 广播规范帧 element_locked(elId=E1,locked:true)', hasFrame(c2, 'element_locked', m => m.elId === 'E1' && m.locked === true && m.by === 'c1'));

    // 迟到者快照含 locks[E1]（持久化/快照一致性）
    const c3 = await wsConnect(room, PORT, 'c3');
    await wait(150);
    wsSend(c3, { type: 'request_snapshot' });
    await wait(250);
    ok('ci380 迟到者 snapshot.locks[E1].locked===true', hasFrame(c3, 'snapshot', m => m.locks && m.locks.E1 && m.locks.E1.locked === true));

    // 房主解锁 → element_unlocked
    wsSend(c1, { type: 'unlock_element', ids: ['E1'] });
    await wait(300);
    ok('ci380 解锁广播 element_unlocked(elId=E1,locked:false)', hasFrame(c2, 'element_unlocked', m => m.elId === 'E1' && m.locked === false));

    // 锁定不存在元素 → error(no_such_element)（隐性修复：原先会静默加锁虚元素）
    wsSend(c1, { type: 'lock_element', ids: ['NOPE'] });
    await wait(250);
    ok('ci380 锁定不存在元素 → error(no_such_element)', hasFrame(c1, 'error', m => m.code === 'no_such_element'));

    c1.destroy(); c2.destroy(); c3.destroy();
  }

  // ============ ci384 follow ============
  {
    const room = 'ci384_' + Date.now();
    const c1 = await wsConnect(room, PORT, 'c1');   // 关注者
    await wait(150);
    const c2 = await wsConnect(room, PORT, 'c2');   // 被关注者
    await wait(200);

    wsSend(c1, { type: 'follow', toId: 'c2' });
    await wait(300);
    ok('ci384 c2 收到 follow(from=c1,toId=c2)', hasFrame(c2, 'follow', m => m.from === 'c1' && m.toId === 'c2'));
    ok('ci384 c2 收到规范帧 follow_start(by=c1,target=c2)', hasFrame(c2, 'follow_start', m => m.by === 'c1' && m.target === 'c2'));

    // 取消关注
    wsSend(c1, { type: 'follow' });
    await wait(300);
    ok('ci384 c2 收到 follow_stop', hasFrame(c2, 'follow_stop', m => m.from === 'c1'));

    // 关注不存在用户 → error
    wsSend(c1, { type: 'follow', toId: 'ghost' });
    await wait(250);
    ok('ci384 关注不存在用户 → error(no_such_user)', hasFrame(c1, 'error', m => m.code === 'no_such_user'));

    // 隐性修复：被关注者(c2)离场时，关注者(c1)应收到 follow_stop
    wsSend(c1, { type: 'follow', toId: 'c2' });
    await wait(300);
    c2.destroy();
    await wait(400);
    ok('ci384 被关注者离场 → 关注者收 follow_stop(by=c2)', hasFrame(c1, 'follow_stop', m => m.by === 'c2'));

    c1.destroy();
  }

  // ============ ci388 comment_add/comment_del ============
  {
    const room = 'ci388_' + Date.now();
    const c1 = await wsConnect(room, PORT, 'c1');
    await wait(150);
    const c2 = await wsConnect(room, PORT, 'c2');
    await wait(150);
    const c3 = await wsConnect(room, PORT, 'c3');
    await wait(150);
    wsSend(c1, { type: 'note', id: 'E1', x: 10, y: 10, w: 80, h: 80, text: '评论对象', color: '#fff' });
    await wait(200);

    wsSend(c2, { type: 'comment_add', id: 'E1', text: '第一条评论' });
    await wait(300);
    ok('ci388 c3 收到 comment(action=add,id=E1,文本匹配)', hasFrame(c3, 'comment', m => m.action === 'add' && m.id === 'E1' && m.comment && m.comment.text === '第一条评论' && m.comment.author === 'c2'));

    wsSend(c2, { type: 'comment_del', id: 'E1', index: 0 });
    await wait(300);
    ok('ci388 删除评论广播 comment(action=del,index=0)', hasFrame(c3, 'comment', m => m.action === 'del' && m.id === 'E1' && m.index === 0));

    // 校验：不存在元素
    wsSend(c2, { type: 'comment_add', id: 'NOPE', text: 'x' });
    await wait(250);
    ok('ci388 评论不存在元素 → error(no_such_element)', hasFrame(c2, 'error', m => m.code === 'no_such_element'));

    // 校验：缺文本
    wsSend(c2, { type: 'comment_add', id: 'E1', text: '' });
    await wait(250);
    ok('ci388 评论缺文本 → error(bad_text)', hasFrame(c2, 'error', m => m.code === 'bad_text'));

    // 持久化/快照：迟到者快照 E1.comments 反映当前状态
    const c4 = await wsConnect(room, PORT, 'c4');
    await wait(150);
    wsSend(c4, { type: 'request_snapshot' });
    await wait(250);
    ok('ci388 迟到者快照 E1.comments 已删除该条(长度0)', hasFrame(c4, 'snapshot', m => {
      const el = (m.strokes || []).find(s => s.id === 'E1');
      return el && Array.isArray(el.comments) && el.comments.length === 0;
    }));

    c1.destroy(); c2.destroy(); c3.destroy(); c4.destroy();
  }

  // ============ ci392 set_role ============
  {
    const room = 'ci392_' + Date.now();
    const c1 = await wsConnect(room, PORT, 'c1');   // 房主
    await wait(150);
    const c2 = await wsConnect(room, PORT, 'c2');
    await wait(200);

    // 非房主拒绝
    wsSend(c2, { type: 'set_role', cid: 'c1', role: 'viewer' });
    await wait(250);
    ok('ci392 非房主 set_role → error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));

    // 房主改为 viewer
    wsSend(c1, { type: 'set_role', cid: 'c2', role: 'viewer' });
    await wait(300);
    ok('ci392 房主改角色广播 member_role(cid=c2,role=viewer,by=c1)', hasFrame(c2, 'member_role', m => m.cid === 'c2' && m.role === 'viewer' && m.by === 'c1'));

    // 非法角色
    wsSend(c1, { type: 'set_role', cid: 'c2', role: 'king' });
    await wait(250);
    ok('ci392 非法角色 → error(bad_role)', hasFrame(c1, 'error', m => m.code === 'bad_role'));

    // 持久化/快照：迟到者 snapshot.roles[c2]===viewer
    const c3 = await wsConnect(room, PORT, 'c3');
    await wait(150);
    wsSend(c3, { type: 'request_snapshot' });
    await wait(250);
    ok('ci392 迟到者 snapshot.roles[c2]===viewer', hasFrame(c3, 'snapshot', m => m.roles && m.roles.c2 === 'viewer'));

    c1.destroy(); c2.destroy(); c3.destroy();
  }

  // ============ ci396 board_version ============
  {
    const room = 'ci396_' + Date.now();
    const c1 = await wsConnect(room, PORT, 'c1');   // 房主
    await wait(150);
    const c2 = await wsConnect(room, PORT, 'c2');
    await wait(200);
    wsSend(c1, { type: 'note', id: 'V1', x: 5, y: 5, w: 40, h: 40, text: 'v', color: '#fff' });
    await wait(200);

    // 非房主保存版本被拒
    wsSend(c2, { type: 'save_version', name: 'x' });
    await wait(250);
    ok('ci396 非房主 save_version → error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));

    // 房主保存
    wsSend(c1, { type: 'save_version', name: '快照A' });
    await wait(300);
    ok('ci396 保存广播 version_saved(name=快照A)', hasFrame(c2, 'version_saved', m => m.name === '快照A' && typeof m.id === 'string'));
    const vsaved = framesOf(c1, 'version_saved')[0];
    const vid = vsaved && vsaved.id;

    // 列出版本（仅回请求者）
    wsSend(c1, { type: 'list_versions' });
    await wait(250);
    ok('ci396 list_versions 回 versions(含 快照A)', hasFrame(c1, 'versions', m => Array.isArray(m.versions) && m.versions.length >= 1 && m.versions.some(v => v.name === '快照A' && v.id === vid)));

    // 恢复版本 → 广播 replace + version_loaded
    wsSend(c1, { type: 'load_version', id: vid });
    await wait(300);
    ok('ci396 恢复广播 replace(strokes) 给 c2', hasFrame(c2, 'replace', m => Array.isArray(m.strokes)));
    ok('ci396 恢复广播 version_loaded(id匹配)', hasFrame(c2, 'version_loaded', m => m.id === vid && m.name === '快照A'));

    // 持久化/快照：迟到者 snapshot.versions 含该版本
    const c3 = await wsConnect(room, PORT, 'c3');
    await wait(150);
    wsSend(c3, { type: 'request_snapshot' });
    await wait(250);
    ok('ci396 迟到者 snapshot.versions 含 快照A', hasFrame(c3, 'snapshot', m => Array.isArray(m.versions) && m.versions.some(v => v.name === '快照A' && v.id === vid)));

    c1.destroy(); c2.destroy(); c3.destroy();
  }

  srv.kill();
  console.log(`\n[CollabBoard ci380-396 handlers] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
