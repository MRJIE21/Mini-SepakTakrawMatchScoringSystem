/* 常用赛程表单与现有阶段协议之间的转换；不改变服务端编排规则。 */
export const defaultFlow = (count) => ({
  format: count >= 4 ? 'groups' : 'knockout', groups: 2, qualifiers: 2,
  legs: 1, assign: 'snake', third: true,
});

export function groupName(index, suffix = '组') {
  let letters = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + (value - 1) % 26) + letters;
  }
  return letters + suffix;
}

export function seedOrder(size) {
  if (size === 1) return [1];
  let order = [1, 2];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((seed) => [seed, next + 1 - seed]);
  }
  return order;
}

export function flowPreview(flow, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('至少报名 1 支队伍后才能编排。');
  if (!['groups', 'league', 'knockout'].includes(flow.format)) throw new Error('请选择比赛流程。');
  const grouped = flow.format === 'groups';
  const groups = grouped ? Number(flow.groups) : 1;
  const qualifiers = Number(flow.qualifiers);
  const legs = Number(flow.legs);
  if (flow.format !== 'knockout' && ![1, 2].includes(legs)) throw new Error('请选择单循环或双循环。');
  if (grouped && (!Number.isInteger(groups) || groups < 1)) {
    throw new Error('小组数量须为正整数。');
  }
  if (grouped && groups > count) throw new Error('每组至少保留 1 支队伍，请减少小组数量。');
  if (!['snake', 'balanced', 'sequential'].includes(flow.assign)) throw new Error('请选择分组方式。');
  const sizes = Array(groups).fill(0);
  for (let i = 0; i < count; i++) {
    if (!grouped) sizes[0]++;
    else if (flow.assign === 'sequential') sizes[Math.floor(i / Math.ceil(count / groups))]++;
    else if (flow.assign === 'snake') {
      const index = Math.floor(i / groups) % 2 ? groups - 1 - i % groups : i % groups;
      sizes[index]++;
    } else sizes[i % groups]++;
  }
  if (grouped && flow.draw_id) {
    if (!Array.isArray(flow.draw_sizes) || flow.draw_sizes.length !== groups
      || flow.draw_sizes.some((n) => !Number.isInteger(n) || n < 1)
      || flow.draw_sizes.reduce((sum, n) => sum + n, 0) !== count) {
      throw new Error('抽签分组与当前报名人数不一致，请核对抽签结果。');
    }
    sizes.splice(0, sizes.length, ...flow.draw_sizes);
  }
  const minimum = Math.min(...sizes);
  if (grouped && minimum < 1) throw new Error('每组至少保留 1 支队伍，请减少小组数量。');
  if (grouped && (![1, 2].includes(qualifiers) || qualifiers > minimum)) throw new Error('每组晋级人数不能超过该组队数。');
  const advancing = grouped ? groups * qualifiers : count;
  const roundRobin = flow.format === 'knockout' ? 0 : sizes.reduce((sum, size) => sum + size * (size - 1) / 2 * legs, 0);
  const bronze = flow.format !== 'league' && flow.third && advancing >= 4;
  const knockout = flow.format === 'league' ? 0 : advancing - 1 + Number(bronze);
  const sources = grouped ? Array.from({ length: qualifiers }, (_, rank) =>
    Array.from({ length: groups }, (_, pool) => ({ type: 'pool_rank', stage: 1, pool, rank: rank + 1 }))).flat() : [];
  const size = 2 ** Math.ceil(Math.log2(advancing));
  const order = seedOrder(size);
  // 非 2 的幂分组可能在原种子顺序下同组相遇；只交换次名签位，首名及轮空位置保持原序。
  if (grouped && qualifiers === 2 && groups > 1) {
    const opponents = new Map();
    for (let i = 0; i < order.length; i += 2) {
      opponents.set(order[i], order[i + 1]);
      opponents.set(order[i + 1], order[i]);
    }
    const runners = sources.slice(groups);
    const opposingPool = (slot) => {
      const seed = opponents.get(groups + slot + 1);
      return seed <= groups ? sources[seed - 1].pool : null;
    };
    for (let slot = 0; slot < groups; slot++) {
      const forbidden = opposingPool(slot);
      if (runners[slot].pool !== forbidden) continue;
      const other = runners.findIndex((runner, index) => index !== slot && runner.pool !== forbidden
        && runners[slot].pool !== opposingPool(index));
      [runners[slot], runners[other]] = [runners[other], runners[slot]];
    }
    sources.splice(groups, groups, ...runners);
  }
  const labels = grouped ? sources.map((s) => `${groupName(s.pool)}第${s.rank}名`)
    : Array.from({ length: count }, (_, i) => `第${i + 1}号种子`);
  const pairs = flow.format === 'league' ? [] : Array.from({ length: size / 2 }, (_, i) => [
    labels[order[i * 2] - 1] || '轮空', labels[order[i * 2 + 1] - 1] || '轮空',
  ]);
  return { sizes, advancing, roundRobin, knockout, total: roundRobin + knockout, bronze, pairs, sources };
}

export function flowStages(flow, count) {
  const preview = flowPreview(flow, count);
  const stages = [];
  if (flow.format !== 'knockout') stages.push({
    kind: 'round_robin', name: flow.format === 'groups' ? '小组赛' : '循环赛',
    params: { pool_count: flow.format === 'groups' ? Number(flow.groups) : 1, legs: Number(flow.legs), assign: flow.assign,
      ...(flow.format === 'groups' && flow.draw_id ? { draw_id: flow.draw_id, draw_sizes: flow.draw_sizes } : {}) },
  });
  if (flow.format !== 'league') stages.push({
    kind: 'single_elim', name: '淘汰赛',
    params: { third_place: preview.bronze, ...(flow.format === 'groups' ? { sources: preview.sources } : {}) },
  });
  return stages;
}

// 只接管能够完整表达的方案；自定义分组、签位、评次等配置保留在高级模式。
export function inferFlow(stages, count) {
  if (!stages.length) return defaultFlow(count);
  const first = stages[0];
  const grouped = stages.length === 2 && first.kind === 'round_robin' && stages[1].kind === 'single_elim';
  if (!grouped && !(stages.length === 1 && ['round_robin', 'single_elim'].includes(first.kind))) return null;
  const params = first.params || {};
  const flow = {
    format: grouped ? 'groups' : first.kind === 'round_robin' ? 'league' : 'knockout',
    groups: params.pool_count ?? 2, qualifiers: grouped ? (stages[1].params?.sources?.length || 0) / params.pool_count : 2,
    legs: params.legs ?? 1, assign: params.assign ?? 'snake',
    third: !!stages[stages.length - 1].params?.third_place,
    ...(params.draw_id ? { draw_id: params.draw_id, draw_sizes: params.draw_sizes } : {}),
  };
  try {
    const expected = flowStages(flow, count);
    const normalize = (value) => Array.isArray(value) ? value.map(normalize)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalize(value[k])])) : value;
    for (let i = 0; i < stages.length; i++) {
      if (JSON.stringify(normalize(stages[i].params || {})) !== JSON.stringify(normalize(expected[i].params))) return null;
    }
    return flow;
  } catch { return null; }
}
