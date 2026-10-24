/* 项目工作台上下文：只保存页面位置；名单、赛程和成绩由后台读取。
   报名闭环统一收敛到工作台“报名名单”，因此这里的链接函数是唯一入口。 */

export function matchingCategory(categories, current) {
  return categories.find(c => c.kind === current.kind && c.gender === current.gender && c.name === current.name)
    || categories.find(c => c.kind === current.kind && c.gender === current.gender)
    || categories.find(c => c.kind === current.kind) || categories[0];
}

export function workspaceTab(params = {}) {
  if (params.tab === 'preparation') return 'registration';
  if (params.tab === 'rankings') return 'results';
  /* 结构树重构兼容：旧 tasks/groups 收敛到概况/赛程，旧 review 由 workspace 跳转全局复核。 */
  if (params.tab === 'tasks') return 'overview';
  if (params.tab === 'groups') return 'schedule';
  return params.tab === 'schedule' && params.view === 'groups' ? 'schedule' : params.tab;
}

export function workspaceLink(category, tab, options = {}) {
  const params = { event: category.event_id, group: category.group_id, category: category.id, tab, ...options };
  params.tab = workspaceTab(params);
  if (params.tab !== 'schedule' || params.view === 'fixtures') delete params.view;
  return `#/workspace?${new URLSearchParams(params)}`;
}

/* 尚未开设项目的组别也要能维护学校与人员：不带 category，只用 group 定位。 */
export function groupWorkspaceLink(group, tab, options = {}) {
  return `#/workspace?${new URLSearchParams({ event: group.event_id,
    group: group.group_id ?? group.id, tab, ...options })}`;
}

/* 学校报名详情固定落在工作台报名名单页签，取消勾选时回到同一组别的学校列表。 */
export function workspaceSchoolLink({ eventId, groupId, categoryId = null, schoolId = null, profile = null }) {
  const params = { event: eventId, tab: 'registration' };
  if (groupId) params.group = groupId;
  if (categoryId) params.category = categoryId;
  if (schoolId) params.school = schoolId;
  if (profile === 'incomplete') params.profile = profile;
  return `#/workspace?${new URLSearchParams(params)}`;
}

const id = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`${label}参数无效`);
  return Number(value);
};

/* Validate explicit targets; remembered context can only fill an unspecified target. */
export function resolveSchoolContext(structure, params = {}, schoolData = null, remembered = null) {
  const eventId = id(params.event, '赛事');
  if (eventId && eventId !== structure.event.id) throw new Error('学校报名与当前赛事不一致');
  const groupId = id(params.group, '组别'), categoryId = id(params.category, '项目'), schoolId = id(params.school, '学校');
  const groups = structure.groups;
  const all = groups.flatMap(group => group.categories.map(category => ({ group, category })));
  const explicit = categoryId ? all.find(item => item.category.id === categoryId) : null;
  if (categoryId && !explicit) throw new Error('链接中的项目不属于当前赛事');
  if (groupId && !groups.some(group => group.id === groupId)) throw new Error('链接中的组别不属于当前赛事');
  if (schoolId && (!schoolData || schoolData.school?.id !== schoolId || schoolData.school.event_id !== structure.event.id
      || !groups.some(group => group.id === schoolData.group?.id))) throw new Error('学校不存在或不属于当前赛事');
  const schoolGroup = schoolId ? schoolData.group.id : null;
  if ((groupId && explicit && groupId !== explicit.group.id)
      || (schoolGroup && ((groupId && schoolGroup !== groupId) || (explicit && schoolGroup !== explicit.group.id)))) {
    throw new Error('学校、组别和项目不属于同一上下文');
  }
  const previous = all.find(item => item.category.id === Number(remembered));
  const group = groups.find(item => item.id === (groupId || schoolGroup || explicit?.group.id))
    || previous?.group || groups[0] || null;
  const category = explicit?.category
    || (previous && previous.group.id === group?.id ? previous.category : null) || group?.categories[0] || null;
  return { group, category, schoolId };
}
