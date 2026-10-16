"""Explicit revision-guarded stages in the existing schedule container.

The server derives protected pairs from official pools. Preview has no writes;
confirmation verifies the exact definition and source basis atomically.
"""
from __future__ import annotations

import json

from .. import db, idempotency, security
from ..domain import advancement
from ..domain.schedule_stages import compile_stage, group_entries, integer
from ..domain.slots import SlotSpec
from ..errors import bad_request, conflict
from ..http_server import route
from .common import active_plan, category_context, get_or_404
from .group_draw import confirmed_draw, fixed_pools, roster_for
from .schedule_read import plan_detail

ORG = ('admin', 'organizer')
KINDS = {'group': 'round_robin', 'knockout': 'single_elim', 'placement': 'placement', 'manual': 'custom'}


def meta(stage):
    return json.loads(stage['params_json'] or '{}').get('schedule_meta')


def save_meta(conn, stage_id, data):
    db.update(conn, 'stages', stage_id, {'params_json': json.dumps({'schedule_meta': data}, ensure_ascii=False)})


def _stage(ctx):
    stage = get_or_404(ctx.conn, 'stages', int(ctx.params['stage_id']), '赛程阶段')
    if not meta(stage):
        raise conflict('历史阶段只能查看和更正成绩，请新建赛程阶段', code='legacy_stage')
    plan = get_or_404(ctx.conn, 'plans', stage['plan_id'], '赛程')
    return stage, plan, meta(stage)


def mutation(ctx, category_id, fn):
    cat = category_context(ctx.conn, category_id)
    if cat['kind'] != 'team':
        raise bad_request('个人赛不设置对阵赛程')
    identity = ctx.body.get('event_identity')
    event = get_or_404(ctx.conn, 'events', cat['event_id'], '赛事')
    deployment = db.q1(ctx.conn, "SELECT v FROM settings WHERE k='deployment_id'")
    expected = {'event_id': event['id'], 'event_uuid': event['uuid'], 'deployment_id': deployment['v']}
    if identity != expected:
        raise conflict('赛事身份已变化，请返回当前项目重新核对', code='event_identity_mismatch')
    uid = idempotency.extract_uid(ctx.body)
    if not uid or len(uid) > 120:
        raise bad_request('赛程操作需要有效的请求标识')
    payload = {'path': ctx.path, 'method': ctx.method, 'actor': ctx.user['id'],
               'body': idempotency.payload_without_uid(ctx.body), 'identity': expected}
    return idempotency.replay_or_run(ctx.conn, ctx.user, uid, payload, fn, scope='schedule', strict=True)


def revision(ctx, data):
    if type(ctx.body.get('base_revision')) is not int or ctx.body['base_revision'] != data['revision']:
        raise conflict('阶段已被其他操作更新，请刷新后重新核对', code='stale_revision',
                       detail={'revision': data['revision']})


def _definition(conn, category_id, raw, stage_id=None):
    if not isinstance(raw, dict):
        raise bad_request('请填写阶段设置')
    purpose = raw.get('purpose')
    definition = {'purpose': purpose, 'name': raw.get('name')}
    try:
        if purpose == 'group':
            draw_id = integer(raw.get('draw_id'), '抽签编号')
            confirmed_draw(conn, category_id, draw_id)
            definition['draw_id'] = draw_id
            if db.q1(conn, """SELECT s.id FROM stages s JOIN plans p ON p.id=s.plan_id
                WHERE p.category_id=? AND s.kind='round_robin' AND s.id<>COALESCE(?,0)""", (category_id, stage_id)):
                raise conflict('本项目已有小组赛阶段，请先撤回并删除原阶段')
        elif purpose in ('knockout', 'placement'):
            ids = raw.get('pool_ids')
            if not isinstance(ids, list) or not 2 <= len(ids) <= 64 or len(set(map(str, ids))) != len(ids):
                raise bad_request('请选择至少两个且不重复的小组')
            ids = [integer(i, '小组ID') for i in ids]
            pools = []
            for pool_id in ids:
                row = db.q1(conn, """SELECT po.*,s.params_json,p.category_id,p.id AS source_plan_id FROM pools po
                    JOIN stages s ON s.id=po.stage_id JOIN plans p ON p.id=s.plan_id WHERE po.id=?""", (pool_id,))
                if not row or row['category_id'] != category_id or row['kind'] != 'group':
                    raise bad_request('参赛来源小组不属于本项目的小组赛')
                current_plan = active_plan(conn, category_id)
                if not current_plan or row['source_plan_id'] != current_plan['id']:
                    raise bad_request('参赛来源必须属于本项目的当前赛程')
                source_meta = meta(row)
                if source_meta and source_meta['state'] != 'confirmed':
                    raise conflict('来源小组赛尚未确认')
                pools.append(dict(row) | {'members': [r['participation_id'] for r in db.q(
                    conn, 'SELECT participation_id FROM pool_members WHERE pool_id=? ORDER BY id', (pool_id,))]})
            # Official order determines adjacency, never client selection order.
            pools.sort(key=lambda p: (p['stage_id'], p['seq'], p['id']))
            official = [r['id'] for r in db.q(conn, """SELECT po.id FROM pools po
                JOIN stages s ON s.id=po.stage_id JOIN plans p ON p.id=s.plan_id
                WHERE p.id=? AND po.kind='group' ORDER BY s.seq,po.seq,po.id""", (current_plan['id'],))]
            selected = [p['id'] for p in pools]
            if purpose == 'knockout' and selected != official:
                raise bad_request('主淘汰赛必须包含本项目全部小组的前两名')
            for index, pool_id in enumerate(official):
                if pool_id in selected and index % 2 == 0 and index + 1 < len(official) and official[index + 1] not in selected:
                    raise bad_request('名次赛请成对选择相邻小组，例如A/B或C/D')
                if pool_id in selected and index % 2 == 1 and official[index - 1] not in selected:
                    raise bad_request('名次赛请成对选择相邻小组，例如A/B或C/D')
            for pool in pools:
                for pid in pool['members']:
                    part = get_or_404(conn, 'participations', pid, '小组成员')
                    if part['category_id'] != category_id or part['status'] != 'active':
                        raise conflict('来源小组成员已退出或变化，请先核对报名和分组', code='source_roster_changed')
            rank = integer(raw.get('source_rank'), '来源名次', 3, 4) if purpose == 'placement' else None
            entries, slots, pairs = group_entries(pools, [rank] if rank else [1, 2])
            definition.update(pool_ids=[p['id'] for p in pools], entries=entries,
                              bracket_slots=slots, required_pairs=pairs)
            if rank:
                definition.update(source_rank=rank, rank_from=raw.get('rank_from'), rank_to=raw.get('rank_to'))
        graph = compile_stage(definition)
    except ValueError as exc:
        raise bad_request(str(exc)) from exc
    definition['name'] = graph['name']
    if purpose in ('knockout', 'placement'):
        if purpose == 'placement' and graph['rank_from'] <= 4:
            raise conflict('第1—4名由主淘汰赛决定，请调整名次赛范围', code='rank_overlap')
        enrolled = db.q1(conn, "SELECT COUNT(*) AS n FROM participations WHERE category_id=? AND status='active'", (category_id,))['n']
        if graph['rank_to'] > enrolled:
            raise bad_request('名次范围超出本项目有效报名学校数量')
        wanted = set(range(graph['rank_from'], graph['rank_to'] + 1))
        wanted_sources = {idempotency.content_hash(e) for e in definition['entries']}
        for other in db.q(conn, """SELECT s.* FROM stages s JOIN plans p ON p.id=s.plan_id
            WHERE p.category_id=? AND s.id<>COALESCE(?,0)""", (category_id, stage_id)):
            data = meta(other)
            if not data:
                continue
            cfg = data['definition']
            if cfg['purpose'] not in ('knockout', 'placement'):
                continue
            low, high = (1, 4) if cfg['purpose'] == 'knockout' else (cfg['rank_from'], cfg['rank_to'])
            if wanted.intersection(range(low, high + 1)):
                raise conflict(f"名次范围与“{other['name']}”重叠，请调整", code='rank_overlap')
            if wanted_sources.intersection(idempotency.content_hash(e) for e in cfg['entries']):
                raise conflict(f"参赛来源已用于“{other['name']}”", code='source_overlap')
    return definition, graph


def _preview(conn, plan, data, stage_id):
    definition, graph = _definition(conn, plan['category_id'], data['definition'], stage_id)
    basis = {'roster': roster_for(conn, plan['category_id']), 'pools': []}
    if definition['purpose'] == 'group':
        draw = confirmed_draw(conn, plan['category_id'], definition['draw_id'])
        basis['draw'] = {key: draw[key] for key in ('id', 'rev', 'steps_json', 'roster_json')}
        graph['groups'] = fixed_pools(conn, plan['category_id'], {'draw_id': draw['id']})
    for pool_id in definition.get('pool_ids', []):
        pool = get_or_404(conn, 'pools', pool_id, '来源小组')
        basis['pools'].append({'pool': dict(pool), 'members': db.rows_to_dicts(db.q(conn,
            'SELECT participation_id,seed_no FROM pool_members WHERE pool_id=? ORDER BY id', (pool_id,))),
            'ranks': db.rows_to_dicts(db.q(conn, 'SELECT * FROM pool_rank_snapshots WHERE pool_id=? ORDER BY rank_no', (pool_id,)))})
    return {'graph': graph, 'definition': definition, 'revision': data['revision'],
            'definition_hash': idempotency.content_hash(definition), 'basis_hash': idempotency.content_hash(basis)}


@route('GET', r'/api/categories/(?P<category_id>\d+)/schedule')
def get_schedule(ctx):
    category_id = int(ctx.params['category_id'])
    cat = category_context(ctx.conn, category_id)
    plan = active_plan(ctx.conn, category_id)
    return {'category': cat, 'plan': plan_detail(ctx.conn, plan, include_matches=False, include_pools=True) if plan else None}


@route('POST', r'/api/categories/(?P<category_id>\d+)/schedule/stages', roles=ORG)
def create_stage(ctx):
    category_id = int(ctx.params['category_id'])
    def create():
        if type(ctx.body.get('base_revision')) is not int or ctx.body['base_revision'] != 0:
            raise conflict('新阶段的初始版本必须为0', code='stale_revision')
        definition, _ = _definition(ctx.conn, category_id, ctx.body.get('definition'))
        plan = active_plan(ctx.conn, category_id)
        if not plan:
            pid = db.insert(ctx.conn, 'plans', {'category_id': category_id, 'name': '项目赛程', 'params_json': '{"managed_schedule":1}'})
            plan = get_or_404(ctx.conn, 'plans', pid)
        seq = db.q1(ctx.conn, 'SELECT COALESCE(MAX(seq),0)+1 AS n FROM stages WHERE plan_id=?', (plan['id'],))['n']
        stage_id = db.insert(ctx.conn, 'stages', {'plan_id': plan['id'], 'seq': seq, 'kind': KINDS[definition['purpose']], 'name': definition['name']})
        save_meta(ctx.conn, stage_id, {'version': 1, 'revision': 1, 'state': 'draft', 'definition': definition})
        security.audit(ctx.conn, ctx.user, 'create_schedule_stage', 'stage', stage_id, definition)
        return {'stage_id': stage_id, 'revision': 1, 'message': '阶段草稿已保存，请核对并确认'}
    return mutation(ctx, category_id, create)


@route('PUT', r'/api/schedule-stages/(?P<stage_id>\d+)', roles=ORG)
def edit_stage(ctx):
    stage, plan, data = _stage(ctx)
    def edit():
        revision(ctx, data)
        if data['state'] != 'draft':
            raise conflict('请先撤回阶段确认，再调整结构')
        definition, _ = _definition(ctx.conn, plan['category_id'], ctx.body.get('definition'), stage['id'])
        data.update(definition=definition, revision=data['revision'] + 1)
        save_meta(ctx.conn, stage['id'], data)
        db.update(ctx.conn, 'stages', stage['id'], {'name': definition['name'], 'kind': KINDS[definition['purpose']]})
        security.audit(ctx.conn, ctx.user, 'edit_schedule_stage', 'stage', stage['id'], definition)
        return {'stage_id': stage['id'], 'revision': data['revision']}
    return mutation(ctx, plan['category_id'], edit)


@route('POST', r'/api/schedule-stages/(?P<stage_id>\d+)/preview', roles=ORG)
def preview_stage(ctx):
    stage, plan, data = _stage(ctx)
    def preview():
        revision(ctx, data)
        return _preview(ctx.conn, plan, data, stage['id'])
    return mutation(ctx, plan['category_id'], preview)


def slot_columns(source, prefix, ids):
    return SlotSpec(source['type'], participation_id=source.get('participation_id'),
                    pool_ref=source.get('pool_id'), rank=source.get('rank'),
                    match_ref=ids.get(source.get('key')) if source.get('key') else source.get('match_id')).to_columns(prefix)


@route('POST', r'/api/schedule-stages/(?P<stage_id>\d+)/confirm', roles=('admin',))
def confirm_stage(ctx):
    stage, plan, data = _stage(ctx)
    def confirm():
        revision(ctx, data)
        if data['state'] != 'draft':
            raise conflict('该阶段已经确认')
        preview = _preview(ctx.conn, plan, data, stage['id'])
        if any(ctx.body.get(key) != preview[key] for key in ('definition_hash', 'basis_hash')):
            raise conflict('预览依据已变化，请重新核对后确认', code='preview_changed')
        graph = preview['graph']
        if graph['byes'] and ctx.body.get('approved_byes') != graph['byes']:
            raise bad_request('请逐项核对并明确确认轮空安排', code='byes_not_confirmed')
        for index, pool in enumerate(graph.get('groups', []), 1):
            pool_id = db.insert(ctx.conn, 'pools', {'stage_id': stage['id'], 'name': pool['name'], 'seq': index})
            for seed, pid in enumerate(pool['members'], 1):
                db.insert(ctx.conn, 'pool_members', {'pool_id': pool_id, 'participation_id': pid, 'seed_no': seed})
        ids = {}
        for seq, match in enumerate(graph['matches'], 1):
            row = {'category_id': plan['category_id'], 'plan_id': plan['id'], 'plan_version': plan['version'],
                   'stage_id': stage['id'], 'seq': seq, 'round_no': match['round_no'], 'round_label': match['round_label'],
                   'schedule_role': match['role'], 'winner_rank': match['winner_rank'], 'loser_rank': match['loser_rank']}
            row.update(slot_columns(match['home'], 'home', ids), **slot_columns(match['away'], 'away', ids))
            ids[match['key']] = db.insert(ctx.conn, 'matches', row)
        awards = []
        for award in graph['awards']:
            source = dict(award['source'])
            if source.get('key'):
                source['match_id'] = ids[source.pop('key')]
            awards.append({'rank': award['rank'], 'source': source})
        data.update(state='confirmed', revision=data['revision'] + 1, awards=awards, match_ids=ids,
                    confirmed_by=ctx.user['id'], confirmed_at=db.now(ctx.conn),
                    definition_hash=preview['definition_hash'], basis_hash=preview['basis_hash'], byes=graph['byes'])
        save_meta(ctx.conn, stage['id'], data)
        advancement.refresh_plan(ctx.conn, plan['id'])
        security.audit(ctx.conn, ctx.user, 'confirm_schedule_stage', 'stage', stage['id'], {'revision': data['revision'], 'matches': ids})
        return {'stage_id': stage['id'], 'revision': data['revision'], 'match_ids': ids, 'message': '阶段已确认，正式场次已保存'}
    return mutation(ctx, plan['category_id'], confirm)


def _guard_retract(conn, stage):
    rows = db.q(conn, 'SELECT * FROM matches WHERE stage_id=?', (stage['id'],))
    own_ids = {m['id'] for m in rows}
    for match in rows:
        if match['result_version'] or match['status'] == 'finished' or \
                db.q1(conn, 'SELECT id FROM score_events WHERE match_id=? LIMIT 1', (match['id'],)) or \
                db.q1(conn, 'SELECT id FROM submissions WHERE match_id=? LIMIT 1', (match['id'],)) or \
                db.q1(conn, 'SELECT k FROM settings WHERE k=?', (f"recording:match:{match['id']}",)):
            raise conflict('该阶段已有领取、计分或成绩记录，请使用正式更正流程', code='stage_started')
        if any(m['match_id'] not in own_ids for m in advancement.downstream_matches(conn, match['id'])):
            raise conflict('其他阶段依赖本阶段比赛，不能撤回', code='has_dependents')
    pools = {p['id'] for p in db.q(conn, 'SELECT id FROM pools WHERE stage_id=?', (stage['id'],))}
    for pool_id in pools:
        if db.q1(conn, 'SELECT id FROM pool_rank_snapshots WHERE pool_id=? LIMIT 1', (pool_id,)) or \
                advancement.matches_depending_on_pool(conn, pool_id):
            raise conflict('小组已有确认名次或后续比赛引用，不能撤回', code='has_dependents')
    for other in db.q(conn, 'SELECT * FROM stages WHERE plan_id=? AND id<>?', (stage['plan_id'], stage['id'])):
        other_meta = meta(other)
        if other_meta and pools.intersection(other_meta['definition'].get('pool_ids', [])):
            raise conflict('后续阶段草稿仍引用本阶段小组，请先处理后续阶段', code='has_dependents')
    return len(rows)


@route('POST', r'/api/schedule-stages/(?P<stage_id>\d+)/unconfirm', roles=('admin',))
def unconfirm_stage(ctx):
    stage, plan, data = _stage(ctx)
    def retract():
        revision(ctx, data)
        reason = str(ctx.body.get('reason') or '').strip()
        if not reason or len(reason) > 500:
            raise bad_request('请填写1至500字的撤回原因')
        if data['state'] != 'confirmed':
            raise conflict('该阶段尚未确认')
        removed = _guard_retract(ctx.conn, stage)
        db.run(ctx.conn, 'DELETE FROM matches WHERE stage_id=?', (stage['id'],))
        db.run(ctx.conn, 'DELETE FROM pools WHERE stage_id=?', (stage['id'],))
        save_meta(ctx.conn, stage['id'], {'version': 1, 'revision': data['revision'] + 1,
                                        'state': 'draft', 'definition': data['definition']})
        security.audit(ctx.conn, ctx.user, 'unconfirm_schedule_stage', 'stage', stage['id'], {'reason': reason, 'removed': removed})
        return {'revision': data['revision'] + 1, 'removed': removed, 'message': '已撤回阶段确认，未开始场次已移除'}
    return mutation(ctx, plan['category_id'], retract)


@route('DELETE', r'/api/schedule-stages/(?P<stage_id>\d+)', roles=ORG)
def delete_stage(ctx):
    category_id = ctx.body.get('category_id')
    if type(category_id) is not int:
        raise bad_request('删除阶段须保留原项目编号')
    def remove():
        stage, plan, data = _stage(ctx)
        if plan['category_id'] != category_id:
            raise bad_request('阶段不属于所选项目')
        revision(ctx, data)
        if data['state'] != 'draft':
            raise conflict('请先由管理员撤回阶段确认')
        _guard_retract(ctx.conn, stage)
        db.run(ctx.conn, 'DELETE FROM stages WHERE id=?', (stage['id'],))
        security.audit(ctx.conn, ctx.user, 'delete_schedule_stage', 'stage', stage['id'])
        return {'message': '阶段草稿已删除'}
    return mutation(ctx, category_id, remove)
