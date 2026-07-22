// ci208 — CollabBoard 聊天表情回应(react_chat)：按 mid 给聊天消息加表情，全员可见(含发送者)；
// 缺参/无 mid 报错。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'reactchat_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099, 'owner');
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'member');
  await wait(250);

  // owner 发一条聊天，从 member 收到的 chat 帧取 mid
  wsSend(c1, { type: 'chat', text: 'hello room' });
  await wait(300);
  const chat = parseFrames(c2.buf).find(m => m.type === 'chat' && m.text === 'hello room');
  ok('member 收到 chat 且含 mid', !!chat && typeof chat.mid === 'number');
  const mid = chat ? chat.mid : -1;

  // owner 给该消息加 👍
  wsSend(c1, { type: 'react_chat', mid, emoji: '👍' });
  await wait(300);
  ok('发送者自身收到 chat_react(含 👍)', hasFrame(c1, 'chat_react', m => m.mid === mid && m.emoji === '👍' && m.reactions && m.reactions['👍'] === 1));
  ok('其他成员收到 chat_react(含 👍)', hasFrame(c2, 'chat_react', m => m.mid === mid && m.emoji === '👍' && m.reactions && m.reactions['👍'] === 1));

  // member 也加 🎉，reactions 累加
  wsSend(c2, { type: 'react_chat', mid, emoji: '🎉' });
  await wait(300);
  ok('reactions 累加 👍:1 🎉:1', hasFrame(c1, 'chat_react', m => m.mid === mid && m.reactions && m.reactions['👍'] === 1 && m.reactions['🎉'] === 1));

  // 缺 mid -> bad_args
  wsSend(c1, { type: 'react_chat', emoji: 'x' });
  await wait(250);
  ok('缺 mid -> error(bad_args)', hasFrame(c1, 'error', m => m.code === 'bad_args'));

  // 不存在的 mid -> no_such_chat
  wsSend(c1, { type: 'react_chat', mid: 999999, emoji: 'x' });
  await wait(250);
  ok('不存在 mid -> error(no_such_chat)', hasFrame(c1, 'error', m => m.code === 'no_such_chat'));

  c1.end(); c2.end();
  srv.kill();
  console.log('react_chat: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
