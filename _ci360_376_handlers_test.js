// _ci360_376_handlers_test.js — ci360/ci364/ci368/ci372/ci376 五个 handler 端到端验证
// ci360 typing：限频+幂等广播，不持久化
// ci364 emoji_reaction：全局表情，轻量存 room.reactions，广播全员
// ci368 timer：timer_start/pause/stop 维护 room.timer，服务端倒数广播 timer 帧
// ci372 vote：vote_create/cast/result 维护 room.votes，广播 vote 帧
// ci376 cursor_presence：高频光标节流广播
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');

let pass = 0, fail = 0;
const ok = (n, c) => { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
process.env.PORT = '8158';
const PORT = 8158;
const room = 'ci_' + Date.now();

const framesOf = (s, type, pred) =>
  parseFrames(s.buf).filter(m => m && m.type === type && (!pred || pred(m)));

(async () => {
  const srv = spawnServer({ PORT: String(PORT) });
  await wait(400);

  // ============ ci360 typing ============
  const t1 = await wsConnect(room, PORT, 'owner');
  await wait(150);
  const t2 = await wsConnect(room, PORT, 'alice');
  await wait(200);
  wsSend(t1, { type: 'set_name', name: '房主' });
  await wait(100);
  wsSend(t1, { type: 'typing', on: true });
  await wait(150);
  wsSend(t1, { type: 'typing', on: true });   // 幂等：状态未变，不应重复广播
  await wait(150);
  wsSend(t1, { type: 'typing', on: false });
  await wait(200);

  ok('ci360 c2 收到 typing on', hasFrame(t2, 'typing', m => m.on === true && m.id === 'owner' && m.name === '房主'));
  ok('ci360 发送者自身不回显 typing', !hasFrame(t1, 'typing'));
  ok('ci360 幂等：连续两次 typing on 仅广播一次', framesOf(t2, 'typing', m => m.on === true).length === 1);
  ok('ci360 c2 收到 typing off', hasFrame(t2, 'typing', m => m.on === false));

  // ============ ci364 emoji_reaction ============
  wsSend(t1, { type: 'emoji_reaction', emoji: '🎉' });
  await wait(250);
  ok('ci364 c2 收到 emoji_reaction(count=1)', hasFrame(t2, 'emoji_reaction', m => m.emoji === '🎉' && m.count === 1 && m.id === 'owner'));
  wsSend(t1, { type: 'emoji_reaction', emoji: '🎉' });
  await wait(250);
  ok('ci364 重复同表情 count=2', hasFrame(t2, 'emoji_reaction', m => m.emoji === '🎉' && m.count === 2));
  const beforeBad = framesOf(t2, 'emoji_reaction').length;
  wsSend(t1, { type: 'emoji_reaction' });   // 缺 emoji
  await wait(250);
  ok('ci364 缺 emoji -> 发送者收 error(bad_emoji)', hasFrame(t1, 'error', m => m.code === 'bad_emoji'));
  ok('ci364 缺 emoji 不广播给他人', framesOf(t2, 'emoji_reaction').length === beforeBad);

  // ============ ci368 timer ============
  wsSend(t1, { type: 'timer_start', seconds: 3 });
  await wait(1300);   // 观察服务端倒数 tick
  ok('ci368 c2 收到 timer start(remaining=3)', hasFrame(t2, 'timer', m => m.action === 'start' && m.remaining === 3 && m.running === true));
  ok('ci368 服务端倒数产生 timer tick(remaining<3)', hasFrame(t2, 'timer', m => m.action === 'tick' && m.remaining < 3 && m.running === true));
  // 迟到者快照应含 timer（隐性修复：snapshot 补齐 room.timer）
  const lateTimer = await wsConnect(room, PORT, 'carol');
  await wait(200);
  wsSend(lateTimer, { type: 'request_snapshot' });
  await wait(250);
  ok('ci368 迟到者 snapshot 含运行中的 timer', hasFrame(lateTimer, 'snapshot', m => m.timer && m.timer.running === true && m.timer.total === 3));
  wsSend(t1, { type: 'timer_pause' });
  await wait(250);
  ok('ci368 c2 收到 timer pause(running=false)', hasFrame(t2, 'timer', m => m.action === 'pause' && m.running === false && m.remaining > 0));
  wsSend(t1, { type: 'timer_stop' });
  await wait(250);
  ok('ci368 c2 收到 timer stop', hasFrame(t2, 'timer', m => m.action === 'stop'));
  wsSend(t2, { type: 'timer_pause' });   // 无计时器
  await wait(250);
  ok('ci368 无计时器 pause -> error(no_timer)', hasFrame(t2, 'error', m => m.code === 'no_timer'));

  // ============ ci372 vote ============
  wsSend(t1, { type: 'vote_create', question: '午饭吃啥', options: ['火锅', '日料'] });
  await wait(300);
  ok('ci372 c2 收到 vote create(2 选项,vid=1)', hasFrame(t2, 'vote', m => m.action === 'create' && m.vote.vid === 1 && m.vote.options.length === 2 && m.vote.question === '午饭吃啥'));
  wsSend(t2, { type: 'vote_cast', vid: 1, option: 0 });
  await wait(300);
  ok('ci372 投票后 cast 帧 option0.votes=1', hasFrame(t2, 'vote', m => m.action === 'cast' && m.vid === 1 && m.vote.options[0].votes === 1 && m.vote.total === 1));
  wsSend(t1, { type: 'vote_cast', vid: 1, option: 1 });
  await wait(300);
  ok('ci372 改投后 tally 正确(option0=1,option1=1,total=2)', hasFrame(t1, 'vote', m =>
    m.action === 'cast' && m.vid === 1 && m.vote.options[1].votes === 1 && m.vote.options[0].votes === 1 && m.vote.total === 2));
  // 迟到者快照应含 votes（隐性修复：snapshot 补齐 room.votes）
  const lateVote = await wsConnect(room, PORT, 'dave');
  await wait(200);
  wsSend(lateVote, { type: 'request_snapshot' });
  await wait(250);
  ok('ci372 迟到者 snapshot 含 votes[vid=1]', hasFrame(lateVote, 'snapshot', m => m.votes && m.votes['1'] && m.votes['1'].question === '午饭吃啥'));
  wsSend(lateVote, { type: 'vote_result', vid: 1 });
  await wait(250);
  ok('ci372 vote_result 广播 tally', hasFrame(t2, 'vote', m => m.action === 'result' && m.vid === 1 && m.vote.total === 2));
  wsSend(lateVote, { type: 'vote_cast', vid: 99, option: 0 });
  await wait(250);
  ok('ci372 不存在投票 -> error(no_such_vote)', hasFrame(lateVote, 'error', m => m.code === 'no_such_vote'));

  // ============ ci376 cursor_presence ============
  wsSend(t1, { type: 'cursor_presence', x: 10, y: 20 });
  await wait(80);
  ok('ci376 c2 收到 cursor_presence(x=10,y=20)', hasFrame(t2, 'cursor_presence', m => m.x === 10 && m.y === 20 && m.id === 'owner'));
  ok('ci376 发送者自身不回显 cursor_presence', !hasFrame(t1, 'cursor_presence'));
  // 节流：minInterval=300 内连发第二条应被丢弃，间隔足够后才广播第三条
  wsSend(t1, { type: 'cursor_presence', x: 10, y: 20, minInterval: 300 });   // 第一条已广播
  await wait(20);
  wsSend(t1, { type: 'cursor_presence', x: 11, y: 21, minInterval: 300 });   // 20ms<300 -> 丢弃
  await wait(350);
  wsSend(t1, { type: 'cursor_presence', x: 12, y: 22, minInterval: 300 });   // 距首条 ~370ms -> 广播
  await wait(250);
  ok('ci376 节流：300ms 内连发仅广播一次(累计 2 条，无 x=11)', framesOf(t2, 'cursor_presence').length === 2 && !hasFrame(t2, 'cursor_presence', m => m.x === 11));
  wsSend(t1, { type: 'cursor_presence' });   // 缺坐标
  await wait(250);
  ok('ci376 缺坐标 -> 发送者收 error(bad_coord)', hasFrame(t1, 'error', m => m.code === 'bad_coord'));
  ok('ci376 缺坐标不广播给他人', !hasFrame(t2, 'cursor_presence', m => typeof m.x !== 'number'));

  t1.destroy(); t2.destroy(); lateTimer.destroy(); lateVote.destroy();
  srv.kill();
  console.log(`\n[CollabBoard ci360-376 handlers] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
