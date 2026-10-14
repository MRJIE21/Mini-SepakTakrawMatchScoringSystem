/* 赛事设置的纯规则；展示状态只取正式结构，不读编辑控件或浏览器草稿。 */
export const PROJECT_PRESETS = Object.freeze([
  { kind: 'team', gender: 'male', name: '男子三人赛', hint: '记录逐分过程' },
  { kind: 'team', gender: 'female', name: '女子三人赛', hint: '记录逐分过程' },
  { kind: 'individual', gender: 'male', name: '男子个人赛', hint: '录入最终成绩' },
  { kind: 'individual', gender: 'female', name: '女子个人赛', hint: '录入最终成绩' },
].map(preset => Object.freeze({ ...preset, key: `${preset.gender}:${preset.kind}` })));

export function projectKey(project) { return `${project.gender}:${project.kind}`; }
export function existingProject(group, preset) {
  return (group.categories || []).find(item => projectKey(item) === projectKey(preset));
}
export function nameAfterChoice(value, generated, preset) {
  return { value: !value.trim() || value === generated ? preset.name : value, generated: preset.name };
}
export function participantLabel(category) {
  const count = Math.max(0, Number(category.participants) || 0);
  return `${count} ${category.kind === 'team' ? '队' : '人'}已报名`;
}
export function setupSummary(structure) {
  const groups = structure.groups || [];
  const projects = groups.reduce((count, group) => count + (group.categories || []).length, 0);
  const venues = (structure.venues || []).length;
  return {
    event: structure.event.start_date || structure.event.end_date ? '已填写日期 · 可继续修改' : '赛事已创建 · 日期可后补',
    structure: !groups.length ? '先添加组别，再开设项目' : `${groups.length} 个组别 · ${projects} 个项目${projects ? '' : ' · 待开设'}`,
    venues: venues ? `${venues} 个场地 · 全赛事共用` : '暂未添加 · 可后补',
  };
}
export function venueOrder(value, venues) {
  if (String(value).trim()) {
    const order = Number(value);
    if (!Number.isSafeInteger(order) || order < 0) throw new Error('顺序须为大于或等于 0 的整数');
    return order;
  }
  const highest = Math.max(0, ...venues.map(venue => Number(venue.seq)).filter(Number.isSafeInteger));
  if (highest === Number.MAX_SAFE_INTEGER) throw new Error('场地顺序已达上限，请指定较小的整数');
  return highest + 1;
}
