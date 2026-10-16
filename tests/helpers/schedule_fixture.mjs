/* Browser fixtures use the same explicit stage API and manual match entry as users. */
import { randomUUID } from 'node:crypto';
export async function scheduleFixture(api, identity, category, { groupCount = 1, drawId = null, knockout = false, confirmed = true } = {}) {
  const frozen = { event_id: identity.event_id, event_uuid: identity.event_uuid,
    deployment_id: identity.deployment_id || (await api('GET', '/api/events')).deployment_id };
  const packet = body => ({ event_identity: frozen, request_uid: randomUUID(), ...body });
  if (!drawId) {
    const roster = await api('GET', `/api/categories/${category}/group-draw`);
    const count = roster.roster.length;
    let draw = (await api('POST', `/api/categories/${category}/group-draw`, packet({ method: 'random',
      capacities: Array.from({ length: groupCount }, (_, i) => Math.floor(count/groupCount) + Number(i < count%groupCount)), roster_hash: roster.roster_hash }))).draw;
    for (const action of ['complete','confirm']) draw = (await api('POST', `/api/categories/${category}/group-draw/${action}`, packet({ draw_id: draw.id, base_rev: draw.rev }))).draw;
    drawId = draw.id;
  }
  const create = definition => api('POST', `/api/categories/${category}/schedule/stages`, packet({ base_revision: 0, definition }));
  const confirmStage = async stage => {
    const preview = await api('POST', `/api/schedule-stages/${stage.stage_id}/preview`, packet({ base_revision: stage.revision }));
    return api('POST', `/api/schedule-stages/${stage.stage_id}/confirm`, packet({ base_revision: stage.revision,
      definition_hash: preview.definition_hash, basis_hash: preview.basis_hash, approved_byes: preview.graph.byes }));
  };
  const stage = await create({ purpose: 'group', name: '小组赛', draw_id: drawId });
  let plan = (await api('GET', `/api/categories/${category}/schedule`)).plan;
  const result = { plan_id: plan.id, stage_id: stage.stage_id, frozen };
  result.confirm = async () => {
    await confirmStage(stage);
    plan = (await api('GET', `/api/categories/${category}/schedule`)).plan;
    const pools = plan.stages.find(s => s.id === stage.stage_id).pools;
    for (const pool of pools) {
      const ids = pool.members.map(m => m.participation_id);
      for (let i = 0; i < ids.length; i++) for (let j = i+1; j < ids.length; j++) {
        await api('POST', '/api/matches', packet({ category_id: category, stage_id: stage.stage_id, pool_id: pool.id,
          home_participation: ids[i], away_participation: ids[j], round_label: `${pool.name}小组赛`, round_no: 1 }));
      }
    }
    if (knockout) await confirmStage(await create({ purpose: 'knockout', name: '淘汰赛', pool_ids: pools.map(p => p.id) }));
    return result;
  };
  if (confirmed) await result.confirm();
  return result;
}
