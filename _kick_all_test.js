// ci188 — CollabBoard 房主踢出全部(kick_all)：向全员广播 kicked_all 并断开除房主外的所有连接；非房主报错。
const { wsConnect, wsSend, parseFrames, hasFrame, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'kickall_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099);          // 房主
  await wait(200);
  const c2 = await wsConnect(room, 8099);
  const c3 = await wsConnect(room, 8099);
  await wait(300);

  const ownerCid = (parseFrames(c1.buf).find(m => m.type === 'welcome') || {}).id;
  ok('拿到房主 id', !!ownerCid);

  let c2Closed = false, c3Closed = false;
  c2.on('close', ()=> c2Closed = true);
  c3.on('close', ()=> c3Closed = true);

  // 房主踢出全部
  wsSend(c1, { type:'kick_all' });
  await wait(350);

  ok('c2 收到 kicked_all', hasFrame(c2, 'kicked_all'));
  ok('c3 收到 kicked_all', hasFrame(c3, 'kicked_all'));
  ok('c1(房主) 也收到 kicked_all 广播', hasFrame(c1, 'kicked_all'));
  ok('c2 连接被断开', c2Closed);
  ok('c3 连接被断开', c3Closed);

  // 房主仍在房间（可继续操作）
  wsSend(c1, { type:'request_snapshot' });
  await wait(150);
  ok('房主仍在线可交互', hasFrame(c1, 'snapshot'));

  // 非房主不能踢出全部
  const c4 = await wsConnect(room, 8099);
  await wait(250);
  wsSend(c4, { type:'kick_all' });
  await wait(250);
  ok('非房主 kick_all -> error(not_owner)', hasFrame(c4, 'error', m => m.code === 'not_owner'));

  c1.end(); c4.end(); srv.kill();
  await wait(100);
  console.log(`kick_all: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
