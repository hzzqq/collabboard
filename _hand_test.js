// ci216 — CollabBoard 举手(raise_hand)：实时转发给他人(含发送者)，on 切换；不落库。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'hand_' + Date.now();

(async () => {
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099, 'owner');
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'member');
  await wait(250);

  // owner 举手（cid=owner）
  wsSend(c1, { type: 'raise_hand', on: true });
  await wait(300);
  ok('发送者自身收到 hand(on:true)', hasFrame(c1, 'hand', m => m.on === true && m.id === 'owner'));
  ok('其他成员收到 hand(on:true)', hasFrame(c2, 'hand', m => m.on === true && m.id === 'owner'));
  ok('hand 帧含 name', hasFrame(c2, 'hand', m => typeof m.name === 'string'));

  // owner 放下手（省略 on 默认 true，需显式 on:false）
  wsSend(c1, { type: 'raise_hand', on: false });
  await wait(300);
  ok('放下手 -> hand(on:false)', hasFrame(c1, 'hand', m => m.on === false && m.id === 'owner'));

  // member 举手（cid=member，含发送者自身可见）
  wsSend(c2, { type: 'raise_hand', on: true });
  await wait(300);
  ok('member 举手自身可见', hasFrame(c2, 'hand', m => m.on === true && m.id === 'member'));
  ok('member 举手 owner 可见', hasFrame(c1, 'hand', m => m.on === true && m.id === 'member'));

  c1.end(); c2.end();
  srv.kill();
  console.log('hand: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
