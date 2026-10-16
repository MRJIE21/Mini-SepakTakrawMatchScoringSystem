/* 接口访问封装：统一处理令牌、错误与下载。 */
const TOKEN_KEY = 'stss_token';
let eventContext = null;
let readScope = null;
let apiUser = null;
let verifiedToken = '';
export function setApiUser(user) { apiUser = user ? { id: user.id, username: user.username } : null; verifiedToken = getToken(); }
export function setApiReadScope(scope) { readScope = scope; }
export function captureRequestContext() {
  return Object.freeze({ identity: getApiEventContext(), user_id: apiUser?.id,
    auth_fingerprint: apiUser ? sha256(new TextEncoder().encode(verifiedToken)) : null });
}
export function recordRequestContext(record) {
  return { ...captureRequestContext(), identity: record.event_identity, user_id: record.owner_id || apiUser?.id };
}
export function readRequestOptions() { return readScope ? { signal: readScope.signal, context: readScope.context } : {}; }

export function setApiEventContext(context) {
  eventContext = context ? Object.freeze({
    event_id: Number(context.event_id || context.id),
    event_uuid: context.event_uuid || context.uuid || '',
    deployment_id: context.deployment_id || '',
  }) : null;
}

export function getApiEventContext() { return eventContext ? { ...eventContext } : null; }

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || `请求失败（${status}）`);
    this.status = status;
    this.code = payload?.code || 'error';
    this.detail = payload?.detail || null;
    this.outcome_unknown = payload?.outcome !== 'not_committed' && status >= 500;
    this.not_committed = payload?.outcome === 'not_committed';
  }
}

async function request(method, path, body, options = {}) {
  const scopeOptions = method === 'GET' ? readRequestOptions() : {};
  options = { ...scopeOptions, ...options };
  const frozen = options.context || captureRequestContext();
  if (frozen.user_id !== apiUser?.id || frozen.auth_fingerprint && frozen.auth_fingerprint !== sha256(new TextEncoder().encode(getToken()))) {
    throw new ApiError(409, { code: 'account_changed', message: '账号已切换，请使用原账号核实此提交', outcome: 'not_committed' });
  }
  const context = frozen.identity;
  const headers = { 'Content-Type': 'application/json' };
  headers['X-Client-Protocol'] = '2';
  if (frozen.user_id != null) headers['X-Actor-ID'] = String(frozen.user_id);
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (context?.event_id) headers['X-Event-ID'] = String(context.event_id);
  if (context?.event_uuid) headers['X-Event-UUID'] = context.event_uuid;
  if (context?.deployment_id) headers['X-Deployment-ID'] = context.deployment_id;
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? (method === 'GET' ? 10000 : 30000));
  try {
    const resp = await fetch(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await readBoundedText(resp, controller, options.maxBytes ?? 8 * 1024 * 1024);
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw new ApiError(resp.status, { code: 'invalid_response', message: '服务器响应不完整，请核实原提交结果' });
    }
    if (!payload || typeof payload !== 'object') throw new ApiError(resp.status, { code: 'invalid_response', message: '服务器返回了无效数据' });
    if (!resp.ok) throw new ApiError(resp.status, payload);
    if (options.validate) await options.validate(payload);
    // Older mobile browsers expose AbortController without throwIfAborted.
    if (controller.signal.aborted) throw controller.signal.reason || new DOMException('请求已取消', 'AbortError');
    return payload;
  } catch (err) {
    const cancelled = options.signal?.aborted && !timedOut;
    const e = err instanceof ApiError ? err : new ApiError(0, {
      code: cancelled ? 'navigation_cancelled' : timedOut ? 'request_timeout' : 'network_error',
      message: cancelled ? '已取消旧页面读取' : timedOut ? '请求超时；提交结果需核实，请用原内容重试' : '网络不可用，请检查连接后重试',
    });
    e.cancelled = cancelled;
    e.offline = !cancelled && !timedOut && e.status === 0;
    if (method !== 'GET' && (e.status === 0 || e.status >= 500 && !e.not_committed || e.code === 'invalid_response')) e.outcome_unknown = true;
    throw e;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function readBoundedText(resp, controller, maxBytes) {
  if (!resp.body?.getReader) return resp.text();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { controller.abort(); throw new ApiError(0, { code: 'invalid_response', message: '响应超过安全大小，请缩小查询范围' }); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body = {}, options) => request('POST', path, body, options),
  put: (path, body = {}, options) => request('PUT', path, body, options),
  del: (path, body = {}, options) => request('DELETE', path, body, options),
};

export async function payloadHash(payload) {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(payload)));
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  return sha256(bytes); // LAN HTTP may not expose SubtleCrypto.
}
function sha256(bytes) {
  const initial = [], constants = [];
  for (let n = 2; constants.length < 64; n++) {
    let prime = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (initial.length < 8) initial.push((Math.sqrt(n) % 1 * 0x100000000) | 0);
    constants.push((Math.cbrt(n) % 1 * 0x100000000) | 0);
  }
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes); data[bytes.length] = 128;
  const view = new DataView(data.buffer), words = new Int32Array(64);
  view.setUint32(data.length - 8, Math.floor(bytes.length / 0x20000000)); view.setUint32(data.length - 4, (bytes.length * 8) >>> 0);
  const rotate = (v, n) => (v >>> n) | (v << (32 - n));
  const h = initial;
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = (words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}
export async function validateReceipt(result, payload, kind, subjectId) {
  const receipt = result?.receipt;
  if (!receipt || receipt.uid !== (payload.submission_uid || payload.request_uid) || receipt.kind !== kind
      || Number(receipt.subject_id) !== Number(subjectId) || receipt.status !== 'confirmed'
      || !Number.isInteger(receipt.applied_version) || receipt.payload_hash !== await payloadHash(payload)) {
    const error = new ApiError(200, { code: 'invalid_response', message: '成功收据不匹配，原提交仍待核实' });
    error.outcome_unknown = true; throw error;
  }
  return receipt;
}

/* 下载类接口（导出 CSV / 记录表 / 备份）：用请求头带令牌，避免令牌出现在 URL 中 */
function buildUrl(path, query) {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

function filenameFromDisposition(header, fallback) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header || '');
  if (!m) return fallback;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

async function fetchBlob(path, query, frozen = captureRequestContext()) {
  if (frozen.user_id !== apiUser?.id || frozen.auth_fingerprint && frozen.auth_fingerprint !== sha256(new TextEncoder().encode(getToken()))) {
    throw new ApiError(409, { code: 'account_changed', message: '账号已切换，请返回原账号核对下载', outcome: 'not_committed' });
  }
  const context = frozen.identity;
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (context?.event_id) headers['X-Event-ID'] = String(context.event_id);
  if (context?.event_uuid) headers['X-Event-UUID'] = context.event_uuid;
  if (context?.deployment_id) headers['X-Deployment-ID'] = context.deployment_id;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
  const resp = await fetch(buildUrl(path, query), { headers, signal: controller.signal });
  if (!resp.ok) {
    let message = `下载失败（${resp.status}）`;
    try { message = (await resp.json()).message || message; } catch { /* 保留默认提示 */ }
    throw new ApiError(resp.status, { message });
  }
  return { blob: await resp.blob(), filename: filenameFromDisposition(resp.headers.get('Content-Disposition'), '') };
  } finally { clearTimeout(timer); }
}

export async function download(path, query = {}, fallbackName = 'download', { isCurrent = () => true } = {}) {
  if (!isCurrent()) return;
  const { blob, filename } = await fetchBlob(path, query);
  if (!isCurrent()) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || fallbackName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* 打印用 HTML：先同步开窗（避免被拦截），再写入带令牌请求到的内容 */
export async function openHtml(path, query = {}, title = '', options = {}) {
  const win = window.open('', '_blank');
  let blob;
  try { ({ blob } = await fetchBlob(path, query, options.context)); }
  catch (error) { win?.close(); throw error; }
  const html = await blob.text();
  if (!win) throw new ApiError(0, { message: '浏览器拦截了新窗口，请允许弹出窗口后重试' });
  if (options.isCurrent && !options.isCurrent()) { win.close(); return null; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  if (title) win.document.title = title;
  return win;
}

/* 记录端本地提交标识 */
export function newUid(prefix = 'sub') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
