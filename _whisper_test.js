// ci204 — CollabBoard 私聊(whisper)：仅把消息定向转发给指定 cid 的成员；
// 非目标不接收；目标不存在/缺目标报错。
const { wsConnect, wsSend, hasFrame, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'whisper_' + Date.now();

(async ()=>{
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099, 'owner');   // 房主(也是发送方)
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'target');  // 私聊目标
  await wait(250);
  const c3 = await wsConnect(room, 8099, 'other');   // 无关第三人
  await wait(250);

  // 房主私聊给 target
  wsSend(c1, { type: 'whisper', to: 'target', text: 'secret' });
  await wait(300);

  ok('目标收到 whisper(文本 secret)', hasFrame(c2, 'whisper', m => m.text === 'secret' && m.from === 'owner'));
  ok('目标收到 whisper 携带发送者身份', hasFrame(c2, 'whisper', m => m.name && m.from === 'owner'));
  ok('第三人未收到 whisper', !hasFrame(c3, 'whisper', m => m.text === 'secret'));
  ok('发送方自身未收到回显', !hasFrame(c1, 'whisper', m => m.text === 'secret'));

  // 目标不存在
  wsSend(c1, { type: 'whisper', to: 'ghost', text: 'x' });
  await wait(250);
  ok('目标不存在 -> error(no_such_client)', hasFrame(c1, 'error', m => m.code === 'no_such_client'));

  // 缺目标
  wsSend(c1, { type: 'whisper', text: 'y' });
  await wait(250);
  ok('缺目标 -> error(no_target)', hasFrame(c1, 'error', m => m.code === 'no_target'));

  c1.end(); c2.end(); c3.end();
  srv.kill();
  console.log('whisper: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
