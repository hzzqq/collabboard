// _focus_element_test.js — ci336 CollabBoard 演示聚焦元素(focus_element/focus_element_off)
// 房主将某元素设为全员视图中心(演示模式)并广播；非房主报错；不存在元素报错；
// 隐性修复：被聚焦元素被删除时自动解除聚焦并广播 focus_element_off(reason:deleted)。
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const PORT = 8144;
const room = 'focus_' + Date.now();
const EL = 'fe:' + Date.now();   // 预置元素 id，便于引用/删除

(async ()=>{
  const srv = spawnServer({ PORT: String(PORT) });
  await wait(400);
  const c1 = await wsConnect(room, PORT, 'owner');   // 房主
  await wait(200);
  const c2 = await wsConnect(room, PORT, 'alice');   // 成员 A
  await wait(200);
  const c3 = await wsConnect(room, PORT, 'bob');     // 成员 B
  await wait(250);

  // 预置一个元素（房主画一笔，id 由客户端给定）
  wsSend(c1, { type:'stroke', stroke: { type:'stroke', id: EL, points:[[10,10],[20,20]], color:'#ffffff' } });
  await wait(300);
  ok('预置元素成功(echo stroke id 匹配)', hasFrame(c2, 'stroke', m => m.stroke && m.stroke.id === EL));

  // 房主聚焦该元素 -> 全员收到 focus_element_on
  wsSend(c1, { type:'focus_element', elId: EL });
  await wait(300);
  ok('房主聚焦 -> 全员收到 focus_element_on(elId 匹配)', hasFrame(c3, 'focus_element_on', m => m.elId === EL));
  ok('focus_element_on 含 by=owner', hasFrame(c2, 'focus_element_on', m => m.by === 'owner'));

  // 非房主聚焦 -> not_owner
  wsSend(c2, { type:'focus_element', elId: EL });
  await wait(250);
  ok('非房主聚焦 -> error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));

  // 不存在元素 -> no_such_element
  wsSend(c1, { type:'focus_element', elId: 'ghost' });
  await wait(250);
  ok('不存在元素 -> error(no_such_element)', hasFrame(c1, 'error', m => m.code === 'no_such_element'));

  // 非字符串 elId -> bad_elId
  wsSend(c1, { type:'focus_element', elId: 5 });
  await wait(250);
  ok('非字符串 elId -> error(bad_elId)', hasFrame(c1, 'error', m => m.code === 'bad_elId'));

  // 房主正常关闭聚焦 -> focus_element_off
  wsSend(c1, { type:'focus_element_off' });
  await wait(300);
  ok('房主关闭 -> focus_element_off(elId 匹配, by=owner)', hasFrame(c3, 'focus_element_off', m => m.elId === EL && m.by === 'owner'));

  // 无聚焦时关闭 -> no_focus
  wsSend(c1, { type:'focus_element_off' });
  await wait(250);
  ok('无聚焦时关闭 -> error(no_focus)', hasFrame(c1, 'error', m => m.code === 'no_focus'));

  // 隐性修复：重新聚焦后被聚焦元素被删除 -> 自动 focus_element_off(reason:deleted)
  wsSend(c1, { type:'focus_element', elId: EL });
  await wait(250);
  ok('再次聚焦成功', hasFrame(c2, 'focus_element_on', m => m.elId === EL));
  wsSend(c1, { type:'delete', ids: [EL] });
  await wait(350);
  const off = parseFrames(c2.buf).filter(m => m && m.type === 'focus_element_off' && m.reason === 'deleted');
  ok('聚焦元素被删除 -> 自动 focus_element_off(reason:deleted)', off.length >= 1 && off[0].elId === EL);

  c1.end(); c2.end(); c3.end();
  srv.kill();
  console.log('focus_element: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
