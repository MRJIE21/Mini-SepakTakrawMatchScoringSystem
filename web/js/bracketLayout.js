/* 对阵树布局：纯计算，无 DOM 依赖，便于单独测试。

   规则：每轮一列；节点纵向居中于它的两个前序场次之间；
   同列出现重叠时按顺序向下错开；只有“前场胜者/负者”来源才产生连线。
*/
export const BOX_W = 236;
export const BOX_H = 66;
export const GAP_Y = 14;
export const COL_GAP = 46;
export const HEAD_H = 30;

export function feederIds(match) {
  return [match.home.source_match_id, match.away.source_match_id].filter((id) => id);
}

export function computeLayout(matches) {
  const rounds = [...new Set(matches.map((m) => m.round_no))].sort((a, b) => a - b);
  const pos = new Map();
  rounds.forEach((roundNo, col) => {
    const list = matches.filter((m) => m.round_no === roundNo).sort((a, b) => a.seq - b.seq);
    let fallback = 0;
    for (const m of list) {
      const feeders = feederIds(m).filter((id) => pos.has(id));
      let y;
      if (feeders.length) {
        y = feeders.reduce((sum, id) => sum + pos.get(id).y, 0) / feeders.length;
      } else {
        y = fallback;
        fallback += BOX_H + GAP_Y;
      }
      pos.set(m.id, { x: col * (BOX_W + COL_GAP), y, col });
    }
    // 同列内避免重叠：按 y 从上到下依次下压（后续连接线仍指向最终位置）
    const placed = list.map((m) => pos.get(m.id)).sort((a, b) => a.y - b.y);
    for (let i = 1; i < placed.length; i += 1) {
      const minY = placed[i - 1].y + BOX_H + GAP_Y;
      if (placed[i].y < minY) placed[i].y = minY;
    }
  });
  const maxY = Math.max(0, ...[...pos.values()].map((p) => p.y));
  return {
    pos,
    rounds,
    width: Math.max(1, rounds.length) * BOX_W + Math.max(0, rounds.length - 1) * COL_GAP,
    height: maxY + BOX_H,
  };
}

/* 连线路径：从前序场次右边中点折到目标场次左边中点 */
export function connectorPath(from, to) {
  const x1 = from.x + BOX_W;
  const y1 = from.y + HEAD_H + BOX_H / 2;
  const x2 = to.x;
  const y2 = to.y + HEAD_H + BOX_H / 2;
  const midX = x1 + COL_GAP / 2;
  return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
}
