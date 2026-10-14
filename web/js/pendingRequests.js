/* Retain only an exact request whose outcome may be unknown, for idempotent retry.
   Unsaved form values are never stored or restored as application data. */
let scope = 'anonymous';
const active = new Map();

export function setPendingRequestScope(user, identity = null) {
  scope = `${user?.username || 'anonymous'}:${identity?.deployment_id || 'unknown'}:${identity?.event_uuid || 'unidentified'}`;
}

export const capturePendingRequestScope = () => scope;
const keyFor = (formKey, prefix = 'stss_pending', storageScope = scope) => `${prefix}:${storageScope}:${formKey}`;
const isRequest = (value) => value && typeof value === 'object' && typeof value.request_uid === 'string' && !!value.request_uid;

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
    return true;
  } catch { return false; }
}

export function removePendingRequest(formKey, storageScope = scope) {
  try {
    const known = active.get(keyFor(formKey, 'stss_pending', storageScope));
    if (known?.uid) localStorage.setItem(`${known.key}:done:${known.uid}`, '1');
    // Original packets stay immutable. Other pages' packets are not removed.
    return true;
  } catch { return false; }
}
