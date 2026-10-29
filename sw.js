// 离线缓存：首次打开后联网缓存全部文件，之后无网也能打开打卡。
// 改版时改一下 CACHE_NAME，前端会重新缓存新版。
var CACHE_NAME = 'perfect-day-v9';
var ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // 逐个缓存：以前是 addAll，一个文件失败整包安装失败、用户悄悄停在旧版。
      // 现在单个失败只跳过它，其余照常缓存，缺失的走网络兜底。
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(url).catch(function () {});
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE_NAME;
      }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (resp) {
        return resp;
      }).catch(function () {
        // 只有页面导航才回退到 index.html；以前是任何请求失败都回 index.html，
        // 离线时 JS/CSS 请求会拿到 HTML 当代码执行，直接报错。
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        throw new Error('offline');
      });
    })
  );
});
