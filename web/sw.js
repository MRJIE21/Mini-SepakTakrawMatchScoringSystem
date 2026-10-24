/* 离线页面资源：在线时优先取最新页面与脚本（发布后刷新一次即可用上新版），
   断网时回退到已缓存副本（设计大纲 9.1、9.2）。
   比赛数据不在这里缓存：提交结果以服务器为准，未提交记录保存在 IndexedDB。 */
const CACHE = 'stss-shell-v99';
const NETWORK_TIMEOUT = 2000;
const SHELL = [
  '/', '/index.html', '/display.html', '/print.html', '/css/app.css', '/manifest.webmanifest',
  '/favicon.svg', '/favicon.ico',
  '/js/main.js', '/js/api.js', '/js/store.js', '/js/ui.js', '/js/labels.js', '/js/scoring.js',
  '/js/dateTime.js', '/js/display.js', '/js/displaySync.js', '/js/print.js',
  '/js/workspaceContext.js',
  '/js/resultCandidateEditor.js', '/js/resultReviewModel.js', '/js/views/resultReview.js',
  '/js/autoSchedule.js',
  '/js/individualDraw.js',
  '/js/bracketLayout.js', '/js/submit.js', '/js/pendingRequests.js',
  '/js/registrationId.js', '/js/schoolRegistrationModel.js', '/js/views/schoolRegistration.js',
  '/js/schoolRegistrationImport.js',
  '/js/athletePicker.js', '/vendor/tom-select/tom-select.base.min.js',
  '/vendor/tom-select/tom-select.default.min.css',
  '/js/permissions.js', '/js/recordingOwner.js', '/js/scheduleStageModel.js', '/js/groupNames.js',
  '/js/groupDraw.js',
  '/js/setupModel.js',
  '/js/teamRules.js', '/js/teamRulesEditor.js',
  '/js/views/dashboard.js', '/js/views/setup.js', '/js/views/catalog.js', '/js/views/schedule.js',
  '/js/views/workspace.js',
  '/js/views/field.js',
  '/js/views/scoring.js', '/js/views/matchAdmin.js', '/js/views/individual.js',
  '/js/views/review.js', '/js/views/results.js', '/js/views/bracket.js',
  '/js/views/school.js', '/js/views/admin.js', '/js/views/displayAdmin.js',
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

async function cachedFallback(request, cache) {
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const path = new URL(request.url).pathname;
  if (request.mode === 'navigate' || path === '/display.html') {
    return (await cache.match('/display.html')) || (await cache.match('/index.html')) || Response.error();
  }
  if (path.endsWith('.html')) return (await cache.match('/index.html')) || Response.error();
  return Response.error();
}

/* 页面与脚本网络优先：发布后刷新一次即可用上新版，避免旧外壳/旧脚本被缓存“钉住”；
   网络不可达或超时（2 秒）时立即回退缓存，保证断网仍能打开。 */
async function networkFirst(request, cache) {
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('shell-timeout')), NETWORK_TIMEOUT)),
    ]);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    return (await cachedFallback(request, cache)) || response;
  } catch (error) {
    return cachedFallback(request, cache);
  }
}

async function cacheFirst(request, cache) {
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (error) {
    return cachedFallback(request, cache);
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // 接口不缓存

  /* 外壳（HTML/JS/CSS）走网络优先：上一版这里是缓存优先，导致发布后第一次刷新
     仍是旧页面（曾表现为“已修复的问题依然存在”）。其余静态资源仍缓存优先。 */
  const shellRequest = event.request.mode === 'navigate' || url.pathname === '/'
    || url.pathname.endsWith('.html') || url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/');
  event.respondWith(
    caches.open(CACHE).then((cache) => (shellRequest ? networkFirst(event.request, cache)
      : cacheFirst(event.request, cache))),
  );
});
