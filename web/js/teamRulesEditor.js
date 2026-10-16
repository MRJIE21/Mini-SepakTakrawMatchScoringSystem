import { api, getToken, captureRequestContext } from './api.js';
import { h, field, numberInput, selectInput, confirmAsync } from './ui.js';
import { RULE_PRESETS, normalizeRules, normalizeSet, rulesSummary, setSummary, sameRules } from './teamRules.js';

export function validateEventRules(data, eventId) {
  if (!data || data.event_id !== eventId || data.rules_scope !== 'event'
      || !['unified', 'legacy_mixed'].includes(data.rules_state)
      || !Number.isInteger(data.rules_revision) || data.rules_revision < 1
      || !['future_matches', 'frozen_matches', 'team_projects'].every(key => Number.isInteger(data[key]) && data[key] >= 0)
      || !/^[a-f0-9]{64}$/.test(data.impact_token || '') || !/^[a-f0-9]{64}$/.test(data.rules_hash || '')
      || !Array.isArray(data.legacy_rules)) throw new Error('赛事比赛规则读取不完整，请重新核对');
  normalizeRules(data.rules);
  for (const item of data.legacy_rules) {
    if (!Number.isInteger(item.category_id) || typeof item.category_name !== 'string' || typeof item.group_name !== 'string') {
      throw new Error('原有比赛规则差异读取不完整，请重新核对');
    }
    normalizeRules(item.rules);
  }
  return { ...data, rules: normalizeRules(data.rules) };
}

/* Event-owned editor; saved metadata and unsaved input remain separate. */
export function createRulesEditor(eventRules, hooks) {
  const { context, tracked, resetInput, hasEdits, mutate, readStructure } = hooks;
  const eventId = eventRules.event_id;
  const endpoint = `/api/events/${eventId}/team-rules`;
  let baseline = validateEventRules(eventRules, eventId);
  const summary = h('span.team-rules-saved', rulesSummary(baseline.rules));
  const root = h('section.team-rules', { dataset: { eventId } });
  const initialToken = getToken();
  const isCurrent = () => {
    const current = captureRequestContext();
    return root.isConnected && hooks.isCurrent() && getToken() === initialToken
      && current.user_id === context.user_id && current.auth_fingerprint === context.auth_fingerprint
      && ['event_id', 'event_uuid', 'deployment_id'].every(key => current.identity?.[key] === context.identity?.[key]);
  };
  const controls = [];
  const track = control => { controls.push(control); return tracked(control); };
  const maximum = track(selectInput([['1', '一局一胜'], ['3', '三局两胜'], ['5', '五局三胜'], ['custom', '自定义局制']], '3', { 'aria-label': '比赛局制' }));
  const custom = track(numberInput(7, { min: 1, max: 9, step: 2, 'aria-label': '自定义最多局数' }));
  const customWrap = field('最多局数（奇数 1—9）', custom);
  const ordinary = setEditor('普通局');
  const inherit = track(h('input', { type: 'checkbox', checked: true, 'aria-label': '决胜局沿用普通局' }));
  const deciding = setEditor('决胜局', false);
  const preview = h('p.team-rules-preview', { role: 'status' });
  const message = h('p.small.muted');
  const error = h('div.warn-box.hidden', { role: 'alert' });
  const stateLabel = h('span.team-rules-state', '已保存');
  const overview = h('div.team-rules-overview', h('b', '当前规则'), summary);
  const editor = h('div.team-rules-body',
    h('section.team-rules-section', h('div.team-rules-section-head', h('h4', '比赛局制'), h('p', '先赢过半局即获胜')),
      h('div.team-rules-grid', field('几局几胜', maximum), customWrap)),
    ordinary.root,
    h('section.team-rules-section', h('div.team-rules-inherit', h('div', h('h4', '决胜局'),
      h('p.small.muted', '最后可能的一局；一局制的唯一一局使用此设置。')),
      h('label.team-rules-inherit-control', inherit, '沿用普通局')), deciding.root),
    overview, preview, message, error);
  const save = h('button.btn.btn-primary', { onclick: saveRules }, '保存规则');
  const cancel = h('button.btn', { onclick: async () => {
    if (feedback.blocked) return;
    if (hasEdits(editor) && !await confirmAsync('取消修改比赛规则', '放弃本次尚未保存的规则输入？', '放弃修改', { initialFocus: 'cancel' })) return;
    if (!isCurrent()) return;
    fill(baseline.rules); feedback.clear(); maximum.focus();
  } }, '取消修改规则');
  const refresh = h('button.btn', { onclick: async () => {
    if (feedback.blocked) return;
    try {
      const fresh = await read(); if (!isCurrent()) return;
      baseline = fresh; hooks.onMetadata?.(fresh); draw();
      message.textContent = fresh.rules_state === 'legacy_mixed' ? '后台规则尚未统一。本次草稿已保留，请核对原有差异后保存。'
        : `后台规则：${rulesSummary(fresh.rules)}。本次输入已保留，请核对后保存；取消将采用后台规则。`;
    } catch (e) { if (isCurrent()) fail(e); }
  } }, '核对后台规则');
  editor.append(h('div.team-rules-footer',
    h('p.small.muted', '修改后仅影响尚未开始的比赛。保存前会显示适用范围。'),
    h('div.team-rules-actions', refresh, cancel, save)),
    h('details.team-rules-help', h('summary', '规则说明与参考'),
      h('p.small.muted', h('a', { href: 'https://www.sepaktakraw.ca/regu-sepak-takraw', target: '_blank', rel: 'noopener noreferrer' }, '15 分固定加赛规则参考'), ' · 仅设置计分口径，请按实际赛事规程选择。')));
  refresh.classList.add('team-rules-refresh'); cancel.classList.add('team-rules-cancel'); save.classList.add('team-rules-save');
  root.append(stateLabel, editor);
  const feedback = hooks.feedbackFactory(editor, isCurrent);
  const disabled = [save, cancel, refresh, ...controls];
  function fail(e) { error.textContent = e.message; error.classList.remove('hidden'); }
  function revealInvalidParameters() {
    try { ordinary.value(); } catch { ordinary.details.open = true; }
    if (!inherit.checked) { try { deciding.value(); } catch { deciding.details.open = true; } }
  }
  function readValue() {
    return normalizeRules({ schema_version: 1, max_sets: maximum.value === 'custom' ? Number(custom.value) : Number(maximum.value),
      regular: ordinary.value(), deciding: inherit.checked ? null : deciding.value() });
  }
  function draw() {
    customWrap.classList.toggle('hidden', maximum.value !== 'custom');
    deciding.root.classList.toggle('hidden', inherit.checked);
    ordinary.draw(); deciding.draw();
    const dirty = hasEdits(editor);
    const mixed = baseline.rules_state === 'legacy_mixed';
    stateLabel.textContent = mixed ? '待统一' : dirty ? '有未保存修改' : '已保存';
    stateLabel.classList.toggle('is-dirty', dirty || mixed);
    overview.firstElementChild.textContent = mixed ? '统一草稿 · 尚未应用' : '当前规则';
    summary.textContent = rulesSummary(baseline.rules);
    overview.hidden = dirty; preview.hidden = !dirty;
    try { preview.textContent = `本次修改：${rulesSummary(readValue())}`; error.classList.add('hidden'); }
    catch (e) {
      preview.hidden = false; preview.textContent = '请填写有效规则参数'; fail(e);
      revealInvalidParameters();
    }
  }
  function fill(rules) {
    rules = normalizeRules(rules);
    resetInput(maximum, [1, 3, 5].includes(rules.max_sets) ? String(rules.max_sets) : 'custom');
    resetInput(custom, [1, 3, 5].includes(rules.max_sets) ? 7 : rules.max_sets);
    resetInput(inherit, rules.deciding === null);
    ordinary.fill(rules.regular); deciding.fill(rules.deciding || rules.regular); draw();
  }
  async function read() {
    return validateEventRules(await api.get(endpoint, { context }), eventId);
  }
  async function saveRules() {
    if (feedback.blocked || !isCurrent()) return;
    let desired; try { desired = readValue(); } catch (e) {
      fail(e); revealInvalidParameters(); error.tabIndex = -1; error.focus(); return;
    }
    await mutate(async () => {
      disabled.forEach(control => { control.disabled = true; });
      try {
        const before = await read(); if (!isCurrent()) return;
        if (before.rules_revision !== baseline.rules_revision || before.rules_state !== baseline.rules_state) {
          baseline = before; hooks.onMetadata?.(before); draw();
          throw new Error(`后台规则已变化：${rulesSummary(before.rules)}。本次输入已保留，请核对后再次保存。`);
        }
        const previous = before.rules_state === 'legacy_mixed'
          ? '原有规则不同，确认后统一本赛事全部组别、男女三人赛。\n'
            + before.legacy_rules.map(item => `${item.group_name} · ${item.category_name}：${rulesSummary(item.rules)}`).join('\n')
          : `原规则：${rulesSummary(before.rules)}`;
        const ok = await confirmAsync('确认修改比赛规则',
          `${previous}\n新规则：${rulesSummary(desired)}\n\n`
          + `${before.future_matches} 场未开始比赛采用新规则；${before.frozen_matches} 场已开始或已有成绩的比赛保持原规则。\n`
          + '以后新增的三人赛项目自动继承。历史场次和成绩保持原规则。', '确认保存规则', { initialFocus: 'cancel' });
        if (!ok || !isCurrent()) return;
        await feedback.run({ controls: disabled, changed: hooks.onBlockedChange, quietIfStale: true,
          request: async () => {
            try { return await api.put(endpoint, {
              rules: desired, expected_revision: before.rules_revision, impact_token: before.impact_token,
              acknowledge_legacy_unification: before.rules_state === 'legacy_mixed' }, { context }); }
            catch (e) {
              if (isCurrent() && e.detail?.rules) {
                baseline = validateEventRules(e.detail, eventId); hooks.onMetadata?.(baseline); draw(); message.textContent = '后台规则或适用范围已变化；本次输入保留，请再次核对。';
              }
              throw e;
            }
          },
          read: async () => { const fresh = await read(); await readStructure(); return fresh; },
          reconcile: fresh => fresh.rules_state === 'unified' && sameRules(fresh.rules, desired),
          saved: (_response, fresh) => {
            baseline = fresh; summary.textContent = rulesSummary(fresh.rules); fill(fresh.rules);
            hooks.onMetadata?.(fresh);
            message.textContent = '';
          }, success: '比赛规则已保存' });
      } catch (e) { if (isCurrent()) fail(e); }
      finally { if (!feedback.blocked && isCurrent()) disabled.forEach(control => { control.disabled = false; }); }
    });
  }
  function setEditor(label, showHeading = true) {
    const preset = track(selectInput([['custom', '自定义'], ...RULE_PRESETS.map(([name], i) => [String(i), name])], '0', { 'aria-label': `${label}常用规则` }));
    const mode = track(selectInput([['direct', '直接获胜'], ['two', '领先两分获胜'], ['fixed_deuce', '平分后固定加赛']], 'direct', { 'aria-label': `${label}获胜方式` }));
    const target = track(numberInput(15, { min: 2, max: 99, step: 1, 'aria-label': `${label}目标分` }));
    const capEnabled = track(h('input', { type: 'checkbox', checked: true, 'aria-label': `${label}启用封顶` }));
    const cap = track(numberInput(15, { min: 2, max: 999, step: 1, 'aria-label': `${label}封顶分` }));
    const extension = track(numberInput(17, { min: 3, max: 999, step: 1, 'aria-label': `${label}固定加赛分` }));
    const capField = field('封顶分', cap);
    const capWrap = h('div', h('label.row.tight', capEnabled, '启用封顶'), capField);
    const extensionWrap = field('固定加赛分', extension);
    const hint = h('p.small.muted');
    const quickButtons = [
      [0, '15 分直接获胜'], [2, '15 分 · 14 平后到 17'], ['custom', '自定义参数'],
    ].map(([key, text]) => {
      const button = h('button.btn.team-rules-preset', { type: 'button', onclick: () => {
        if (key === 'custom') { preset.value = 'custom'; details.open = true; preset.focus(); }
        else { setValues(RULE_PRESETS[key][1]); details.open = false; }
        root.dispatchEvent(new Event('input', { bubbles: true }));
      } }, text);
      controls.push(button);
      return { key, button };
    });
    const details = h('details.team-rules-details', h('summary', '查看和调整详细参数'),
      h('div.team-rules-grid', field('常用规则', preset), field('获胜方式', mode), field('目标分', target), capWrap, extensionWrap));
    const section = h(showHeading ? 'section.team-rules-section' : 'div.team-rules-deciding',
      showHeading ? h('div.team-rules-section-head', h('h4', label), h('p', '选择常用规则，或展开自定义参数')) : null,
      h('div.team-rules-presets', ...quickButtons.map(item => item.button)), hint, details);
    function value() {
      return normalizeSet(mode.value === 'fixed_deuce' ? { mode: 'fixed_deuce', target_points: Number(target.value), deuce_points: Number(extension.value) }
        : { mode: 'target', target_points: Number(target.value), win_by: mode.value === 'two' ? 2 : 1, point_cap: capEnabled.checked ? Number(cap.value) : null });
    }
    function setValues(rule, reset = false) {
      const assign = (control, v) => { if (reset) resetInput(control, v); else if (control.type === 'checkbox') control.checked = v; else control.value = v; };
      assign(mode, rule.mode === 'fixed_deuce' ? 'fixed_deuce' : rule.win_by === 2 ? 'two' : 'direct');
      assign(target, rule.target_points); assign(capEnabled, rule.mode === 'target' && rule.point_cap !== null);
      assign(cap, rule.point_cap ?? rule.target_points); assign(extension, rule.deuce_points ?? Math.min(999, rule.target_points + 2));
      const match = RULE_PRESETS.findIndex(([, candidate]) => JSON.stringify(candidate) === JSON.stringify(rule));
      assign(preset, match < 0 ? 'custom' : String(match));
    }
    preset.addEventListener('change', () => { if (preset.value !== 'custom') setValues(RULE_PRESETS[Number(preset.value)][1]); draw(); });
    for (const control of [mode, target, capEnabled, cap, extension]) control.addEventListener('input', () => { preset.value = 'custom'; draw(); });
    return { root: section, details, value, fill: rule => { setValues(rule, true); details.open = preset.value === 'custom'; }, draw: () => {
      capWrap.classList.toggle('hidden', mode.value === 'fixed_deuce'); capField.classList.toggle('hidden', !capEnabled.checked);
      extensionWrap.classList.toggle('hidden', mode.value !== 'fixed_deuce');
      try { hint.textContent = setSummary(value()) + '。'; } catch { hint.textContent = '请填写有效规则参数。'; }
      for (const { key, button } of quickButtons) {
        const selected = key === 'custom' ? !['0', '2'].includes(preset.value) : String(key) === preset.value;
        button.setAttribute('aria-pressed', String(selected));
      }
    } };
  }
  root.addEventListener('input', draw);
  for (const control of [maximum, custom, inherit]) control.addEventListener('input', () => {
    if (control === inherit && !inherit.checked) deciding.details.open = true;
    draw();
  });
  fill(baseline.rules);
  return { root, get blocked() { return feedback.blocked; }, update(next) {
    baseline = validateEventRules(next, eventId);
    summary.textContent = rulesSummary(baseline.rules);
    if (!hasEdits(editor) && !feedback.blocked) fill(baseline.rules);
    else draw();
  } };
}
