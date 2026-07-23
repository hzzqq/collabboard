// _roster_star_layer_search_test.js — ci344/ci348/ci352/ci356 CollabBoard 四 handler e2e
//   ci344 list_members：成员名册仅回请求者（cid/name/status/isOwner/count）
//   ci348 star_element：元素收藏 toggle（广播 element_starred/unstarred + count，持久化 room.stars）
//   ci352 set_layer_name：房主命名图层（layer_name 广播，空名删除，非房主拒绝）
//   ci356 board_search：整板文本搜索（text/note/pin 命中，只回请求者，空词报错）
const { wsConnect, wsSend, hasFrame, parseFrames, wait, spawnServer } = require('./_wstest');
let pass = 0, fail = 0;
const ok = (n, c)=> { if(c) pass++; else { fail++; console.log('  FAIL', n); } };
const PORT = 8147;
const room = 'rsls_' + Date.now();

(async ()=>{
  const srv = spawnServer({ PORT: String(PORT) });
  await wait(400);
  const c1 = await wsConnect(room, PORT, 'owner');   // 房主
  await wait(200);
  const c2 = await wsConnect(room, PORT, 'alice');   // 成员
  await wait(250);

  // ===== ci344 list_members =====
  wsSend(c2, { type:'list_members' });
  await wait(300);
  ok('请求者收到 member_list(count=2)', hasFrame(c2, 'member_list', m => m.count === 2 && Array.isArray(m.members)));
  ok('member_list 含 owner 且 isOwner=true', hasFrame(c2, 'member_list', m => m.members.some(x => x.cid === 'owner' && x.isOwner === true)));
  ok('member_list 含 alice 且 isOwner=false', hasFrame(c2, 'member_list', m => m.members.some(x => x.cid === 'alice' && x.isOwner === false && x.status === 'online')));
  ok('名册不广播给他人', !hasFrame(c1, 'member_list', ()=> true));

  // 铺一个 text 元素供 star/search 用
  wsSend(c1, { type:'text', id: 'el_t1', x: 10, y: 20, text: '会议纪要 Roadmap 讨论' });
  wsSend(c1, { type:'note', id: 'el_n1', x: 30, y: 40, text: '待办：整理 roadmap 里程碑' });
  wsSend(c1, { type:'pin', id: 'el_p1', x: 50, y: 60, label: '关键位置' });
  await wait(300);

  // ===== ci348 star_element =====
  wsSend(c2, { type:'star_element', elId: 'el_t1' });
  await wait(300);
  ok('收藏 -> 全员收 element_starred(count=1)', hasFrame(c1, 'element_starred', m => m.elId === 'el_t1' && m.by === 'alice' && m.count === 1));
  ok('收藏者自己也收到广播', hasFrame(c2, 'element_starred', m => m.elId === 'el_t1'));
  wsSend(c1, { type:'star_element', elId: 'el_t1' });   // 第二人收藏
  await wait(300);
  ok('第二人收藏 -> count=2', hasFrame(c2, 'element_starred', m => m.by === 'owner' && m.count === 2));
  wsSend(c2, { type:'star_element', elId: 'el_t1' });   // toggle 取消
  await wait(300);
  ok('再点 toggle 取消 -> element_unstarred(count=1)', hasFrame(c1, 'element_unstarred', m => m.elId === 'el_t1' && m.by === 'alice' && m.count === 1));
  wsSend(c2, { type:'star_element', elId: 'ghost_el' });
  await wait(250);
  ok('收藏不存在元素 -> error(no_such_element)', hasFrame(c2, 'error', m => m.code === 'no_such_element'));
  wsSend(c2, { type:'star_element' });
  await wait(250);
  ok('缺 elId -> error(bad_elId)', hasFrame(c2, 'error', m => m.code === 'bad_elId'));

  // ===== ci352 set_layer_name =====
  wsSend(c2, { type:'set_layer_name', layerId: 'L1', name: '背景层' });
  await wait(250);
  ok('非房主命名 -> error(not_owner)', hasFrame(c2, 'error', m => m.code === 'not_owner'));
  ok('非房主命名不广播', !hasFrame(c1, 'layer_name', ()=> true));
  wsSend(c1, { type:'set_layer_name', layerId: 'L1', name: '背景层' });
  await wait(300);
  ok('房主命名 -> 全员收 layer_name', hasFrame(c2, 'layer_name', m => m.layerId === 'L1' && m.name === '背景层' && m.by === 'owner'));
  wsSend(c1, { type:'set_layer_name', layerId: 'L1', name: '' });
  await wait(300);
  ok('空名删除命名 -> layer_name(name=null)', hasFrame(c2, 'layer_name', m => m.layerId === 'L1' && m.name === null));
  wsSend(c1, { type:'set_layer_name', name: 'x' });
  await wait(250);
  ok('缺 layerId -> error(bad_layerId)', hasFrame(c1, 'error', m => m.code === 'bad_layerId'));

  // ===== ci356 board_search =====
  wsSend(c2, { type:'board_search', q: 'roadmap' });
  await wait(300);
  ok('搜索 roadmap 命中 2 条(不区分大小写)', hasFrame(c2, 'search_results', m => m.q === 'roadmap' && m.count === 2));
  ok('结果含 text 与 note 两类', hasFrame(c2, 'search_results', m => {
    const t = (m.results || []).map(r => r.type).sort().join(',');
    return t === 'note,text';
  }));
  ok('搜索结果不广播给他人', !hasFrame(c1, 'search_results', ()=> true));
  wsSend(c1, { type:'board_search', q: '关键' });
  await wait(300);
  ok('pin label 命中', hasFrame(c1, 'search_results', m => m.count === 1 && m.results[0].elId === 'el_p1' && m.results[0].type === 'pin'));
  wsSend(c1, { type:'board_search', q: '不存在的词xyz' });
  await wait(300);
  ok('无命中 -> count=0', hasFrame(c1, 'search_results', m => m.q === '不存在的词xyz' && m.count === 0));
  wsSend(c1, { type:'board_search', q: '   ' });
  await wait(250);
  ok('空关键词 -> error(bad_query)', hasFrame(c1, 'error', m => m.code === 'bad_query'));

  // ===== 快照一致性：迟到者拿 snapshot 应含 stars/layerNames 字段 =====
  wsSend(c1, { type:'set_layer_name', layerId: 'L2', name: '标注层' });
  await wait(250);
  const c3 = await wsConnect(room, PORT, 'carol');
  await wait(250);
  wsSend(c3, { type:'request_snapshot' });
  await wait(300);
  ok('snapshot 含 stars(el_t1 剩 owner)', hasFrame(c3, 'snapshot', m => m.stars && Array.isArray(m.stars.el_t1) && m.stars.el_t1.length === 1 && m.stars.el_t1[0] === 'owner'));
  ok('snapshot 含 layerNames(L2=标注层)', hasFrame(c3, 'snapshot', m => m.layerNames && m.layerNames.L2 === '标注层'));

  c1.destroy(); c2.destroy(); c3.destroy();
  srv.kill();
  console.log(`\n[CollabBoard roster/star/layer/search] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
