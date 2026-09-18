/* CollabBoard 使用说明面板
 * 自包含组件：只注入自己的 DOM 与样式，不读写任何业务变量、不改动渲染逻辑。
 * 打开：右下角「?」按钮 / 键盘 ? / F1        关闭：Esc / 点遮罩 / 右上角 ×
 * 首次访问自动展开一次（localStorage 记住，之后不再自动弹）。
 */
(function () {
  'use strict';

  var STORE_KEY = 'collabboard.help.seen.v1';
  var TITLE = 'CollabBoard 使用说明';
  var SUBTITLE = '实时协作白板 · 零依赖 WebSocket';

  var SECTIONS = [
    {
      h: '这是什么',
      p: '一个<b>实时协作白板</b>：多人打开<b>同一个房间</b>，画笔、文字、图形、光标、表情会<b>即时同步</b>给房间里所有人。服务端用 Node 原生 WebSocket 手写，按房间隔离广播。',
      list: [
        '左栏是工具与房间管理，中间大画布是白板，右栏是聊天。',
        '想一起画，就把浏览器地址栏的链接（带 <code>?room=xxx</code>）发给同伴，或在左栏切换同一房间名。'
      ]
    },
    {
      h: '怎么一起协作',
      table: [
        ['设置昵称', '先填昵称再「设置」，同伴就能在在线名单里认出你'],
        ['同一房间', '房间名相同即同步；左栏「活跃房间」可一键切换'],
        ['房间锁定', '房主可锁定房间，仅房主可编辑；可转让房主、踢出用户'],
        ['在场感知', '能看到同伴的实时光标、选区虚线框、激光笔与表情回应']
      ]
    },
    {
      h: '连接与启动',
      table: [
        ['启动服务', '双击 start.bat，服务端在后台独立运行'],
        ['访问白板', '浏览器访问根路径 / 即可进入白板（server.js 会自动返回 index.html）'],
        ['断线重连', '连接断开时顶部会出现红色重连条，自动倒计时重连；点「立即重连」可马上尝试'],
        ['换端口', '手动用 PORT=xxx 启动 server.js，前端会自动跟随当前页面端口']
      ]
    },
    {
      h: '画图工具',
      table: [
        ['画笔 / 直线 / 矩形 / 椭圆 / 箭头 / 三角形 / 菱形', '常用形状（三角形与菱形持久化为矢量图元，可选中移动）'],
        ['文字', '点一下输入文字；双击已有文字可原地改字'],
        ['橡皮', '擦除（destination-out）'],
        ['选择 / 框选', '拖动移动单个元素；框选可多选，整组一起拖'],
        ['📍 标记 / 🔦 激光笔', '指向画布某处 / 临时红点指引，不落库'],
        ['💬 评论 / 🟨 便签', '给元素加评论角标；贴彩色便签卡'],
        ['🖼 插入图片', '选文件或 Ctrl+V 粘贴截图']
      ]
    },
    {
      h: '选中元素后能做什么',
      table: [
        ['选择 / 移动', '拖动画好的元素整体平移；松手同步给他人'],
        ['全选 / 取消选择', '一键选中全部（Ctrl+A），或清空选区（Esc）'],
        ['克隆 / 粘贴样式', '复制一份（Ctrl+D）；把首个选中元素的样式刷给其余元素'],
        ['编组 / 解组', '多元素合并成组，整体移动'],
        ['锁定 / 解锁', '房主锁定元素后，仅房主可编辑（画黄锁标记）']
      ]
    },
    {
      h: '排版与顺序',
      table: [
        ['对齐', '左 / 中 / 右 / 顶 / 中 / 底（需先选中 ≥2 个）'],
        ['均匀分布', '横向 / 纵向均布（需先选中 ≥3 个）'],
        ['图层顺序', '置顶 / 上移 / 下移 / 置底'],
        ['旋转', '左转 / 右转 90°'],
        ['删除选中', '移除当前选中的元素（Del / Backspace）']
      ]
    },
    {
      h: '导出与分享',
      table: [
        ['保存 PNG', '把白板导出成位图图片'],
        ['导出 SVG', '导出矢量图，放大不糊'],
        ['复制邀请链接', '把当前房间链接复制到剪贴板，发给同伴'],
        ['导出白板 JSON', '备份全部笔迹，可留档'],
        ['设背景 / 标题（房主）', '改看板底色与标题']
      ]
    },
    {
      h: '聊天与表情',
      table: [
        ['右侧聊天栏', '和同房间伙伴说话，回车发送；会显示「正在输入…」'],
        ['即时表情回应', '点 👍❤️😂🎉👀🔥 在画布中央浮出大号 emoji，纯在场反馈']
      ]
    },
    {
      h: '快捷键',
      table: [
        ['Ctrl + Z', '撤销'],
        ['Ctrl + Y', '重做'],
        ['Esc', '取消当前选择'],
        ['回车', '在聊天框按回车发送消息']
      ]
    },
    {
      h: '启动与遇到问题',
      table: [
        ['本地协作', '需要先起服务端：<code>node server.js</code>，再访问 <code>localhost:18080</code>'],
        ['只有我一个人 / 不同步', '检查 URL 里的 <code>room=</code> 是否一致；直接双击 html 只能本地画，不会联网同步'],
        ['连不上', '服务端没起、或端口 18080 被占用；看命令行报错'],
        ['画布点不动', '已兼容鼠标、触控笔、触摸屏与部分内嵌浏览器；若仍无响应，尝试用 Chrome/Edge 独立窗口打开']
      ]
    }
  ];

  /* ---------------- 以下为通用渲染逻辑（与各应用一致） ---------------- */

  function css() {
    return [
      '.wbh-fab{position:fixed;right:18px;bottom:18px;width:42px;height:42px;border-radius:50%;',
      'background:rgba(20,26,34,.92);color:#f78c6c;border:1px solid #2b3742;font:600 19px/1 ui-monospace,Menlo,Consolas,monospace;',
      'cursor:pointer;z-index:99998;display:flex;align-items:center;justify-content:center;',
      'box-shadow:0 6px 20px rgba(0,0,0,.45);transition:.16s;}',
      '.wbh-fab:hover{background:#16202b;color:#ffb199;transform:translateY(-2px);border-color:#f78c6c;}',
      '.wbh-mask{position:fixed;inset:0;background:rgba(4,7,11,.72);backdrop-filter:blur(3px);',
      'z-index:99999;display:none;align-items:center;justify-content:center;padding:26px;}',
      '.wbh-mask.on{display:flex;}',
      '.wbh-box{background:#11151c;border:1px solid #263140;border-radius:14px;max-width:760px;width:100%;',
      'max-height:84vh;overflow:auto;color:#cdd6e0;font:13.5px/1.72 ui-sans-serif,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
      'box-shadow:0 24px 70px rgba(0,0,0,.6);position:relative;}',
      '.wbh-hd{position:sticky;top:0;background:linear-gradient(180deg,#141a23,#11151c);padding:18px 22px 13px;',
      'border-bottom:1px solid #202a36;display:flex;align-items:baseline;gap:10px;}',
      '.wbh-hd h2{margin:0;font-size:18px;color:#eaf2f8;letter-spacing:.5px;}',
      '.wbh-hd .sub{font-size:12px;color:#6d7d8d;}',
      '.wbh-x{position:absolute;right:14px;top:13px;width:28px;height:28px;border-radius:7px;background:transparent;',
      'border:1px solid #2b3742;color:#8b9aa8;cursor:pointer;font-size:15px;line-height:1;}',
      '.wbh-x:hover{background:#1b2530;color:#e6f2f8;}',
      '.wbh-bd{padding:6px 22px 22px;}',
      '.wbh-sec{margin-top:19px;}',
      '.wbh-sec h3{margin:0 0 7px;font-size:13.5px;color:#f78c6c;letter-spacing:.6px;',
      'display:flex;align-items:center;gap:8px;}',
      '.wbh-sec h3::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,#22303c,transparent);}',
      '.wbh-sec p{margin:0 0 8px;color:#a9b8c6;}',
      '.wbh-sec ul{margin:0;padding-left:19px;color:#a9b8c6;}',
      '.wbh-sec li{margin:4px 0;}',
      '.wbh-sec b{color:#dce8f2;font-weight:600;}',
      '.wbh-t{width:100%;border-collapse:collapse;margin:2px 0 4px;}',
      '.wbh-t td{padding:6px 10px;border-bottom:1px solid #1c2530;vertical-align:top;color:#a9b8c6;}',
      '.wbh-t tr:last-child td{border-bottom:none;}',
      '.wbh-t td:first-child{width:34%;color:#dce8f2;font-weight:600;white-space:nowrap;}',
      '.wbh-bd code{background:#0b0f14;border:1px solid #1f2a35;border-radius:4px;padding:1px 6px;',
      'font:12px ui-monospace,Menlo,Consolas,monospace;color:#f78c6c;}',
      '.wbh-ft{margin-top:22px;padding-top:13px;border-top:1px solid #1c2530;color:#5f6f7e;font-size:12px;}',
      '@media(max-width:640px){.wbh-t td:first-child{width:42%;white-space:normal;}}',
      /* 首次访问的「非阻塞」提示条：仅占底部一小条，绝不覆盖画布/侧栏/聊天，永不锁死应用 */
      '.wbh-hint{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99997;',
      'display:flex;align-items:center;gap:10px;background:rgba(17,21,28,.96);color:#cdd6e0;',
      'border:1px solid #2b3742;border-radius:10px;padding:10px 14px;',
      'font:13px ui-sans-serif,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
      'box-shadow:0 8px 28px rgba(0,0,0,.5);max-width:min(90vw,640px);}',
      '.wbh-hint b{color:#f78c6c;}',
      '.wbh-hint-open{background:#f78c6c22;border:1px solid #f78c6c;color:#f78c6c;border-radius:8px;',
      'padding:5px 12px;cursor:pointer;font-size:12px;flex:none;}',
      '.wbh-hint-open:hover{background:#f78c6c33;}',
      '.wbh-hint-x{background:transparent;border:1px solid #2b3742;color:#8b9aa8;border-radius:6px;',
      'width:26px;height:26px;cursor:pointer;font-size:14px;line-height:1;flex:none;}',
      '.wbh-hint-x:hover{background:#1b2530;color:#e6f2f8;}'
    ].join('');
  }

  function esc(s) { return String(s); }

  function build() {
    var st = document.createElement('style');
    st.textContent = css();
    document.head.appendChild(st);

    var html = '<div class="wbh-box" role="dialog" aria-modal="true" aria-label="' + TITLE + '">' +
      '<div class="wbh-hd"><h2>' + TITLE + '</h2><span class="sub">' + SUBTITLE + '</span></div>' +
      '<button class="wbh-x" title="关闭 (Esc)">&times;</button><div class="wbh-bd">';

    SECTIONS.forEach(function (s) {
      html += '<div class="wbh-sec"><h3>' + esc(s.h) + '</h3>';
      if (s.p) html += '<p>' + s.p + '</p>';
      if (s.list) {
        html += '<ul>';
        s.list.forEach(function (li) { html += '<li>' + li + '</li>'; });
        html += '</ul>';
      }
      if (s.table) {
        html += '<table class="wbh-t"><tbody>';
        s.table.forEach(function (r) { html += '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; });
        html += '</tbody></table>';
      }
      if (s.p2) html += '<p>' + s.p2 + '</p>';
      html += '</div>';
    });

    html += '<div class="wbh-ft">随时按 <code>?</code> 或 <code>F1</code> 再次打开本说明 · <code>Esc</code> 关闭</div>';
    html += '</div></div>';

    var mask = document.createElement('div');
    mask.className = 'wbh-mask';
    mask.innerHTML = html;
    document.body.appendChild(mask);

    var fab = document.createElement('button');
    fab.className = 'wbh-fab';
    fab.textContent = '?';
    fab.title = '使用说明 (? 或 F1)';
    document.body.appendChild(fab);

    function open() { mask.classList.add('on'); }
    function close() { mask.classList.remove('on'); }
    function toggle() { mask.classList.contains('on') ? close() : open(); }

    fab.addEventListener('click', open);
    mask.querySelector('.wbh-x').addEventListener('click', close);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });

    document.addEventListener('keydown', function (e) {
      var t = e.target, tag = t && t.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
      if (e.key === 'Escape' && mask.classList.contains('on')) { close(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?' || e.key === 'F1') { e.preventDefault(); toggle(); }
    });

    try {
      if (!localStorage.getItem(STORE_KEY)) { firstVisitHint(); localStorage.setItem(STORE_KEY, '1'); }
    } catch (_) { /* 隐私模式下 localStorage 不可用，忽略 */ }

    // 首次访问提示：非阻塞小条，绝不弹出全屏遮罩锁死应用；点击可主动打开完整说明。
    function firstVisitHint() {
      var bar = document.createElement('div');
      bar.className = 'wbh-hint';
      bar.innerHTML = '<span>📖 首次使用 CollabBoard？点击右下角 <b>?</b> 随时查看完整使用说明</span>' +
        '<button class="wbh-hint-open" type="button">查看说明</button>' +
        '<button class="wbh-hint-x" type="button" title="不再提示">&times;</button>';
      document.body.appendChild(bar);
      var openBtn = bar.querySelector('.wbh-hint-open');
      var closeBtn = bar.querySelector('.wbh-hint-x');
      if (openBtn) openBtn.addEventListener('click', function () { open(); if (bar.parentNode) bar.parentNode.removeChild(bar); });
      if (closeBtn) closeBtn.addEventListener('click', function () { if (bar.parentNode) bar.parentNode.removeChild(bar); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
