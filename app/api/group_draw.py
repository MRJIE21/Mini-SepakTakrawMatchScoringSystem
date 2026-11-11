"""持久化学校抽签，逐校揭晓、确认、撤销及固定分组的编排衔接。"""
from __future__ import annotations

import json

from .. import db, idempotency, security
from ..domain.group_draw import draw_groups, method_label
from ..domain.slots import pool_name
from ..errors import bad_request, conflict, forbidden, not_found
from ..http_server import route
from .common import active_plan, category_context

ORG = ("admin", "organizer")


def roster_for(conn, category_id):
    return [dict(p) for p in db.q(conn, """SELECT p.id, p.seed_no, t.school_id,
                s.name AS school_name, COALESCE(NULLIF(s.short_name,''), s.name) AS display
            FROM participations p JOIN teams t ON t.id=p.team_id JOIN schools s ON s.id=t.school_id
            WHERE p.category_id=? AND p.status='active' AND p.deleted_at IS NULL
            ORDER BY p.id""", (category_id,))]


def latest_draw(conn, category_id):
    return db.q1(conn, "SELECT * FROM group_draws WHERE category_id=? ORDER BY id DESC LIMIT 1", (category_id,))


def draw_stale(conn, draw):
    return json.loads(draw['roster_json']) != roster_for(conn, draw['category_id'])


def draw_detail(conn, draw):
    if not draw:
        return None
    roster = json.loads(draw['roster_json'])
    by_id = {p['id']: p for p in roster}
    capacities = json.loads(draw['capacities_json'])
    steps = json.loads(draw['steps_json'])[:draw['revealed']]
    steps = [{**step, "number": index + 1, "display": by_id[step['participation_id']]['display'],
              "school_name": by_id[step['participation_id']]['school_name'],
              "seed_no": by_id[step['participation_id']]['seed_no']}
             for index, step in enumerate(steps)]
    users = {u['id']: u['display_name'] for u in db.q(conn, "SELECT id,display_name FROM users")}
    return {k: draw[k] for k in ('id', 'category_id', 'method', 'status', 'rev', 'revealed',
                               'created_at', 'confirmed_at', 'cancel_reason')} | {
        'capacities': capacities, 'total': len(roster), 'roster': roster, 'steps': steps,
        'groups': [{'name': pool_name(i, '组'), 'capacity': capacity,
                    'members': [s for s in steps if s['group'] == i]}
                   for i, capacity in enumerate(capacities)],
        'created_by_name': users.get(draw['created_by'], ''),
        'confirmed_by_name': users.get(draw['confirmed_by'], ''),
        'stale': draw_stale(conn, draw),
    }


def ensure_editable(conn, category_id):
    cat = category_context(conn, category_id)
    if cat['kind'] != 'team':
        raise bad_request('小组抽签仅用于以学校为单位的三人赛项目')
    if db.q1(conn, """SELECT po.id FROM pools po JOIN stages s ON s.id=po.stage_id
        JOIN plans p ON p.id=s.plan_id WHERE p.category_id=? LIMIT 1""", (category_id,)):
        raise conflict('分组已用于正式赛程，请先处理后续引用并撤回小组赛阶段确认', code='draw_in_use')
    if db.q1(conn, "SELECT id FROM plans WHERE category_id=? AND status IN ('locked','running')", (category_id,)):
        raise forbidden('方案已锁定，请先由管理员解锁后再调整抽签')
    if db.q1(conn, "SELECT id FROM matches WHERE category_id=? AND status='finished' LIMIT 1", (category_id,)):
        raise conflict('该项目已有比赛成绩，不能重新抽签或改变分组', code='has_results')


def confirmed_draw(conn, category_id, draw_id):
    draw = latest_draw(conn, category_id)
    if not draw or draw['id'] != draw_id or draw['status'] != 'confirmed':
        raise conflict('抽签尚未确认或已撤销，请核对当前抽签结果后重新保存编排', code='draw_not_confirmed')
    if draw_stale(conn, draw):
        raise conflict('参赛学校或种子序号已变化，请撤销旧抽签并重新抽签', code='draw_roster_changed')
    return draw


def fixed_pools(conn, category_id, params):
    draw = confirmed_draw(conn, category_id, params['draw_id'])
    steps = json.loads(draw['steps_json'])
    return [{'name': pool_name(i, '组'),
             'members': [s['participation_id'] for s in steps if s['group'] == i]}
            for i in range(len(json.loads(draw['capacities_json'])))]


def _mutation(ctx, fn):
    uid = idempotency.extract_uid(ctx.body)
    if not uid or len(uid) > 120:
        raise bad_request('抽签操作需要有效的请求标识')
    payload = {'path': ctx.path, 'user_id': ctx.user['id'],
               'body': idempotency.payload_without_uid(ctx.body)}
    return idempotency.replay_or_run(ctx.conn, ctx.user, uid, payload, fn, scope='group_draw')


@route('GET', r'/api/categories/(?P<category_id>\d+)/group-draw', roles=ORG)
def get_draw(ctx):
    category_id = int(ctx.params['category_id'])
    cat = category_context(ctx.conn, category_id)
    if cat['kind'] != 'team':
        raise bad_request('小组抽签仅用于三人赛项目')
    current = latest_draw(ctx.conn, category_id)
    history = db.q(ctx.conn, "SELECT * FROM group_draws WHERE category_id=? ORDER BY id DESC LIMIT 20", (category_id,))
    plan = active_plan(ctx.conn, category_id)
    blocked = '方案已锁定，请由管理员解锁后调整' if plan and plan['status'] in ('locked', 'running') else ''
    if db.q1(ctx.conn, """SELECT po.id FROM pools po JOIN stages s ON s.id=po.stage_id
        JOIN plans p ON p.id=s.plan_id WHERE p.category_id=? LIMIT 1""", (category_id,)):
        blocked = '分组已用于正式赛程，调整前须处理后续引用并撤回小组赛阶段确认'
    if db.q1(ctx.conn, "SELECT id FROM matches WHERE category_id=? AND status='finished' LIMIT 1", (category_id,)):
        blocked = '已有比赛成绩，不能改变抽签分组'
    roster = roster_for(ctx.conn, category_id)
    from ..manual_results import snapshot
    manual = snapshot(ctx.conn, category_id)
    return {'draw': draw_detail(ctx.conn, current), 'roster': roster, 'manual_result': manual,
            'roster_hash': idempotency.content_hash(roster),
            'history': [draw_detail(ctx.conn, row) for row in history if row['status'] == 'cancelled'],
            'blocked_reason': blocked or ('已录入人工分组；请通过导入显式覆盖，不自动重新抽签' if manual else '')}


@route('POST', r'/api/categories/(?P<category_id>\d+)/group-draw', roles=ORG)
def start_draw(ctx):
    category_id = int(ctx.params['category_id'])
    def create():
        ensure_editable(ctx.conn, category_id)
        if db.q1(ctx.conn, 'SELECT category_id FROM manual_result_sets WHERE category_id=?', (category_id,)):
            raise conflict('已录入人工分组，请通过导入显式覆盖，不能自动重新抽签', code='manual_result_final')
        previous = latest_draw(ctx.conn, category_id)
        if previous and previous['status'] != 'cancelled':
            raise conflict('已有抽签记录，请继续本次抽签；重新抽签须先填写原因并撤销', code='draw_exists')
        roster = roster_for(ctx.conn, category_id)
        if ctx.body.get('roster_hash') != idempotency.content_hash(roster):
            raise conflict('报名名单已变化，请刷新后核对参赛学校', code='draw_roster_changed')
        capacities = ctx.body.get('capacities')
        if not isinstance(capacities, list):
            raise bad_request('请填写各组人数')
        try:
            steps = draw_groups(roster, ctx.body.get('method'), capacities)
        except ValueError as exc:
            raise bad_request(str(exc)) from exc
        draw_id = db.insert(ctx.conn, 'group_draws', {
            'category_id': category_id, 'method': ctx.body['method'],
            'capacities_json': json.dumps(capacities),
            'roster_json': json.dumps(roster, ensure_ascii=False),
            'steps_json': json.dumps(steps), 'created_by': ctx.user['id'],
        })
        security.audit(ctx.conn, ctx.user, 'start_group_draw', 'group_draw', draw_id,
                       {'method': ctx.body['method'], 'capacities': capacities})
        return {'draw': draw_detail(ctx.conn, latest_draw(ctx.conn, category_id))}
    return _mutation(ctx, create)


@route('POST', r'/api/categories/(?P<category_id>\d+)/group-draw/(?P<action>next|complete|confirm|cancel)', roles=ORG)
def change_draw(ctx):
    category_id, action = int(ctx.params['category_id']), ctx.params['action']
    def change():
        ensure_editable(ctx.conn, category_id)
        draw = latest_draw(ctx.conn, category_id)
        if not draw:
            raise not_found('该项目尚未抽签')
        if ctx.body.get('draw_id') != draw['id'] or ctx.body.get('base_rev') != draw['rev']:
            raise conflict('其他设备已更新抽签，请刷新后继续', code='draw_stale_revision')
        if draw['status'] == 'cancelled':
            raise conflict('本次抽签已撤销，请开始新抽签')
        values = {'rev': draw['rev'] + 1}
        if action == 'cancel':
            reason = str(ctx.body.get('reason') or '').strip()
            if not reason or len(reason) > 500:
                raise bad_request('请填写 1—500 字的撤销原因')
            values.update(status='cancelled', cancel_reason=reason)
        else:
            if draw_stale(ctx.conn, draw):
                raise conflict('参赛学校或种子序号已变化，请撤销本次抽签并重新核对名单', code='draw_roster_changed')
            if action == 'confirm':
                if draw['status'] != 'complete':
                    raise conflict('请先揭晓全部学校，再确认抽签结果', code='draw_incomplete')
                values.update(status='confirmed', confirmed_by=ctx.user['id'], confirmed_at=db.now(ctx.conn))
            else:
                if draw['status'] != 'drawing':
                    raise conflict('本次抽签已完成，请核对并确认结果')
                total = len(json.loads(draw['steps_json']))
                revealed = total if action == 'complete' else draw['revealed'] + 1
                values.update(revealed=revealed, status='complete' if revealed == total else 'drawing')
        db.update(ctx.conn, 'group_draws', draw['id'], values)
        security.audit(ctx.conn, ctx.user, f'{action}_group_draw', 'group_draw', draw['id'],
                       {'revealed': values.get('revealed', draw['revealed']), 'reason': values.get('cancel_reason', '')})
        return {'draw': draw_detail(ctx.conn, latest_draw(ctx.conn, category_id))}
    return _mutation(ctx, change)


@route('GET', r'/api/categories/(?P<category_id>\d+)/group-draw/notice.html', roles=ORG)
def print_draw(ctx):
    from .exports import _print_response, _category_label
    category_id = int(ctx.params['category_id'])
    cat = category_context(ctx.conn, category_id)
    draw = latest_draw(ctx.conn, category_id)
    if not draw or draw['status'] != 'confirmed':
        raise conflict('请先确认抽签结果，再打印正式分组表')
    draw = confirmed_draw(ctx.conn, category_id, draw['id'])
    detail = draw_detail(ctx.conn, draw)
    rows = [[group['name'], index + 1, member['school_name'],
             f"第{member['pot']}档" if member['pot'] else '—', member['seed_no'] or '—']
            for group in detail['groups'] for index, member in enumerate(group['members'])]
    note = (f"抽签编号：{draw['id']}；方式：{method_label(draw['method'])}；"
            f"确认人：{detail['confirmed_by_name']}；确认时间：{draw['confirmed_at']}。")
    return _print_response(ctx, '学校小组抽签分组表', cat['event_name'],
                           f"{cat['group_name']} · {_category_label(cat['name'], cat['gender'])}",
                           ['小组', '组内签位', '学校', '档位', '种子序号'], rows, note)
