/* v2: atomic CAS, persistent generation fences, preserved recovery branches. */
const DRAFTS = 'drafts_v2', CACHE = 'packages_v2', RECOVERY = 'recovery_v2';
let dbPromise = null, storeUser = null;
const nonce = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const writer = nonce(), copy = (v) => v == null ? v : structuredClone(v);
const prefix = () => storeUser ? `user:${storeUser.id}:` : '';
const unwrap = (v, p) => v ? { ...v, key: v.key.startsWith(p) ? v.key.slice(p.length) : v.key } : null;
export class StorageError extends Error { constructor(code, message) { super(message); this.code = code; } }
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new StorageError('storage_unavailable', '浏览器存储不可用')); return; }
    const req = indexedDB.open('stss_local', 2);
    let rejected = false;
    req.onupgradeneeded = () => { for (const name of [DRAFTS, CACHE, RECOVERY]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'key' }); };
    req.onblocked = () => { rejected = true; reject(new StorageError('upgrade_blocked', '旧页阻塞升级：请保存或导出旧记录，关闭旧记录页后重载。')); };
    req.onsuccess = () => {
      if (rejected) { req.result.close(); return; }
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(new StorageError(req.error?.name === 'VersionError' ? 'upgrade_blocked' : 'storage_unavailable', req.error?.message || '浏览器存储不可用'));
  }).catch((error) => { dbPromise = null; throw error; });
  return dbPromise;
}
async function read(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly'), req = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
    let result;
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result ?? (key === undefined ? [] : null));
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('读取本机记录失败'));
  });
}
const lsKey = (key) => `stss_v2:${key}`;
function lsRead(key) { try { return JSON.parse(localStorage.getItem(lsKey(key)) || 'null'); } catch { return null; } }
function journal(value) {
  const key = `stss_branch:${value.key}:${writer}:${nonce()}`;
  try {
    localStorage.setItem(key, JSON.stringify({ ...copy(value), recovery_key: key, writer, storage_conflict: true }));
    if (!localStorage.getItem(key)) return false;
    const remove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const old = localStorage.key(i);
      if (old !== key && old?.startsWith(`stss_branch:${value.key}:${writer}:`)) {
        const item = JSON.parse(localStorage.getItem(old));
        if (!item.payload && !item.submission_unknown) remove.push(old);
      }
    }
    for (const old of remove) localStorage.removeItem(old);
    return true;
  } catch { return false; }
}
async function mutate(key, update, incoming = null, archivePrevious = false) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([DRAFTS, RECOVERY], 'readwrite'), store = tx.objectStore(DRAFTS), req = store.get(key);
      let result = null;
      req.onsuccess = () => {
        try {
          result = update(copy(req.result || null));
          if (result) {
            if (req.result && (archivePrevious && !req.result.terminal || req.result.receipt?.receipt_kind === 'candidate_received'))
              tx.objectStore(RECOVERY).put({ ...copy(req.result),
                key: `${key}:branch:${nonce()}`, original_key: key,
                review_archive: !!req.result.receipt, storage_conflict: !req.result.receipt });
            store.put(result);
          }
          else if (incoming) tx.objectStore(RECOVERY).put({ ...copy(incoming), key: `${key}:branch:${nonce()}`, original_key: key, storage_conflict: true });
        } catch (error) { reject(error); tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('本机保存事务失败'));
    });
  } catch (error) {
    if (error.code === 'upgrade_blocked') throw error;
    if (error.code !== 'storage_unavailable') throw error;
    if (!globalThis.indexedDB && globalThis.navigator?.locks?.request) return navigator.locks.request(`stss-v2:${key}`, { mode: 'exclusive' }, async () => {
      const result = update(lsRead(key));
      if (!result) { if (incoming) journal(incoming); return null; }
      if (lsRead(key) && (archivePrevious && !lsRead(key).terminal || lsRead(key).receipt?.receipt_kind==='candidate_received')
          && !journal({...lsRead(key),review_archive:!!lsRead(key).receipt}))
        throw new StorageError('storage_unavailable', '旧输入未能保留，请先导出再提交');
      localStorage.setItem(lsKey(key), JSON.stringify(result)); return result;
    });
    if (incoming) journal(incoming);
    throw new StorageError('storage_unavailable', '缺少可靠存储和跨页锁，已尽力保存独立恢复分支；请导出并恢复存储后提交。');
  }
}
export function setStoreUser(user) { storeUser = user; }
export function deviceName() {
  let name = localStorage.getItem('stss_device');
  if (!name) { name = `设备-${nonce().slice(0, 4).toUpperCase()}`; localStorage.setItem('stss_device', name); }
  return name;
}
export const localStore = {
  async cachePut(value) {
    const draft = { ...copy(value), key: prefix() + value.key, kind: 'package' };
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => { const tx = db.transaction(CACHE, 'readwrite'); tx.objectStore(CACHE).put(draft); tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
    } catch (error) {
      if (error.code === 'upgrade_blocked') throw error;
      try { localStorage.setItem(`stss_cache_v2:${draft.key}`, JSON.stringify(draft)); } catch { return null; }
    }
    return value;
  },
  async begin(value, previous = null) {
    const p = prefix(), key = p + value.key, owner = storeUser?.id;
    if (!value.event_identity || value.base_version == null) throw new StorageError('unverified_draft', '请核对最新场次版本后开始新记录');
    const saved = await mutate(key, (current) => {
      const replaceOrdinary = previous && current && !current.payload && !previous.payload
        && !current.storage_conflict && current.generation === previous.generation
        && current.revision === previous.revision && current.uid === previous.uid;
      if (current && ((!current.terminal && !replaceOrdinary) || current.payload && current.submission_unknown && !current.receipt)) return null;
      return { ...copy(value), key, owner_id: owner, generation: nonce(), revision: (current?.revision || 0) + 1, terminal: false, updated_at: new Date().toISOString() };
    }, { ...copy(value), key }, !!previous);
    if (saved) Object.assign(value, unwrap(saved, p)); return saved ? value : null;
  },
  async put(value) {
    if (value.kind === 'package') return this.cachePut(value);
    const p = prefix(), key = p + value.key;
    if (storeUser && value.owner_id && value.owner_id !== storeUser.id) throw new StorageError('wrong_owner', '请由原账号处理此记录');
    const incoming = { ...copy(value), key, owner_id: storeUser?.id || value.owner_id };
    const saved = await mutate(key, (current) => {
      if (!current || current.terminal || incoming.storage_conflict || current.generation !== incoming.generation || current.revision !== incoming.revision || current.uid !== incoming.uid) return null;
      return { ...incoming, revision: current.revision + 1, updated_at: new Date().toISOString() };
    }, incoming);
    if (saved) Object.assign(value, unwrap(saved, p)); return saved ? value : null;
  },
  async get(key) {
    const p = prefix(), full = p + key;
    try {
      const draft = await read(DRAFTS, full);
      if (draft) return draft.terminal ? null : unwrap(draft, p);
      const cached = await read(CACHE, full); if (cached) return unwrap(cached, p);
      const db = await openDb();
      const old = db.objectStoreNames.contains('drafts') ? await read('drafts', full) : null;
      let fallback; try { fallback = JSON.parse(localStorage.getItem(`stss_draft_${full}`) || 'null'); } catch { /* preserve original */ }
      const legacy = old || fallback;
      if (legacy?.kind === 'package') return unwrap(legacy, p);
      if (legacy) {
        const imported = { ...unwrap(legacy, p), base_version: legacy.base_version ?? 0 };
        if (old && fallback && (old.content_digest && fallback.content_digest ? old.content_digest !== fallback.content_digest : JSON.stringify(old) !== JSON.stringify(fallback))) {
          imported.storage_conflict = true; imported.legacy_copies = [copy(old), copy(fallback)];
        }
        if (imported.payload) { imported.submission_unknown = true; imported.status = 'failed'; }
        if (!imported.event_identity) return { ...imported, storage_conflict: true };
        return await this.begin(imported) || await this.get(key);
      }
    } catch (error) {
      if (error.code === 'upgrade_blocked') throw error;
      const draft = lsRead(full); if (draft) return draft.terminal ? null : unwrap(draft, p);
    }
    try { return unwrap(JSON.parse(localStorage.getItem(`stss_cache_v2:${full}`) || 'null'), p); } catch { return null; }
  },
  async all() {
    const p = prefix(); let drafts = [], branches = [];
    try { drafts = await read(DRAFTS); branches = await read(RECOVERY); }
    catch (error) { if (error.code === 'upgrade_blocked') throw error; }
    const db = await openDb().catch((e) => { if (e.code === 'upgrade_blocked') throw e; return null; });
    const legacy = db?.objectStoreNames.contains('drafts') ? await read('drafts') : [];
    for (const item of legacy.filter((d) => d.key.startsWith(p) && d.kind !== 'package' && d.status !== 'submitted')) {
      if (!drafts.some((d) => d.key === item.key)) {
        const migrated = await this.get(item.key.slice(p.length));
        if (migrated) drafts.push({ ...migrated, key: item.key });
      }
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      try {
        if (key?.startsWith('stss_branch:')) branches.push(JSON.parse(localStorage.getItem(key)));
        if (key?.startsWith('stss_v2:')) drafts.push(JSON.parse(localStorage.getItem(key)));
      } catch { /* preserve other records */ }
    }
    return [...drafts.filter((d) => !d.terminal || d.storage_conflict || d.receipt?.receipt_kind === 'candidate_received'),
      ...branches.map((d) => ({ ...d, key: d.original_key || d.key, storage_conflict: !d.review_archive }))]
      .filter((d) => d.key.startsWith(p) && d.kind !== 'package').map((d) => unwrap(d, p));
  },
  async remove(key, expected) {
    if (!expected?.generation) throw new StorageError('missing_generation', '记录已变化，请重新读取后处理');
    const full = (expected.owner_id ? `user:${expected.owner_id}:` : prefix()) + key;
    const saved = await mutate(full, (current) => !current || current.generation !== expected.generation || current.revision !== expected.revision ? null
      : { ...current, terminal: true, discarded: true, storage_conflict: !!current.submission_unknown,
        revision: current.revision + 1 });
    return !!saved;
  },
  async finalize(value, receipt) {
    if (receipt?.receipt_kind === 'candidate_received') return this.markReceived(value,receipt);
    if (receipt?.uid !== value.uid || receipt?.status !== 'confirmed') throw new StorageError('invalid_receipt', '收据不匹配，原请求保留待核实');
    const full = (value.owner_id ? `user:${value.owner_id}:` : prefix()) + value.key;
    const saved = await mutate(full, (current) => !current ? null : { ...current, terminal: true, receipt,
      finalized_generation: value.generation, storage_conflict: current.generation !== value.generation || current.uid !== receipt.uid,
      revision: current.revision + 1 });
    return !!saved;
  },
  async markReceived(value,receipt) {
    if (receipt?.receipt_kind!=='candidate_received' || receipt.uid!==value.uid || receipt.status!=='received')
      throw new StorageError('invalid_receipt','接收回执不匹配，原包保留');
    const full=(value.owner_id ? `user:${value.owner_id}:` : prefix())+value.key;
    const saved=await mutate(full,current=>!current || current.generation!==value.generation || current.uid!==receipt.uid ? null
      : {...current,terminal:true,status:'received',receipt,submission_unknown:false,revision:current.revision+1});
    if (saved) Object.assign(value,unwrap(saved,full.slice(0,full.length-value.key.length)));
    return !!saved;
  },
  async finishReview(value,receipt) {
    if (receipt?.receipt_kind!=='review_decision' || receipt.uid!==value.uid
        || !['approved','returned','withdrawn'].includes(receipt.status))
      throw new StorageError('invalid_receipt','复核回执不匹配，原决定保留');
    const p=value.owner_id ? `user:${value.owner_id}:` : prefix(),full=p+value.key;
    const saved=await mutate(full,current=>!current || current.generation!==value.generation || current.uid!==receipt.uid ? null
      : {...current,terminal:true,receipt,status:receipt.status,submission_unknown:false,revision:current.revision+1});
    if(saved)Object.assign(value,unwrap(saved,p));
    return !!saved;
  },
};
