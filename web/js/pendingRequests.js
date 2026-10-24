/* Retain only an exact request whose outcome may be unknown, for idempotent retry.
   Unsaved form values are never stored or restored as application data. */
let scope = 'anonymous';
const active = new Map();

export function setPendingRequestScope(user, identity = null) {
  /* identity 可能来自 /api/events 的赛事对象（uuid 字段）或显式的 event_uuid；
     两种都接受，避免退化成 unidentified 而让不同赛事共用同一恢复包。 */
  const eventUuid = identity?.event_uuid || identity?.uuid || 'unidentified';
  scope = `${user?.username || 'anonymous'}:${identity?.deployment_id || 'unknown'}:${eventUuid}`;
}

export const capturePendingRequestScope = () => scope;
const keyFor = (formKey, prefix = 'stss_pending', storageScope = scope) => `${prefix}:${storageScope}:${formKey}`;
const isRequest = (value) => value && typeof value === 'object' && typeof value.request_uid === 'string' && !!value.request_uid;

/* 已结束（成功/被确定性拒绝）的恢复包不再需要：把 packet 与 done 墓碑成对删除，
   避免长期运行后 localStorage 被历史键占满（配额满会让启动缓存写入失败）。
   旧版仅写 done 墓碑、packet 永留的键在下次写入同一表单时一并清理。 */
function dropCompleted(frozenKey, uid) {
  try {
    localStorage.removeItem(`${frozenKey}:packet:${uid}`);
    localStorage.removeItem(`${frozenKey}:done:${uid}`);
  } catch { /* 存储不可用时忽略清理 */ }
}

function pruneCompleted(frozenKey, keepUid) {
  try {
    const donePrefix = `${frozenKey}:done:`;
    const stale = [];
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(donePrefix)) {
        const uid = key.slice(donePrefix.length);
        // 只有同时存在 v2 packet 的键才能安全成对删除；旧草稿回退依赖 done 墓碑。
        if (uid !== keepUid && localStorage.getItem(`${frozenKey}:packet:${uid}`)) stale.push(uid);
      }
    }
    for (const uid of stale) dropCompleted(frozenKey, uid);
  } catch { /* 存储不可用时忽略清理 */ }
}

export function readPendingRequest(formKey, storageScope = scope) {
  try {
    const frozenKey = keyFor(formKey, 'stss_pending', storageScope);
    const candidates = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${frozenKey}:packet:`)) {
        const value = JSON.parse(localStorage.getItem(key));
        if (isRequest(value) && !localStorage.getItem(`${frozenKey}:done:${value.request_uid}`)) candidates.push(value);
      }
    }
    if (candidates.length) { active.set(frozenKey, { key: frozenKey, uid: candidates[0].request_uid }); return candidates[0]; }
    const current = JSON.parse(localStorage.getItem(frozenKey) || 'null');
    if (isRequest(current) && !localStorage.getItem(`${frozenKey}:done:${current.request_uid}`)) { active.set(frozenKey, { key: frozenKey, uid: current.request_uid }); return current; }
    // Upgrade compatibility: accept only the original in-flight packet, never the old form model.
    const legacy = JSON.parse(localStorage.getItem(keyFor(formKey, 'stss_draft', storageScope)) || 'null')?.values?.pending;
    active.set(frozenKey, { key: frozenKey, uid: isRequest(legacy) ? legacy.request_uid : null });
    return isRequest(legacy) && !localStorage.getItem(`${frozenKey}:done:${legacy.request_uid}`) ? legacy : null;
  } catch { return null; }
}

export function writePendingRequest(formKey, request, storageScope = scope) {
  if (!isRequest(request)) return false;
  try {
    const frozenKey = keyFor(formKey, 'stss_pending', storageScope);
    const packetKey = `${frozenKey}:packet:${request.request_uid}`;
    if (localStorage.getItem(`${frozenKey}:done:${request.request_uid}`)) return false;
    const text = JSON.stringify(request), existing = localStorage.getItem(packetKey);
    if (existing && existing !== text) return false;
    localStorage.setItem(packetKey, text);
    active.set(frozenKey, { key: frozenKey, uid: request.request_uid });
    pruneCompleted(frozenKey, request.request_uid);
    return true;
  } catch { return false; }
}

export function removePendingRequest(formKey, storageScope = scope) {
  try {
    const known = active.get(keyFor(formKey, 'stss_pending', storageScope));
    if (known?.uid) {
      if (localStorage.getItem(`${known.key}:packet:${known.uid}`)) {
        // v2 恢复包已结束：成对删除，避免键长期累积；其他页面/其他账号的包不受影响。
        dropCompleted(known.key, known.uid);
        active.delete(known.key);
      } else {
        // 旧版草稿回退：原包保存在 stss_draft 中不可删除，只能写 done 墓碑抑制复活。
        localStorage.setItem(`${known.key}:done:${known.uid}`, '1');
      }
    }
    // Original packets stay immutable. Other pages' packets are not removed.
    return true;
  } catch { return false; }
}
