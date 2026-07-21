const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8090;
// store.js 单元测试：save/load 往返 + text 保留 + 不存在返回 null + 删除。
const store = require('./store');
let pass = 0, fail = 0;
const ok = (n, c)=> c ? pass++ : (fail++, console.log('  FAIL', n));

const name = '__test_' + Date.now();
const data = {
  strokes: [ { tool:'pen', points:[{x:1,y:2}] }, { type:'text', text:'hi', x:3, y:4 } ],
  chats:   [ { type:'chat', name:'a', text:'yo' } ]
};
store.saveRoom(name, data);
const loaded = store.loadRoom(name);
ok('save/load 往返', loaded && loaded.strokes.length === 2 && loaded.chats.length === 1);
ok('text 标注保留', loaded.strokes.some(s => s.type === 'text' && s.text === 'hi'));
ok('chats 保留', loaded.chats[0].text === 'yo');
ok('不存在的房间返回 null', store.loadRoom('__nope_' + Date.now()) === null);

// 覆盖写入
store.saveRoom(name, { strokes: [], chats: [] });
ok('覆盖后清空', store.loadRoom(name).strokes.length === 0);

store.deleteRoom(name);
ok('删除后不存在', store.loadRoom(name) === null);

console.log(`\n[store] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
