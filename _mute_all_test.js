// ci192 — CollabBoard 房主全员禁言(mute_all)：将所有非房主成员加入 muted 集合并分别通知；被禁言者聊天被服务端拦截；非房主操作报错。
const { wsConnect, wsSend, parseFrames, hasFrame, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'muteall_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099);            // 首个加入者 = 房主
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'victim');  // 成员，稳定身份 victim
  await wait(250);

  const ownerCid = (parseFrames(c1.buf).find(m => m.type === 'welcome') || {}).id;

  // 房主全员禁言
  wsSend(c1, { type: 'mute_all' });
  await wait(350);

  ok('成员收到 you_muted(来自房主)', hasFrame(c2, 'you_muted', m => m.by === ownerCid));
  ok('广播 muted_all(携带 by=owner)', hasFrame(c1, 'muted_all', m => m.by === ownerCid));

  // 被禁言成员发聊天被服务端拦截
  wsSend(c2, { type: 'chat', text: 'hello' });
  await wait(300);
  ok('被禁言成员发聊天被拒(error muted)', hasFrame(c2, 'error', m => m.code === 'muted'));
  ok('被禁言成员的聊天未广播给房主', !hasFrame(c1, 'chat', m => m.text === 'hello'));

  // 非房主不能全员禁言
  const c3 = await wsConnect(room, 8099);
  await wait(250);
  wsSend(c3, { type: 'mute_all' });
  await wait(250);
  ok('非房主 mute_all -> error(not_owner)', hasFrame(c3, 'error', m => m.code === 'not_owner'));

  c1.end(); c2.end(); c3.end();
  srv.kill();
  console.log('mute_all: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
