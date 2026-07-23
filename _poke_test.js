// _poke_test.js — ci340 CollabBoard 戳一戳(poke)
// 任意成员可定向提醒另一成员：仅目标收到 poked（含 from/name/at），发送者收到 poke_sent 回执；
// 校验：bad_cid / self_poke / no_such_member / poke_too_fast(3s 限频)；旁观者不应收到 poked。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const PORT = 8145;
const room = 'poke_' + Date.now();

(async ()=>{
  const srv = spawnServer({ PORT: String(PORT) });
  await wait(400);
  const c1 = await wsConnect(room, PORT, 'owner');   // 房主
  await wait(200);
  const c2 = await wsConnect(room, PORT, 'alice');   // 成员 A
  await wait(200);
  const c3 = await wsConnect(room, PORT, 'bob');     // 成员 B(旁观者)
  await wait(250);

  // 正常戳：alice 戳 bob -> bob 收 poked(from=alice)，alice 收 poke_sent(cid=bob)
  wsSend(c2, { type:'poke', cid: 'bob' });
  await wait(300);
  ok('目标收到 poked(from=alice)', hasFrame(c3, 'poked', m => m.from === 'alice' && typeof m.at === 'number'));
  ok('发送者收到 poke_sent(cid=bob)', hasFrame(c2, 'poke_sent', m => m.cid === 'bob'));
  ok('旁观者(owner)不应收到 poked', !hasFrame(c1, 'poked', ()=> true));

  // 限频：3s 内再次戳 -> poke_too_fast
  wsSend(c2, { type:'poke', cid: 'owner' });
  await wait(250);
  ok('3s 内再次戳 -> error(poke_too_fast)', hasFrame(c2, 'error', m => m.code === 'poke_too_fast'));
  ok('限频期间目标不应收到 poked', !hasFrame(c1, 'poked', ()=> true));

  // bad_cid：非字符串
  wsSend(c1, { type:'poke', cid: 5 });
  await wait(250);
  ok('非字符串 cid -> error(bad_cid)', hasFrame(c1, 'error', m => m.code === 'bad_cid'));

  // self_poke：戳自己
  wsSend(c1, { type:'poke', cid: 'owner' });
  await wait(250);
  ok('戳自己 -> error(self_poke)', hasFrame(c1, 'error', m => m.code === 'self_poke'));

  // no_such_member：不存在成员
  wsSend(c1, { type:'poke', cid: 'ghost' });
  await wait(250);
  ok('不存在成员 -> error(no_such_member)', hasFrame(c1, 'error', m => m.code === 'no_such_member'));

  // 限频窗口过后可再次戳：等 3s，bob 戳 alice
  await wait(3100);
  wsSend(c3, { type:'poke', cid: 'alice' });
  await wait(300);
  ok('bob 戳 alice -> alice 收 poked(from=bob)', hasFrame(c2, 'poked', m => m.from === 'bob'));
  ok('bob 收 poke_sent(cid=alice)', hasFrame(c3, 'poke_sent', m => m.cid === 'alice'));

  c1.destroy(); c2.destroy(); c3.destroy();
  srv.kill();
  console.log(`\n[CollabBoard poke] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
