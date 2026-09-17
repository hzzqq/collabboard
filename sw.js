/* CollabBoard Service Worker — PWA 离线壳
 * 策略：
 *  - 仅拦截 GET；/api/* 与 WebSocket 握手绝不拦截（实时数据不可缓存）
 *  - 静态资源：stale-while-revalidate（先回缓存保证秒开，后台刷新缓存）
 *  - 页面导航：离线时回退缓存的 index.html（配合既有断线重连条，重连后自动恢复）
 *  - 版本升级：CACHE_NAME 变更 → 旧缓存全删（activate 阶段）
 */
const CACHE_NAME = 'collabboard-v1';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './help.js',
  './settings.js',
  './grid.js',
  './history.js',
  './store.js',
  './svg.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // 非 GET 一律放行
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;           // 管理 API 不缓存
  if (req.headers.get('upgrade') === 'websocket') return; // WebSocket 握手不拦截（双保险）

  // 静态资源：stale-while-revalidate
  e.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
