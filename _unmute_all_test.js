// ci196 — CollabBoard 房主全员解禁(unmute_all)：清空 muted 集合并广播；解禁后成员可正常聊天；非房主操作报错。
const { wsConnect, wsSend, parseFrames, hasFrame, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'unmuteall_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099);            // 房主
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'victim');  // 成员
  await wait(250);

  const ownerCid = (parseFrames(c1.buf).find(m => m.type === 'welcome') || {}).id;

  // 先全员禁言
  wsSend(c1, { type: 'mute_all' });
  await wait(300);
  ok('禁言后成员收到 you_muted', hasFrame(c2, 'you_muted', m => m.by === ownerCid));

  // 被禁言期间聊天被拒
  wsSend(c2, { type: 'chat', text: 'blocked' });
  await wait(250);
  ok('禁言期间聊天被拒(error muted)', hasFrame(c2, 'error', m => m.code === 'muted'));
  ok('禁言期间聊天未广播', !hasFrame(c1, 'chat', m => m.text === 'blocked'));

  // 房主全员解禁
  wsSend(c1, { type: 'unmute_all' });
  await wait(300);
  ok('广播 unmuted_all(携带 by=owner)', hasFrame(c1, 'unmuted_all', m => m.by === ownerCid));

  // 解禁后成员可正常聊天
  wsSend(c2, { type: 'chat', text: 'hello2' });
  await wait(300);
  ok('解禁后聊天广播给房主', hasFrame(c1, 'chat', m => m.text === 'hello2'));
  // 再以第二条消息确认确实已解禁(非沿用旧缓冲)
  wsSend(c2, { type: 'chat', text: 'hello3' });
  await wait(300);
  ok('解禁后第二条聊天也广播给房主', hasFrame(c1, 'chat', m => m.text === 'hello3'));

  // 非房主不能全员解禁
  const c3 = await wsConnect(room, 8099);
  await wait(250);
  wsSend(c3, { type: 'unmute_all' });
  await wait(250);
  ok('非房主 unmute_all -> error(not_owner)', hasFrame(c3, 'error', m => m.code === 'not_owner'));

  c1.end(); c2.end(); c3.end();
  srv.kill();
  console.log('unmute_all: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
