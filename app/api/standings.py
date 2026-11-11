"""小组排名、抽签、名次确认与学校总分（设计大纲 7、12.1）。"""
from __future__ import annotations

import json

from .. import db, security, team_rules_store
from ..domain import team_rules
from ..domain import advancement, points, ranking
from ..domain.validation import payload_hash
from ..errors import bad_request, conflict, forbidden, not_found
from ..http_server import route
from ..result_safety import atomic_result
from .common import category_context, get_or_404, plan_effective

ADMIN = ("admin",)
ORG = ("admin", "organizer")


# ------------------------------------------------------------------ 小组排名
def pool_standings_payload(conn, pool, include_excluded: bool = True) -> dict:
    pool = dict(pool)
    if pool["kind"] == "bracket":
        raise bad_request("淘汰赛按晋级与名次赛确定名次，不使用循环赛积分或抽签", code="not_standings_pool")
    stage = db.q1(conn, "SELECT * FROM stages WHERE id = ?", (pool["stage_id"],))
    params = _loads(stage["params_json"]) if stage else {}
    points_scheme = {**ranking.DEFAULT_POINTS, **(params.get("points") or {})}
    bye_award = params.get("bye_award", "none")
    members = db.q(
        conn,
        """SELECT pm.participation_id, pm.seed_no, p.team_id, p.status AS member_status,
                  p.seed_no AS participation_seed,
                  COALESCE(t.name, a.name) AS subject,
                  COALESCE(s.short_name, s.name) AS school
             FROM pool_members pm
             JOIN participations p ON p.id = pm.participation_id
             LEFT JOIN teams t ON t.id = p.team_id
             LEFT JOIN athletes a ON a.id = p.athlete_id
             LEFT JOIN schools s ON s.id = COALESCE(t.school_id, a.school_id)
            WHERE pm.pool_id = ? AND p.deleted_at IS NULL
            ORDER BY pm.seed_no IS NULL, pm.seed_no, pm.id""",
        (pool["id"],))
    member_list = []
    for m in members:
        member_list.append({
            "participation_id": m["participation_id"],
            "label": m["school"] if m["team_id"] else f"{m['school']}·{m['subject']}",
            "seed_no": m["seed_no"],
        })
    match_rows = db.q(conn, "SELECT * FROM matches WHERE pool_id = ? AND reset_state IN ('none','active') ORDER BY seq, id", (pool["id"],))
    match_list = []
    source_matches = []
    for m in match_rows:
        sets = db.q(conn, "SELECT * FROM match_sets WHERE match_id = ? ORDER BY set_no", (m["id"],))
        match_list.append({
            "rules": team_rules_store.match_rules(conn, m)['rules'],
            "id": m["id"], "home_participation": m["home_actual"], "away_participation": m["away_actual"],
            "status": m["status"], "result_status": m["result_status"],
            "round_label": m["round_label"], "round_no": m["round_no"],
            "sets": [dict(s) for s in sets],
        })
        source = {k: m[k] for k in ("id", "stage_id", "seq", "round_no", "plan_version")}
        for side in ("home", "away"):
            for suffix in ("source_type", "source_pool", "source_rank", "source_match", "participation"):
                source[f"{side}_{suffix}"] = m[f"{side}_{suffix}"]
        if m["result_version"]:
            rule_info = team_rules_store.match_rules(conn, m)
            if rule_info['rules_hash'] != team_rules.fingerprint(None):
                source['rules_hash'] = rule_info['rules_hash']
            source.update({"result_version": m["result_version"], "result_status": m["result_status"],
                           "recorded": [m["home_actual"], m["away_actual"]],
                           "sets": [{k: s[k] for k in ("set_no", "home_points", "away_points", "winner_side")}
                                    for s in sets]})
        source_matches.append(source)
    lots = {r["participation_id"]: r["lot_value"]
            for r in db.q(conn, "SELECT * FROM draw_lots WHERE pool_id = ?", (pool["id"],))}
    result = ranking.compute_standings(member_list, match_list, lots,
                                       bye_award=bye_award, points=points_scheme)
    offset = (pool["rank_from"] or 1) - 1
    for row in result["rows"]:
        row["pool_rank"] = row.get("rank")
        row["project_rank"] = (row["rank"] + offset) if row.get("rank") else None
        row["project_rank_text"] = (f"第{row['project_rank']}名" if row.get("project_rank")
                                    else f"待确认（第{row['rank_from'] + offset}—{row['rank_to'] + offset}名）")
    if not include_excluded:
        result.pop("excluded", None)
    result["pool"] = pool
    result["bye_award"] = bye_award
    result["points_scheme"] = points_scheme
    result["base_results"] = payload_hash({
        "pool": {k: pool[k] for k in ("id", "stage_id", "kind", "seq", "rank_from", "rank_to")},
        "stage": {"id": stage["id"], "plan_id": stage["plan_id"], "kind": stage["kind"],
                  "seq": stage["seq"], "params": params},
        "members": [{k: m[k] for k in ("participation_id", "seed_no", "member_status", "participation_seed")}
                    for m in members], "matches": source_matches, "lots": sorted(lots.items())})
    # 未完成场次列给界面，确认按钮旁就能说明阻断原因（改进方案 §13.1）
    result["incomplete_matches"] = [
        {"match_id": m["id"], "round_label": m["round_label"], "status": m["status"]}
        for m in match_list if m["status"] not in ("finished", "void")
    ]
    snapshot = db.q(conn,
                    "SELECT rank_no, participation_id, status FROM pool_rank_snapshots WHERE pool_id = ?"
                    " ORDER BY rank_no", (pool["id"],))
    result["snapshot"] = [dict(s) for s in snapshot]
    # Optimistic lock for confirmation edits, separate from the pure source
    # basis. Including this in confirmation_basis would invalidate itself.
    result["base_confirmation"] = payload_hash({"snapshot": result["snapshot"],
        "resolutions": _saved_resolutions(pool), "basis": pool.get("confirmation_basis", "")})
    result["needs_reconfirm"] = bool(snapshot and (not pool.get("confirmation_basis") or
                                          pool["confirmation_basis"] != result["base_results"]))
    if snapshot and not result["needs_reconfirm"]:
        saved = _saved_resolutions(pool)
        live = sorted((saved.get(r["participation_id"], r.get("project_rank")), r["participation_id"])
                      for r in result["rows"]
                      if saved.get(r["participation_id"], r.get("project_rank")) is not None
                      and (pool["rank_from"] or 1) <= saved.get(r["participation_id"], r.get("project_rank"))
                      <= (pool["rank_to"] or len(result["rows"])))
        frozen = [(s["rank_no"], s["participation_id"]) for s in snapshot]
        if live != frozen or any(s["status"] != "confirmed" for s in snapshot):
            result["needs_reconfirm"] = True
    result["confirmed"] = pool["status"] == "confirmed" and bool(snapshot) and not result["needs_reconfirm"]
    return result


def _saved_resolutions(pool):
    try:
        return {int(r["participation_id"]): int(r["rank"])
                for r in json.loads(pool.get("confirmation_resolutions") or "[]")}
    except (TypeError, ValueError, KeyError):
        return {}


def _require_pool_basis(body, data):
    if not body.get("base_results"):
        raise bad_request("请刷新小组排名并核对确认依据", code="client_upgrade_required")
    if body["base_results"] != data["base_results"]:
        raise conflict("成绩、成员、签位或抽签已变化，请重新核对名次", code="ranking_changed",
                       detail={"base_results": data["base_results"]})


def _loads(text: str) -> dict:
    try:
        return json.loads(text or "{}")
    except json.JSONDecodeError:
        return {}


@route("GET", r"/api/pools/(?P<pool_id>\d+)/standings")
def pool_standings(ctx):
    pool = get_or_404(ctx.conn, "pools", int(ctx.params["pool_id"]), "比赛小组")
    return pool_standings_payload(ctx.conn, pool)


@route("POST", r"/api/pools/(?P<pool_id>\d+)/lots", roles=ORG)
@atomic_result
def record_lots(ctx):
    """录入现场抽签结果：order 为并列队伍的先后顺序。"""
    pool = get_or_404(ctx.conn, "pools", int(ctx.params["pool_id"]), "比赛小组")
    stage = get_or_404(ctx.conn, "stages", pool["stage_id"], "阶段")
    plan = get_or_404(ctx.conn, "plans", stage["plan_id"], "编排方案")
    raw_order = ctx.body.get("order") or []
    if not isinstance(raw_order, list):
        raise bad_request("抽签顺序必须是参赛主体列表")
    try:
        order = [int(x) for x in raw_order]
    except (TypeError, ValueError):
        raise bad_request("抽签顺序包含无效的参赛主体") from None
    if not order:
        raise bad_request("请提供抽签顺序")
    if len(order) != len(set(order)):
        raise bad_request("抽签顺序中不能重复出现同一参赛主体")
    standings = pool_standings_payload(ctx.conn, pool)
    _require_pool_basis(ctx.body, standings)
    target = next((group for group in standings["unresolved"]
                   if {member["participation_id"] for member in group["members"]} == set(order)
                   and len(group["members"]) == len(order)), None)
    if target is None:
        raise bad_request("抽签顺序必须完整对应一组当前待处理的并列队伍")
    members = {r["participation_id"] for r in db.q(
        ctx.conn, "SELECT participation_id FROM pool_members WHERE pool_id = ?", (pool["id"],))}
    for pid in order:
        part = db.q1(ctx.conn,
                     "SELECT category_id FROM participations WHERE id = ? AND deleted_at IS NULL",
                     (pid,))
        if part is None:
            raise not_found(f"参赛记录 {pid} 不存在")
        if part["category_id"] != plan["category_id"]:
            raise bad_request(f"参赛主体 {pid} 不属于本项目，不能录入本小组的抽签结果")
        if members and pid not in members:
            raise bad_request(f"参赛主体 {pid} 不在该小组中，不能录入抽签结果")
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM draw_lots WHERE pool_id = ?"
               f" AND participation_id IN ({','.join('?' for _ in order)})",
               (pool["id"], *order))
        for i, pid in enumerate(order, start=1):
            db.insert(ctx.conn, "draw_lots", {
                "pool_id": pool["id"], "participation_id": pid, "lot_value": i,
                "note": ctx.body.get("note") or "现场抽签", "recorded_by": ctx.user["id"]})
    from .scoring import _stale_pools
    stale = _stale_pools(ctx.conn, plan["id"])
    advancement.refresh_plan(ctx.conn, plan["id"])
    revalidate_derived_placements(ctx.conn, plan["category_id"])
    security.audit(ctx.conn, ctx.user, "record_lots", "pool", pool["id"], {"order": order})
    return {"message": "抽签结果已保存", "stale_pools": stale,
            "standings": pool_standings_payload(ctx.conn, get_or_404(ctx.conn, "pools", pool["id"], "小组"))}


@route("POST", r"/api/pools/(?P<pool_id>\d+)/confirm", roles=ORG)
@atomic_result
def confirm_pool(ctx):
    """确认小组名次并写入快照，供后续对阵解析。

    并列名次未抽签时不允许确认对应名次，除非显式给出 resolutions（现场确认顺序）。
    """
    pool = get_or_404(ctx.conn, "pools", int(ctx.params["pool_id"]), "比赛小组")
    if pool["kind"] == "bracket":
        raise bad_request("淘汰赛按晋级与名次赛确定名次，不确认循环赛小组排名", code="not_standings_pool")
    stage = get_or_404(ctx.conn, "stages", pool["stage_id"], "阶段")
    plan = get_or_404(ctx.conn, "plans", stage["plan_id"], "编排方案")
    if not plan_effective(ctx.conn, plan):
        raise forbidden("方案尚未生效（未锁定且没有自定义比赛），不能确认名次")
    # 还有未处理完的场次时不能确认名次。必须先逐场明确处理结果，
    # 不能用 force + 文本原因绕过晋级依据。
    pending = db.q(ctx.conn,
                   """SELECT id, round_label, status FROM matches
                       WHERE pool_id = ? AND status NOT IN ('finished','void')""", (pool["id"],))
    if pending:
        raise conflict("该小组还有未处理完成的场次，不能确认名次；请先逐场明确处理结果",
                       code="matches_incomplete",
                       detail={"matches": [{"match_id": r["id"], "round_label": r["round_label"],
                                            "status": r["status"]} for r in pending]})
    data = pool_standings_payload(ctx.conn, pool)
    _require_pool_basis(ctx.body, data)
    if not ctx.body.get("base_confirmation"):
        raise bad_request("请刷新小组确认状态并核对", code="client_upgrade_required")
    if ctx.body["base_confirmation"] != data["base_confirmation"]:
        raise conflict("小组确认已被其他人员更新，请重新核对", code="ranking_changed")
    rows = data["rows"]
    resolutions = _validate_resolutions(ctx.body.get("resolutions") or [], data, pool)
    target_from = pool["rank_from"] or 1
    target_to = pool["rank_to"] or len(rows)
    unresolved_hits = []
    for group in data["unresolved"]:
        g_from = group["rank_from"] + (pool["rank_from"] or 1) - 1
        g_to = group["rank_to"] + (pool["rank_from"] or 1) - 1
        if g_to < target_from or g_from > target_to:
            continue
        missing = [m["participation_id"] for m in group["members"] if m["participation_id"] not in resolutions]
        if missing:
            unresolved_hits.append({**group, "missing": missing})
    if unresolved_hits:
        raise conflict("存在并列名次尚未抽签或确认，不能确认该范围内的名次",
                       code="tie_pending", detail={"tie_sets": unresolved_hits})
    snapshot: list[tuple[int, int, str]] = []
    offset = (pool["rank_from"] or 1) - 1
    for row in rows:
        if row["participation_id"] in resolutions:
            rank_no = resolutions[row["participation_id"]]
            status = "confirmed"
            note = "现场确认顺序"
        elif row.get("rank"):
            rank_no = row["rank"] + offset
            status = "confirmed"
            note = "抽签结果" if row.get("by_lot") else ""
        else:
            continue
        if rank_no < target_from or rank_no > target_to:
            continue
        snapshot.append((rank_no, row["participation_id"], note))
    if not snapshot:
        raise bad_request("没有任何可确认的名次")
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM pool_rank_snapshots WHERE pool_id = ?", (pool["id"],))
        for rank_no, pid, note in snapshot:
            db.insert(ctx.conn, "pool_rank_snapshots", {
                "pool_id": pool["id"], "rank_no": rank_no, "participation_id": pid,
                "status": "confirmed", "note": note})
        db.update(ctx.conn, "pools", pool["id"], {
            "status": "confirmed", "confirmed_by": ctx.user["id"], "confirmed_at": db.now(ctx.conn),
            "confirmation_basis": data["base_results"],
            "confirmation_resolutions": json.dumps([
                {"participation_id": pid, "rank": rank} for pid, rank in sorted(resolutions.items())])})
        result = advancement.refresh_plan(ctx.conn, plan["id"])
        # refresh may populate previously missing derived members. Such an old
        # database must be reloaded, never accepted with a self-changing basis.
        confirmed = get_or_404(ctx.conn, "pools", pool["id"], "小组")
        after = pool_standings_payload(ctx.conn, confirmed)
        if after["base_results"] != data["base_results"]:
            raise conflict("小组签位成员已更新，请重新加载排名并确认", code="ranking_changed")
        revalidated = revalidate_derived_placements(ctx.conn, plan["category_id"])
        manual_review = review_manual_placements_after_pool_confirm(
            ctx.conn, plan["category_id"], confirmed)
    security.audit(ctx.conn, ctx.user, "confirm_pool", "pool", pool["id"],
                   {"ranks": [s[0] for s in snapshot], "forced": False,
                    "unfinished_matches": [], "manual_review": manual_review})
    return {"message": f"已确认 {len(snapshot)} 个名次",
            "affected": result["affected"],
            "placements": revalidated, "manual_review": manual_review, "standings": after}


def _validate_resolutions(raw, data, pool):
    if not isinstance(raw, list):
        raise bad_request("现场确认顺序必须为列表")
    resolutions = {}
    for r in raw:
        if (not isinstance(r, dict) or type(r.get("participation_id")) is not int
                or type(r.get("rank")) is not int or r["participation_id"] in resolutions):
            raise bad_request("现场确认顺序必须包含唯一参赛者和整数名次")
        resolutions[r["participation_id"]] = r["rank"]
    known = {r["participation_id"]: r for r in data["rows"]}
    if set(resolutions) - set(known):
        raise bad_request("确认顺序包含不属于本组的参赛者")
    # Redundant unchanged ranks from older pages are harmless, but cannot
    # override a rank already determined by the scoring rules.
    for pid in list(resolutions):
        if known[pid].get("project_rank") is not None:
            if resolutions[pid] != known[pid]["project_rank"]:
                raise bad_request("不能修改已经明确的非并列名次")
            del resolutions[pid]
    offset = (pool["rank_from"] or 1) - 1
    for group in data["unresolved"]:
        ids = {m["participation_id"] for m in group["members"]}
        chosen = ids & set(resolutions)
        if chosen and (chosen != ids or {resolutions[pid] for pid in ids} !=
                       set(range(group["rank_from"] + offset, group["rank_to"] + offset + 1))):
            raise bad_request("必须完整且不重复地排列当前并列组的对应名次")
    return resolutions


# ------------------------------------------------------------------ 项目名次
def derive_placements(conn, category_id: int, plan) -> tuple[list[dict], list[str]]:
    """按当前已确认的比赛结果与小组名次快照推导能确定的名次（只计算，不写库）。

    只处理比赛结果真正决定的名次（决赛、三四名决赛、阶梯淘汰、已确认的小组名次），
    不替裁判或组织者补造未确定的名次。
    """
    derived: list[dict] = []
    notes: list[str] = []
    stages = db.q(conn, "SELECT * FROM stages WHERE plan_id = ? ORDER BY seq", (plan["id"],))
    for stage in stages:
        params = _loads(stage["params_json"])
        pools = db.q(conn, "SELECT * FROM pools WHERE stage_id = ? ORDER BY seq", (stage["id"],))
        managed = params.get('schedule_meta')
        if managed:
            if managed['state'] != 'confirmed':
                continue
            for match in db.q(conn, 'SELECT * FROM matches WHERE stage_id=? ORDER BY seq,id', (stage['id'],)):
                winner = advancement.result_winner_side(conn, match)
                if winner and match['winner_rank'] and match['loser_rank']:
                    _assign(derived, match, winner, match['winner_rank'], match['loser_rank'], stage['name'] + ' · ' + match['round_label'])
            from .schedule import slot_columns
            for award in managed.get('awards', []):
                columns = slot_columns(award['source'], 'home', {})
                pid, is_bye, reason = advancement.resolve_slot(conn, columns, 'home')
                if pid and not is_bye and not reason:
                    derived.append({'participation_id': pid, 'rank_no': award['rank'], 'source': 'auto', 'note': stage['name']})
            continue
        if stage["kind"] == "placement":
            fmt = params.get("format", "round_robin")
            for pool in pools:
                if fmt == "round_robin":
                    derived.extend(_ranks_from_snapshot(conn, pool, notes))
                else:
                    derived.extend(_ranks_from_elimination(conn, pool, notes))
        elif stage["kind"] == "single_elim":
            derived.extend(_ranks_from_elimination(conn, pools[0] if pools else None, notes))
        elif stage["kind"] == "double_elim":
            derived.extend(_ranks_from_double_elim(conn, stage, notes))
        elif stage["kind"] == "gauntlet":
            derived.extend(_ranks_from_gauntlet(conn, stage, notes))
        else:
            notes.append(f"{stage['name']}：小组名次用于晋级，不等同于项目名次，未计入"
                         if stage["kind"] in ("round_robin", "swiss") else
                         f"{stage['name']}：自定义阶段名次需现场确认")
    return derived, notes


def effective_plan(conn, category_id: int):
    return db.q1(conn,
                 """SELECT * FROM plans WHERE category_id = ?
                     ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'locked' THEN 1
                              WHEN 'previewed' THEN 2 WHEN 'draft' THEN 3 ELSE 4 END, id DESC
                     LIMIT 1""", (category_id,))


def revalidate_derived_placements(conn, category_id: int) -> dict:
    """成绩变化后重新核对由比赛结果推导出来的名次。

    只处理 source 为 auto / standings 的名次：
      - 仍能推导且名次变化 → 更新名次并提升版本
      - 已无法推导 → 标为待确认（不计入学校积分）
    人工录入与个人赛现场确认的名次不受影响，仅在有冲突时报告。
    """
    plan = effective_plan(conn, category_id)
    if plan is None:
        return {"updated": 0, "invalidated": [], "conflicts": []}
    derived, _notes = derive_placements(conn, category_id, plan)
    expected = {item["participation_id"]: item for item in derived}
    rows = db.q(conn, "SELECT * FROM placements WHERE category_id = ?", (category_id,))
    updated = invalidated = 0
    invalidated_items: list[dict] = []
    conflicts: list[dict] = []
    manual_ranks = {r["rank_no"]: r for r in rows
                    if r["source"] not in ("auto", "standings") and r["status"] == "confirmed"
                    and r["rank_no"] is not None}
    for row in rows:
        if row["source"] not in ("auto", "standings"):
            item = expected.get(row["participation_id"])
            if item and row["status"] == "confirmed" and row["rank_no"] != item["rank_no"]:
                conflicts.append({"participation_id": row["participation_id"],
                                  "held_rank": row["rank_no"], "derived_rank": item["rank_no"],
                                  "reason": "现场确认名次与比赛结果推导不一致，请人工核对"})
            continue
        item = expected.get(row["participation_id"])
        holder = manual_ranks.get(item["rank_no"]) if item else None
        if holder and holder["participation_id"] != row["participation_id"]:
            conflicts.append({"participation_id": row["participation_id"], "derived_rank": item["rank_no"],
                              "held_by": holder["participation_id"],
                              "reason": "推导名次与人工确认冲突，需人工核对"})
            item = None
        if item is None:
            if row["status"] == "confirmed" or row["rank_no"] is not None:
                db.update(conn, "placements", row["id"], {
                    "rank_no": None, "status": "pending",
                    "note": "成绩变化后已无法由比赛结果确定，需重新确认",
                    "version": row["version"] + 1, "confirmed_by": None, "confirmed_at": None})
                invalidated += 1
                invalidated_items.append({"participation_id": row["participation_id"],
                                          "previous_rank": row["rank_no"]})
            continue
        if row["rank_no"] != item["rank_no"] or row["status"] != "confirmed":
            db.update(conn, "placements", row["id"], {
                "rank_no": item["rank_no"], "status": "confirmed", "source": item["source"],
                "note": f"{item['note']}（成绩变化后自动重算）",
                "version": row["version"] + 1, "confirmed_at": db.now(conn)})
            updated += 1
    recompute_category_points(conn, category_id)
    return {"updated": updated, "invalidated": invalidated_items, "conflicts": conflicts}


def _confirmed_manual_placements(conn, category_id):
    return db.q(conn,
                """SELECT * FROM placements WHERE category_id = ? AND status = 'confirmed'
                     AND source NOT IN ('auto','standings','individual') ORDER BY rank_no, id""",
                (category_id,))


def mark_manual_placements_for_review(conn, category_id: int, reason: str) -> list[dict]:
    """成绩更正后，依赖旧小组名次的人工项目名次必须退出正式口径。

    只标记 team 项目的人工/现场确认名次；个人赛名次与淘汰赛自动推导名次由各自
    流程处理。保留原 rank_no 作为提示，但 pending 不计入学校总分与正式公告。
    """
    cat = category_context(conn, category_id)
    if cat["kind"] != "team":
        return []
    changed = []
    for row in _confirmed_manual_placements(conn, category_id):
        db.update(conn, "placements", row["id"], {
            "status": "pending", "note": reason, "version": row["version"] + 1,
            "confirmed_by": None, "confirmed_at": None})
        changed.append({"participation_id": row["participation_id"],
                        "previous_rank": row["rank_no"], "reason": reason})
    if changed:
        recompute_category_points(conn, category_id)
    return changed


def review_manual_placements_after_pool_confirm(conn, category_id: int, pool) -> list[dict]:
    """小组名次重新确认后，把仍与快照冲突的人工名次退回待核对。"""
    cat = category_context(conn, category_id)
    if cat["kind"] != "team" or (pool["rank_from"] or 1) != 1:
        return []
    snapshots = {row["participation_id"]: row["rank_no"] for row in db.q(
        conn, "SELECT participation_id, rank_no FROM pool_rank_snapshots "
              "WHERE pool_id = ? AND status = 'confirmed'", (pool["id"],))}
    changed = []
    for row in _confirmed_manual_placements(conn, category_id):
        expected = snapshots.get(row["participation_id"])
        if expected is not None and row["rank_no"] != expected:
            db.update(conn, "placements", row["id"], {
                "status": "pending",
                "note": f"小组名次已重新确认（现第{expected}名），项目名次需重新核对",
                "version": row["version"] + 1, "confirmed_by": None, "confirmed_at": None})
            changed.append({"participation_id": row["participation_id"],
                            "previous_rank": row["rank_no"], "expected_rank": expected})
    if changed:
        recompute_category_points(conn, category_id)
    return changed


@route("GET", r"/api/categories/(?P<category_id>\d+)/placements")
def list_placements(ctx):
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] == "individual":
        rows = db.q(ctx.conn, """SELECT pl.*, p.id AS result_participation_id,
                       a.name AS subject, COALESCE(s.short_name, s.name) AS school_name,
                       s.id AS school_id, ir.result_value, ir.error_count, ir.violation_count,
                       ir.result_status
                  FROM individual_results ir
                  JOIN participations p ON p.id = ir.participation_id
                  JOIN athletes a ON a.id = p.athlete_id
                  JOIN schools s ON s.id = a.school_id
                  LEFT JOIN placements pl ON pl.category_id = ir.category_id AND pl.participation_id = p.id
                 WHERE ir.category_id = ? AND p.deleted_at IS NULL
                   AND (pl.id IS NOT NULL OR ir.result_status = 'dsq')
                 ORDER BY ir.result_status = 'dsq', pl.rank_no IS NULL, pl.rank_no, s.name, a.name""",
                    (category_id,))
        out = []
        for row in rows:
            item = dict(row)
            item["participation_id"] = item.pop("result_participation_id")
            if item["result_status"] == "dsq":
                item.update(category_id=category_id, rank_no=None, status="dsq", source=None, note=None)
            base, multiplier, pts = points.placement_points(item["rank_no"], cat["kind"])
            item.update(base_points=base, multiplier=multiplier, points=pts)
            out.append(item)
        return {"category": cat, "placements": out}
    rows = db.q(ctx.conn,
                """SELECT pl.*, COALESCE(t.name, a.name) AS subject,
                          COALESCE(s.short_name, s.name) AS school_name,
                          COALESCE(t.school_id, a.school_id) AS school_id
                     FROM placements pl
                     JOIN participations p ON p.id = pl.participation_id
                     LEFT JOIN teams t ON t.id = p.team_id
                     LEFT JOIN athletes a ON a.id = p.athlete_id
                     LEFT JOIN schools s ON s.id = COALESCE(t.school_id, a.school_id)
                    WHERE pl.category_id = ? AND p.deleted_at IS NULL
                    ORDER BY pl.rank_no IS NULL, pl.rank_no, pl.id""",
                (category_id,))
    out = []
    for r in rows:
        item = dict(r)
        base, multiplier, pts = points.placement_points(r["rank_no"], cat["kind"])
        item.update({"base_points": base, "multiplier": multiplier, "points": pts})
        out.append(item)
    return {"category": cat, "placements": out}


@route("POST", r"/api/categories/(?P<category_id>\d+)/placements", roles=ORG)
def upsert_placement(ctx):
    """录入或修改一个名次。confirm=True 时计入正式积分。"""
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "team":
        raise bad_request("三人赛名次由编排结果或评次赛确认；个人赛名次在个人成绩页录入")
    pid = int(ctx.body.get("participation_id") or 0)
    if not pid:
        raise bad_request("请指定参赛主体")
    part = db.q1(ctx.conn,
                 "SELECT * FROM participations WHERE id = ? AND deleted_at IS NULL", (pid,))
    if part is None:
        raise not_found("参赛记录不存在")
    if part["category_id"] != category_id:
        raise bad_request("该参赛主体不属于本项目，不能在本项目录入名次")
    rank_no = ctx.body.get("rank_no")
    rank_no = int(rank_no) if rank_no not in (None, "") else None
    status = "confirmed" if ctx.body.get("confirm", True) else "pending"
    if rank_no is not None and status == "confirmed":
        dup = db.q1(ctx.conn,
                    """SELECT id, participation_id FROM placements
                        WHERE category_id = ? AND rank_no = ? AND participation_id <> ?
                          AND status = 'confirmed'""", (category_id, rank_no, pid))
        if dup:
            raise conflict(f"名次 {rank_no} 已被其他参赛主体占用", code="rank_taken")
    existing = db.q1(ctx.conn, "SELECT * FROM placements WHERE category_id = ? AND participation_id = ?",
                     (category_id, pid))
    with db.tx(ctx.conn):
        if existing:
            db.update(ctx.conn, "placements", existing["id"], {
                "rank_no": rank_no, "status": status, "source": "manual",
                "note": ctx.body.get("note") or existing["note"],
                "version": existing["version"] + 1,
                "confirmed_by": ctx.user["id"] if status == "confirmed" else None,
                "confirmed_at": db.now(ctx.conn) if status == "confirmed" else None})
            placement_id = existing["id"]
        else:
            placement_id = db.insert(ctx.conn, "placements", {
                "category_id": category_id, "participation_id": pid, "rank_no": rank_no,
                "status": status, "source": "manual", "note": ctx.body.get("note") or "",
                "confirmed_by": ctx.user["id"] if status == "confirmed" else None,
                "confirmed_at": db.now(ctx.conn) if status == "confirmed" else None})
        recompute_category_points(ctx.conn, category_id)
    security.audit(ctx.conn, ctx.user, "set_placement", "placement", placement_id,
                   {"rank_no": rank_no, "status": status})
    return {"placement_id": placement_id, "message": "名次已保存"}


@route("DELETE", r"/api/placements/(?P<placement_id>\d+)", roles=ORG)
def delete_placement(ctx):
    placement = get_or_404(ctx.conn, "placements", int(ctx.params["placement_id"]), "名次记录")
    if category_context(ctx.conn, placement["category_id"])["kind"] == "individual":
        raise bad_request("个人赛名次由已确认成绩和现场抽签结果统一确定，请在个人赛成绩页更正")
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM placements WHERE id = ?", (placement["id"],))
        recompute_category_points(ctx.conn, placement["category_id"])
        security.audit(ctx.conn, ctx.user, "delete_placement", "placement", placement["id"],
                       {"category_id": placement["category_id"],
                        "participation_id": placement["participation_id"],
                        "rank_no": placement["rank_no"], "status": placement["status"],
                        "source": placement["source"]})
    return {"message": "已删除"}


@route("POST", r"/api/categories/(?P<category_id>\d+)/placements/auto", roles=ORG)
@atomic_result
def auto_placements(ctx):
    """按已确认的比赛结果与小组名次推导能确定的名次。

    只处理比赛结果真正决定的名次（决赛、三四名决赛、阶梯淘汰、已确认的小组名次），
    不替裁判或组织者补造未确定的名次。
    """
    category_id = int(ctx.params["category_id"])
    category_context(ctx.conn, category_id)
    confirm = bool(ctx.body.get("confirm", True))
    plan = effective_plan(ctx.conn, category_id)
    if plan is None or not plan_effective(ctx.conn, plan):
        raise bad_request("该项目尚未生效的编排方案或自定义比赛")
    derived, notes = derive_placements(ctx.conn, category_id, plan)
    if not derived:
        raise bad_request("目前没有可推导的名次，请先完成并确认相关比赛，或手工录入现场确认结果")

    existing = {r["rank_no"]: r for r in db.q(
        ctx.conn,
        "SELECT * FROM placements WHERE category_id = ? AND rank_no IS NOT NULL AND status = 'confirmed'",
        (category_id,))}
    saved = 0
    conflicts: list[dict] = []
    with db.tx(ctx.conn):
        for item in derived:
            holder = existing.get(item["rank_no"])
            if holder and holder["participation_id"] != item["participation_id"] \
                    and holder["source"] not in ("auto", "standings"):
                conflicts.append({"rank_no": item["rank_no"],
                                  "held_by": holder["participation_id"],
                                  "source": holder["source"],
                                  "reason": "该名次已有现场确认结果，系统不自动覆盖"})
                continue
            status = "confirmed" if confirm else "pending"
            row = db.q1(ctx.conn,
                        "SELECT * FROM placements WHERE category_id = ? AND participation_id = ?",
                        (category_id, item["participation_id"]))
            if row:
                if row["source"] not in ("auto", "standings"):
                    conflicts.append({"participation_id": row["participation_id"],
                                      "reason": "保留人工或个人项目名次，需人工核对"})
                    continue
                db.update(ctx.conn, "placements", row["id"], {
                    "rank_no": item["rank_no"], "status": status, "source": item["source"],
                    "note": item["note"], "version": row["version"] + 1,
                    "confirmed_by": ctx.user["id"] if confirm else None,
                    "confirmed_at": db.now(ctx.conn) if confirm else None})
            else:
                db.insert(ctx.conn, "placements", {
                    "category_id": category_id, "participation_id": item["participation_id"],
                    "rank_no": item["rank_no"], "status": status, "source": item["source"],
                    "note": item["note"],
                    "confirmed_by": ctx.user["id"] if confirm else None,
                    "confirmed_at": db.now(ctx.conn) if confirm else None})
            saved += 1
        recompute_category_points(ctx.conn, category_id)
    security.audit(ctx.conn, ctx.user, "auto_placements", "category", category_id,
                   {"count": saved, "confirm": confirm})
    return {"saved": saved, "confirmed": confirm, "placements": derived, "conflicts": conflicts,
            "notes": notes + ["未列出的名次需通过评次赛或现场确认录入，系统不会自动补造"]}


@route("POST", r"/api/categories/(?P<category_id>\d+)/placements/from-pools", roles=ORG)
@atomic_result
def placements_from_pools(ctx):
    """单组循环项目的现场名次一键按已确认小组名次重生成。

    仅适用于恰好一个 confirmed 的 round_robin 小组、且没有淘汰/名次赛的项目；
    多组或含淘汰的项目必须人工核对，避免系统替裁判做跨组排序。
    """
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "team":
        raise bad_request("个人赛名次请使用个人赛成绩确认")
    plan = effective_plan(ctx.conn, category_id)
    if plan is None:
        raise bad_request("该项目尚未建立编排方案")
    stages = db.q(ctx.conn, "SELECT * FROM stages WHERE plan_id = ? ORDER BY seq", (plan["id"],))
    if len(stages) != 1 or stages[0]["kind"] != "round_robin":
        raise conflict("仅适用于单组循环项目；多组或含淘汰/名次赛的项目请手工核对",
                       code="not_single_pool")
    pools = db.q(ctx.conn, "SELECT * FROM pools WHERE stage_id = ? AND kind = 'group' ORDER BY seq",
                 (stages[0]["id"],))
    if len(pools) != 1:
        raise conflict("仅适用于单组循环项目；多组项目请手工核对", code="not_single_pool")
    pool = pools[0]
    if pool["status"] != "confirmed":
        raise conflict("请先确认小组名次，再生成项目名次", code="pool_not_confirmed")
    snapshot = db.q(ctx.conn,
                    "SELECT * FROM pool_rank_snapshots WHERE pool_id = ? AND status = 'confirmed' "
                    "ORDER BY rank_no", (pool["id"],))
    if not snapshot:
        raise conflict("小组名次快照不存在，请重新确认小组名次", code="pool_not_confirmed")
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM placements WHERE category_id = ? AND source <> 'individual'",
               (category_id,))
        for row in snapshot:
            db.insert(ctx.conn, "placements", {
                "category_id": category_id, "participation_id": row["participation_id"],
                "rank_no": row["rank_no"], "status": "confirmed", "source": "standings",
                "note": f"{pool['name']}名次确认", "confirmed_by": ctx.user["id"],
                "confirmed_at": db.now(ctx.conn)})
        recompute_category_points(ctx.conn, category_id)
    security.audit(ctx.conn, ctx.user, "placements_from_pools", "category", category_id,
                   {"pool_id": pool["id"], "count": len(snapshot)})
    placements = db.q(ctx.conn,
                      "SELECT id, participation_id, rank_no, status, source, note FROM placements "
                      "WHERE category_id = ? ORDER BY rank_no, id", (category_id,))
    return {"message": f"已按小组名次生成 {len(snapshot)} 个项目名次",
            "placements": [dict(row) for row in placements]}


def _ranks_from_elimination(conn, pool, notes: list[str]) -> list[dict]:
    out: list[dict] = []
    if pool is None:
        return out
    base = (pool["rank_from"] or 1) - 1
    matches = db.q(conn, "SELECT * FROM matches WHERE pool_id = ? ORDER BY seq", (pool["id"],))
    for m in matches:
        winner = advancement.result_winner_side(conn, m)
        if winner is None:
            continue
        label = m["round_label"]
        if "三、四名" in label:
            _assign(out, m, winner, base + 3, base + 4, f"{pool['name']}三四名决赛")
        elif label == "决赛":
            _assign(out, m, winner, base + 1, base + 2, f"{pool['name']}决赛")
    if matches and not out:
        notes.append(f"{pool['name']}：决赛尚未确认，暂无名次")
    return out


def _assign(out: list[dict], match, winner: str, win_rank: int, lose_rank: int, source: str):
    w_pid = match["home_actual"] if winner == "home" else match["away_actual"]
    l_pid = match["away_actual"] if winner == "home" else match["home_actual"]
    if w_pid:
        out.append({"participation_id": w_pid, "rank_no": win_rank,
                    "source": "auto", "note": source})
    if l_pid:
        out.append({"participation_id": l_pid, "rank_no": lose_rank,
                    "source": "auto", "note": source})


def _ranks_from_double_elim(conn, stage, notes: list[str]) -> list[dict]:
    parent = db.q1(
        conn, "SELECT * FROM matches WHERE stage_id = ? AND round_no = 200 ORDER BY seq DESC LIMIT 1",
        (stage["id"],))
    if parent is None:
        notes.append("双淘汰尚无决赛场次")
        return []
    parent_winner = advancement.result_winner_side(conn, parent)
    if parent_winner is None:
        notes.append("双淘汰父决赛结果或对阵依据需要确认")
        return []
    reset = None
    if _loads(stage["params_json"]).get("grand_final_reset") and parent_winner == "away":
        reset = db.q1(conn, "SELECT * FROM matches WHERE reset_parent_id=? AND reset_state='active'",
                      (parent["id"],))
        if (not reset or reset["reset_parent_version"] != parent["result_version"] or
                (reset["home_actual"], reset["away_actual"]) != (parent["home_actual"], parent["away_actual"])):
            notes.append("双淘汰重置场次尚未确认或需要显式复核")
            return []
    final = reset or parent
    winner = advancement.result_winner_side(conn, final)
    if winner is None:
        return []
    out: list[dict] = []
    _assign(out, final, winner, 1, 2, "双淘汰决赛重置" if reset else "双淘汰决赛")
    return out


def _ranks_from_gauntlet(conn, stage, notes: list[str]) -> list[dict]:
    """阶梯淘汰：按落败顺序给出完整名次。

    M 场比赛对应 M+1 支队；第 i 场落败者名次为 M+2-i（首个落败者垫底），
    最后一场的胜者第 1、负者第 2。
    """
    matches = db.q(conn, "SELECT * FROM matches WHERE stage_id = ? ORDER BY seq", (stage["id"],))
    if not matches:
        return []
    total = len(matches)
    out: list[dict] = []
    for i, m in enumerate(matches, start=1):
        winner = advancement.result_winner_side(conn, m)
        if winner is None:
            continue
        if i == total:
            _assign(out, m, winner, 1, 2, "阶梯决赛")
        else:
            loser_side = "away" if winner == "home" else "home"
            pid = m["away_actual"] if winner == "home" else m["home_actual"]
            if pid:
                out.append({"participation_id": pid, "rank_no": total + 2 - i,
                            "source": "auto", "note": f"阶梯淘汰第{i}场落败"})
    return out


def _ranks_from_snapshot(conn, pool, notes: list[str]) -> list[dict]:
    if pool["status"] != "confirmed" or pool_standings_payload(conn, pool)["needs_reconfirm"]:
        notes.append(f"{pool['name']}：小组名次需要重新确认")
        return []
    snap = db.q(conn, "SELECT * FROM pool_rank_snapshots WHERE pool_id = ? AND status = 'confirmed' ORDER BY rank_no",
                (pool["id"],))
    return [{"participation_id": s["participation_id"], "rank_no": s["rank_no"],
             "source": "standings", "note": f"{pool['name']}名次确认"} for s in snap]


# ------------------------------------------------------------------ 学校积分
def recompute_category_points(conn, category_id: int) -> int:
    """按已确认名次重算该项目学校积分明细（先清后写，避免重复追加）。"""
    cat = category_context(conn, category_id)
    placements = db.q(conn,
                      """SELECT pl.*, COALESCE(t.school_id, a.school_id) AS school_id
                           FROM placements pl
                           JOIN participations p ON p.id = pl.participation_id
                           LEFT JOIN teams t ON t.id = p.team_id
                           LEFT JOIN athletes a ON a.id = p.athlete_id
                          WHERE pl.category_id = ? AND pl.status = 'confirmed'
                            AND p.deleted_at IS NULL""", (category_id,))
    db.run(conn, "DELETE FROM school_points WHERE category_id = ?", (category_id,))
    count = 0
    for pl in placements:
        base, multiplier, pts = points.placement_points(pl["rank_no"], cat["kind"])
        db.insert(conn, "school_points", {
            "event_id": cat["event_id"], "group_id": cat["group_id"], "school_id": pl["school_id"],
            "category_id": category_id, "participation_id": pl["participation_id"],
            "placement_id": pl["id"], "rank_no": pl["rank_no"] or 0,
            "base_points": base, "multiplier": multiplier, "points": pts,
            "placement_version": pl["version"]})
        count += 1
    return count


def group_started(conn, group_id) -> bool:
    """大组别是否已开赛的唯一判定口径。

    只有确实产生过程分/提交/结果、已有记录领取，或已有已确认名次/个人成绩时
    才算“已开赛”；仅生成赛程、等待记录（无任何过程数据）不算。页面、CSV/XLSX
    与打印公告都通过本函数判断，避免各处二次判定产生分叉。
    """
    category_ids = [r["id"] for r in db.q(
        conn, "SELECT id FROM categories WHERE group_id = ?", (group_id,))]
    if not category_ids:
        return False
    marks = ",".join("?" * len(category_ids))
    args = tuple(category_ids)
    if db.q1(conn, f"""SELECT 1 FROM matches m
             WHERE m.category_id IN ({marks}) AND m.reset_state IN ('none', 'active')
               AND m.status <> 'void'
               AND (m.result_version > 0 OR m.status = 'finished'
                    OR EXISTS (SELECT 1 FROM score_events e WHERE e.match_id = m.id)
                    OR EXISTS (SELECT 1 FROM match_sets st WHERE st.match_id = m.id)
                    OR EXISTS (SELECT 1 FROM submissions sub WHERE sub.match_id = m.id)
                    OR EXISTS (SELECT 1 FROM settings s
                               WHERE s.k = 'recording:match:' || m.id))
             LIMIT 1""", args) is not None:
        return True
    if db.q1(conn, f"""SELECT 1 FROM placements pl
             WHERE pl.category_id IN ({marks}) AND pl.status = 'confirmed' LIMIT 1""", args) is not None:
        return True
    if db.q1(conn, f"""SELECT 1 FROM individual_results ir
             JOIN participations p ON p.id = ir.participation_id
             WHERE p.category_id IN ({marks}) AND p.deleted_at IS NULL LIMIT 1""", args) is not None:
        return True
    if db.q1(conn, f"""SELECT 1 FROM settings s
             WHERE s.k IN (SELECT 'recording:individual_project:' || c.id FROM categories c WHERE c.id IN ({marks})) OR s.k IN (SELECT 'recording:individual:' || p.id FROM participations p
                            WHERE p.category_id IN ({marks}) AND p.deleted_at IS NULL) LIMIT 1""", args + args) is not None:
        return True
    return False


def group_school_totals(conn, group_id):
    """学校团体总分汇总；接口与导出共用同一 pending/已开赛口径。"""
    group = get_or_404(conn, "groups", group_id, "大组别")
    started = group_started(conn, group_id)
    schools = db.q(conn,
                   """SELECT s.id AS school_id, s.name, s.short_name FROM school_entries se
                        JOIN schools s ON s.id = se.school_id WHERE se.group_id = ? ORDER BY s.name""",
                   (group_id,))
    rows = db.q(conn,
                """SELECT sp.school_id, sp.points, sp.rank_no, sp.base_points, sp.multiplier,
                           sp.category_id, c.name AS category_name, c.gender AS category_gender, c.kind,
                          COALESCE(t.name, a.name) AS participation_label
                     FROM school_points sp
                     JOIN categories c ON c.id = sp.category_id
                     JOIN participations p ON p.id = sp.participation_id
                     LEFT JOIN teams t ON t.id = p.team_id
                     LEFT JOIN athletes a ON a.id = p.athlete_id
                    WHERE sp.group_id = ? AND p.deleted_at IS NULL""", (group_id,))
    pending = db.q(conn,
                   """SELECT COALESCE(t.school_id, a.school_id) AS school_id, c.name AS category_name,
                              c.gender AS category_gender,
                             COALESCE(t.name, a.name) AS participation_label
                        FROM participations p
                        JOIN categories c ON c.id = p.category_id
                        LEFT JOIN placements pl ON pl.participation_id = p.id AND pl.category_id = c.id
                        LEFT JOIN teams t ON t.id = p.team_id
                        LEFT JOIN athletes a ON a.id = p.athlete_id
                        LEFT JOIN individual_results ir
                               ON ir.participation_id = p.id AND ir.category_id = c.id
                       WHERE c.group_id = ? AND p.status = 'active'
                         AND p.deleted_at IS NULL
                         AND (pl.id IS NULL OR pl.status <> 'confirmed')
                         AND NOT (c.kind = 'individual'
                                  AND COALESCE(ir.result_status, '') IN ('dns', 'dnf', 'dsq'))""", (group_id,))
    tiebreaks = {r["school_id"]: r["manual_order"]
                 for r in db.q(conn, "SELECT * FROM school_tiebreaks WHERE group_id = ?",
                               (group_id,))}
    result = points.compute_school_totals(db.rows_to_dicts(schools), db.rows_to_dicts(rows),
                                         db.rows_to_dicts(pending), tiebreaks, started=started)
    result["started"] = bool(started)
    result["group"] = dict(group)
    return result


@route("GET", r"/api/groups/(?P<group_id>\d+)/school-totals")
def school_totals(ctx):
    return group_school_totals(ctx.conn, int(ctx.params["group_id"]))


@route("POST", r"/api/groups/(?P<group_id>\d+)/school-tiebreak", roles=ORG)
def set_school_tiebreak(ctx):
    """总分与名次数量仍相同的学校，录入现场确认结果。"""
    group_id = int(ctx.params["group_id"])
    get_or_404(ctx.conn, "groups", group_id, "大组别")
    order = [int(x) for x in (ctx.body.get("school_ids") or [])]
    if not order:
        raise bad_request("请提供学校顺序")
    if len(order) != len(set(order)):
        raise bad_request("学校顺序中不能出现重复学校")
    entered = {r["school_id"] for r in db.q(
        ctx.conn, "SELECT school_id FROM school_entries WHERE group_id = ?", (group_id,))}
    for sid in order:
        if sid not in entered:
            raise bad_request(f"学校 {sid} 未在本大组别报名，不能录入本组别的现场确认结果")
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM school_tiebreaks WHERE group_id = ?", (group_id,))
        for i, sid in enumerate(order, start=1):
            db.insert(ctx.conn, "school_tiebreaks", {
                "group_id": group_id, "school_id": sid, "manual_order": i,
                "note": ctx.body.get("note") or "现场确认结果", "recorded_by": ctx.user["id"]})
    security.audit(ctx.conn, ctx.user, "school_tiebreak", "group", group_id, {"order": order})
    return {"message": "已录入现场确认结果"}


@route("DELETE", r"/api/groups/(?P<group_id>\d+)/school-tiebreak", roles=ORG)
def clear_school_tiebreak(ctx):
    group_id = int(ctx.params["group_id"])
    with db.tx(ctx.conn):
        removed = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM school_tiebreaks WHERE group_id = ?",
                        (group_id,))["n"]
        db.run(ctx.conn, "DELETE FROM school_tiebreaks WHERE group_id = ?", (group_id,))
        security.audit(ctx.conn, ctx.user, "clear_school_tiebreak", "group", group_id,
                       {"removed": removed})
    return {"message": "已清除现场确认结果"}


@route("GET", r"/api/events/(?P<event_id>\d+)/school-totals")
def event_school_totals(ctx):
    """各大组别独立汇总，一次返回，便于赛事概览展示。

    直接复用 group_school_totals：概览与详情、导出、打印公告保持同一口径。
    """
    event_id = int(ctx.params["event_id"])
    groups = db.q(ctx.conn, "SELECT id FROM groups WHERE event_id = ? ORDER BY seq", (event_id,))
    out = []
    for g in groups:
        result = group_school_totals(ctx.conn, g["id"])
        out.append({"group": result["group"], "rows": result["rows"],
                    "unresolved": result["unresolved"], "started": result["started"]})
    return {"groups": out}
