// ci184 — CollabBoard 房主清空房间(clear_room)：清掉所有笔画与聊天记录、重置撤销栈，广播 room_cleared；非房主报错。
const { wsConnect, wsSend, parseFrames, hasFrame, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'clearroom_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099);          // 首个加入者 = 房主
  await wait(200);
  const c2 = await wsConnect(room, 8099);
  await wait(250);

  const ownerCid = (parseFrames(c1.buf).find(m => m.type === 'welcome') || {}).id;
  ok('拿到房主 id', !!ownerCid);

  // c2 画一笔 + 发一条聊天
  wsSend(c2, { type:'stroke', stroke:{ id:'sx1', points:[[1,2],[3,4]] } });
  await wait(120);
  wsSend(c2, { type:'chat', text:'hello' });
  await wait(120);
  ok('c1 收到 c2 的笔画广播', hasFrame(c1, 'replace') || hasFrame(c1, 'stroke'));

  // 房主清空房间
  wsSend(c1, { type:'clear_room' });
  await wait(180);
  ok('c1 收到 room_cleared', hasFrame(c1, 'room_cleared'));
  ok('c2 收到 room_cleared', hasFrame(c2, 'room_cleared'));
  const cc = parseFrames(c1.buf).filter(m => m.type === 'room_cleared').pop();
  ok('room_cleared 含 by=房主', cc && cc.by === ownerCid);

  // 清空后房间确无笔画/聊天
  wsSend(c1, { type:'request_snapshot' });
  await wait(150);
  const snap = parseFrames(c1.buf).filter(m => m.type === 'snapshot').pop();
  ok('清空后 snapshot 笔画为空', snap && Array.isArray(snap.strokes) && snap.strokes.length === 0);
  ok('清空后 snapshot 聊天为空', snap && Array.isArray(snap.chats) && snap.chats.length === 0);

  // 非房主清空应报错
  wsSend(c2, { type:'clear_room' });
  await wait(150);
  ok('非房主 clear_room -> error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));

  c1.end(); c2.end(); srv.kill();
  await wait(100);
  console.log(`clear_room: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
