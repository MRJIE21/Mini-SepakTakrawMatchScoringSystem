/* Apply an explicitly authorized, versioned local-data reset once per browser origin. */
let policy = null;
try {
  const response = await fetch('/baseline-state.json', { cache: 'no-store' });
  if (response.ok) policy = await response.json();
} catch { /* Offline startup cannot confirm a new reset policy. */ }

if (policy?.reset_id && localStorage.getItem('stss_baseline_reset') !== policy.reset_id) {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.filter(r => r.scope.startsWith(location.origin + '/')).map(r => r.unregister()));
  }
  if ('caches' in globalThis) {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('stss-')).map(key => caches.delete(key)));
  }
  if ('indexedDB' in globalThis) await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('stss_local');
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭本系统其他页面后刷新，以清理旧的本机记录。'));
  });
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) if (key.startsWith('stss_')) storage.removeItem(key);
  }
  localStorage.setItem('stss_baseline_reset', policy.reset_id);
}
