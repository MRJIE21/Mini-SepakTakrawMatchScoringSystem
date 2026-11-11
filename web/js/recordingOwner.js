import { api, captureRequestContext } from './api.js';
import { state, go } from './main.js';
import { h, field, selectInput, textInput, formDialog, toast, confirmAsync, clear } from './ui.js';

export function transferButton(kind, id, onTransferred = null) {
  if (!['admin', 'organizer'].includes(state.user.role)) return null;
  return h('button.btn', { onclick: async () => {
    try {
      const users = (await api.get('/api/recorders')).users;
      const target = selectInput(users.map(u => [u.id, `${u.display_name}（${u.username}）`]), '');
      const reason = textInput('', { placeholder: '例如：换班交接' });
      formDialog({ title: '转交记录任务', sections: [{body: h('div.form-grid', field('接手记录员', target), field('转交原因', reason))}],
        actions: [{label:'确认转交', primary:true, run:async ({close}) => {
          if (!reason.value.trim()) throw new Error('请填写转交原因');
          await api.post(`/api/recording/${kind}/${id}/transfer`, {user_id:Number(target.value), reason:reason.value.trim()});
          toast('已转交。请交接未提交的比赛过程，再由接手账号继续记录。','ok');
          close();
          if (onTransferred) await onTransferred();
          else go('field');
        }}] });
    } catch(error) { toast(error.message, 'error'); }
  } }, '转交');
}


// Opening an entry only reads ownership. Mutations require explicit buttons.
export async function recordingGate(kind, id, record, details, proceed) {
  const context = captureRequestContext();
  const url = `/api/recording/${kind}/${id}`;
  let info;
  let offline = false;
  try { info = await api.get(url, { context }); }
  catch (error) {
    if (!error.offline) throw error;
    offline = true; info = record;
  }
  Object.assign(record, info);
  if (info.recorder_id === state.user.id && info.recording_started) return null;
  const panel = h('div.panel.recording-gate');
  const message = h('div.info-box', { role: 'status' }, info.recorder_id === state.user.id
    ? '开始处理前可取消领取；开始处理后请通过转交完成换班。'
    : info.recorder_id ? '该记录已由他人领取，换班请联系成绩人员转交。'
    : '请核对以上信息，点击“确认领取”后才会分配任务。');
  const actions = h('div.recording-gate-actions');
  let busy = false;
  let pendingAction = null;
  const render = () => {
    clear(panel); clear(actions);
    const mine = info.recorder_id === state.user.id;
    panel.append(h('h3', mine ? (info.recording_started ? '已领取 · 已开始处理' : '已领取 · 尚未开始处理') : info.recorder_id ? '已由他人领取' : '待确认领取'),
      h('dl.recording-gate-details', ...[...details, ['记录员', info.recorder_name || '未领取']]
        .flatMap(([label, value]) => [h('dt', `${label}：`), h('dd', value ?? '未安排')])), message);
    const button = (label, action, reason, primary = false) => {
      const hint = offline ? '请联网后操作' : action === 'release' && !mine ? '' : reason;
      const hintId = `recording-${kind}-${id}-${action}-reason`;
      const b = h('button.btn' + (primary ? '.btn-primary' : ''), {
        disabled: busy || offline || !!reason,
        title: hint || '',
        'aria-describedby': hint ? hintId : null,
        onclick: () => run(action),
      }, busy && pendingAction === action ? ({ claim: '正在确认领取…', release: '正在取消领取…', start: '正在开始处理…' })[action] : label);
      actions.append(h('div.recording-gate-action', b, hint ? h('div.small.muted', { id: hintId }, hint) : null));
    };
    if (!mine) button('确认领取', 'claim', info.claim_block_reason || '', true);
    else button(info.recording_started ? '继续记录' : '开始处理', 'start',
      info.claim_block_reason && info.claim_block_reason !== '该记录已被领取' ? info.claim_block_reason : '', true);
    if (kind !== 'individual_project') button('取消领取', 'release', info.release_block_reason || (mine ? '' : '仅领取人可取消尚未开始处理的记录'));
    panel.append(actions);
  };
  const run = async (action) => {
    if (busy) return;
    if (action === 'release' && !await confirmAsync('取消领取', '确认释放此记录？取消后其他记录员可以领取。', '确认取消领取')) return;
    busy = true; pendingAction = action; render();
    try {
      const result = await api.post(`${url}/${action}`, { claim_token: info.claim_token }, { context });
      toast(action === 'claim' ? '确认领取成功，记录已归属当前账号' : result.message, 'ok');
      info = await api.get(url, { context }); Object.assign(record, info);
      message.textContent = action === 'claim' ? '领取成功。开始处理前仍可取消领取。' : result.message;
      if (action === 'start' || (kind === 'individual_project' && action === 'claim')) { await proceed(); return; }
    } catch (error) {
      message.textContent = `${error.message}。请重新读取状态后核对，勿重复操作。`;
      message.className = 'warn-box';
      // An unknown response must not be interpreted as a failed mutation.
      try { info = await api.get(url, { context }); Object.assign(record, info); }
      catch { offline = true; }
    } finally { busy = false; pendingAction = null; render(); }
  };
  const refresh = h('button.btn.mt', { onclick: async () => {
    if (busy) return;
    try { info = await api.get(url, { context }); offline = false; Object.assign(record, info); render(); }
    catch (error) { toast(error.message, 'error'); }
  } }, '刷新领取状态');
  const wrapper = h('div', panel, refresh);
  render();
  return wrapper;
}

export function releaseUnavailable() {
  return h('div.recording-gate-action', h('button.btn', { disabled: true, title: '已开始处理或已提交，不能取消领取' }, '取消领取'));
}
