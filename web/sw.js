/* 离线页面资源：在线时优先取最新页面，断网时回退到已缓存副本（设计大纲 9.1、9.2）。
   比赛数据不在这里缓存：提交结果以服务器为准，未提交记录保存在 IndexedDB。 */
const CACHE = 'stss-shell-v49';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/manifest.webmanifest',
  '/js/main.js', '/js/api.js', '/js/store.js', '/js/ui.js', '/js/labels.js', '/js/scoring.js',
  '/js/dateTime.js',
  '/js/workspaceContext.js',
  '/js/bracketLayout.js', '/js/submit.js', '/js/pendingRequests.js',
  '/js/enrollmentImport.js',
  '/js/schoolRegistrationModel.js', '/js/views/schoolRegistration.js',
  '/js/schoolRegistrationImport.js',
  '/js/athletePicker.js', '/vendor/tom-select/tom-select.base.min.js',
  '/vendor/tom-select/tom-select.default.min.css',
  '/js/permissions.js', '/js/recordingOwner.js', '/js/schedulingFlow.js',
  '/js/groupDraw.js',
  '/js/setupModel.js',
  '/js/views/dashboard.js', '/js/views/setup.js', '/js/views/catalog.js', '/js/views/scheduling.js',
  '/js/views/workspace.js',
  '/js/views/field.js',
  '/js/views/scoring.js', '/js/views/matchAdmin.js', '/js/views/individual.js',
  '/js/views/review.js', '/js/views/results.js', '/js/views/bracket.js',
  '/js/views/school.js', '/js/views/admin.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // 接口不缓存

  event.respondWith(
    fetch(event.request).then((resp) => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      }
      return resp;
    }).catch(() => caches.match(event.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
