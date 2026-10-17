"""现场记录提交：三人赛完整成绩包、个人赛最终结果、提交查询与正式更正。

对应设计大纲 4.2、6、12.2、12.3。
默认提交成功即确认；服务器接收成功前前端不得清除本地记录。
"""
from __future__ import annotations

import json
from itertools import groupby

from .. import db, security, access, idempotency, team_rules_store
from ..domain import advancement, validation
from ..errors import ApiError, bad_request, conflict, forbidden, not_found
from ..http_server import route
from ..result_safety import (atomic_result, can_read_receipt, receipt, require_result_role,
                             require_version, result_scope, submission_receipt)
from .common import (MATCH_STATUS_NAMES, category_context, get_or_404,
                     match_full_context, match_plan_effective, side_players, serialize_match)

REC = ("admin", "organizer", "recorder")
ORG = ("admin", "organizer")


@route("POST", r"/api/recording/(?P<kind>match|individual)/(?P<subject_id>\d+)/claim", roles=REC)
def claim_recording(ctx):
    return access.claim(ctx, ctx.params['kind'], int(ctx.params['subject_id']))


@route("POST", r"/api/recording/(?P<kind>match|individual)/(?P<subject_id>\d+)/transfer", roles=ORG)
def transfer_recording(ctx):
    return access.claim(ctx, ctx.params['kind'], int(ctx.params['subject_id']), transfer=True)


@route("GET", r"/api/recorders", roles=ORG)
def available_recorders(ctx):
    registry = db.get_conn()
    eid = db.q1(ctx.conn, 'SELECT id FROM events LIMIT 1')['id']
    users = db.q(registry, "SELECT id,role,display_name,username FROM users WHERE active=1 AND role IN ('admin','organizer','recorder')")
    return {'users': [dict(u) for u in users if access.event_ids(registry, u) is None or eid in access.event_ids(registry, u)]}


# ------------------------------------------------------------------ 记录端
@route("GET", r"/api/scoring/queue")
def scoring_queue(ctx):
    from ..match_listing import list_page
    return list_page(ctx, queue=True)


@route("GET", r"/api/scoring/match/(?P<match_id>\d+)")
def match_package(ctx):
    """赛前数据下载：场次信息、双方队员、方案版本与基础版本。"""
    match = get_or_404(ctx.conn, "matches", int(ctx.params["match_id"]), "场次")
    info = match_full_context(ctx.conn, match["id"])
    players = {}
    for side in ("home", "away"):
        pid = info[side]["participation_id"]
        players[side] = side_players(ctx.conn, pid) if pid else []
    info["players"] = players
    info["base_version"] = match["result_version"]
    info["recorded"] = bool(match["status"] == "finished")
    return {"match": info}


@route("POST", r"/api/scoring/submit", roles=REC)
@atomic_result
def submit_match(ctx):
    """三人赛完整成绩包提交（幂等 + 版本冲突检测 + 过程结果一致性校验）。"""
    payload = ctx.body or {}
    uid = str(payload.get("submission_uid") or "").strip()
    if not uid:
        raise bad_request("缺少提交标识 submission_uid")
    match_id = int(payload.get("match_id") or 0)
    match = get_or_404(ctx.conn, "matches", match_id, "场次")
    access.require_owner(ctx, 'match', match_id)
    result_scope(ctx, "match", match_id, match["category_id"])
    digest = validation.payload_hash(payload)
    previous = db.q1(ctx.conn, "SELECT * FROM submissions WHERE uid = ?", (uid,))
    if db.q1(ctx.conn, "SELECT uid FROM request_log WHERE uid=?", (uid,)):
        raise conflict("此标识已用于其他请求", code="uid_conflict")
    if previous:
        if (previous["payload_hash"] == digest and previous["user_id"] == ctx.user["id"]
                and previous["kind"] == "match" and previous["match_id"] == match_id):
            return {"duplicate": True, "submission_id": previous["id"],
                    "status": previous["status"], "message": "该提交已接收，未重复保存",
                    "receipt": submission_receipt(ctx.conn, previous)}
        raise conflict("相同提交标识的内容与已保存记录不一致，请检查设备数据", code="uid_conflict")

    if match["status"] == "pending":
        raise conflict("该场次仍在等待前序结果，暂不能计分", code="not_ready",
                       detail={"note": match["note"]})
    if match["reset_state"] in ("inactive", "review"):
        raise conflict("该重置赛已停用或需要复核，不能提交成绩", code="reset_requires_review")
    if match["status"] == "void":
        raise conflict("该场次为轮空，没有实际比赛，不能提交比分", code="void_match")
    if match["status"] == "finished" and ctx.user["role"] == "recorder":
        raise forbidden("该场次已有确认结果，正式更正需要编排与成绩人员或管理员操作")
    plan = db.q1(ctx.conn, "SELECT * FROM plans WHERE id = ?", (match["plan_id"],)) if match["plan_id"] else None
    if plan and not match_plan_effective(ctx.conn, match, plan):
        raise conflict("该自动编排场次尚未生效，请管理员先锁定方案，不能提交正式成绩",
                       code="plan_not_locked")
    if payload.get("plan_version") not in (None, match["plan_version"]):
        raise conflict("提交携带的方案版本与服务器不一致，请重新加载场次数据",
                       code="plan_version_conflict",
                       detail={"server_plan_version": match["plan_version"]})
    base_version = require_version(payload)
    if base_version != match["result_version"]:
        raise conflict("该场次结果已被其他设备更新，请先核对当前结果再提交",
                       code="version_conflict",
                       detail={"server_result_version": match["result_version"],
                               "your_base_version": base_version,
                               "current": _current_result(ctx.conn, match_id)})

    # 对阵版本：提交包必须绑定记录时的双方身份；对阵一旦变化，旧记录必须进入冲突核对
    rec_home = payload.get("home_participation")
    rec_away = payload.get("away_participation")
    if rec_home is None or rec_away is None:
        raise bad_request("提交包缺少记录时的对阵双方（home_participation / away_participation）",
                          code="missing_lineup")
    current_lineup = (match["home_actual"], match["away_actual"])
    if (int(rec_home), int(rec_away)) != current_lineup:
        raise conflict("对阵双方已发生变化，本记录与当前对阵不一致，请核对后重新记录或导出留档",
                       code="lineup_changed",
                       detail={"recorded": [int(rec_home), int(rec_away)],
                               "current": [current_lineup[0], current_lineup[1]]})

    sets = payload.get("sets") or []
    events = payload.get("events") or []
    result_status = payload.get("result_status") or "normal"
    rule_info = team_rules_store.freeze(ctx.conn, match)
    team_rules_store.check_payload(payload, rule_info)
    errors = validation.validate_team_package(sets=sets, events=events, result_status=result_status,
                                              rules=rule_info['rules'])
    if errors:
        raise ApiError(422, "invalid_package", "提交数据未通过校验，请核对后重试",
                       detail={"errors": errors})
    if match['status'] == 'finished':
        raise conflict('已提交成绩请使用正式更正并填写原因', code='correction_required')

    with db.tx(ctx.conn):
        _write_match_result(ctx.conn, match, sets, events, result_status, payload)
        submission_id = db.insert(ctx.conn, "submissions", {
            "uid": uid, "kind": "match", "match_id": match_id, "device": payload.get("device") or "",
            "base_version": base_version, "plan_version": match["plan_version"],
            "payload_hash": digest, "home_participation": int(rec_home),
            "away_participation": int(rec_away), "status": "confirmed",
            "message": payload.get("note") or "", "user_id": ctx.user["id"]})
        adv = {"affected": []}
        reset = _maybe_create_reset_match(ctx.conn, match)
        # 顺序重要：先退回与当前成绩不一致的小组名次快照，再刷新签位，
        # 下游场次才会立刻回到“等待前序结果”，不会按旧名次继续开赛
        stale = _stale_pools(ctx.conn, match["plan_id"]) if match["plan_id"] else []
        if match["plan_id"]:
            adv = advancement.refresh_plan(ctx.conn, match["plan_id"])
        if plan and plan["status"] == "locked":
            db.update(ctx.conn, "plans", plan["id"], {"status": "running"})
        revalidated = _revalidate_placements(ctx.conn, match["category_id"])
        _log_audit(ctx.conn, ctx.user, "submit_match", match_id,
                   {"result_status": result_status, "sets": sets, "submission_uid": uid})
    return {"submission_id": submission_id, "duplicate": False,
            "message": "成绩已提交并确认" + ("；已按方案生成决赛重置场次" if reset else ""),
            "affected": adv["affected"], "reset_match_created": reset,
            "stale_pools": stale, "placements": revalidated,
            "receipt": receipt(uid, "match", match_id, payload, base_version + 1, submission_id),
            "match": match_full_context(ctx.conn, match_id)}


def _write_match_result(conn, match, sets: list[dict], events: list, result_status: str,
                        payload: dict, keep_events: bool = False) -> None:
    match_id = match["id"]
    rules = team_rules_store.match_rules(conn, db.q1(conn, 'SELECT * FROM matches WHERE id=?', (match_id,)))['rules']
    db.run(conn, "DELETE FROM match_sets WHERE match_id = ?", (match_id,))
    for s in sorted(sets, key=lambda x: int(x.get("set_no") or 0)):
        hp, ap = int(s.get("home_points") or 0), int(s.get("away_points") or 0)
        db.insert(conn, "match_sets", {
            "match_id": match_id, "set_no": int(s["set_no"]), "home_points": hp,
            "away_points": ap,
            "winner_side": s.get("winner_side") or validation.set_winner(hp, ap, rules=rules, set_no=int(s['set_no'])) or ""})
    if not keep_events:
        db.run(conn, "DELETE FROM score_events WHERE match_id = ?", (match_id,))
        for e in sorted(events, key=lambda x: int(x.get("seq") or 0)):
            db.insert(conn, "score_events", {
                "match_id": match_id, "seq": int(e.get("seq") or 0),
                "kind": e.get("kind") or "score", "set_no": int(e.get("set_no") or 0),
                "side": e.get("side") or "", "home_after": e.get("home_after"),
                "away_after": e.get("away_after"), "ref_seq": e.get("ref_seq"),
                "created_at": e.get("created_at") or db.now(conn)})
    db.update(conn, "matches", match_id, {
        "status": "finished", "result_status": result_status,
        "result_version": match["result_version"] + 1,
        "updated_at": db.now(conn)})


def _current_result(conn, match_id: int) -> dict:
    sets = db.q(conn, "SELECT * FROM match_sets WHERE match_id = ? ORDER BY set_no", (match_id,))
    return {"sets": [dict(s) for s in sets],
            "result_status": db.q1(conn, "SELECT result_status FROM matches WHERE id = ?",
                                   (match_id,))["result_status"]}


def _reset_history(conn, match):
    return bool(match["status"] == "finished" or
                db.q1(conn, "SELECT id FROM match_sets WHERE match_id=? LIMIT 1", (match["id"],)) or
                db.q1(conn, "SELECT id FROM score_events WHERE match_id=? LIMIT 1", (match["id"],)) or
                db.q1(conn, "SELECT id FROM submissions WHERE match_id=? LIMIT 1", (match["id"],)))


def _maybe_create_reset_match(conn, match, resolutions=None, user=None) -> bool:
    """Reconcile reset activity, never silently reusing a historical result."""
    match = db.q1(conn, "SELECT * FROM matches WHERE id = ?", (match["id"],))
    if match is None or not match["plan_id"] or match["round_no"] != 200:
        return False
    plan = db.q1(conn, "SELECT * FROM plans WHERE id = ?", (match["plan_id"],))
    if plan is None:
        return False
    stage = db.q1(conn, "SELECT * FROM stages WHERE id = ?", (match["stage_id"],))
    if stage is None or stage["kind"] != "double_elim":
        return False
    params = _loads(stage["params_json"])
    required = bool(params.get("grand_final_reset") and
                    advancement.result_winner_side(conn, match) == "away")
    existing = db.q(conn, "SELECT * FROM matches WHERE reset_parent_id=? ORDER BY reset_state='active' DESC,id", (match["id"],))
    has_active = any(row["reset_state"] == "active" for row in existing)
    supplied = resolutions or []
    if not isinstance(supplied, list):
        raise bad_request("reset_resolutions 必须是复核列表")
    resolution_map = {}
    for item in supplied:
        if (not isinstance(item, dict) or type(item.get("match_id")) is not int
                or item["match_id"] in resolution_map or item.get("action") not in ("deactivate", "reuse", "replace")
                or type(item.get("base_version")) is not int or not str(item.get("reason") or "").strip()):
            raise bad_request("请填写重置赛 ID、版本、复核动作及原因")
        resolution_map[item["match_id"]] = item
    if set(resolution_map) - {row["id"] for row in existing}:
        raise bad_request("重置赛复核项不属于该父决赛")
    blocked = []
    for row in existing:
        if (row["reset_state"] == "inactive" and (not required or has_active)
                and row["id"] not in resolution_map):
            continue
        claim = access.assignment(conn, "match", row["id"])
        history = _reset_history(conn, row)
        changed = row["reset_parent_version"] != match["result_version"]
        needs_review = (row["reset_state"] == "review" or
                        (history or claim) and (not required or changed or row["reset_state"] != "active"))
        action = resolution_map.get(row["id"])
        if action and action["base_version"] != row["result_version"]:
            raise conflict("重置赛结果已变化，请重新核对", code="version_conflict",
                           detail={"match_id": row["id"], "server_result_version": row["result_version"]})
        if needs_review and not action:
            blocked.append({"match_id": row["id"], "base_version": row["result_version"],
                            "state": row["reset_state"], "claimed_by": claim["user_id"] if claim else None,
                            "has_history": history})
            continue
        if action and action["action"] == "reuse":
            other = db.q1(conn, "SELECT id FROM matches WHERE reset_parent_id=? AND reset_state='active' AND id<>?",
                          (match["id"], row["id"]))
            if other:
                raise conflict("该父决赛已有其他有效重置赛，请先显式处置", code="reset_active_exists")
            if (not required or (row["home_actual"], row["away_actual"]) !=
                    (match["home_actual"], match["away_actual"]) or
                    (history and (row["status"] != "finished" or
                                  row["result_status"] not in advancement.FINISHED_RESULTS))):
                raise conflict("旧重置成绩与当前对阵或有效结果不符，不能复用", code="reset_reuse_invalid")
            new_state = "active"
        elif action or not required:
            new_state = "inactive"
        else:
            new_state = "active"
        updates = {"reset_state": new_state, "reset_parent_version": match["result_version"]}
        if row["reset_state"] != new_state:
            team_rules_store.freeze(conn, row)
            updates["result_version"] = row["result_version"] + 1
            updates["updated_at"] = db.now(conn)
        db.update(conn, "matches", row["id"], updates)
        if action:
            security.audit(conn, user, "review_reset_match", "match", row["id"],
                           {"parent_id": match["id"], "before": row["reset_state"],
                            "after": new_state, **action})
    if blocked:
        raise conflict("重置赛已有领取或历史记录，请显式复核处置后再更正父决赛",
                       code="reset_requires_review", detail={"reset_matches": blocked})
    if not required or db.q1(conn, "SELECT id FROM matches WHERE reset_parent_id=? AND reset_state='active'",
                            (match["id"],)):
        return False
    # A deliberately deactivated old result is history. A fresh active fixture
    # gets a new identity and therefore cannot accidentally inherit its scores.
    source_fields = {f"{side}_{suffix}": match[f"{side}_{suffix}"]
                     for side in ("home", "away")
                     for suffix in ("source_type", "source_pool", "source_rank", "source_match", "participation")}
    new_id = db.insert(conn, "matches", {
        "category_id": match["category_id"], "plan_id": match["plan_id"],
        "plan_version": match["plan_version"], "stage_id": match["stage_id"],
        "pool_id": match["pool_id"], "seq": match["seq"] + 1, "round_no": 201,
        "round_label": "决赛重置", "status": "pending",
        **source_fields, "reset_parent_id": match["id"], "reset_state": "active",
        "reset_parent_version": match["result_version"],
        "note": "败者区队伍赢下决赛，按赛前锁定方案加赛一场"})
    security.audit(conn, user, "create_reset_match", "match", new_id, {"from": match["id"]})
    return True


def _stale_pools(conn, plan_id: int) -> list[dict]:
    """成绩变化后，把名次快照与当前排名不一致的小组退回“待确认”。

    退回后该小组的名次不再解析后续签位（相关场次回到等待前序结果），
    需要成绩人员重新确认；已完成的后续场次不会被自动改写，只做提示。
    """
    from .standings import pool_standings_payload
    rows = db.q(conn,
                """SELECT p.* FROM pools p JOIN stages s ON s.id = p.stage_id
                    WHERE s.plan_id = ? AND p.status = 'confirmed'""", (plan_id,))
    out = []
    for pool in rows:
        data = pool_standings_payload(conn, pool, include_excluded=False)
        if not data.get("needs_reconfirm"):
            continue
        db.update(conn, "pools", pool["id"], {"status": "finished",
                                             "confirmed_by": None, "confirmed_at": None})
        db.run(conn, "UPDATE pool_rank_snapshots SET status='pending' WHERE pool_id=?", (pool["id"],))
        out.append({"pool_id": pool["id"], "pool_name": pool["name"],
                    "hint": "成绩变化后小组名次与已确认快照不一致，已退回待确认，请重新确认名次"})
    return out


def _revalidate_placements(conn, category_id: int) -> dict:
    """成绩变化后重新核对由结果推导出的项目名次与学校积分（设计大纲 12.3）。"""
    from .standings import revalidate_derived_placements
    return revalidate_derived_placements(conn, category_id)


def _log_audit(conn, user, action: str, match_id: int, detail: dict) -> None:
    security.audit(conn, user, action, "match", match_id, detail)


def _loads(text: str) -> dict:
    try:
        return json.loads(text or "{}")
    except json.JSONDecodeError:
        return {}


# ------------------------------------------------------------------ 个人赛
@route("POST", r"/api/scoring/individual", roles=REC)
@atomic_result
def submit_individual(ctx):
    """个人赛最终成绩提交：只记录结果与确认名次，不记录过程。"""
    with db.tx(ctx.conn):
        return _submit_individual(ctx)


def _submit_individual(ctx):
    payload = ctx.body or {}
    uid = str(payload.get("submission_uid") or "").strip()
    if not uid:
        raise bad_request("缺少提交标识 submission_uid")
    pid = int(payload.get("participation_id") or 0)
    access.require_owner(ctx, 'individual', pid)
    part = db.q1(ctx.conn, "SELECT * FROM participations WHERE id = ?", (pid,))
    if part is None:
        raise not_found("参赛记录不存在")
    cat = category_context(ctx.conn, part["category_id"])
    result_scope(ctx, "individual", pid, cat["id"])
    if cat["kind"] != "individual":
        raise bad_request("该项目不是个人赛，请使用三人赛记录页")
    digest = validation.payload_hash(payload)
    previous = db.q1(ctx.conn, "SELECT * FROM submissions WHERE uid = ?", (uid,))
    if db.q1(ctx.conn, "SELECT uid FROM request_log WHERE uid=?", (uid,)):
        raise conflict("此标识已用于其他请求", code="uid_conflict")
    if previous:
        previous_subject = db.q1(ctx.conn, "SELECT participation_id FROM individual_results WHERE id=?",
                                 (previous["individual_result_id"],))
        if (previous["payload_hash"] == digest and previous["user_id"] == ctx.user["id"]
                and previous["kind"] == "individual" and previous_subject
                and previous_subject["participation_id"] == pid):
            return {"duplicate": True, "submission_id": previous["id"], "status": previous["status"],
                    "message": "该提交已接收，未重复保存",
                    "receipt": submission_receipt(ctx.conn, previous)}
        raise conflict("相同提交标识的内容与已保存记录不一致", code="uid_conflict")

    result_status = payload.get("result_status") or "normal"
    result_value = payload.get("result_value")
    error_count = payload.get("error_count")
    violation_count = payload.get("violation_count")
    result_text = payload.get("result_text") or ""
    rank_no = payload.get("rank_no")
    rank_no = int(rank_no) if rank_no not in (None, "") else None
    if rank_no is not None:
        raise bad_request("原始成绩提交不能直接确认名次；请在全部结果完整后统一确认项目名次",
                          code="rank_requires_project_confirmation")
    errors = validation.validate_individual_package(
        result_status=result_status, result_value=result_value, result_text=result_text,
        rank_no=rank_no, events=payload.get("events"), error_count=error_count,
        violation_count=violation_count)
    if rank_no is not None and result_status != "normal":
        errors.append("只有正常完成的成绩才能记录名次；取消成绩、未完成、未参加请单独标记")
    if errors:
        raise ApiError(422, "invalid_package", "提交数据未通过校验，请核对后重试",
                       detail={"errors": errors})
    existing = db.q1(ctx.conn, "SELECT * FROM individual_results WHERE category_id = ? AND participation_id = ?",
                     (cat["id"], pid))
    if not existing:
        from ..individual_draw_store import guard_recording
        guard_recording(ctx.conn, cat['id'])
    base_version = require_version(payload)
    current_version = existing["version"] if existing else 0
    if base_version != current_version:
        raise conflict("该成绩已被更新，请先核对当前记录再提交", code="version_conflict",
                       detail={"server_version": current_version,
                               "your_base_version": base_version})
    correcting = bool(existing)
    reason = str(payload.get("reason") or "").strip()
    if correcting:
        if ctx.user["role"] not in ORG:
            raise forbidden("已有确认成绩，正式更正需要编排与成绩人员或管理员操作")
        if not reason:
            raise bad_request("请填写正式更正原因", code="correction_reason_required",
                              detail={"fields": {"reason": "请填写正式更正原因"}})
    with db.tx(ctx.conn):
        if existing:
            db.update(ctx.conn, "individual_results", existing["id"], {
                "result_value": result_value, "error_count": error_count,
                "violation_count": violation_count, "result_text": result_text, "rank_no": rank_no,
                "result_status": result_status, "confirmed": int(result_status != "pending"),
                "note": payload.get("note") or "", "version": current_version + 1,
                "updated_at": db.now(ctx.conn)})
            result_id = existing["id"]
        else:
            result_id = db.insert(ctx.conn, "individual_results", {
                "category_id": cat["id"], "participation_id": pid, "result_value": result_value,
                "error_count": error_count, "violation_count": violation_count,
                "result_text": result_text, "rank_no": rank_no, "result_status": result_status,
                "confirmed": int(result_status != "pending"), "note": payload.get("note") or "", "version": 1})
        # 任一原始结果变化都可能改变其他选手名次，整项退回待确认。
        db.run(ctx.conn, "UPDATE individual_results SET rank_no = NULL WHERE category_id = ?", (cat["id"],))
        db.run(ctx.conn, """UPDATE placements SET rank_no = NULL, status = 'pending',
                            note = '个人成绩变化，请重新确认项目名次', version = version + 1,
                            confirmed_by = NULL, confirmed_at = NULL
                            WHERE category_id = ? AND status = 'confirmed'""", (cat["id"],))
        from .standings import recompute_category_points
        recompute_category_points(ctx.conn, cat["id"])
        submission_id = db.insert(ctx.conn, "submissions", {
            "uid": uid, "kind": "individual", "individual_result_id": result_id,
            "device": payload.get("device") or "", "base_version": base_version,
            "payload_hash": digest, "status": "confirmed",
            "message": payload.get("note") or "", "user_id": ctx.user["id"]})
        security.audit(ctx.conn, ctx.user, "correct_individual" if correcting else "submit_individual",
                       "individual_result", result_id,
                       {"reason": reason, "before": dict(existing) if existing else None,
                        "after": dict(db.q1(ctx.conn, "SELECT * FROM individual_results WHERE id = ?", (result_id,)))})
    return {"submission_id": submission_id, "duplicate": False,
            "message": "个人成绩已保存，待核对" if result_status == "pending" else "个人成绩已提交，项目名次需统一确认",
            "receipt": receipt(uid, "individual", pid, payload, base_version + 1, submission_id),
            "result_id": result_id, "placement_updated": rank_no is not None}


def _upsert_individual_placement(conn, cat, pid: int, rank_no: int, user) -> None:
    row = db.q1(conn, "SELECT * FROM placements WHERE category_id = ? AND participation_id = ?",
                (cat["id"], pid))
    if row:
        db.update(conn, "placements", row["id"], {
            "rank_no": rank_no, "status": "confirmed", "source": "individual",
            "version": row["version"] + 1, "confirmed_by": user["id"],
            "confirmed_at": db.now(conn)})
    else:
        db.insert(conn, "placements", {
            "category_id": cat["id"], "participation_id": pid, "rank_no": rank_no,
            "status": "confirmed", "source": "individual", "note": "个人赛现场确认名次",
            "confirmed_by": user["id"], "confirmed_at": db.now(conn)})


@route("GET", r"/api/categories/(?P<category_id>\d+)/individual-results")
def list_individual_results(ctx):
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    rows = db.q(ctx.conn,
                """SELECT ir.*, COALESCE(t.name, a.name) AS subject, s.name AS school_name,
                          s.short_name AS school_short
                     FROM individual_results ir
                     JOIN participations p ON p.id = ir.participation_id
                     LEFT JOIN teams t ON t.id = p.team_id
                     LEFT JOIN athletes a ON a.id = p.athlete_id
                     LEFT JOIN schools s ON s.id = COALESCE(t.school_id, a.school_id)
                    WHERE ir.category_id = ? ORDER BY ir.rank_no IS NULL, ir.rank_no, s.name""",
                (category_id,))
    results = db.rows_to_dicts(rows)
    for result in results:
        result.update(access.owner_info(ctx.conn, 'individual', result['participation_id']))
        authors = db.q(ctx.conn, '''SELECT u.display_name FROM submissions s
            LEFT JOIN users u ON u.id=s.user_id WHERE s.individual_result_id=? ORDER BY s.id''', (result['id'],))
        if authors:
            result['recorder_name'] = authors[0]['display_name'] or ''
            result['corrector_name'] = authors[-1]['display_name'] if len(authors) > 1 else ''
    return {"category": cat, "results": results}


@route("POST", r"/api/categories/(?P<category_id>\d+)/individual-rankings/confirm", roles=ORG)
@atomic_result
def confirm_individual_rankings(ctx):
    """按有效次数降序、失误次数升序统一确认个人赛名次。"""
    with db.tx(ctx.conn):
        return _confirm_individual_rankings(ctx)


def _confirm_individual_rankings(ctx):
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "individual":
        raise bad_request("该项目不是个人赛")
    rows = db.q(ctx.conn,
                """SELECT p.id AS participation_id, ir.*, a.name AS athlete_name,
                          s.name AS school_name FROM participations p
                    LEFT JOIN individual_results ir ON ir.participation_id = p.id
                                                   AND ir.category_id = p.category_id
                    LEFT JOIN athletes a ON a.id = p.athlete_id
                    LEFT JOIN schools s ON s.id = a.school_id
                    WHERE p.category_id = ? AND p.status = 'active' ORDER BY p.id""",
                (category_id,))
    missing = [r["participation_id"] for r in rows if r["id"] is None]
    if missing:
        raise conflict("仍有运动员未录入结果，不能确认项目名次", code="results_incomplete",
                       detail={"participation_ids": missing})
    pending = [r["participation_id"] for r in rows if r["result_status"] == "pending" or not r["confirmed"]]
    if pending:
        raise conflict("仍有运动员的成绩待确认，请先完成成绩核对", code="results_pending",
                       detail={"participation_ids": pending})
    snapshot = validation.payload_hash([
        {k: r[k] for k in ("participation_id", "version", "result_status", "result_value", "error_count")}
        for r in rows])
    body = ctx.body or {}
    if body.get("base_results") and body["base_results"] != snapshot:
        raise conflict("成绩或报名名单已变化，请关闭抽签窗口并重新核对", code="ranking_changed")
    normal = [r for r in rows if r["result_status"] == "normal"]
    normal.sort(key=lambda r: (-int(r["result_value"]), int(r["error_count"])))
    ties = []
    offset = 0
    for _, members in groupby(normal, key=lambda r: (r["result_value"], r["error_count"])):
        members = list(members)
        if len(members) > 1:
            ties.append({"rank_from": offset + 1, "rank_to": offset + len(members), "members": [
                {"participation_id": r["participation_id"], "label": f"{r['school_name']} · {r['athlete_name']}"}
                for r in members]})
        offset += len(members)
    orders = body.get("tie_orders")
    if ties and orders is None:
        involved = [member["participation_id"] for tie in ties for member in tie["members"]]
        raise conflict("存在有效次数和失误次数均相同的运动员，请先录入抽签结果",
                       code="individual_tie_pending",
                       detail={"participation_ids": involved, "ties": ties, "base_results": snapshot})
    if orders is not None:
        if not body.get("base_results"):
            raise bad_request("抽签确认缺少成绩版本，请重新核对")
        if not isinstance(orders, list) or len(orders) != len(ties):
            raise bad_request("请完整填写每一组并列运动员的抽签顺序")
        for tie, order in zip(ties, orders):
            members = {m["participation_id"] for m in tie["members"]}
            if (not isinstance(order, list) or len(order) != len(members)
                    or any(type(pid) is not int for pid in order) or set(order) != members):
                raise bad_request("抽签顺序必须包含本组所有运动员且不能重复")
            lookup = {r["participation_id"]: r for r in normal}
            normal[tie["rank_from"] - 1:tie["rank_to"]] = [lookup[pid] for pid in order]
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM placements WHERE category_id = ? AND source = 'individual'",
               (category_id,))
        db.run(ctx.conn, "UPDATE individual_results SET rank_no = NULL WHERE category_id = ?",
               (category_id,))
        for rank_no, row in enumerate(normal, start=1):
            db.update(ctx.conn, "individual_results", row["id"], {"rank_no": rank_no})
            _upsert_individual_placement(ctx.conn, cat, row["participation_id"], rank_no, ctx.user)
        from .standings import recompute_category_points
        recompute_category_points(ctx.conn, category_id)
        security.audit(ctx.conn, ctx.user, "confirm_individual_rankings", "category", category_id,
                       {"count": len(normal), "tie_orders": orders or [], "base_results": snapshot})
    return {"message": f"已按成绩确认 {len(normal)} 个名次", "count": len(normal)}


# ------------------------------------------------------------------ 提交查询
@route("GET", r"/api/submissions/(?P<uid>[A-Za-z0-9_\-\.]+)")
def submission_status(ctx):
    """网络中断且响应未知时，先查询提交是否成功。"""
    row = db.q1(ctx.conn, "SELECT * FROM submissions WHERE uid = ?", (ctx.params["uid"],))
    if row is None or not can_read_receipt(ctx, row["user_id"]):
        return {"found": False}
    return {"found": True, "submission": dict(row), "receipt": submission_receipt(ctx.conn, row)}


@route("GET", r"/api/receipts/(?P<uid>[A-Za-z0-9_\-\.]+)", roles=None)
def result_receipt(ctx):
    """Minimal immutable acknowledgment, independent of current claim ownership."""
    uid = ctx.params["uid"]
    row = db.q1(ctx.conn, "SELECT * FROM submissions WHERE uid=?", (uid,))
    if row and can_read_receipt(ctx, row["user_id"]):
        return {"found": True, "receipt": submission_receipt(ctx.conn, row)}
    request = db.q1(ctx.conn, "SELECT * FROM request_log WHERE uid=?", (uid,))
    if request and can_read_receipt(ctx, request["user_id"]):
        saved = _loads(request["result_json"])
        if saved.get("receipt"):
            return {"found": True, "receipt": saved["receipt"]}
    return {"found": False}


@route("GET", r"/api/matches/(?P<match_id>\d+)/submissions")
def match_submissions(ctx):
    rows = db.q(ctx.conn,
                """SELECT s.*, u.display_name AS user_name FROM submissions s
                     LEFT JOIN users u ON u.id = s.user_id
                    WHERE s.match_id = ? ORDER BY s.id DESC""", (int(ctx.params["match_id"]),))
    return {"submissions": db.rows_to_dicts(rows)}


# ------------------------------------------------------------------ 正式更正
@route("POST", r"/api/matches/(?P<match_id>\d+)/correction", roles=ORG)
@atomic_result
def correct_match(ctx):
    return _run_result_mutation(ctx, "correction", _correct_match)


def _run_result_mutation(ctx, kind, fn):
    require_result_role(ctx)
    uid = idempotency.extract_uid(ctx.body)
    if not uid:
        raise bad_request("请升级页面并保留输入，正式修改必须携带 request_uid",
                          code="client_upgrade_required")
    match_id = int(ctx.params["match_id"])
    match = get_or_404(ctx.conn, "matches", match_id, "场次")
    scope = result_scope(ctx, kind, match_id, match["category_id"])
    if db.q1(ctx.conn, "SELECT id FROM submissions WHERE uid=?", (uid,)):
        raise conflict("此标识已用于其他提交", code="request_uid_reused")

    def apply():
        base_version = require_version(ctx.body)
        if base_version != match["result_version"]:
            raise conflict("该场次结果已变化，请先核对当前结果", code="version_conflict",
                           detail={"server_result_version": match["result_version"],
                                   "your_base_version": base_version,
                                   "current": _current_result(ctx.conn, match_id)})
        result = fn(ctx)
        applied = db.q1(ctx.conn, "SELECT result_version FROM matches WHERE id=?", (match_id,))[0]
        result["receipt"] = receipt(uid, kind, match_id, ctx.body, applied)
        return result

    return idempotency.replay_or_run(ctx.conn, ctx.user, uid, ctx.body, apply, scope, strict=True)


def _correct_match(ctx):
    """正式成绩更正：需权限与原因，保留原结果版本，列出受影响场次。"""
    match_id = int(ctx.params["match_id"])
    match = get_or_404(ctx.conn, "matches", match_id, "场次")
    if match["reset_state"] in ("inactive", "review"):
        raise conflict("重置赛需要先显式复核", code="reset_requires_review")
    reason = (ctx.body.get("reason") or "").strip()
    if not reason:
        raise bad_request("正式更正必须填写原因")
    if match["result_version"] == 0:
        raise bad_request("该场次尚无已确认结果，请直接提交成绩")
    sets = ctx.body.get("sets") or []
    events = ctx.body.get("events") or []
    result_status = ctx.body.get("result_status") or match["result_status"] or "normal"
    keep_events = not events
    rule_info = team_rules_store.freeze(ctx.conn, match)
    team_rules_store.check_payload(ctx.body, rule_info)
    errors = validation.validate_team_package(sets=sets, events=events, result_status=result_status,
                                              require_events=not keep_events, rules=rule_info['rules'])
    if errors:
        raise ApiError(422, "invalid_package", "更正数据未通过校验", detail={"errors": errors})
    before = _current_result(ctx.conn, match_id)
    with db.tx(ctx.conn):
        _write_match_result(ctx.conn, match, sets, events, result_status, ctx.body,
                            keep_events=keep_events)
        adv = {"affected": []}
        reset = _maybe_create_reset_match(ctx.conn, match, ctx.body.get("reset_resolutions"), ctx.user)
        stale = _stale_pools(ctx.conn, match["plan_id"]) if match["plan_id"] else []
        if match["plan_id"]:
            adv = advancement.refresh_plan(ctx.conn, match["plan_id"])
        revalidated = _revalidate_placements(ctx.conn, match["category_id"])
        security.audit(ctx.conn, ctx.user, "correct_match", "match", match_id,
                       {"reason": reason, "before": before,
                        "events_kept": keep_events,
                        "after": {"sets": sets, "result_status": result_status}})
    return {"message": "成绩已更正", "affected": adv["affected"], "stale_pools": stale,
            "reset_match_created": reset, "before": before, "placements": revalidated,
            "match": match_full_context(ctx.conn, match_id)}


@route("POST", r"/api/matches/(?P<match_id>\d+)/cancel", roles=ORG)
@atomic_result
def cancel_match(ctx):
    return _run_result_mutation(ctx, "cancel", _cancel_match)


def _cancel_match(ctx):
    """取消一场比赛（现场确认的结果状态，不自行补造比分）。"""
    match_id = int(ctx.params["match_id"])
    match = get_or_404(ctx.conn, "matches", match_id, "场次")
    if match["reset_state"] in ("inactive", "review"):
        raise conflict("重置赛需要先显式复核", code="reset_requires_review")
    reason = (ctx.body.get("reason") or "").strip()
    if not reason:
        raise bad_request("请填写取消或未完成的原因")
    status = ctx.body.get("result_status") or "cancelled"
    if status not in ("cancelled", "unfinished"):
        raise bad_request("只能标记为已取消或未完成")
    with db.tx(ctx.conn):
        team_rules_store.freeze(ctx.conn, match)
        db.update(ctx.conn, "matches", match_id, {
            "status": "finished", "result_status": status,
            "result_version": match["result_version"] + 1,
            "note": reason, "updated_at": db.now(ctx.conn)})
        _maybe_create_reset_match(ctx.conn, match, ctx.body.get("reset_resolutions"), ctx.user)
        stale = _stale_pools(ctx.conn, match["plan_id"]) if match["plan_id"] else []
        adv = advancement.refresh_plan(ctx.conn, match["plan_id"]) if match["plan_id"] else {"affected": []}
        revalidated = _revalidate_placements(ctx.conn, match["category_id"])
        security.audit(ctx.conn, ctx.user, "cancel_match", "match", match_id, {"reason": reason})
    return {"message": "已按现场确认结果记录", "affected": adv["affected"], "stale_pools": stale,
            "placements": revalidated,
            "match": match_full_context(ctx.conn, match_id)}


@route("POST", r"/api/matches/(?P<match_id>\d+)/reset-review", roles=ORG)
@atomic_result
def review_reset_match(ctx):
    return _run_result_mutation(ctx, "reset_review", _review_reset_match)


def _review_reset_match(ctx):
    match_id = int(ctx.params["match_id"])
    match = get_or_404(ctx.conn, "matches", match_id, "重置赛")
    if match["reset_state"] == "none":
        raise bad_request("该场次不是重置赛")
    parent_id = match["reset_parent_id"]
    if not parent_id and ctx.body.get("action") == "deactivate":
        if not str(ctx.body.get("reason") or "").strip():
            raise bad_request("请填写显式复核原因")
        team_rules_store.freeze(ctx.conn, match)
        db.update(ctx.conn, "matches", match_id, {"reset_state": "inactive",
                  "result_version": match["result_version"] + 1, "updated_at": db.now(ctx.conn)})
        security.audit(ctx.conn, ctx.user, "review_reset_match", "match", match_id,
                       {"action": "deactivate", "reason": ctx.body["reason"], "parent_unverified": True})
        revalidated = _revalidate_placements(ctx.conn, match["category_id"])
        return {"message": "历史重置赛已停用，历史成绩已保留", "placements": revalidated,
                "match": match_full_context(ctx.conn, match_id)}
    if not parent_id:
        parent_id = ctx.body.get("parent_match_id")
        if type(parent_id) is not int:
            raise conflict("历史重置赛父关系需由成绩人员显式核实", code="reset_parent_unverified")
        parent = get_or_404(ctx.conn, "matches", parent_id, "父决赛")
        stage = get_or_404(ctx.conn, "stages", match["stage_id"], "阶段")
        if (parent["round_no"] != 200 or parent["stage_id"] != match["stage_id"] or
                parent["plan_id"] != match["plan_id"] or parent["category_id"] != match["category_id"] or
                stage["kind"] != "double_elim" or not _loads(stage["params_json"]).get("grand_final_reset")):
            raise bad_request("父场次必须是同一双淘汰阶段的合法父决赛")
        if ctx.body.get("parent_base_version") != parent["result_version"]:
            raise conflict("父决赛已变化，请重新核对", code="version_conflict")
        db.update(ctx.conn, "matches", match_id, {"reset_parent_id": parent_id})
    else:
        parent = get_or_404(ctx.conn, "matches", parent_id, "父决赛")
    resolution = {"match_id": match_id, "base_version": ctx.body["base_version"],
                  "action": ctx.body.get("action"), "reason": ctx.body.get("reason")}
    created = _maybe_create_reset_match(ctx.conn, parent, [resolution], ctx.user)
    adv = advancement.refresh_plan(ctx.conn, parent["plan_id"])
    revalidated = _revalidate_placements(ctx.conn, parent["category_id"])
    return {"message": "重置赛已完成显式复核", "reset_match_created": created,
            "affected": adv["affected"], "placements": revalidated,
            "match": match_full_context(ctx.conn, match_id)}
