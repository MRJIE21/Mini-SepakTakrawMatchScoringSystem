/* 淘汰及评次图：带连线的对阵树（胜者区/败者区分区显示），循环赛与评次循环仍用表格。

   布局规则：每轮一列，节点纵向居中于它的两个前序场次之间，
   列与列之间用折线连接；待定签位按来源显示，不补造队伍。
*/
import { api, captureRequestContext } from '../api.js';
import { registerView, state, loadStructure } from '../main.js';
import { h, field, selectInput, table, statusBadge, matchStatusBadge, categoryLabel } from '../ui.js';
import { BOX_W, BOX_H, COL_GAP, HEAD_H, computeLayout, connectorPath } from '../bracketLayout.js';

const KIND_LABEL = {
  round_robin: '循环赛', single_elim: '单淘汰', double_elim: '双淘汰', swiss: '瑞士制',
  gauntlet: '阶梯淘汰', placement: '评次赛', custom: '自定义组合',
};

const LINE = '#c6d3e6';

async function render({ el, params, signal, requestContext = captureRequestContext(), isCurrent = () => true }) {
  const alive = () => el.isConnected && !signal?.aborted && isCurrent();
  if (!state.eventId) throw new Error('请先在“赛事概览”中创建赛事');
  const structure = state.structure || await loadStructure();
  if (!alive()) return;
  const cats = [];
  for (const g of structure.groups) {
    for (const c of g.categories) cats.push({ ...c, group_name: g.name });
  }
  const catId = Number(params.category || cats[0].id);
  const cat = cats.find((c) => c.id === catId) || cats[0];

  el.append(h('div.panel',
    h('div.panel-head',
      h('h2', '淘汰及评次图'),
      field('项目', selectInput(cats.map((c) => [c.id, categoryLabel(c, { withGroup: true })]),
        cat.id, { onchange: (e) => { location.hash = `#/bracket?category=${e.target.value}`; } }))),
    h('div.small.muted', '连线表示晋级关系：左侧场次的胜者进入右侧场次；待定位置按签位来源显示，'
      + '灰色虚线框表示尚未确定双方，金色框为冠军。'),
  ));

  const data = await api.get(`/api/categories/${cat.id}/plan`, { signal, context: requestContext });
  if (!alive()) return;
  if (!data.plan) {
    el.append(h('div.panel', h('div.info-box', '该项目尚未编排方案，也没有自定义比赛。')));
    return;
  }
  for (const stage of data.plan.stages) {
    if (!stage.matches.length) continue;
    const panel = h('div.panel',
      h('div.panel-head',
        h('h3', `${stage.seq}. ${stage.name}`),
        h('div.row.tight',
          statusBadge(KIND_LABEL[stage.kind] || stage.kind, 'info'),
          h('span.small.muted', `场次 ${stage.matches.length}`))),
    );
    if (stage.note) panel.append(h('div.small.muted.mb', stage.note));

    const bracketPools = stage.pools.filter((p) => p.kind === 'bracket');
    const isElim = bracketPools.length > 0;
    const purpose = stage.params?.schedule_meta?.definition.purpose;
    if (['knockout', 'placement'].includes(purpose)) {
      panel.append(renderTree(stage.matches, { poolOf: new Map(), poolNames: new Map(), sectionPoolId: null }));
    } else if (isElim) {
      const ctxBase = {
        poolOf: new Map(stage.matches.map((m) => [m.id, m.pool_id])),
        poolNames: new Map(stage.pools.map((p) => [p.id, p.name])),
      };
      for (const pool of bracketPools) {
        const list = stage.matches.filter((m) => m.pool_id === pool.id);
        if (!list.length) continue;
        const others = bracketPools.filter((p) => p.id !== pool.id);
        panel.append(h('h4.mt', { style: 'margin-bottom:6px' },
          pool.name,
          others.length ? h('span.small.muted', { style: 'margin-left:8px;font-weight:400' },
            `与${others.map((p) => p.name).join('、')}通过标签衔接`) : null));
        panel.append(renderTree(list, { ...ctxBase, sectionPoolId: pool.id }));
      }
    } else {
      for (const pool of stage.pools) {
        const poolMatches = stage.matches.filter((m) => m.pool_id === pool.id);
        if (!poolMatches.length) continue;
        panel.append(h('h4.mt', `${pool.name}（${pool.rank_from
          ? `第${pool.rank_from}—${pool.rank_to}名` : `${poolMatches.length} 场`}）`));
        panel.append(h('div.table-scroll', table([
          { label: '轮次', key: 'round_label' },
          { label: '主队/选手', render: (m) => sideText(m.home) },
          { label: '客队/选手', render: (m) => sideText(m.away) },
          { label: '比分', render: (m) => setSummary(m) },
          { label: '状态', render: (m) => matchStatusBadge(m) },
        ], poolMatches)));
      }
    }
    el.append(panel);
  }
}

function renderTree(matches, ctx) {
  const { pos, rounds, width, height } = computeLayout(matches);
  const canvas = h('div.bk-canvas', {
    style: `width:${width + 150}px;height:${height + HEAD_H + 12}px`,
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'bk-svg');
  svg.setAttribute('width', String(width + 150));
  svg.setAttribute('height', String(height + HEAD_H + 12));
  const paths = [];

  /* 轮次标题 */
  for (const roundNo of rounds) {
    const sample = matches.find((m) => m.round_no === roundNo);
    const x = pos.get(sample.id).x;
    canvas.append(h('div.bk-head', { style: `left:${x}px;width:${BOX_W}px;top:2px` },
      sample.round_label || `第${roundNo}轮`));
  }

  /* 连线 */
  for (const m of matches) {
    const target = pos.get(m.id);
    for (const side of ['home', 'away']) {
      const feederId = m[side].source_match_id;
      if (!feederId || !pos.has(feederId)) continue;
      paths.push(connectorPath(pos.get(feederId), target));
    }
  }
  svg.innerHTML = paths.map((d) =>
    `<path d="${d}" fill="none" stroke="${LINE}" stroke-width="2"/>`).join('');
  canvas.append(svg);

  /* 场次卡片 */
  for (const m of matches) {
    const p = pos.get(m.id);
    canvas.append(matchCard(m, p.x, p.y + HEAD_H, ctx));
  }

  /* 冠军 */
  const lastRound = rounds[rounds.length - 1];
  const explicitFinal = matches.filter(m => m.schedule_role === 'final');
  const finals = explicitFinal.length ? explicitFinal : matches.filter((m) => m.round_no === lastRound);
  if (finals.length === 1) {
    const final = finals[0];
    const winner = winnerOf(final);
    const p = pos.get(final.id);
    if (winner) {
      const name = final[winner].label || '胜者';
      canvas.append(h('div.bk-champion', {
        style: `left:${p.x + BOX_W + COL_GAP}px;top:${p.y + HEAD_H + 8}px;width:${BOX_W * 0.62}px`,
      },
        h('div.small.muted', { style: 'font-size:11px' }, final.winner_rank && final.winner_rank !== 1 ? `第${final.winner_rank}名` : '冠军'),
        h('div', { style: 'font-weight:700' }, name)));
    }
  }
  return h('div.bk-wrap', canvas);
}

function matchCard(m, x, y, ctx) {
  const classes = ['bk-card'];
  if (m.status === 'pending') classes.push('pending');
  if (m.status === 'void') classes.push('void');
  const card = h(`div.${classes.join('.')}`, {
    style: `left:${x}px;top:${y}px;width:${BOX_W}px`,
    title: !isVoidResult(m) && m.sets.length
      ? m.sets.map((s) => `第${s.set_no}局 ${s.home_points}:${s.away_points}`).join('　') : '',
  },
    h('div.bk-title', `${m.public_code || `第${m.seq}场`} · ${m.round_label}${m.status === 'void' ? ' · 轮空' : ''}`),
    sideRow(m, 'home', ctx),
    sideRow(m, 'away', ctx));
  return card;
}

function sideRow(m, side, ctx) {
  const winner = winnerOf(m);
  const rowClass = winner === side ? 'bk-line win' : 'bk-line';
  return h(`div.${rowClass}`, teamNode(m[side], ctx),
    h('span.bk-sc', scoreText(m, side)));
}

function teamNode(slot, ctx) {
  if (!slot) return h('span.bk-team', '—');
  if (slot.type === 'bye') return h('span.bk-team.muted', '轮空');
  const parts = [];
  if (slot.source_match_id) {
    const fromPool = ctx.poolOf.get(slot.source_match_id);
    if (fromPool && fromPool !== ctx.sectionPoolId) {
      parts.push(h('span.bk-tag', ctx.poolNames.get(fromPool) || '另一区'));
    }
  }
  if (slot.label) {
    parts.push(h('span.bk-team', { title: slot.reason || '' }, slot.label));
  } else {
    const text = slot.source_label || {
      pool_rank: `小组第${slot.source_rank}名`,
      match_winner: '前场胜者',
      match_loser: '前场负者',
      participation: '待指定',
    }[slot.type] || '待定';
    parts.push(h('span.bk-team.muted', { title: slot.reason || '' }, `${text}（待定）`));
  }
  return h('span', { style: 'display:flex;gap:4px;align-items:center;min-width:0;flex:1' }, parts);
}

function winnerOf(m) {
  if (m.winner_side) return m.winner_side;
  const wins = { home: 0, away: 0 };
  for (const s of m.sets) if (s.winner_side) wins[s.winner_side] += 1;
  if (wins.home > wins.away && wins.home >= 2) return 'home';
  if (wins.away > wins.home && wins.away >= 2) return 'away';
  return null;
}

function isVoidResult(m) {
  return m.result_status === 'cancelled' || m.result_status === 'unfinished';
}

function scoreText(m, side) {
  if (m.status === 'pending') return '';
  if (isVoidResult(m)) return '';
  if (m.result_status === 'home_forfeit') return side === 'home' ? '弃权' : '胜';
  if (m.result_status === 'away_forfeit') return side === 'away' ? '弃权' : '胜';
  if (m.result_status && m.result_status !== 'normal') {
    return side === 'home' ? (m.sets[0] ? `${m.sets.filter((s) => s.winner_side === 'home').length}` : '') : '';
  }
  if (!m.sets.length) return '';
  return String(m.sets.filter((s) => s.winner_side === side).length);
}

function setSummary(m) {
  if (isVoidResult(m)) {
    return m.result_status === 'cancelled' ? '已取消（原局分作废）' : '未完成（原局分作废）';
  }
  if (m.result_status === 'home_forfeit') return '主队弃权';
  if (m.result_status === 'away_forfeit') return '客队弃权';
  if (!m.sets.length) return '';
  return m.sets.map((s) => `${s.home_points}:${s.away_points}`).join(' ');
}

function sideText(side) {
  if (!side) return '';
  if (side.type === 'bye') return h('span.muted', '轮空');
  if (side.label) return side.label;
  if (side.source_label) return h('span.muted', { title: side.reason || '' }, side.source_label + '（待定）');
  const map = {
    pool_rank: `小组第${side.source_rank}名（待定）`,
    match_winner: '前场胜者（待定）',
    match_loser: '前场负者（待定）',
    participation: '指定队伍（待定）',
  };
  return h('span.muted', { title: side.reason || '' }, map[side.type] || '待定');
}

registerView({ name: 'bracket', label: '淘汰及评次图', roles: ['admin', 'organizer', 'recorder', 'viewer'], render });
