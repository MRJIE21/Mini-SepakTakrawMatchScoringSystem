/* 纯文本显示规则独立于 DOM，便于各页面复用和自动测试。 */
export function categoryLabel(category, { withGroup = false } = {}) {
  const name = category?.name || category?.category_name || '未命名项目';
  const gender = category?.gender || category?.category_gender;
  const genderText = { male: '男子', female: '女子' }[gender] || '';
  const named = genderText && !name.includes(genderText) ? `${genderText} · ${name}` : name;
  const group = category?.group_name ? category.group_name.split('：')[0] : '';
  return withGroup && group ? `${group} / ${named}` : named;
}
