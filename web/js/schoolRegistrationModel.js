/* Pure draft/projection helpers. Persistent athlete and participation IDs stay intact. */
export const clone = (value) => structuredClone(value);
export const personValues = (p) => ({ key: p.key, name: p.name, gender: p.gender || '', jersey_no: p.jersey_no || '', note: p.note || '' });
export const projectValues = (p) => ({ category_id: p.category_id, choice: p.choice,
  members: p.members || [], captain_key: p.captain_key || '', athlete_key: p.athlete_key || '',
  seed_no: p.seed_no || null, note: p.note || '' });
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalizedName = value => String(value || '').trim().toLowerCase();
export function refreshPersonReview(base, model, person) {
  const name = normalizedName(person.name);
  const peers = model.people.filter(p => p.key !== person.key && normalizedName(p.name) === name);
  const candidates = base.people.filter(p => normalizedName(p.name) === name)
    .map(p => ({ id: p.id, rev: p.rev })).sort((a, b) => a.id - b.id);
  const signature = JSON.stringify([name, normalizedName(person.note), candidates,
    peers.map(p => [p.key, normalizedName(p.note)])]);
  if (person.reviewSignature !== undefined && person.reviewSignature !== signature) person.confirm_distinct_person = false;
  person.reviewSignature = signature;
  person.same_name_candidates = candidates;
  return peers;
}
export function hasPersonInput(form, defaultGender = '') {
  return !!form && (!!form.name?.trim() || !!form.note?.trim() || !!form.jersey_no?.trim()
    || (form.gender !== undefined && form.gender !== defaultGender));
}
export function removeNewPerson(model, key) {
  if (!key.startsWith('new:')) throw new Error('只能移除尚未提交的新增人员');
  const references = model.projects.filter(p => p.athlete_key === key || p.captain_key === key
    || p.members.some(m => m.athlete_key === key));
  if (references.some(p => p.choice === 'participate')) throw new Error('请先从项目中移除此人员');
  if (references.some(p => {
    const cat = model.categories.find(c => c.id === p.category_id);
    return cat?.roster_locked_reason || cat?.locked_reason;
  })) throw new Error('人员仍被已冻结的项目引用，请先核对项目名单');
  for (const p of references) {
    p.members = p.members.filter(m => m.athlete_key !== key);
    if (p.captain_key === key) p.captain_key = '';
    if (p.athlete_key === key) p.athlete_key = '';
  }
  model.people = model.people.filter(p => p.key !== key);
}
export function submission(base, model) {
  const people = model.people.filter((p) => {
    const old = base.people.find((x) => x.key === p.key);
    return !old || !equal(personValues(old), personValues(p));
  }).map((p) => ({ ...personValues(p), base_rev: p.rev,
    same_name_candidates: p.same_name_candidates, confirm_distinct_person: p.confirm_distinct_person }));
  const projects = model.projects.filter((p) => {
    const old = base.projects.find((x) => x.category_id === p.category_id);
    return !old || !equal(projectValues(old), projectValues(p));
  }).map(projectValues);
  return { event_identity: base.event_identity, base_hash: base.base_hash, people, projects };
}
export function occupancy(model) {
  const map = new Map();
  for (const p of model.projects.filter((x) => x.choice === 'participate')) {
    const cat = model.categories.find((x) => x.id === p.category_id);
    const keys = cat.kind === 'team' ? p.members.map((m) => m.athlete_key) : [p.athlete_key];
    for (const key of keys.filter(Boolean)) map.set(key, [...(map.get(key) || []), cat]);
  }
  return map;
}
export function eligibility(person, cat, model) {
  if (person.gender && person.gender !== cat.gender) return '性别与项目不符';
  const other = (occupancy(model).get(person.key) || []).filter((c) => c.id !== cat.id);
  return other.length ? `已参加${other.map((c) => c.name).join('、')}；先在原项目移除或退出` : '';
}

/* 本项目号码只允许 1—20 的整数；常用号码是不受限制的档案字段，
   不能原样带入项目号码，否则服务端预览会以 400 拒绝。 */
const JERSEY_PATTERN = /^([1-9]|1[0-9]|20)$/;
export function jerseyOrEmpty(value) {
  const text = String(value ?? '').trim();
  return JERSEY_PATTERN.test(text) ? text : '';
}

/* 统一的错误摘要：服务端 message + detail.fields 的具体说明（去重、去空）。 */
export function errorSummary(error) {
  const message = String(error?.message || error || '操作失败，请修正后重试').trim() || '操作失败，请修正后重试';
  const details = [];
  const fields = error?.detail?.fields;
  if (fields && typeof fields === 'object') {
    for (const value of Object.values(fields)) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text && text !== message && !details.includes(text)) details.push(text);
    }
  }
  return { message, details, text: [message, ...details].join('；') };
}

/* 预览前即可判定的服务端 400：返回需要用户先处理的问题，空数组表示可以提交预览。 */
export function localIssues(model) {
  const issues = [];
  const occupied = occupancy(model);
  for (const person of model.people || []) {
    const name = String(person.name || '').trim();
    if (!name) { issues.push('人员名单中有运动员未填写姓名，请补全后再预览'); break; }
    const conflicts = (occupied.get(person.key) || [])
      .filter((cat) => person.gender && cat.gender && person.gender !== cat.gender);
    if (conflicts.length) {
      issues.push(`「${name}」的性别与已报名项目「${conflicts.map((cat) => cat.name).join('、')}」不符，请先调整性别或项目名单`);
    }
  }
  for (const project of model.projects || []) {
    if (project.choice !== 'participate') continue;
    const cat = (model.categories || []).find((item) => item.id === project.category_id);
    if (!cat) continue;
    if (cat.kind === 'individual' && !project.athlete_key) {
      issues.push(`「${cat.name}」已选择参加报名，请先选择 1 名运动员`);
    }
    if (cat.kind === 'team') {
      const members = project.members || [];
      if (members.some((member) => !member.athlete_key)) issues.push(`「${cat.name}」队员名单不完整，请重新选择队员`);
      if (members.length > 6) issues.push(`「${cat.name}」最多 6 名队员`);
    }
    const seed = project.seed_no;
    if (seed !== null && seed !== undefined && String(seed).trim() !== '') {
      const value = Number(String(seed).trim());
      if (!Number.isInteger(value) || value <= 0) issues.push(`「${cat.name}」种子序号必须是正整数`);
    }
  }
  return issues;
}
export function reconcile(base, local, latest) {
  const merged = clone(latest), conflicts = [];
  for (const key of ['newPersonForms', 'importText']) if (key in local) merged[key] = clone(local[key]);
  for (const [list, key, values] of [['people', 'key', personValues], ['projects', 'category_id', projectValues]]) {
    for (const item of local[list]) {
      const old = base[list].find((x) => x[key] === item[key]);
      const remote = latest[list].find((x) => x[key] === item[key]);
      if (old && equal(values(old), values(item))) continue;
      if (!old || (remote && (equal(values(old), values(remote)) || equal(values(item), values(remote))))) {
        const index = merged[list].findIndex((x) => x[key] === item[key]);
        const retained = { ...item, ...(remote ? { rev: remote.rev } : {}) };
        if (index < 0) merged[list].push(retained); else merged[list][index] = retained;
      } else conflicts.push({ list, key: item[key], local: item, remote });
    }
  }
  return { merged, conflicts };
}
