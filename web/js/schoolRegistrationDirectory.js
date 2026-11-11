/* 按学校报名模式的大组别分类与只读统计；不生成业务提交。 */
export function classifySchools(structure, schools) {
  const seen = new Set();
  for (const school of schools) {
    if (!Number.isSafeInteger(school.id) || school.event_id !== structure.event.id || seen.has(school.id)
        || !structure.groups.some(group => group.id === school.group_id)
        || !Number.isSafeInteger(school.athlete_count) || school.athlete_count < 0) {
      throw new Error('学校的大组别归属或参赛人员统计异常，请核对后重新读取');
    }
    seen.add(school.id);
  }
  return structure.groups.map(group => {
    const members = schools.filter(school => school.group_id === group.id);
    return { group, schools: members, peopleCount: members.reduce((sum, school) => sum + school.athlete_count, 0) };
  });
}

export function summarizeSchool(data, school, group) {
  if (data.school?.id !== school.id || data.school.event_id !== school.event_id || data.group?.id !== group.id
      || !Array.isArray(data.people) || !Array.isArray(data.projects) || !Array.isArray(data.categories)
      || !Array.isArray(data.warnings)) throw new Error('学校报名读取不完整，请重新读取');
  const people = new Map();
  for (const person of data.people) {
    if (person.school_id !== school.id || person.group_id !== group.id || !person.key || people.has(person.key)) {
      throw new Error('参赛人员的学校或大组别归属异常，请核对后重新读取');
    }
    people.set(person.key, person);
  }
  const registered = new Set(), rows = [], counts = { participate: 0, unresolved: 0, not_participating: 0, withdrawn: 0 };
  const categories = new Set();
  for (const project of data.projects) {
    const category = data.categories.find(item => item.id === project.category_id);
    if (!category || !group.categories.some(item => item.id === category.id) || categories.has(category.id)
        || !Object.hasOwn(counts, project.choice) || !Array.isArray(project.members)) {
      throw new Error('学校报名项目归属或状态异常，请核对后重新读取');
    }
    categories.add(category.id); counts[project.choice]++;
    const keys = project.choice === 'participate'
      ? (category.kind === 'team' ? project.members.map(member => member.athlete_key) : [project.athlete_key].filter(Boolean)) : [];
    if (keys.some(key => !people.has(key))) throw new Error('报名引用的参赛人员不存在，请核对后重新读取');
    keys.forEach(key => registered.add(key));
    rows.push({ category, project, people: keys.map(key => people.get(key)) });
  }
  if (categories.size !== group.categories.length) throw new Error('学校报名项目读取不完整，请重新读取');
  return { data, counts, rows, registeredCount: registered.size, peopleCount: people.size,
    warnings: data.warnings.length, people: [...people.values()].map(person => ({ ...person,
      registered: registered.has(person.key), projects: rows.filter(row => row.people.some(item => item.key === person.key)).map(row => row.category.name) })) };
}

export function schoolMatches(school, summary, query = '', status = 'all') {
  const keyword = query.trim().toLocaleLowerCase();
  if (keyword && !`${school.name} ${school.short_name || ''}`.toLocaleLowerCase().includes(keyword)) return false;
  if (status === 'all') return true;
  if (!summary) return false;
  if (status === 'participate') return summary.counts.participate > 0;
  if (status === 'unresolved') return summary.counts.unresolved > 0;
  if (status === 'incomplete') return summary.warnings > 0;
  return false;
}

export function selectedSchoolIds(value, schools, groupId, currentId = null) {
  if (!value) return [];
  const raw = String(value).split(',');
  const ids = raw.map(item => /^[1-9]\d*$/.test(item) ? Number(item) : NaN);
  if (ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length
      || ids.some(id => !schools.some(school => school.id === id && school.group_id === groupId))
      || currentId && !ids.includes(currentId)) throw new Error('所选学校不属于同一大组别，请重新选择学校');
  return ids;
}
