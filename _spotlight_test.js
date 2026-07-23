// _spotlight_test.js — ci332 CollabBoard 聚光灯(spotlight/spotlight_off)
// 房主将成员设为全员焦点(演示模式)并广播；非房主报错；不存在成员报错；
// 隐性问题：被聚焦成员离场时自动关闭聚光灯(spotlight_off reason:left)。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const PORT = 8143;
const room = 'spot_' + Date.now();

(async ()=>{
  const srv = spawnServer({ PORT: String(PORT) });
  await wait(400);
  const c1 = await wsConnect(room, PORT, 'owner');   // 房主
  await wait(200);
  const c2 = await wsConnect(room, PORT, 'alice');   // 成员 A
  await wait(200);
  const c3 = await wsConnect(room, PORT, 'bob');     // 成员 B
  await wait(250);

  // 房主聚焦 alice -> 全员收到 spotlight_on
  wsSend(c1, { type: 'spotlight', cid: 'alice' });
  await wait(300);
  ok('房主聚焦 -> 全员收到 spotlight_on(cid=alice)', hasFrame(c3, 'spotlight_on', m => m.spotlight && m.spotlight.cid === 'alice'));
  ok('spotlight_on 含 by=owner', hasFrame(c2, 'spotlight_on', m => m.spotlight && m.spotlight.by === 'owner'));

  // 非房主开聚光灯 -> not_owner
  wsSend(c2, { type: 'spotlight', cid: 'bob' });
  await wait(250);
  ok('非房主开聚光灯 -> error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));

  // 不存在成员 -> no_such_member
  wsSend(c1, { type: 'spotlight', cid: 'ghost' });
  await wait(250);
  ok('不存在成员 -> error(no_such_member)', hasFrame(c1, 'error', m => m.code === 'no_such_member'));

  // 非字符串 cid -> bad_cid
  wsSend(c1, { type: 'spotlight', cid: 5 });
  await wait(250);
  ok('非字符串 cid -> error(bad_cid)', hasFrame(c1, 'error', m => m.code === 'bad_cid'));

  // 房主正常关闭聚光灯 -> spotlight_off
  wsSend(c1, { type: 'spotlight_off' });
  await wait(300);
  ok('房主关闭 -> spotlight_off(cid=alice, by=owner)', hasFrame(c3, 'spotlight_off', m => m.cid === 'alice' && m.by === 'owner'));

  // 无聚光灯时关闭 -> no_spotlight
  wsSend(c1, { type: 'spotlight_off' });
  await wait(250);
  ok('无聚光灯时关闭 -> error(no_spotlight)', hasFrame(c1, 'error', m => m.code === 'no_spotlight'));

  // 非房主关闭 -> 第二条 not_owner（c2 此前已有 1 次）
  wsSend(c1, { type: 'spotlight', cid: 'bob' });
  await wait(250);
  wsSend(c2, { type: 'spotlight_off' });
  await wait(250);
  const notOwnerCount = parseFrames(c2.buf).filter(m => m && m.type === 'error' && m.code === 'not_owner').length;
  ok('非房主关闭聚光灯 -> 第二条 error(not_owner)', notOwnerCount === 2);

  // 隐性问题：被聚焦成员(bob)离场 -> 自动 spotlight_off(reason:left)
  c3.end();
  await wait(400);
  ok('被聚焦成员离场 -> spotlight_off(reason:left)', hasFrame(c2, 'spotlight_off', m => m.cid === 'bob' && m.reason === 'left'));

  c1.end(); c2.end();
  srv.kill();
  console.log('spotlight: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
