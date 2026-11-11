/* 只读抽签展示：不生成结果，不写报名、成绩或配置。 */
export function drawPool(roster = [], revealed = []) {
  if (!Array.isArray(roster) || !Array.isArray(revealed)) throw new Error('抽签池数据读取不完整');
  const taken = new Set(revealed.map(row => row.participation_id ?? row.id));
  const seen = new Set();
  return roster.filter(row => {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || seen.has(row.id)) throw new Error('抽签池报名标识异常，请重新读取');
    seen.add(row.id);
    return (!row.status || row.status === 'active') && !taken.has(row.id);
  });
}

export function validateTeamDrawData(data, categoryId) {
  if (!data || !Object.hasOwn(data, 'draw') || !Array.isArray(data.history)) throw new Error('学校分组读取不完整');
  drawPool(data.roster);
  const draw = data.draw;
  if (!draw) return data;
  if (draw.category_id !== categoryId || !Number.isSafeInteger(draw.id)
      || !['drawing', 'complete', 'confirmed', 'cancelled'].includes(draw.status)
      || !Array.isArray(draw.capacities) || !Array.isArray(draw.groups) || !Array.isArray(draw.steps)
      || !Number.isSafeInteger(draw.total) || !Number.isSafeInteger(draw.revealed)
      || draw.steps.length !== draw.revealed || draw.revealed > draw.total
      || draw.groups.length !== draw.capacities.length
      || draw.groups.some(group => !Array.isArray(group.members))) throw new Error('学校分组结果异常，请重新读取');
  return data;
}

export function teamGroupResult(category, plan = null, data = null) {
  if (category.kind !== 'team') throw new Error('分组显示仅适用于三人赛项目');
  if (plan && plan.category_id !== category.id) throw new Error('正式分组与当前项目不一致');
  const stages = (plan?.stages || []).filter(stage => stage.params?.schedule_meta
    ? stage.params.schedule_meta.state === 'confirmed' : ['locked', 'running', 'archived'].includes(plan.status))
    .map(stage => ({ id: stage.id, name: stage.name, groups: (stage.pools || []).filter(pool => pool.kind === 'group') }))
    .filter(stage => stage.groups.length);
  if (stages.length) {
    return { source: 'schedule', label: '正式赛程分组', stages: stages.map(stage => {
      const seen = new Set();
      const groups = stage.groups.map(group => ({ id: group.id, name: group.name,
        members: group.members.map(member => {
          if (!Number.isSafeInteger(member.participation_id) || member.participation_id < 1 || seen.has(member.participation_id)
              || typeof member.display !== 'string' || !member.display.trim()) throw new Error('正式小组成员异常，请重新核对赛程');
          seen.add(member.participation_id);
          return { id: member.participation_id, name: member.display };
        }) }));
      return { ...stage, groups, total: seen.size };
    }) };
  }
  const manual = data?.manual_result;
  if (manual) {
    if (manual.category_id !== category.id) throw new Error('人工分组与当前项目不一致');
    if (manual.status !== 'current') return { source: 'none', stages: [], message: '人工分组对应的报名名单已变化，请核对后重新导入。' };
    return { source: 'manual', label: '人工分组结果 · 系统未做二次调整', stages: [{ name: `人工结果第 ${manual.revision} 版`,
      total: manual.entries.length, groups: manual.groups.map(g => ({ name: g.name,
        members: g.members.map(m => ({ id: m.id, name: m.school_name })) })) }] };
  }
  const draw = data?.draw;
  if (draw?.category_id !== undefined && draw.category_id !== category.id) throw new Error('抽签分组与当前项目不一致');
  if (!draw || draw.status !== 'confirmed' || draw.stale) return { source: 'none', stages: [],
    message: draw?.stale ? '抽签名单已变化，旧结果已失效，请重新核对。' : '' };
  const seen = new Set();
  const groups = draw.groups.map(group => ({ name: group.name, members: group.members.map(member => {
    if (!Number.isSafeInteger(member.participation_id) || seen.has(member.participation_id)) throw new Error('抽签分组成员异常，请重新读取');
    seen.add(member.participation_id);
    return { id: member.participation_id, name: member.school_name };
  }) }));
  if (seen.size !== draw.total) throw new Error('已确认分组名单不完整，请重新读取');
  return { source: 'draw', label: '已确认抽签分组 · 尚未建立正式小组',
    revision: draw.rev, stages: [{ name: `抽签 ${draw.id}`, groups, total: seen.size }] };
}
