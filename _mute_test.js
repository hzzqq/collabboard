// CollabBoard 房主禁言/解禁测试：mute 仅房主可用、被禁言者 chat 被服务端拦截、unmute 恢复
const { wsConnect, wsSend, parseFrames, hasFrame, wait, spawnServer } = require('./_wstest');

let pass = 0, fail = 0;
function ok(name, cond){ if(cond) pass++; else { fail++; console.log('  FAIL', name); } }

(async ()=>{
  const server = spawnServer();
  await wait(700);
  try {
    const c1 = await wsConnect('muteRoom');   // 房主
    const c2 = await wsConnect('muteRoom');   // 被禁言者
    await wait(200);
    const wel = parseFrames(c2.buf).find(m => m.type === 'welcome');
    const c2id = wel ? wel.id : null;
    ok('拿到 c2 的 id', !!c2id);

    // 1. 房主禁言
    wsSend(c1, { type:'mute', toId: c2id });
    await wait(400);
    ok('被禁言者 c2 收到 you_muted', hasFrame(c2, 'you_muted'));
    ok('房主 c1 收到 muted(含 id)', hasFrame(c1, 'muted', m => m.id === c2id));

    // 2. 被禁言者发聊天 -> 服务端拦截，仅回 error，他人收不到
    wsSend(c2, { type:'chat', text:'我是被禁言的' });
    await wait(300);
    ok('被禁言者收到 error(muted)', hasFrame(c2, 'error', m => m.code === 'muted'));
    ok('房主未收到被禁言者的 chat', !hasFrame(c1, 'chat', m => m.text === '我是被禁言的'));

    // 3. 非房主禁言 -> 报错
    wsSend(c2, { type:'mute', toId: 'nope' });
    await wait(300);
    ok('非房主 mute 返回 not_owner', hasFrame(c2, 'error', m => m.code === 'not_owner'));

    // 4. 房主解禁
    wsSend(c1, { type:'unmute', toId: c2id });
    await wait(400);
    ok('被禁言者 c2 收到 you_unmuted', hasFrame(c2, 'you_unmuted'));
    ok('房主 c1 收到 unmuted(含 id)', hasFrame(c1, 'unmuted', m => m.id === c2id));

    // 5. 解禁后可正常聊天
    wsSend(c2, { type:'chat', text:'解禁后可以发言了' });
    await wait(300);
    ok('解禁后房主收到 chat', hasFrame(c1, 'chat', m => m.text === '解禁后可以发言了'));
  } catch(e){ fail++; console.log('  FAIL 异常', e.message); }
  finally { server.kill(); }

  console.log(`\n[CollabBoard mute] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
