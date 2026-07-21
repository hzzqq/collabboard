# CollabBoard · 零依赖 WebSocket 协作白板

> 用 Node `net` 手写 RFC6455 WebSocket 协议（握手 / 帧 / 广播），配合 Canvas 实现的多人实时协作白板：房间隔离、多人光标、笔画/文字/图形、撤销重做、聊天、正在输入、磁盘持久化。**零第三方依赖**。

![tech](https://img.shields.io/badge/Node.net-RFC6455-fab387) ![deps](https://img.shields.io/badge/dependencies-0-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 特性

- **手写 WebSocket 服务端**：基于 Node `net`，从零实现 RFC6455 握手、帧编解码（掩码/分片）、广播，不依赖 `ws`。
- **房间命名空间隔离**：`?room=NAME` 按房间隔离画布与在线名单。
- **多人光标浮层**：实时同步其他用户光标位置与颜色。
- **绘图工具**：自由笔画、文字、矩形、椭圆（含填充开关）。
- **元素拖拽移动**：每个元素分配稳定 id，服务端 `move` 指令按 id 平移并广播（可撤销、落盘）。
- **群组移动**：`move` 支持 `ids` 数组一次平移多个元素，单 id 移动保持旧协议兼容（可撤销、落盘）。
- **图层顺序调整**：`zorder` 指令支持置顶(front) / 置底(back) / 上移(raise) / 下移(lower)，服务端权威重排 strokes 数组（选中组保持原相对堆叠序），入撤销栈、广播 `replace`、落盘。
- **图片元素**：支持插入 base64 图片到白板（体积限制 ~3MB），作为可移动 / 可撤销的元素。
- **房间锁定**：首个加入者为房主（owner），`lock/unlock` 仅房主可执行；锁定态下非房主的编辑被拒（仅回 `error` 不广播不入库），房主离开自动提拔下一位并解锁。
- **撤销 / 重做**：快照式 + `Ctrl+Z` / `Ctrl+Y`，跨端 `replace` 同步。
- **聊天 + 昵称 + 在线名单**：带昵称的聊天广播、在线用户列表、50 条历史补发。
- **正在输入指示**：`typing` 消息转发，页面显示「X 正在输入…」，静默 2s 自动收起。
- **心跳保活**：服务端定时 ping，未回 pong 销毁死连接；连接分配唯一颜色并下发 `welcome(id,color)`。
- **HTTP 管理 API**：`GET /api/health`、`/api/rooms`、`/api/room?name=`（非 WebSocket 的 GET 请求走 HTTP 路由）。
- **磁盘持久化**：抽 `store.js`，房间数据落盘 `rooms/`，重启不丢。
- **导出白板 JSON / SVG（矢量）**：页面一键导出当前画布快照（JSON），或导出无损矢量 SVG（`svg.js` 纯函数，含笔画 / 图形 / 文字 / 图片映射）。
- **克隆选中元素（duplicate）**：服务端深拷贝选中 strokes、分配新 id、偏移（+20,+20）、进撤销栈、广播 `replace`、落盘；客户端一键克隆。
- **旋转选中元素（rotate）**：服务端 `rotateElement` 绕组质心按 90° 整数倍旋转（矢量转点、文字 / 图片转锚点 + 累计 `rot`），进撤销栈、广播、落盘；客户端左右 90° 按钮 + 旋转渲染。
- **选择性删除（delete）**：服务端按 `ids` 从房间移除选中元素、进撤销栈、广播 `replace`、落盘（沿用正确撤销提交顺序）；客户端删除按钮 + 删除后清理选中集。
- **编辑已有文字（text-edit）**：服务端 `text` 消息携带已存在文字元素 id 时原地更新字段（保留 id/author）、进撤销栈、广播 `replace`、落盘；客户端非绘制工具下双击文字弹出编辑。
- **网格对齐（grid）**：`grid.js` 纯函数 `snapPoint`/`gridLines`，绘制（笔/擦/线框/文字）吸附到网格，开启时画布叠加淡网格线，网格尺寸可调（10/20/40/50）。
- **标记点 pin**：服务端 `pin` 消息（接收 x/y/label，分配 id、权威署名 author/authorColor，进撤销栈、广播、落盘），并纳入 EDIT_OPS 锁保护（锁定房间时非房主被拒）；客户端新增 📍 标记工具（点击落点）、彩色圆点 + 白边渲染。
- **箭头工具（arrow）**：新增 ↗ 箭头绘制工具，作为笔画 `tool='arrow'` 变体，接收 / 广播 / 快照落库 / 锁定保护全链路打通（箭头由两点 + 箭头端部构成，属持久化 stroke）。
- **临时激光笔（laser）**：新增 🔦 激光笔——按下拖动实时显示发光红点 + 光晕给他人看（临时、不落库、不受房间锁限制），松手即清；仅实时转发（不入 EDIT_OPS、不持久化），`laser_end` 主动清除远端光点。

## 🧱 技术栈

`Node.js` `net`（手写 WebSocket） · `Canvas 2D` · 零运行时依赖

## 🚀 运行

```bash
# 1. 启动服务端（默认 8080）
node server.js

# 2. 浏览器打开（多开窗口测试多人协作）
#    http://localhost:8080/index.html?room=demo
```

## 🧪 测试

二十三 套端到端测试（手写 WS / HTTP 客户端，测试独立端口避免与本机其他服务争用 8080）：

```bash
npm test
# 二十三 套端到端测试（手写 WS / HTTP 客户端），共 205/205 通过：
# _store_test      (6/6)   房间磁盘持久化
# _wb_text_test    (5/5)   文字工具 + 图形填充
# _move_test       (6/6)   元素拖拽移动（稳定 id / 广播 / 快照平移）
# _lock_test       (9/9)   房间锁定（房主判定 / 锁定广播 / 非房主编辑被拒 / 解锁）
# _image_test      (10/10) 图片元素（base64 / 体积上限 / 移动 / 撤销）
# _http_test       (7/7)   HTTP 管理 API
# _typing_test     (3/3)   正在输入广播
# _history_test    (11/11) 服务端权威撤销/重做
# _attr_test       (6/6)   服务端权威署名（防冒名）
# _reconnect_test  (7/7)   断线重连（指数退避 / 快照同步）
# _pressure_test   (5/5)   画笔压感
# _roomlist_test   (7/7)   活跃房间列表
# _multimove_test  (6/6)   群组移动（ids 数组 / 兼容单 id）
# _export_test     (19/19) 导出 SVG 矢量（笔画/图形/文字/图片映射 + XML 转义）
# _zorder_test     (9/9)   图层顺序（置顶/置底/上移/下移 / 群组保持相对序）
# _duplicate_test  (12/12) 克隆选中元素（深拷贝 / 新 id / 偏移 / 撤销 / 广播）
# _rotate_test     (15/15) 旋转选中元素（90° 整数倍 / 质心 / 撤销 / 渲染）
# _delete_test     (11/11) 选择性删除（ids 过滤 / 撤销两次还原）
# _text_edit_test  (6/6)   编辑已有文字（按 id 原地更新 / 撤销还原）
# _grid_test       (11/11) 网格对齐（snapPoint/gridLines / 绘制吸附）
# _pin_test        (10/10) 标记点 pin（广播 / 落盘 / 锁定后非房主被拒）
# _arrow_test      (9/9)   箭头工具（stroke 变体 / 广播 / 落库 / 锁定保护）
# _laser_test      (15/15) 临时激光笔（转发给他人 / 不回显自己 / laser_end / 不落库 / 锁定下仍广播）
```

## 🏗 架构

```
server.js
 ├─ net.createServer —— 原生 TCP
 ├─ WS 握手 (Sec-WebSocket-Accept) + 帧解析/组装
 ├─ httpServe() —— 非 WS 的 GET 走 HTTP 管理 API
 ├─ rooms Map —— 房间隔离 + presence + 50 条历史
 ├─ handleData() —— stroke/cursor/text/typing/chat/set_name/replace/move/zorder/duplicate/rotate/delete/pin/lock(unlock) 分发（编辑类 OP 受 lock 守卫）
 └─ 心跳 ping/pong + 死连接回收
store.js —— 房间数据 getRoom/落盘 (rooms/*.json)
index.html —— Canvas 绘图 + 多人光标 + 聊天 + 撤销重做 + 导出
```

## 📄 许可

MIT © hzzqq
