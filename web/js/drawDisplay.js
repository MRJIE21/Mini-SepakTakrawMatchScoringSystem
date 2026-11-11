import { h, errorState } from './ui.js';
import { teamGroupResult } from './drawDisplayModel.js';

export function drawFlowNavigation(root, label, steps, current, onSelect = null) {
  return h('nav.draw-flow', { 'aria-label': label }, ...steps.map((step, index) => h('button.btn', {
    type: 'button', 'aria-current': step.key === current ? 'step' : null,
    onclick: () => {
      if (onSelect) { onSelect(step.key); return; }
      const target = root.querySelector(`[data-draw-section="${step.key}"]`);
      if (!target) return;
      if (target.tagName === 'DETAILS') target.open = true;
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      const heading = target.matches('summary,h3,h4') ? target : target.querySelector('summary,h3,h4');
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
    },
  }, h('span.draw-flow-number', { 'aria-hidden': 'true' }, String(index + 1)), step.label)));
}

export function renderGroupResult(category, plan, data = null) {
  const result = h('section.draw-result.mt', { 'data-draw-section': 'result', 'aria-label': '分组显示' }, h('h3', '分组显示'));
  try {
    const model = teamGroupResult(category, plan, data);
    result.dataset.resultSource = model.source;
    if (model.source === 'none') { if (!data || model.message) result.append(h('p.muted', data ? model.message
      : '暂无可查看的正式赛程分组。小组赛阶段确认并发布后才显示正式名单。')); return result; }
    result.append(h('p.small.muted', model.label));
    for (const stage of model.stages) result.append(h('section.draw-result-stage',
      h('h4', `${stage.name} · ${stage.groups.length} 个小组 · ${stage.total} 所学校`),
      h('div.draw-result-groups', ...stage.groups.map(group => h('section.draw-result-group',
        h('h4', `${group.name} · ${group.members.length} 所学校`), group.members.length
          ? h('ol', ...group.members.map(member => h('li', { 'data-participation': member.id }, member.name)))
          : h('p.small.muted', '当前小组暂无有效成员。'))))));
  } catch (error) { result.dataset.resultSource = 'error'; result.append(errorState(error)); }
  return result;
}
