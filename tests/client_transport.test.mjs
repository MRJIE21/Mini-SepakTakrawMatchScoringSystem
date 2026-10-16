import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { api, setApiUser, setApiEventContext, captureRequestContext, payloadHash, validateReceipt } from '../web/js/api.js';
const values = new Map();
globalThis.localStorage = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
setApiUser({ id: 7 }); setApiEventContext({ event_id: 1, event_uuid: 'event-A', deployment_id: 'deployment' });
const context = captureRequestContext();
setApiEventContext({ event_id: 2, event_uuid: 'event-B', deployment_id: 'deployment' });
let headers;
globalThis.fetch = async (_path, options) => { headers = options.headers; return new Response('{}'); };
await api.post('/api/example', {}, { context });
assert.equal(headers['X-Event-UUID'], 'event-A'); assert.equal(headers['X-Client-Protocol'], '2');
assert.equal(headers['X-Actor-ID'], '7');
setApiUser({ id: 8 });
await assert.rejects(api.post('/api/example', {}, { context }), (error) => error.code === 'account_changed');
setApiUser({ id: 7 });
globalThis.fetch = async () => new Response('<html>broken</html>', { status: 200 });
await assert.rejects(api.post('/api/example'), (error) => error.code === 'invalid_response' && error.outcome_unknown);
globalThis.fetch = async () => new Response(JSON.stringify({ code: 'busy', outcome: 'not_committed' }), { status: 503 });
await assert.rejects(api.post('/api/example'), (error) => !error.outcome_unknown);
globalThis.fetch = (_path, options) => Promise.resolve(new Response(new ReadableStream({ start(controller) {
  controller.enqueue(new TextEncoder().encode('{'));
  options.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
} })));
await assert.rejects(api.post('/api/example', {}, { timeoutMs: 20 }), (error) => error.code === 'request_timeout' && error.outcome_unknown);
const cancel = new AbortController(); cancel.abort();
globalThis.fetch = async (_path, options) => { options.signal.throwIfAborted(); };
await assert.rejects(api.get('/api/old-page', { signal: cancel.signal }), (error) => error.cancelled && !error.offline);
// Simulate mobile browsers that support AbortController but lack the newer helper.
const abortHelper = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted');
Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, writable: true, value: undefined });
try {
  setApiUser(null);
  globalThis.fetch = async () => new Response(JSON.stringify({ token: 'mobile-token', user: { id: 7 } }));
  assert.equal((await api.post('/api/login', { username: 'mobile', password: 'isolated' })).token, 'mobile-token');
  const oldBrowserCancel = new AbortController();
  oldBrowserCancel.abort();
  // Even if a completed response wins the fetch race, the cancellation remains effective.
  await assert.rejects(api.get('/api/old-page', { signal: oldBrowserCancel.signal }),
    (error) => error.code === 'navigation_cancelled' && error.cancelled && !error.offline);
  globalThis.fetch = (_path, options) => Promise.resolve(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'));
    options.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
  } })));
  await assert.rejects(api.post('/api/login', { username: 'mobile', password: 'isolated' }, { timeoutMs: 20 }),
    (error) => error.code === 'request_timeout' && error.outcome_unknown && !error.cancelled && !error.offline);
} finally {
  if (abortHelper) Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', abortHelper);
  else delete AbortSignal.prototype.throwIfAborted;
  setApiUser({ id: 7 });
}
const payload = { submission_uid: 'fixed-uid', match_id: 1, 中文: '校队', events: [{ seq: 1, side: 'home' }] };
const canonical = JSON.stringify({ events: payload.events.map((e) => ({ seq: e.seq, side: e.side })), match_id: 1, submission_uid: 'fixed-uid', 中文: '校队' });
assert.equal(await payloadHash(payload), createHash('sha256').update(canonical).digest('hex'));
const receipt = { uid: 'fixed-uid', kind: 'match', subject_id: 1, applied_version: 1, status: 'confirmed', payload_hash: await payloadHash(payload) };
assert.equal((await validateReceipt({ receipt }, payload, 'match', 1)).uid, 'fixed-uid');
await assert.rejects(validateReceipt({ receipt: { ...receipt, subject_id: 2 } }, payload, 'match', 1), (error) => error.outcome_unknown);
await assert.rejects(validateReceipt({}, payload, 'match', 1), (error) => error.outcome_unknown);
console.log('PASS transport: frozen actor/event, protocol, malformed success, noncommit, body deadline, navigation cancel, legacy mobile AbortSignal, matching receipt');
