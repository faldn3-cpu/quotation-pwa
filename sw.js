const CACHE_NAME = 'quote-draft-v15';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css?v=15',
  './app.js?v=15',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

// 安裝 Service Worker 並快取基礎靜態資源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 啟動 Service Worker 並強制清除所有舊版快取
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] 刪除舊快取儲存庫:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 攔截網路請求：
// 1. GAS / POST API -> Network Only (直接放行)
// 2. HTML 頁面 / 導向請求 -> Network First (網路優先，斷網才用快取)
// 3. 其他靜態資源 -> Stale-While-Revalidate (即時回傳快取並背景同步最新版)
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // 1. API 請求直接放行
  if (url.includes('script.google.com') || event.request.method === 'POST') {
    return;
  }

  const isNavigate = event.request.mode === 'navigate';
  const isHtml = event.request.headers.get('accept')?.includes('text/html');
  const isIndex = url.endsWith('/') || url.includes('index.html');

  // 2. HTML 主頁面與導向請求採用 Network First
  if (isNavigate || isHtml || isIndex) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 3. 其他靜態資源 (JS/CSS/字型) 採用 Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch((err) => {
          console.warn('[SW] 背景擷取靜態資源失敗:', err);
        });

      return cachedResponse || fetchPromise;
    })
  );
});

// 監聽背景同步事件
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-drafts') {
    event.waitUntil(syncDrafts());
  }
});

async function syncDrafts() {
  console.log('Background Sync: 正在上傳離線草稿...');
  const clients = await self.clients.matchAll();
  clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE' }));
}
