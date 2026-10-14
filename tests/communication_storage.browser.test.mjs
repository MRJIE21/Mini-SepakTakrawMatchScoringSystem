/* Real Edge tabs and IndexedDB; isolated data, production server factory. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.STSS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const tempRoot = path.resolve(process.env.STSS_TEST_TMP || path.join(root, '..', 'tmp'));
await mkdir(tempRoot, { recursive: true });
const dataDir = await mkdtemp(path.join(tempRoot, 'stss-storage-browser-'));
const code = `
import json
from app import db, security
from app.http_server import Handler, load_routes, create_server
db.init_db()
conn=db.connect(); security.ensure_default_users(conn); conn.close(); load_routes()
class Quiet(Handler):
    def log_message(self,*args): pass
server=create_server(('127.0.0.1',0),Quiet)
print(json.dumps({'port':server.server_port}),flush=True)
server.serve_forever()
`;
const child = spawn(process.env.STSS_PYTHON || 'python', ['-u', '-c', code], { cwd: root, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STSS_DATA_DIR: dataDir, STSS_DB: path.join(dataDir, 'registry.db'),
    STSS_EVENTS_DIR: path.join(dataDir, 'events'), STSS_ADMIN_PASSWORD: 'BrowserTest123', PYTHONUTF8: '1' } });
let errors = '', browser;
child.stderr.on('data', (value) => { errors += value; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errors || 'server startup timeout')), 15000);
    child.once('error', reject); child.once('exit', (value) => reject(new Error(`server exited ${value}: ${errors}`)));
    let output = '';
    child.stdout.on('data', (value) => { output += value; try { const result = JSON.parse(output.split('\n')[0]); clearTimeout(timer); resolve(result.port); } catch {} });
  });
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ executablePath: process.env.STSS_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext();
  const a = await context.newPage(), b = await context.newPage();
  for (const page of [a, b]) {
    await page.goto(base);
    await page.evaluate(async () => { window.storage = await import('/js/store.js'); storage.setStoreUser({ id: 7, role: 'recorder' }); });
  }
  assert.equal(await a.evaluate(async () => {
    window.draft = { key: 'deployment:event:match:1', kind: 'match', match_id: 1, uid: 'fixed-uid', events: [], status: 'recording',
      base_version: 0, event_identity: { event_id: 1, event_uuid: 'event', deployment_id: 'deployment' } };
    return !!await storage.localStore.begin(draft);
  }), true);
  await b.evaluate(async () => { window.draft = await storage.localStore.get('deployment:event:match:1'); draft.events.push({ seq: 1, side: 'away' }); });
  assert.equal(await a.evaluate(async () => { draft.events.push({ seq: 1, side: 'home' }); return !!await storage.localStore.put(draft); }), true);
  assert.equal(await b.evaluate(async () => !!await storage.localStore.put(draft)), false);
  const records = await a.evaluate(async () => storage.localStore.all());
  assert.equal(records.find((d) => !d.storage_conflict).events[0].side, 'home');
  assert.equal(records.find((d) => d.storage_conflict).events[0].side, 'away');
  assert.equal(await a.evaluate(async () => storage.localStore.finalize(draft, { uid: 'fixed-uid', status: 'confirmed', applied_version: 1 })), true);
  assert.equal(await b.evaluate(async () => !!await storage.localStore.put(draft)), false);
  assert.equal(await a.evaluate(async () => storage.localStore.get(draft.key)), null);
  assert.equal(await a.evaluate(async () => {
    window.newDraft = { ...draft, uid: 'new-uid', base_version: 1, events: [], generation: undefined, revision: undefined };
    return !!await storage.localStore.begin(newDraft);
  }), true);
  assert.equal(await a.evaluate(async () => storage.localStore.finalize(draft, { uid: 'fixed-uid', status: 'confirmed', applied_version: 1 })), true);
  const late = await a.evaluate(async () => (await storage.localStore.all()).find((d) => d.uid === 'new-uid'));
  assert.equal(late.terminal, true); assert.equal(late.storage_conflict, true);
  assert.notEqual(late.generation, late.finalized_generation);
  console.log('PASS real two tabs: CAS preserves both scores, finalize fences stale put, late receipt preserves newer generation readonly');
  const ordinary = await a.evaluate(async () => {
    const old = { key: 'deployment:event:individual:9', kind: 'individual', uid: 'ordinary-old',
      result_value: 777, base_version: 0, event_identity: { event_uuid: 'event' } };
    await storage.localStore.begin(old);
    window.previousOrdinary = structuredClone(old);
    const next = { ...old, uid: 'explicit-submit', result_value: 55, payload: { submission_uid: 'explicit-submit' } };
    const saved = await storage.localStore.begin(next, old);
    const stale = await storage.localStore.put(previousOrdinary);
    const unsafe = await storage.localStore.begin({ ...next, uid: 'unsafe-replace' }, next);
    const all = await storage.localStore.all();
    return { saved: !!saved, stale: !!stale, unsafe: !!unsafe,
      preserved: all.some(d => d.uid === 'ordinary-old' && d.result_value === 777 && d.storage_conflict) };
  });
  assert.deepEqual(ordinary, { saved: true, stale: false, unsafe: false, preserved: true });
  console.log('PASS old ordinary input is archived atomically; stale writer and unknown packet cannot be replaced');
  await context.close();

  const upgradeContext = await browser.newContext(), old = await upgradeContext.newPage(), upgraded = await upgradeContext.newPage();
  await old.goto(base);
  await old.evaluate(async () => {
    const request = indexedDB.open('stss_local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
    window.legacyDb = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = legacyDb.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put({ key: 'user:7:deployment:event:match:2', kind: 'match', match_id: 2, uid: 'legacy-uid', status: 'recording',
      events: [{ seq: 1, side: 'home' }], base_version: 0, event_identity: { event_id: 1, event_uuid: 'event', deployment_id: 'deployment' } });
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    // Deliberately mimic v41: keep this connection open without onversionchange.
  });
  await upgraded.goto(base);
  assert.equal(await upgraded.evaluate(async () => {
    window.storage = await import('/js/store.js'); storage.setStoreUser({ id: 7 });
    try { await storage.localStore.get('deployment:event:match:2'); return 'unexpected'; } catch (error) { return error.code; }
  }), 'upgrade_blocked');
  assert.equal(await upgraded.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('stss_v2:'))), false);
  await old.close();
  const imported = await upgraded.evaluate(async () => storage.localStore.get('deployment:event:match:2'));
  assert.equal(imported.events[0].side, 'home'); assert.ok(imported.generation);
  console.log('PASS v41 connection: upgrade blocks safely without LS fallback, closing old tab allows preserved legacy migration');
  await upgradeContext.close();

  const degraded = await browser.newContext();
  await degraded.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined }); Object.defineProperty(navigator, 'locks', { value: undefined }); });
  const page = await degraded.newPage(); await page.goto(base);
  const result = await page.evaluate(async () => {
    const module = await import('/js/store.js'); module.setStoreUser({ id: 7 });
    let code;
    try { await module.localStore.begin({ key: 'deployment:event:match:3', uid: 'degraded', kind: 'match', events: [{ seq: 1, side: 'away' }], base_version: 0, event_identity: { event_uuid: 'event' } }); }
    catch (error) { code = error.code; }
    return { code, records: await module.localStore.all() };
  });
  assert.equal(result.code, 'storage_unavailable'); assert.equal(result.records[0].events[0].side, 'away'); assert.equal(result.records[0].storage_conflict, true);
  console.log('PASS no IndexedDB/WebLocks: immutable recovery branch retained, shared submission unavailable');
  await degraded.close();
} finally {
  await browser?.close(); child.kill();
  if (child.exitCode == null) await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2000); });
  assert.ok(path.resolve(dataDir).startsWith(tempRoot + path.sep));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
