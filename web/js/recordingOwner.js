import { api } from './api.js';
import { state, go } from './main.js';
import { h, field, selectInput, textInput, formDialog, toast } from './ui.js';

export function transferButton(kind, id) {
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
          close(); go('field');
        }}] });
    } catch(error) { toast(error.message, 'error'); }
  } }, '转交记录任务');
}
