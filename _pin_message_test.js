// _pin_message_test.js — ci328 CollabBoard 聊天置顶(pin_message/unpin_message)
// 房主置顶按 mid 定位并广播+持久化；非房主报错；不存在 mid 报错；
// 隐性问题：置顶消息被 delete_chat 删除时自动取消置顶(chat_unpinned reason:deleted)。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const PORT = 8142;
const room = 'pin_' + Date.now();

(async ()=>{
  const srv = spawnServer({ PORT: String(PORT) });
  await wait(400);
  const c1 = await wsConnect(room, PORT, 'owner');   // 房主
  await wait(200);
  const c2 = await wsConnect(room, PORT, 'member');  // 普通成员
  await wait(250);

  // 成员发一条聊天(mid=1)
  wsSend(c2, { type: 'chat', text: 'important msg' });
  await wait(300);

  // 房主置顶 mid=1
  wsSend(c1, { type: 'pin_message', mid: 1 });
  await wait(300);
  ok('房主置顶 -> 全员收到 chat_pinned', hasFrame(c2, 'chat_pinned', m => m.pinned && m.pinned.mid === 1 && m.pinned.text === 'important msg'));
  ok('置顶帧含 pinnedBy=owner', hasFrame(c1, 'chat_pinned', m => m.pinned && m.pinned.pinnedBy === 'owner'));

  // 非房主置顶 -> not_owner
  wsSend(c2, { type: 'pin_message', mid: 1 });
  await wait(250);
  ok('非房主置顶 -> error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));

  // 不存在 mid -> no_such_message
  wsSend(c1, { type: 'pin_message', mid: 999 });
  await wait(250);
  ok('不存在 mid -> error(no_such_message)', hasFrame(c1, 'error', m => m.code === 'no_such_message'));

  // 非数值 mid -> bad_mid
  wsSend(c1, { type: 'pin_message', mid: 'x' });
  await wait(250);
  ok('非数值 mid -> error(bad_mid)', hasFrame(c1, 'error', m => m.code === 'bad_mid'));

  // 隐性问题：删除已置顶消息 -> 自动取消置顶
  wsSend(c1, { type: 'delete_chat', mid: 1 });
  await wait(300);
  ok('删除置顶消息 -> chat_unpinned(reason:deleted)', hasFrame(c2, 'chat_unpinned', m => m.mid === 1 && m.reason === 'deleted'));

  // 现在无置顶，unpin -> no_pinned
  wsSend(c1, { type: 'unpin_message' });
  await wait(250);
  ok('无置顶时 unpin -> error(no_pinned)', hasFrame(c1, 'error', m => m.code === 'no_pinned'));

  // 重新发聊天(mid=2)并置顶，再正常取消
  wsSend(c2, { type: 'chat', text: 'second' });
  await wait(250);
  wsSend(c1, { type: 'pin_message', mid: 2 });
  await wait(250);
  wsSend(c1, { type: 'unpin_message' });
  await wait(300);
  ok('正常取消置顶 -> chat_unpinned(mid=2)', hasFrame(c2, 'chat_unpinned', m => m.mid === 2 && !m.reason));

  // 非房主取消置顶 -> not_owner
  wsSend(c1, { type: 'pin_message', mid: 2 });
  await wait(250);
  wsSend(c2, { type: 'unpin_message' });
  await wait(250);
  const notOwnerCount = parseFrames(c2.buf).filter(m => m && m.type === 'error' && m.code === 'not_owner').length;
  ok('非房主取消置顶 -> 第二条 error(not_owner)', notOwnerCount === 2);

  c1.end(); c2.end();
  srv.kill();
  console.log('pin_message: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
