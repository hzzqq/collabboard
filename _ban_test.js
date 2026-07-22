// ci180 — CollabBoard 房主封禁(ban)：加入 banned 集合 + 广播 + 断开目标；同身份重连被拒；非房主/封禁自身报错。
const { wsConnect, wsSend, parseFrames, hasFrame, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'ban_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099);          // 首个加入者 = 房主
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'victim'); // 成员，稳定身份 victim
  await wait(250);

  const ownerCid = (parseFrames(c1.buf).find(m => m.type === 'welcome') || {}).id;

  // 房主封禁 victim
  let c2Closed = false;
  c2.on('close', ()=> c2Closed = true);
  wsSend(c1, { type: 'ban', toId: 'victim' });
  await wait(400);

  ok('房主收到 banned 广播(含 victim)', hasFrame(c1, 'banned', m => m.ids && m.ids.includes('victim')));
  ok('banned 广播携带 by=owner', hasFrame(c1, 'banned', m => m.by === ownerCid));
  ok('victim 客户端收到 banned 帧', hasFrame(c2, 'banned', m => m.ids && m.ids.includes('victim')));
  ok('victim 连接被断开', c2Closed);

  // 同身份重连应被拒
  const c2b = await wsConnect(room, 8099, 'victim');
  await wait(350);
  ok('被封禁身份重连收到 error(banned)', hasFrame(c2b, 'error', m => m.code === 'banned'));
  ok('被封禁身份重连不收到 welcome', !hasFrame(c2b, 'welcome'));

  // 非房主禁止言封禁
  const c3 = await wsConnect(room, 8099);
  await wait(250);
  wsSend(c3, { type: 'ban', toId: 'ghost' });
  await wait(250);
  ok('非房主 ban -> error(not_owner)', hasFrame(c3, 'error', m => m.code === 'not_owner'));

  // 房主不能封禁自己
  wsSend(c1, { type: 'ban', toId: ownerCid });
  await wait(250);
  ok('房主封禁自己 -> error(ban_self)', hasFrame(c1, 'error', m => m.code === 'ban_self'));

  // 普通房间仍可正常加入(封禁不影响其他身份)
  const c4 = await wsConnect(room, 8099, 'innocent');
  await wait(300);
  ok('未封禁身份可正常加入(welcome)', hasFrame(c4, 'welcome'));

  c1.end(); c2b.end(); c3.end(); c4.end();
  srv.kill();
  console.log('ban: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
