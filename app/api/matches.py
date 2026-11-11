"""场次列表、详情、场地与时间安排、手动增删比赛（设计大纲 8、12.1）。"""
from __future__ import annotations

from .. import db, security
from ..domain import advancement, schedule
from ..errors import bad_request, conflict, forbidden, not_found
from ..http_server import route
from .common import (active_plan, category_context, get_or_404, plan_effective,
                     serialize_match)

ORG = ("admin", "organizer")


@route("GET", r"/api/matches")
def list_matches(ctx):
    from ..match_listing import list_page
    return list_page(ctx)


@route("GET", r"/api/matches/(?P<match_id>\d+)")
def match_detail(ctx):
    from .common import match_full_context
    return {"match": match_full_context(ctx.conn, int(ctx.params["match_id"]))}


def _check_venue(conn, category_id: int, venue_id) -> None:
    """场地必须属于本项目所在赛事：避免把一个赛事的场地写到另一个赛事的场次上。"""
    if not venue_id:
        return
    venue = get_or_404(conn, "venues", int(venue_id), "场地")
    row = db.q1(conn, """SELECT g.event_id FROM categories c JOIN groups g ON g.id = c.group_id
                          WHERE c.id = ?""", (category_id,))
    if row is None or venue["event_id"] != row["event_id"]:
        raise bad_request("该场地不属于本赛事，不能安排给本项目的比赛")


@route("PUT", r"/api/matches/(?P<match_id>\d+)", roles=ORG)
def update_match(ctx):
    if ctx.body.get('request_uid'):
        from .schedule import mutation
        match = get_or_404(ctx.conn, 'matches', int(ctx.params['match_id']), '比赛')
        return mutation(ctx, match['category_id'], lambda: _update_match(ctx))
    return _update_match(ctx)


def _update_match(ctx):
    """安排场地、时间；未锁定方案时也可调整轮次信息。"""
    match_id = int(ctx.params["match_id"])
    match = get_or_404(ctx.conn, "matches", match_id, "场次")
    if 'base_updated_at' in ctx.body and ctx.body['base_updated_at'] != match['updated_at']:
        raise conflict('比赛安排已变化，请刷新后重新核对', code='stale_revision')
    if 'base_schedule_revision' in ctx.body and ctx.body['base_schedule_revision'] != match['schedule_revision']:
        raise conflict('比赛安排已被其他操作更新，请刷新后核对', code='stale_revision')
    fields = {}
    if "venue_id" in ctx.body:
        fields["venue_id"] = int(ctx.body["venue_id"]) if ctx.body["venue_id"] else None
    if "scheduled_at" in ctx.body:
        fields["scheduled_at"] = schedule.normalize_time(ctx.body["scheduled_at"])
    if "note" in ctx.body:
        fields["note"] = ctx.body["note"] or ""
    if not fields:
        raise bad_request("没有需要更新的字段")
    _check_venue(ctx.conn, match["category_id"], fields.get("venue_id"))
    schedule.validate_schedule(ctx.conn, {match_id: {**dict(match), **fields}})
    fields["updated_at"] = db.now(ctx.conn)
    fields['schedule_revision'] = match['schedule_revision'] + 1
    db.update(ctx.conn, "matches", match_id, fields)
    security.audit(ctx.conn, ctx.user, "schedule_match", "match", match_id, fields)
    return {"message": "已更新", "match": serialize_match(ctx.conn, get_or_404(ctx.conn, "matches", match_id))}


def _parse_base_revisions(raw, ids: list[int]) -> dict[int, int] | None:
    """解析批量排场的可选逐场基础版本；缺省返回 None（保持旧行为）。"""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise bad_request("base_schedule_revisions 必须是“场次ID: 版本号”对象",
                          code="invalid_base_revisions")
    bases: dict[int, int] = {}
    for key, value in raw.items():
        try:
            mid = int(key)
        except (TypeError, ValueError):
            raise bad_request("base_schedule_revisions 的场次 ID 必须是整数",
                              code="invalid_base_revisions") from None
        if type(value) is not int or value < 0:
            raise bad_request(f"场次 {mid} 的基础版本必须是非负整数",
                              code="invalid_base_revisions")
        if mid in bases:
            raise bad_request("base_schedule_revisions 中出现重复场次",
                              code="invalid_base_revisions")
        bases[mid] = value
    # 批量安排需要覆盖全部场次：只校验部分场次会让未校验的场次仍可能被静默覆盖。
    missing = [mid for mid in ids if mid not in bases]
    if missing:
        raise bad_request(f"缺少场次 {missing[0]} 的基础版本", code="invalid_base_revisions")
    extra = sorted(set(bases) - set(ids))
    if extra:
        raise bad_request(f"基础版本包含未选择的场次 {extra[0]}", code="invalid_base_revisions")
    return bases


@route("POST", r"/api/matches/bulk-schedule", roles=ORG)
def bulk_schedule(ctx):
    """批量安排场地。

    body: {match_ids, venue_id, start_at, interval_minutes,
           base_schedule_revisions?: {match_id: schedule_revision}}
    提供 base_schedule_revisions 时在同一事务内逐场校验当前版本；任一不匹配返回
    409 stale_revision（detail 含 match_id/current）且不写入任何覆盖。
    """
    ids = [int(x) for x in (ctx.body.get("match_ids") or [])]
    if not ids:
        raise bad_request("请选择要安排的场次")
    if len(ids) != len(set(ids)):
        raise bad_request("不能重复选择同一场次")
    venue_id = ctx.body.get("venue_id")
    start = (ctx.body.get("start_at") or "").strip()
    raw_interval = ctx.body.get("interval_minutes")
    try:
        interval = 30 if raw_interval in (None, "") else int(raw_interval)
    except (TypeError, ValueError):
        raise bad_request("场次间隔必须为正整数分钟") from None
    if interval <= 0:
        raise bad_request("场次间隔必须大于 0 分钟")
    from datetime import datetime, timedelta
    if start:
        try:
            cursor = datetime.strptime(start, "%Y-%m-%d %H:%M")
        except ValueError as exc:
            raise bad_request("开始时间格式应为 2026-09-20 09:00") from exc
    else:
        cursor = None
    bases = _parse_base_revisions(ctx.body.get("base_schedule_revisions"), ids)
    marks = ",".join("?" for _ in ids)
    with db.tx(ctx.conn):
        # 事务内重读当前状态：BEGIN IMMEDIATE 后其它写入者无法插队，保证版本校验与写入原子。
        rows = db.q(ctx.conn, f"SELECT * FROM matches WHERE id IN ({marks})", ids)
        missing = set(ids) - {r["id"] for r in rows}
        if missing:
            raise not_found(f"场次不存在：{', '.join(str(m) for m in sorted(missing))}")
        by_id = {r["id"]: r for r in rows}
        for r in rows:
            _check_venue(ctx.conn, r["category_id"], venue_id)
        if bases is not None:
            for mid in ids:
                current = int(by_id[mid]["schedule_revision"])
                if current != bases[mid]:
                    raise conflict("比赛安排已被其他操作更新，请重新读取后再批量安排",
                                   code="stale_revision",
                                   detail={"match_id": mid, "current": current})
        changes = {}
        for i, mid in enumerate(ids):
            fields = {}
            if venue_id:
                fields["venue_id"] = int(venue_id)
            if cursor:
                fields["scheduled_at"] = (cursor + timedelta(minutes=interval * i)
                                          ).strftime("%Y-%m-%d %H:%M")
            if fields:
                fields["updated_at"] = db.now(ctx.conn)
                changes[mid] = fields
        schedule.validate_schedule(ctx.conn, {r["id"]: {**dict(r), **changes[r["id"]]}
                                             for r in rows if r["id"] in changes})
        for mid, fields in changes.items():
            fields['schedule_revision'] = int(by_id[mid]['schedule_revision']) + 1
            db.update(ctx.conn, "matches", mid, fields)
        event_id = db.q1(ctx.conn,
                         """SELECT g.event_id FROM categories c
                              JOIN groups g ON g.id = c.group_id WHERE c.id = ?""",
                         (rows[0]["category_id"],))["event_id"]
        security.audit(ctx.conn, ctx.user, "bulk_schedule", "event", event_id, {
            "matches": ids, "venue_id": int(venue_id) if venue_id else None,
            "start_at": start, "interval_minutes": interval, "scheduled": len(changes)})
    from .catalog import invalidate_event_stats
    invalidate_event_stats(event_id)
    return {"message": f"已安排 {len(ids)} 场"}


@route("GET", r"/api/events/(?P<event_id>\d+)/dashboard")
def dashboard(ctx):
    """赛事概览：大组别入口、项目进度、已提交与待处理场次。"""
    event_id = int(ctx.params["event_id"])
    event = get_or_404(ctx.conn, "events", event_id, "赛事")
    groups = db.q(ctx.conn, "SELECT * FROM groups WHERE event_id = ? ORDER BY seq", (event_id,))
    out = []
    for g in groups:
        cats = db.q(ctx.conn, "SELECT * FROM categories WHERE group_id = ? ORDER BY seq", (g["id"],))
        cat_items = []
        for c in cats:
            stats = db.q1(ctx.conn,
                          """SELECT COUNT(*) AS total,
                                    SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finished,
                                    SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS void,
                                    SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
                                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
                               FROM matches WHERE category_id = ?""", (c["id"],))
            placed = db.q1(ctx.conn,
                           """SELECT COUNT(*) AS n FROM placements
                               WHERE category_id = ? AND status = 'confirmed'""", (c["id"],))
            participants = db.q1(ctx.conn,
                                 """SELECT COUNT(*) AS n FROM participations
                                     WHERE category_id = ? AND status='active'
                                       AND deleted_at IS NULL""",
                                 (c["id"],))
            individual = db.q1(ctx.conn, """SELECT
                COUNT(CASE WHEN ir.confirmed=1 AND ir.result_status <> 'pending' THEN 1 END) AS confirmed,
                COUNT(CASE WHEN ir.confirmed=1 AND ir.result_status='normal' THEN 1 END) AS eligible
                FROM participations p LEFT JOIN individual_results ir ON ir.participation_id=p.id
                WHERE p.category_id=? AND p.status='active'
                  AND p.deleted_at IS NULL""", (c["id"],))
            enrolled = participants["n"] or 0
            results_complete = ((stats["total"] or 0) > 0 and
                                (stats["finished"] or 0) + (stats["void"] or 0) == stats["total"])
            required_placements = enrolled
            if c["kind"] == "individual":
                results_complete = enrolled > 0 and individual["confirmed"] == enrolled
                required_placements = individual["eligible"] or 0
            complete = enrolled > 0 and results_complete and (placed["n"] or 0) >= required_placements
            plan = db.q1(ctx.conn,
                         """SELECT id, status, version FROM plans WHERE category_id = ?
                             ORDER BY id DESC LIMIT 1""", (c["id"],))
            plan_data = dict(plan) if plan else None
            if plan:
                from .schedule import meta
                states = [meta(s)['state'] for s in db.q(ctx.conn, 'SELECT params_json FROM stages WHERE plan_id=?', (plan['id'],)) if meta(s)]
                plan_data['managed_state'] = 'draft' if 'draft' in states else 'confirmed' if states else None
            draw = db.q1(ctx.conn, "SELECT status FROM group_draws WHERE category_id=? AND status<>'cancelled' ORDER BY id DESC LIMIT 1", (c['id'],)) if c['kind'] == 'team' else None
            cat_items.append({
                "id": c["id"], "name": c["name"], "gender": c["gender"], "kind": c["kind"],
                "participants": enrolled,
                "matches_total": stats["total"] or 0,
                "matches_finished": stats["finished"] or 0,
                "matches_void": stats["void"] or 0,
                "matches_ready": stats["ready"] or 0,
                "matches_pending": stats["pending"] or 0,
                "placements_confirmed": placed["n"] or 0,
                "placements_required": required_placements,
                "individual_confirmed": individual["confirmed"] or 0,
                "results_complete": results_complete,
                "completed": complete,
                "plan": plan_data,
                "draw_status": draw['status'] if draw else None,
            })
        total = db.q1(ctx.conn,
                      """SELECT COUNT(*) AS total,
                                SUM(CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END) AS finished
                           FROM matches m JOIN categories c ON c.id = m.category_id
                          WHERE c.group_id = ?""", (g["id"],))
        out.append({**dict(g), "categories": cat_items,
                    "matches_total": total["total"] or 0,
                    "matches_finished": total["finished"] or 0})
    recent = db.q(ctx.conn,
                  """SELECT m.id, m.category_id, m.updated_at, m.result_status, m.round_label,
                            c.name AS category_name, c.kind AS category_kind,
                            c.gender AS category_gender, g.name AS group_name
                       FROM matches m JOIN categories c ON c.id = m.category_id
                       JOIN groups g ON g.id = c.group_id
                      WHERE g.event_id = ? AND m.status = 'finished'
                      ORDER BY m.updated_at DESC LIMIT 15""", (event_id,))
    enrolled_categories = [cat for group in out for cat in group["categories"] if cat["participants"]]
    return {"event": dict(event), "groups": out, "recent": db.rows_to_dicts(recent),
            "completed": bool(enrolled_categories) and all(cat["completed"] for cat in enrolled_categories)}


# ------------------------------------------------------------------ 手动增删
def _manual_stage(conn, category_id: int, stage_id: int | None) -> tuple[dict, int]:
    """返回 (方案, 阶段 id)。未指定阶段时挂到“自定义比赛”阶段，必要时自动建立。"""
    plan = active_plan(conn, category_id)
    if plan is None:
        plan_id = db.insert(conn, "plans", {
            "category_id": category_id, "name": "自定义比赛",
            "status": "draft", "version": 1, "params_json": '{"stages": []}'})
        plan = db.q1(conn, "SELECT * FROM plans WHERE id = ?", (plan_id,))
        security.audit(conn, None, "create_manual_plan", "plan", plan_id)
    if stage_id:
        stage = db.q1(conn, "SELECT * FROM stages WHERE id = ? AND plan_id = ?",
                      (stage_id, plan["id"]))
        if stage is None:
            raise bad_request("所选阶段不属于该项目的当前方案")
        return plan, stage["id"]
    stage = db.q1(conn,
                  "SELECT * FROM stages WHERE plan_id = ? AND kind = 'custom' ORDER BY seq LIMIT 1",
                  (plan["id"],))
    if stage is not None:
        return plan, stage["id"]
    seq = db.q1(conn, "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM stages WHERE plan_id = ?",
                (plan["id"],))["s"]
    stage_id = db.insert(conn, "stages", {
        "plan_id": plan["id"], "seq": seq, "kind": "custom", "name": "自定义比赛",
        "params_json": "{}", "note": "由编排人员逐场添加的比赛"})
    return plan, stage_id


@route("POST", r"/api/matches", roles=ORG)
def create_match(ctx):
    if ctx.body.get('request_uid'):
        from .schedule import mutation
        return mutation(ctx, int(ctx.body.get('category_id') or 0), lambda: _create_match(ctx))
    return _create_match(ctx)


def _create_match(ctx):
    """手动添加一场比赛：直接指定双方参赛主体，不需要预先编排。

    body: {category_id, stage_id?, round_label?, home_participation, away_participation,
           venue_id?, scheduled_at?, note?}
    """
    body = ctx.body or {}
    category_id = int(body.get("category_id") or 0)
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "team":
        raise bad_request("个人赛不生成对阵，请在个人赛结果页录入成绩")
    home = int(body.get("home_participation") or 0)
    away = int(body.get("away_participation") or 0)
    if not home or not away:
        raise bad_request("请选择双方参赛主体")
    if home == away:
        raise bad_request("一场比赛的双方不能是同一支队伍")
    for pid, label in ((home, "主队"), (away, "客队")):
        part = db.q1(ctx.conn, """SELECT * FROM participations
            WHERE id = ? AND deleted_at IS NULL""", (pid,))
        if part is None:
            raise not_found(f"{label}的参赛记录不存在")
        if part["category_id"] != category_id:
            raise bad_request(f"{label}不属于本项目")
        if part["status"] != "active":
            raise bad_request(f"{label}已标记退出，不能安排比赛")
    _check_venue(ctx.conn, category_id, body.get("venue_id"))
    stage_id = int(body["stage_id"]) if body.get("stage_id") else None
    plan, stage_id = _manual_stage(ctx.conn, category_id, stage_id)
    stage = get_or_404(ctx.conn, 'stages', stage_id, '阶段')
    from .schedule import meta
    managed = meta(stage)
    pool_id = None
    if managed and managed['definition']['purpose'] == 'group':
        if managed['state'] != 'confirmed':
            raise conflict('请先确认小组赛阶段')
        pool_id = body.get('pool_id')
        pool = db.q1(ctx.conn, 'SELECT * FROM pools WHERE id=? AND stage_id=?', (pool_id, stage_id))
        if not pool:
            raise bad_request('请选择本阶段的小组')
        if pool['status'] == 'confirmed':
            raise conflict('小组名次已确认，新增比赛须先按更正流程撤销确认')
        members = {r['participation_id'] for r in db.q(ctx.conn, 'SELECT participation_id FROM pool_members WHERE pool_id=?', (pool_id,))}
        if not {home, away}.issubset(members):
            raise bad_request('小组赛双方必须属于所选小组')
    elif body.get('pool_id'):
        raise bad_request('手工比赛不能引用其他阶段的小组')
    reason = _ensure_stage_editable(ctx.conn, ctx.user, plan["id"], stage_id,
                                    "向锁定阶段添加场次", body)
    with db.tx(ctx.conn):
        seq = db.q1(ctx.conn,
                    "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM matches WHERE stage_id = ?",
                    (stage_id,))["s"]
        match_id = db.insert(ctx.conn, "matches", {
            "category_id": category_id, "plan_id": plan["id"], "plan_version": plan["version"],
            "stage_id": stage_id, "pool_id": pool_id,
            "seq": seq, "round_no": int(body.get("round_no") or 1),
            "round_label": (body.get("round_label") or "自定义比赛").strip(),
            "venue_id": int(body["venue_id"]) if body.get("venue_id") else None,
            "scheduled_at": schedule.normalize_time(body.get("scheduled_at")),
            "home_source_type": "participation", "home_participation": home,
            "away_source_type": "participation", "away_participation": away,
            "status": "pending", "note": body.get("note") or ""})
        advancement.refresh_plan(ctx.conn, plan["id"])
        schedule.validate_schedule(ctx.conn, {match_id: dict(get_or_404(ctx.conn, "matches", match_id))})
        security.audit(ctx.conn, ctx.user, "create_match", "match", match_id,
                       {"home": home, "away": away, "stage_id": stage_id, "reason": reason})
    return {"match_id": match_id, "stage_id": stage_id, "plan_id": plan["id"],
            "message": "比赛已添加，可直接进入记录页计分"}


def _ensure_stage_editable(conn, user, plan_id, stage_id, action: str, body: dict) -> str:
    """方案锁定后的写保护（设计大纲 5.3、12.3）。

    锁定/进行中的方案里，只有“自定义比赛”阶段可以由编排人员随意增删；
    自动生成的小组赛与淘汰赛场次必须由管理员操作，并留下原因备查。
    返回需要记入审计的原因（未受限时为空串）。
    """
    plan = db.q1(conn, "SELECT * FROM plans WHERE id = ?", (plan_id,)) if plan_id else None
    stage = db.q1(conn, 'SELECT * FROM stages WHERE id=?', (stage_id,)) if stage_id else None
    if stage:
        from .schedule import meta
        managed = meta(stage)
        if managed:
            if managed['state'] != 'confirmed':
                raise conflict('阶段尚未确认，不能增删正式比赛')
            if managed['definition']['purpose'] in ('knockout', 'placement'):
                raise conflict('该场次属于已确认的决位图，请先撤回阶段确认后调整结构')
            return ''
    if plan is None or plan["status"] not in ("locked", "running"):
        return ""
    stage = db.q1(conn, "SELECT * FROM stages WHERE id = ?", (stage_id,)) if stage_id else None
    if stage is not None and stage["kind"] == "custom":
        return ""
    if user["role"] != "admin":
        raise forbidden(f"方案已锁定，{action}只能由管理员操作；如确需调整请先由管理员解锁方案")
    reason = (body.get("reason") or "").strip()
    if not reason:
        raise bad_request(f"方案已锁定，{action}必须填写原因", code="reason_required")
    return reason


@route("DELETE", r"/api/matches/(?P<match_id>\d+)", roles=ORG)
def delete_match(ctx):
    if ctx.body.get('request_uid'):
        from .schedule import mutation
        # A replay can occur after deletion. Category is carried in the frozen packet.
        return mutation(ctx, int(ctx.body.get('category_id') or 0), lambda: _delete_match(ctx))
    return _delete_match(ctx)


def _delete_match(ctx):
    """删除一场比赛。已有确认结果或已有关联后续场次时不允许直接删除。"""
    match_id = int(ctx.params["match_id"])
    match = get_or_404(ctx.conn, "matches", match_id, "场次")
    if match['status'] == 'finished' and match['result_version'] > 0:
        raise conflict('该场次已有确认成绩，请通过正式更正流程处理', code='has_result')
    if ctx.body.get('category_id') and ctx.body['category_id'] != match['category_id']:
        raise bad_request('比赛不属于所选项目')
    if db.q1(ctx.conn, 'SELECT k FROM settings WHERE k=?', (f'recording:match:{match_id}',)) or \
            db.q1(ctx.conn, 'SELECT id FROM score_events WHERE match_id=? LIMIT 1', (match_id,)) or \
            db.q1(ctx.conn, 'SELECT id FROM submissions WHERE match_id=? LIMIT 1', (match_id,)):
        raise conflict('比赛已领取或开始记录，请通过正式更正流程处理', code='match_started')
    if match['pool_id'] and db.q1(ctx.conn, "SELECT id FROM pools WHERE id=? AND status='confirmed'", (match['pool_id'],)):
        raise conflict('小组名次已确认，请先处理名次和下游影响')
    reason = _ensure_stage_editable(ctx.conn, ctx.user, match["plan_id"], match["stage_id"],
                                    "删除锁定方案中的场次", ctx.body or {})
    if match["status"] == "finished" and match["result_version"] > 0:
        raise conflict("该场次已有确认成绩，不能直接删除；请先使用“正式更正”或标记为已取消",
                       code="has_result")
    dependents = advancement.downstream_matches(ctx.conn, match_id)
    if dependents:
        raise conflict("已有后续场次依赖此场结果，删除会导致后续对阵失效",
                       code="has_dependents",
                       detail={"dependents": dependents})
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM matches WHERE id = ?", (match_id,))
        if match["plan_id"]:
            advancement.refresh_plan(ctx.conn, match["plan_id"])
        security.audit(ctx.conn, ctx.user, "delete_match", "match", match_id,
                       {"round_label": match["round_label"], "status": match["status"],
                        "reason": reason})
    return {"message": "比赛已删除"}


@route("POST", r"/api/stages/(?P<stage_id>\d+)/clear", roles=ORG)
def clear_stage_matches(ctx):
    """清空某个阶段中尚未确认成绩的场次（用于重来或删除自动生成的赛程）。"""
    stage_id = int(ctx.params["stage_id"])
    stage = get_or_404(ctx.conn, "stages", stage_id, "阶段")
    if ctx.body.get('list_revision') is not None:
        from ..list_revision import value
        if int(ctx.body['list_revision']) != value(ctx.conn):
            raise conflict('该阶段场次已变化，请重新核对清空范围', code='list_changed')
    reason = _ensure_stage_editable(ctx.conn, ctx.user, stage["plan_id"], stage_id,
                                    "清空锁定阶段的场次", ctx.body or {})
    rows = db.q(ctx.conn,
                """SELECT * FROM matches WHERE stage_id = ? AND status <> 'finished'""",
                (stage_id,))
    blocked: list[int] = []
    deleted = 0
    with db.tx(ctx.conn):
        for row in rows:
            if advancement.downstream_matches(ctx.conn, row["id"]) or db.q1(ctx.conn,
                    "SELECT k FROM settings WHERE k=?", (f"recording:match:{row['id']}",)) \
                    or db.q1(ctx.conn, 'SELECT id FROM score_events WHERE match_id=? LIMIT 1', (row['id'],)):
                blocked.append(row["id"])
                continue
            db.run(ctx.conn, "DELETE FROM matches WHERE id = ?", (row["id"],))
            deleted += 1
        for pool in db.q(ctx.conn, "SELECT id FROM pools WHERE stage_id = ?", (stage_id,)):
            left = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM matches WHERE pool_id = ?",
                         (pool["id"],))
            if not left["n"]:
                db.run(ctx.conn, "DELETE FROM pools WHERE id = ?", (pool["id"],))
        plan = db.q1(ctx.conn, "SELECT * FROM plans WHERE id = ?", (stage["plan_id"],))
        if plan:
            advancement.refresh_plan(ctx.conn, plan["id"])
        security.audit(ctx.conn, ctx.user, "clear_stage", "stage", stage_id,
                       {"deleted": deleted, "blocked": blocked, "reason": reason})
    return {"deleted": deleted, "blocked": blocked,
            "message": f"已删除 {deleted} 场未确认场次"
                       + (f"，{len(blocked)} 场因后续依赖或已开始记录未删除" if blocked else "")}


@route('GET', r'/api/stages/(?P<stage_id>\d+)/summary', roles=ORG)
def stage_summary(ctx):
    from ..list_revision import value
    from ..match_listing import read_snapshot
    with read_snapshot(ctx.conn):
        get_or_404(ctx.conn, 'stages', int(ctx.params['stage_id']), '阶段')
        row = db.q1(ctx.conn, '''SELECT COUNT(*) AS total,
            SUM(CASE WHEN status <> 'finished' THEN 1 ELSE 0 END) AS unstarted
            FROM matches WHERE stage_id=?''', (int(ctx.params['stage_id']),))
        return {'total': row['total'], 'unstarted': row['unstarted'] or 0,
                'list_revision': value(ctx.conn)}


@route('GET', r'/api/matches/schedule-check', roles=ORG)
def check_schedule(ctx):
    cat = category_context(ctx.conn, int(ctx.arg('category_id') or 0))
    at = schedule.normalize_time(ctx.arg('scheduled_at'))
    if not at:
        return {'conflicts': [], 'total': 0}
    venue = int(ctx.arg('venue_id') or 0)
    parts = [int(ctx.arg(name) or 0) for name in ('home_participation', 'away_participation')]
    query = '''FROM matches m JOIN categories c ON c.id=m.category_id
        JOIN groups g ON g.id=c.group_id JOIN plans p ON p.id=m.plan_id
        WHERE g.event_id=? AND p.status<>'archived' AND m.status<>'void'
        AND COALESCE(m.result_status,'')<>'cancelled' AND m.reset_state IN ('none','active')
        AND m.scheduled_at=? AND ((?<>0 AND m.venue_id=?)
            OR COALESCE(m.home_actual,m.home_participation) IN (?,?)
            OR COALESCE(m.away_actual,m.away_participation) IN (?,?))'''
    args = [cat['event_id'], at, venue, venue, *parts, *parts]
    n = db.q1(ctx.conn, 'SELECT COUNT(*) AS n ' + query, args)['n']
    rows = db.q(ctx.conn, 'SELECT m.id,m.round_label ' + query + ' ORDER BY m.id LIMIT 50', args)
    return {'total': n, 'conflicts': [dict(r) for r in rows]}
