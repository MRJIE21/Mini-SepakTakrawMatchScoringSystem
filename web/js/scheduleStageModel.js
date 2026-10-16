/* Display and local feedback only; the server owns validation and pairing. */
export const purposeName = { group: '小组赛', knockout: '淘汰赛', placement: '名次赛', manual: '手工比赛' };
export function stageLabel(stage) {
  const definition = stage.params?.schedule_meta?.definition;
  return definition?.purpose === 'placement' ? `${stage.name} · 第${definition.rank_from}—${definition.rank_to}名` : stage.name;
}
export function sourceLabel(source, pools, matchIds = {}) {
  if (source.type === 'pool_rank') return `${pools.find(p => p.id === source.pool_id)?.name || '小组'}第${source.rank}名`;
  if (source.type === 'bye') return '轮空';
  if (source.type === 'participation') return `参赛学校 ${source.participation_id}`;
  const id = source.match_id || matchIds[source.key];
  return `${id ? `M${String(id).padStart(3, '0')}` : `本阶段第${String(source.key || '').replace('n', '')}场`}${source.type === 'match_winner' ? '胜者' : '负者'}`;
}
export function rankRange(count, from, to) {
  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to - from + 1 !== count) {
    throw new Error(`请选择连续的 ${count} 个名次，名次范围由你填写`);
  }
  return { rank_from: from, rank_to: to };
}
