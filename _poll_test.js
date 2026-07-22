// ci212 — CollabBoard 协作投票(poll)：create_poll / vote_poll(允许改票) / close_poll，
// 全员可见(含发起者)，缺参/越界/非发起者关闭/已关闭后投票均有正确报错。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  FAIL', n); } };
const room = 'poll_' + Date.now();

(async () => {
  const srv = spawnServer();
  await wait(300);
  const c1 = await wsConnect(room, 8099, 'owner');
  await wait(200);
  const c2 = await wsConnect(room, 8099, 'member');
  await wait(250);

  // 1) 发起投票（2 个选项）
  wsSend(c1, { type: 'create_poll', question: '晚餐吃啥?', options: ['火锅', '烧烤'] });
  await wait(300);
  const created = parseFrames(c1.buf).find(m => m.type === 'poll_created');
  ok('发起者收到 poll_created', !!created && created.poll);
  ok('选项正确(火锅/烧烤)', created && created.poll.options.length === 2 && created.poll.options[0].text === '火锅');
  ok('初始 total=0', created && created.poll.total === 0);
  const pid = created ? created.poll.pid : -1;
  ok('其他成员也收到 poll_created', hasFrame(c2, 'poll_created', m => m.poll && m.poll.pid === pid));

  // 2) 两人投票（owner→0, member→1）
  wsSend(c1, { type: 'vote_poll', pid, optionIndex: 0 });
  wsSend(c2, { type: 'vote_poll', pid, optionIndex: 1 });
  await wait(350);
  let upd = parseFrames(c1.buf).filter(m => m.type === 'poll_updated' && m.poll.pid === pid).pop();
  ok('投票后计票 火锅:1 烧烤:1 total=2', upd && upd.poll.options[0].votes === 1 && upd.poll.options[1].votes === 1 && upd.poll.total === 2);

  // 3) member 改票到 0
  wsSend(c2, { type: 'vote_poll', pid, optionIndex: 0 });
  await wait(300);
  upd = parseFrames(c1.buf).filter(m => m.type === 'poll_updated' && m.poll.pid === pid).pop();
  ok('改票后 火锅:2 烧烤:0 total=2', upd && upd.poll.options[0].votes === 2 && upd.poll.options[1].votes === 0);

  // 4) 缺选项 -> bad_args
  wsSend(c1, { type: 'create_poll', question: 'x', options: ['only'] });
  await wait(250);
  ok('选项不足 -> error(bad_args)', hasFrame(c1, 'error', m => m.code === 'bad_args'));

  // 5) 投票不存在的 poll -> no_such_poll
  wsSend(c1, { type: 'vote_poll', pid: 999999, optionIndex: 0 });
  await wait(250);
  ok('不存在 poll -> error(no_such_poll)', hasFrame(c1, 'error', m => m.code === 'no_such_poll'));

  // 6) 非发起者关闭 -> forbidden
  wsSend(c2, { type: 'close_poll', pid });
  await wait(250);
  ok('非发起者关闭 -> error(forbidden)', hasFrame(c2, 'error', m => m.code === 'forbidden'));

  // 7) 发起者关闭 -> closed:true
  wsSend(c1, { type: 'close_poll', pid });
  await wait(300);
  ok('发起者关闭 -> poll_updated closed', hasFrame(c1, 'poll_updated', m => m.poll.pid === pid && m.closed === true && m.poll.closed === true));

  // 8) 关闭后投票 -> poll_closed
  wsSend(c2, { type: 'vote_poll', pid, optionIndex: 1 });
  await wait(250);
  ok('关闭后投票 -> error(poll_closed)', hasFrame(c2, 'error', m => m.code === 'poll_closed'));

  // 9) 快照含 polls
  wsSend(c2, { type: 'request_snapshot' });
  await wait(250);
  ok('snapshot 含 polls', hasFrame(c2, 'snapshot', m => Array.isArray(m.polls) && m.polls.some(p => p.pid === pid)));

  c1.end(); c2.end();
  srv.kill();
  console.log('poll: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
