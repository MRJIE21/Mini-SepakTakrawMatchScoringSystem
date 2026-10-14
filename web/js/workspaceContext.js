/* 项目导航只保存页面位置；名单、赛程和成绩由后台读取。 */
export function matchingCategory(categories, current) {
  return categories.find(c => c.kind === current.kind && c.gender === current.gender && c.name === current.name)
    || categories.find(c => c.kind === current.kind && c.gender === current.gender)
    || categories.find(c => c.kind === current.kind) || categories[0];
}

export function workspaceLink(category, tab, options = {}) {
  return `#/workspace?${new URLSearchParams({ event: category.event_id,
    group: category.group_id, category: category.id, tab, ...options })}`;
}
