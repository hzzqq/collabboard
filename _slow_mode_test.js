// ci200 — CollabBoard 慢速模式(slow_mode)：房主设最短聊天间隔，服务端在 chat 时强制限频；
// 非房主设置报错。验证首条放行、连发拦截、冷却后可再发、非房主拒绝。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'slowmode_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099);            // 首个加入者 = 房主
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'victim');  // 稳定身份 victim
  await wait(250);

  // 房主开启 2 秒慢速模式
  wsSend(c1, { type: 'slow_mode', seconds: 2 });
  await wait(350);
  const ownerCid = (parseFrames(c1.buf).find(m => m.type === 'welcome') || {}).id;
  ok('广播 slow_mode seconds=2(by=owner)', hasFrame(c1, 'slow_mode', m => m.seconds === 2 && m.by === ownerCid));

  // 首条聊天放行(冷却期前无记录)
  wsSend(c2, { type: 'chat', text: 'hi1' });
  await wait(300);
  ok('首条聊天被广播给房主', hasFrame(c1, 'chat', m => m.text === 'hi1'));

  // 冷却期内连发被拒
  wsSend(c2, { type: 'chat', text: 'hi2' });
  await wait(300);
  ok('冷却期内连发 -> error slow_mode', hasFrame(c2, 'error', m => m.code === 'slow_mode'));
  ok('被拦截的聊天未广播', !hasFrame(c1, 'chat', m => m.text === 'hi2'));

  // 冷却结束后再发成功
  await wait(2100);
  wsSend(c2, { type: 'chat', text: 'hi3' });
  await wait(300);
  ok('冷却结束后再发成功', hasFrame(c1, 'chat', m => m.text === 'hi3'));

  // 非房主不能设置
  const c3 = await wsConnect(room, 8099);
  await wait(250);
  wsSend(c3, { type: 'slow_mode', seconds: 5 });
  await wait(250);
  ok('非房主 slow_mode -> error(not_owner)', hasFrame(c3, 'error', m => m.code === 'not_owner'));

  c1.end(); c2.end(); c3.end();
  srv.kill();
  console.log('slow_mode: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
