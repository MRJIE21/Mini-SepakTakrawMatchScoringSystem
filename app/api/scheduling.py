"""Compatibility reads and an explicit tombstone for the retired planner."""
from ..errors import ApiError
from ..http_server import route
from .common import active_plan, category_context, get_or_404
from .schedule_read import plan_detail


@route('GET', r'/api/categories/(?P<category_id>\d+)/plan')
def get_plan(ctx):
    category_id = int(ctx.params['category_id'])
    plan = active_plan(ctx.conn, category_id)
    return {'category': category_context(ctx.conn, category_id),
            'plan': plan_detail(ctx.conn, plan, ctx.arg('include_matches', '1') != '0') if plan else None}


@route('GET', r'/api/plans/(?P<plan_id>\d+)')
def get_plan_by_id(ctx):
    plan = get_or_404(ctx.conn, 'plans', int(ctx.params['plan_id']), '赛程')
    return {'plan': plan_detail(ctx.conn, plan, ctx.arg('include_matches', '1') != '0')}


@route('POST', r'/api/categories/(?P<category_id>\d+)/plan', roles=('admin', 'organizer'))
@route('PUT', r'/api/plans/(?P<plan_id>\d+)/stages', roles=('admin', 'organizer'))
@route('POST', r'/api/plans/(?P<plan_id>\d+)/(?:generate|lock|unlock)', roles=('admin', 'organizer'))
@route('PUT', r'/api/pools/(?P<pool_id>\d+)(?:/members)?', roles=('admin', 'organizer'))
@route('POST', r'/api/stages/(?P<stage_id>\d+)/next-round', roles=('admin', 'organizer'))
@route('GET', r'/api/plans/(?P<plan_id>\d+)/impact', roles=('admin', 'organizer'))
def retired(ctx):
    raise ApiError(410, 'planner_retired', '自动辅助编排已移除，请在项目工作台的比赛赛程中维护阶段和比赛')
