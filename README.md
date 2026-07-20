# CollabBoard · 零依赖 WebSocket 协作白板

> 用 Node `net` 手写 RFC6455 WebSocket 协议（握手 / 帧 / 广播），配合 Canvas 实现的多人实时协作白板：房间隔离、多人光标、笔画/文字/图形、撤销重做、聊天、正在输入、磁盘持久化。**零第三方依赖**。

![tech](https://img.shields.io/badge/Node.net-RFC6455-fab387) ![deps](https://img.shields.io/badge/dependencies-0-blue) ![license](https://img.shields.io/badge/license-MIT-green)

---

## ✨ 特性

- **手写 WebSocket 服务端**：基于 Node `net`，从零实现 RFC6455 握手、帧编解码（掩码/分片）、广播，不依赖 `ws`。
- **房间命名空间隔离**：`?room=NAME` 按房间隔离画布与在线名单。
- **多人光标浮层**：实时同步其他用户光标位置与颜色。
- **绘图工具**：自由笔画、文字、矩形、椭圆（含填充开关）。
- **撤销 / 重做**：快照式 + `Ctrl+Z` / `Ctrl+Y`，跨端 `replace` 同步。
- **聊天 + 昵称 + 在线名单**：带昵称的聊天广播、在线用户列表、50 条历史补发。
- **正在输入指示**：`typing` 消息转发，页面显示「X 正在输入…」，静默 2s 自动收起。
- **心跳保活**：服务端定时 ping，未回 pong 销毁死连接；连接分配唯一颜色并下发 `welcome(id,color)`。
- **HTTP 管理 API**：`GET /api/health`、`/api/rooms`、`/api/room?name=`（非 WebSocket 的 GET 请求走 HTTP 路由）。
- **磁盘持久化**：抽 `store.js`，房间数据落盘 `rooms/`，重启不丢。
- **导出白板 JSON**：页面一键导出当前画布快照。

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

四套端到端测试（手写 WS / HTTP 客户端）：

```bash
node _store_test.js      # 房间磁盘持久化        6/6
node _wb_text_test.js     # 文字工具 + 图形填充    5/5
node _http_test.js        # HTTP 管理 API          7/7
node _typing_test.js      # 正在输入广播           3/3
# 或一次性跑全部：
npm test
```

## 🏗 架构

```
server.js
 ├─ net.createServer —— 原生 TCP
 ├─ WS 握手 (Sec-WebSocket-Accept) + 帧解析/组装
 ├─ httpServe() —— 非 WS 的 GET 走 HTTP 管理 API
 ├─ rooms Map —— 房间隔离 + presence + 50 条历史
 ├─ handleData() —— stroke/cursor/text/typing/chat/set_name/replace 分发
 └─ 心跳 ping/pong + 死连接回收
store.js —— 房间数据 getRoom/落盘 (rooms/*.json)
index.html —— Canvas 绘图 + 多人光标 + 聊天 + 撤销重做 + 导出
```

## 📄 许可

MIT © hzzqq
