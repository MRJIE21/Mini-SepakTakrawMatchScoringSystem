/* Pure draft/projection helpers. Persistent athlete and participation IDs stay intact. */
export const clone = (value) => structuredClone(value);
export const personValues = (p) => ({ key: p.key, name: p.name, gender: p.gender || '', jersey_no: p.jersey_no || '', note: p.note || '' });
export const projectValues = (p) => ({ category_id: p.category_id, choice: p.choice,
  members: p.members || [], captain_key: p.captain_key || '', athlete_key: p.athlete_key || '',
  seed_no: p.seed_no || null, note: p.note || '' });
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
