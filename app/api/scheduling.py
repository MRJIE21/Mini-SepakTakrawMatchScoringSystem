"""编排方案：阶段配置、生成预览、锁定与变更（设计大纲 5.5、12.1）。

方案状态：draft（草稿）→ previewed（预览核对）→ locked（已锁定）→ running（执行中）
锁定范围：某个大组别下的具体三人赛项目；记录员不能改变方案。
"""
from __future__ import annotations

import json

from .. import db, security
from ..domain import advancement, formats
from ..domain.slots import SlotSpec
from ..errors import ApiError, bad_request, conflict, forbidden, not_found
from ..http_server import route
from .common import active_plan, category_context, get_or_404, serialize_match, serialize_matches
from .group_draw import validate_draw_stages, guard_group_generation, fixed_pools

ADMIN = ("admin",)
ORG = ("admin", "organizer")

STAGE_KIND_NAMES = {
    "round_robin": "循环赛",
    "single_elim": "单淘汰",
    "double_elim": "双淘汰",
    "swiss": "瑞士制",
    "gauntlet": "阶梯淘汰",
    "placement": "评次赛",
    "custom": "自定义组合",
}


# ------------------------------------------------------------------ 读取
@route("GET", r"/api/categories/(?P<category_id>\d+)/plan")
def get_plan(ctx):
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    plan = active_plan(ctx.conn, category_id)
    if plan is None:
        return {"category": cat, "plan": None,
                "available_formats": format_catalog()}
    return {"category": cat, "plan": plan_detail(ctx.conn, plan, include_matches=ctx.arg('include_matches', '1') != '0'),
            "available_formats": format_catalog()}


@route("GET", r"/api/plans/(?P<plan_id>\d+)")
def get_plan_by_id(ctx):
    plan = get_or_404(ctx.conn, "plans", int(ctx.params["plan_id"]), "编排方案")
    return {"plan": plan_detail(ctx.conn, plan, include_matches=ctx.arg('include_matches', '1') != '0')}


def format_catalog() -> list[dict]:
    return [
        {"kind": "round_robin", "name": "循环赛（单/双循环）",
         "params": [{"key": "legs", "label": "循环次数", "type": "select", "options": [1, 2], "default": 1},
                    {"key": "pool_count", "label": "小组数量", "type": "int", "default": 1},
                    {"key": "assign", "label": "分组方式", "type": "select",
                     "options": ["snake", "balanced", "sequential"], "default": "snake"}]},
        {"kind": "single_elim", "name": "单淘汰",
         "params": [{"key": "third_place", "label": "安排三、四名决赛", "type": "bool", "default": False}]},
        {"kind": "double_elim", "name": "双淘汰",
         "params": [{"key": "grand_final_reset", "label": "决赛重置（败者区队伍赢下决赛后加赛）",
                     "type": "bool", "default": False}]},
        {"kind": "swiss", "name": "瑞士制",
         "params": [{"key": "rounds", "label": "轮次数", "type": "int", "default": 5},
                    {"key": "first_round", "label": "首轮配对", "type": "select",
                     "options": ["fold", "adjacent"], "default": "fold"},
                    {"key": "avoid_rematch", "label": "优先避免重复对阵", "type": "bool", "default": True},
                    {"key": "bye_award", "label": "轮空是否授予积分", "type": "select",
                     "options": ["none", "win"], "default": "none"}]},
        {"kind": "gauntlet", "name": "阶梯淘汰（按种子依次挑战）", "params": []},
        {"kind": "placement", "name": "评次与安慰赛",
         "params": [{"key": "format", "label": "形式", "type": "select",
                     "options": ["round_robin", "single_elim"], "default": "round_robin"},
                    {"key": "rank_from", "label": "目标名次起", "type": "int", "default": 9},
                    {"key": "rank_to", "label": "目标名次止", "type": "int", "default": 12},
                    {"key": "legs", "label": "循环次数", "type": "int", "default": 1}]},
        {"kind": "custom", "name": "自定义组合（逐场指定签位来源）", "params": []},
    ]


def plan_detail(conn, plan, include_matches=True) -> dict:
    from collections import defaultdict
    plan = dict(plan)
    stages = db.q(conn, "SELECT * FROM stages WHERE plan_id = ? ORDER BY seq", (plan["id"],))
    counts = {r['stage_id']: dict(r) for r in db.q(conn, """SELECT stage_id,COUNT(*) AS match_count,
        SUM(CASE WHEN status <> 'finished' THEN 1 ELSE 0 END) AS unstarted_count
        FROM matches WHERE plan_id=? GROUP BY stage_id""", (plan['id'],))}
    pools_by_stage, members_by_pool, matches_by_stage = defaultdict(list), defaultdict(list), defaultdict(list)
    if include_matches:
        for pool in db.q(conn, """SELECT p.* FROM pools p JOIN stages s ON s.id=p.stage_id
            WHERE s.plan_id=? ORDER BY p.seq,p.id""", (plan['id'],)):
            pools_by_stage[pool['stage_id']].append(dict(pool))
        for m in db.q(conn, """SELECT pm.*,p.team_id,COALESCE(t.name,a.name) AS subject,
            COALESCE(NULLIF(s.short_name,''),s.name) AS school FROM pool_members pm
            JOIN pools po ON po.id=pm.pool_id JOIN stages st ON st.id=po.stage_id
            JOIN participations p ON p.id=pm.participation_id LEFT JOIN teams t ON t.id=p.team_id
            LEFT JOIN athletes a ON a.id=p.athlete_id LEFT JOIN schools s ON s.id=COALESCE(t.school_id,a.school_id)
            WHERE st.plan_id=? ORDER BY pm.seed_no IS NULL,pm.seed_no,pm.id""", (plan['id'],)):
            members_by_pool[m['pool_id']].append({'participation_id': m['participation_id'],
                'seed_no': m['seed_no'], 'display': m['school'] if m['team_id'] else f"{m['school']}·{m['subject']}"})
        rows = db.q(conn, "SELECT * FROM matches WHERE plan_id=? ORDER BY stage_id,seq,id", (plan['id'],))
        for m in serialize_matches(conn, rows):
            matches_by_stage[m['stage_id']].append(m)
    stage_items = []
    for st in stages:
        pools = pools_by_stage[st['id']]
        for pool in pools:
            pool['members'] = members_by_pool[pool['id']]
        stage_items.append({**dict(st), 'kind_name': STAGE_KIND_NAMES.get(st['kind'], st['kind']),
            'params': _loads(st['params_json']), 'pools': pools, 'matches': matches_by_stage[st['id']],
            'match_count': counts.get(st['id'], {}).get('match_count', 0),
            'unstarted_count': counts.get(st['id'], {}).get('unstarted_count', 0)})
    plan['stages'] = stage_items
    plan['params'] = _loads(plan['params_json'])
    plan['kind_names'] = STAGE_KIND_NAMES
    plan['matches_included'] = include_matches
    return plan


def _loads(text: str) -> dict:
    try:
        return json.loads(text or "{}")
    except json.JSONDecodeError:
        return {}


# ------------------------------------------------------------------ 配置
@route("POST", r"/api/categories/(?P<category_id>\d+)/plan", roles=ORG)
def configure_plan(ctx):
    """建立或替换草稿方案。body: {name, stages:[{kind,name,params}], note}"""
    category_id = int(ctx.params["category_id"])
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] != "team":
        raise bad_request("个人赛只记录最终结果，不进行对阵编排")
    stages = ctx.body.get("stages")
    if not isinstance(stages, list):
        raise bad_request("stages 必须是阶段配置数组（可以为空，稍后逐步添加）")
    for st in stages:
        if st.get("kind") not in STAGE_KIND_NAMES:
            raise bad_request(f"未知阶段类型：{st.get('kind')}")
    plan = active_plan(ctx.conn, category_id)
    if plan and plan["status"] in ("locked", "running"):
        raise forbidden("方案已锁定，请先由管理员解锁后再调整", )
    validate_draw_stages(ctx.conn, category_id, stages)
    payload = json.dumps({"stages": stages}, ensure_ascii=False)
    if plan:
        db.update(ctx.conn, "plans", plan["id"], {
            "name": ctx.body.get("name") or plan["name"],
            "params_json": payload, "status": "draft",
            "updated_at": db.now(ctx.conn)})
        plan_id = plan["id"]
    else:
        plan_id = db.insert(ctx.conn, "plans", {
            "category_id": category_id, "name": ctx.body.get("name") or "默认方案",
            "status": "draft", "params_json": payload})
    security.audit(ctx.conn, ctx.user, "configure_plan", "plan", plan_id,
                   {"stages": [s.get("kind") for s in stages]})
    return {"plan_id": plan_id, "message": "赛程配置已保存，请生成预览后核对"}


@route("PUT", r"/api/pools/(?P<pool_id>\d+)", roles=ORG)
def rename_pool(ctx):
    """小组可自定义命名。"""
    pool_id = int(ctx.params["pool_id"])
    get_or_404(ctx.conn, "pools", pool_id, "比赛小组")
    name = (ctx.body.get("name") or "").strip()
    if not name:
        raise bad_request("小组名称不能为空")
    db.update(ctx.conn, "pools", pool_id, {"name": name})
    security.audit(ctx.conn, ctx.user, "rename_pool", "pool", pool_id, {"name": name})
    return {"message": "小组已重命名"}


@route("PUT", r"/api/plans/(?P<plan_id>\d+)/stages", roles=ORG)
def set_plan_stages(ctx):
    """整体替换草稿方案的阶段配置（向导式逐步添加阶段时使用）。"""
    plan = get_or_404(ctx.conn, "plans", int(ctx.params["plan_id"]), "编排方案")
    if plan["status"] in ("locked", "running"):
        raise forbidden("方案已锁定，请先解锁再调整阶段")
    finished = db.q1(ctx.conn,
                     "SELECT COUNT(*) AS n FROM matches WHERE plan_id = ? AND status = 'finished'",
                     (plan["id"],))
    if finished["n"]:
        raise conflict("该方案已有比赛结果，不能整体替换阶段配置", code="has_results")
    stages = ctx.body.get("stages")
    if not isinstance(stages, list):
        raise bad_request("stages 必须是阶段配置数组")
    for st in stages:
        if not isinstance(st, dict) or st.get("kind") not in STAGE_KIND_NAMES:
            raise bad_request(f"未知阶段类型：{st.get('kind') if isinstance(st, dict) else st}")
    validate_draw_stages(ctx.conn, plan['category_id'], stages)
    payload = json.dumps({"stages": stages}, ensure_ascii=False)
    db.update(ctx.conn, "plans", plan["id"], {
        "params_json": payload, "status": "draft", "updated_at": db.now(ctx.conn)})
    return {"message": "阶段配置已保存", "stages": stages}


@route("POST", r"/api/plans/(?P<plan_id>\d+)/generate", roles=ORG)
def generate_plan(ctx):
    """按配置生成赛程（写入阶段、小组、场次与签位来源），状态进入预览。"""
    plan = get_or_404(ctx.conn, "plans", int(ctx.params["plan_id"]), "编排方案")
    if plan["status"] in ("locked", "running"):
        raise forbidden("方案已锁定，请先解锁")
    finished = db.q1(ctx.conn,
                     "SELECT COUNT(*) AS n FROM matches WHERE plan_id = ? AND status = 'finished'",
                     (plan["id"],))
    if finished["n"]:
        raise conflict("该方案已有比赛结果，不能直接重新生成；请解锁并按变更影响处理", code="has_results")
    cfg = _loads(plan["params_json"])
    stages_cfg = cfg.get("stages") or []
    if not stages_cfg:
        raise bad_request("方案尚未配置阶段")
    validate_draw_stages(ctx.conn, plan['category_id'], stages_cfg)
    guard_group_generation(ctx.conn, plan['category_id'], stages_cfg)
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM stages WHERE plan_id = ?", (plan["id"],))
        warnings: list[str] = []
        participation_ids = [
            r["id"] for r in db.q(ctx.conn,
                                  """SELECT id FROM participations WHERE category_id = ? AND status = 'active'
                                      ORDER BY seed_no IS NULL, seed_no, id""", (plan["category_id"],))]
        for seq, st_cfg in enumerate(stages_cfg, start=1):
            kind = st_cfg["kind"]
            params = dict(st_cfg.get("params") or {})
            if params.get('draw_id') is not None:
                params['pools'] = fixed_pools(ctx.conn, plan['category_id'], params)
            # 向导里手动指定的分组成员是参赛主体 id，生成器按下标使用，这里做一次翻译
            if params.get("pools"):
                idx_of = {pid: i for i, pid in enumerate(participation_ids)}
                translated = []
                for item in params["pools"]:
                    item2 = dict(item)
                    if item2.get("members"):
                        item2["members"] = [idx_of[int(m)] for m in item2["members"]
                                            if int(m) in idx_of]
                    translated.append(item2)
                params["pools"] = translated
            name = st_cfg.get("name") or f"{seq}. {STAGE_KIND_NAMES[kind]}"
            sources, source_warnings = _expand_sources(ctx.conn, plan["id"], kind, params, seq,
                                                       participation_ids)
            warnings.extend(source_warnings)
            gen = formats.generate_stage(kind, sources, params, seq, name)
            warnings.extend(f"{name}：{w}" for w in gen.warnings)
            _persist_stage(ctx.conn, plan, gen)
        advancement.refresh_plan(ctx.conn, plan["id"])
        db.update(ctx.conn, "plans", plan["id"], {"status": "previewed"})
    counts = db.q1(ctx.conn,
                   """SELECT COUNT(*) AS total,
                             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                             SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS voided
                        FROM matches WHERE plan_id = ?""", (plan["id"],))
    security.audit(ctx.conn, ctx.user, "generate_plan", "plan", plan["id"])
    return {"message": "已生成赛程预览",
            "matches_total": counts["total"] or 0,
            "matches_pending": counts["pending"] or 0,
            "matches_void": counts["voided"] or 0,
            "warnings": warnings}


def _expand_sources(conn, plan_id: int, kind: str, params: dict, seq: int,
                    participation_ids: list[int]) -> tuple[list[SlotSpec], list[str]]:
    """把配置里的签位来源展开成 SlotSpec 列表。"""
    warnings: list[str] = []
    descriptors = params.get("sources")
    if not descriptors:
        if seq > 1:
            warnings.append("后续阶段未指定签位来源，已按本项目全部参赛主体生成，请核对")
        return [SlotSpec("participation", participation_id=pid) for pid in participation_ids], warnings
    specs: list[SlotSpec] = []
    for d in descriptors:
        dtype = d.get("type")
        if dtype == "participations":
            specs.extend(SlotSpec("participation", participation_id=pid) for pid in participation_ids)
        elif dtype == "participation":
            specs.append(SlotSpec("participation", participation_id=int(d["participation_id"])))
        elif dtype == "bye":
            specs.append(SlotSpec("bye"))
        elif dtype in ("pool_rank", "pool_rank_range"):
            stage_row = db.q1(conn, "SELECT id FROM stages WHERE plan_id = ? AND seq = ?",
                              (plan_id, int(d.get("stage") or 0)))
            if stage_row is None:
                raise bad_request(f"签位来源引用了不存在的阶段：第{d.get('stage')}阶段")
            pool_rows = db.q(conn, "SELECT id FROM pools WHERE stage_id = ? ORDER BY seq, id",
                             (stage_row["id"],))
            pool_idx = int(d.get("pool") or 0)
            if pool_idx >= len(pool_rows):
                raise bad_request(f"签位来源引用了不存在的比赛小组：第{d.get('stage')}阶段第{pool_idx + 1}组")
            pool_id = pool_rows[pool_idx]["id"]
            if dtype == "pool_rank":
                specs.append(SlotSpec("pool_rank", pool_ref=pool_id, rank=int(d.get("rank") or 1)))
            else:
                for rank in range(int(d.get("from") or 1), int(d.get("to") or 1) + 1):
                    specs.append(SlotSpec("pool_rank", pool_ref=pool_id, rank=rank))
        elif dtype in ("match_winner", "match_loser", "stage_round"):
            stage_row = db.q1(conn, "SELECT id FROM stages WHERE plan_id = ? AND seq = ?",
                              (plan_id, int(d.get("stage") or 0)))
            if stage_row is None:
                raise bad_request(f"签位来源引用了不存在的阶段：第{d.get('stage')}阶段")
            round_no = int(d.get("round") or 0)
            rows = db.q(conn,
                        "SELECT id FROM matches WHERE stage_id = ? AND round_no = ? ORDER BY seq, id",
                        (stage_row["id"], round_no))
            if not rows:
                raise bad_request(f"签位来源引用了不存在的轮次：第{d.get('stage')}阶段第{round_no}轮")
            if dtype == "stage_round":
                want = d.get("side", "loser")
                for r in rows:
                    specs.append(SlotSpec("match_winner" if want == "winner" else "match_loser",
                                          match_ref=r["id"]))
            else:
                idx = int(d.get("index") or 0)
                if idx >= len(rows):
                    raise bad_request("签位来源引用了不存在的场次")
                specs.append(SlotSpec("match_winner" if dtype == "match_winner" else "match_loser",
                                      match_ref=rows[idx]["id"]))
        else:
            raise bad_request(f"未知签位来源类型：{dtype}")
    return specs, warnings


def _persist_stage(conn, plan, gen) -> None:
    stage_id = db.insert(conn, "stages", {
        "plan_id": plan["id"], "seq": gen.seq, "kind": gen.kind, "name": gen.name,
        "params_json": json.dumps(gen.params, ensure_ascii=False),
        "note": gen.note})
    pool_key_map: dict[str, int] = {}
    for pool in gen.pools:
        pool_id = db.insert(conn, "pools", {
            "stage_id": stage_id, "name": pool.name, "kind": pool.kind, "seq": pool.seq,
            "status": "pending", "rank_from": pool.rank_from, "rank_to": pool.rank_to})
        pool_key_map[pool.key] = pool_id
        for i, pid in enumerate(pool.members, start=1):
            if pid:
                conn.execute("INSERT OR IGNORE INTO pool_members (pool_id, participation_id, seed_no)"
                             " VALUES (?, ?, ?)", (pool_id, pid, i))
    match_key_map: dict[str, int] = {}
    for m in gen.matches:
        cols = {
            "category_id": plan["category_id"], "plan_id": plan["id"],
            "plan_version": plan["version"], "stage_id": stage_id,
            "pool_id": pool_key_map.get(m.pool_key),
            "seq": m.seq, "round_no": m.round_no, "round_label": m.round_label,
            "status": "pending", "note": m.note,
        }
        cols.update(m.home.to_columns("home", match_key_map={}, pool_key_map=pool_key_map))
        cols.update(m.away.to_columns("away", match_key_map={}, pool_key_map=pool_key_map))
        match_id = db.insert(conn, "matches", cols)
        match_key_map[m.key] = match_id
    # 轮空：单独保存一条不计分的记录，保证轮空积分口径与后续避免重复轮空都有依据
    if gen.bye_participation:
        seq = db.q1(conn, "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM matches WHERE stage_id = ?",
                    (stage_id,))["s"]
        round_no = gen.matches[0].round_no if gen.matches else 1
        award = "win" if (gen.params or {}).get("bye_award") == "win" else "none"
        db.insert(conn, "matches", {
            "category_id": plan["category_id"], "plan_id": plan["id"],
            "plan_version": plan["version"], "stage_id": stage_id,
            "pool_id": pool_key_map.get(gen.pools[0].key) if gen.pools else None,
            "seq": seq, "round_no": round_no, "round_label": f"第{round_no}轮",
            "status": "void", "home_source_type": "participation",
            "home_participation": gen.bye_participation,
            "away_source_type": "bye", "home_actual": gen.bye_participation,
            "note": "轮空：" + ("按方案授予积分" if award == "win" else "不计积分")})
    # 第二遍：回填前序场次引用（同阶段内的引用需要先有 id）
    for m in gen.matches:
        updates = {}
        if m.home.type in ("match_winner", "match_loser") and m.home.match_ref in match_key_map:
            updates["home_source_match"] = match_key_map[m.home.match_ref]
        if m.away.type in ("match_winner", "match_loser") and m.away.match_ref in match_key_map:
            updates["away_source_match"] = match_key_map[m.away.match_ref]
        if updates:
            sets = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(f"UPDATE matches SET {sets} WHERE id = ?",
                         (*updates.values(), match_key_map[m.key]))


# ------------------------------------------------------------------ 锁定
@route("POST", r"/api/plans/(?P<plan_id>\d+)/lock", roles=ADMIN)
def lock_plan(ctx):
    plan = get_or_404(ctx.conn, "plans", int(ctx.params["plan_id"]), "编排方案")
    if plan["status"] == "locked" or plan["status"] == "running":
        raise conflict("方案已锁定", code="already_locked")
    if plan["status"] != "previewed":
        raise bad_request("请先生成赛程预览并核对，再锁定方案")
    stages_cfg = _loads(plan['params_json']).get('stages') or []
    validate_draw_stages(ctx.conn, plan['category_id'], stages_cfg)
    guard_group_generation(ctx.conn, plan['category_id'], stages_cfg)
    pending = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM matches WHERE plan_id = ?", (plan["id"],))
    if not pending["n"]:
        raise bad_request("方案没有生成任何场次，请检查参赛人数与阶段配置")
    with db.tx(ctx.conn):
        db.update(ctx.conn, "plans", plan["id"], {
            "status": "locked",
            "locked_by": ctx.user["id"],
            "locked_at": db.now(ctx.conn)})
    security.audit(ctx.conn, ctx.user, "lock_plan", "plan", plan["id"], {"version": plan["version"]})
    return {"message": "方案已锁定，记录员可按已安排场次录入成绩"}


@route("POST", r"/api/plans/(?P<plan_id>\d+)/unlock", roles=ADMIN)
def unlock_plan(ctx):
    plan = get_or_404(ctx.conn, "plans", int(ctx.params["plan_id"]), "编排方案")
    if plan["status"] not in ("locked", "running"):
        raise bad_request("方案当前不是锁定状态")
    finished = db.q(ctx.conn,
                    "SELECT id, round_label FROM matches WHERE plan_id = ? AND status = 'finished'",
                    (plan["id"],))
    reason = (ctx.body.get("reason") or "").strip()
    if finished:
        if not ctx.body.get("force"):
            raise conflict(f"已有 {len(finished)} 场结果，解锁会影响后续对阵；"
                           "请确认变更影响后使用强制解锁", code="has_results",
                           detail={"finished": len(finished)})
        if not reason:
            raise bad_request("强制解锁必须填写原因")
    with db.tx(ctx.conn):
        snapshot = json.dumps(plan_detail(ctx.conn, plan), ensure_ascii=False, default=str)
        db.insert(ctx.conn, "plan_archive", {
            "plan_id": plan["id"], "version": plan["version"], "snapshot": snapshot,
            "reason": reason or "解锁调整", "archived_by": ctx.user["id"]})
        db.update(ctx.conn, "plans", plan["id"], {
            "status": "previewed" if finished else "draft",
            "version": plan["version"] + 1, "locked_by": None, "locked_at": None})
    security.audit(ctx.conn, ctx.user, "unlock_plan", "plan", plan["id"],
                   {"reason": reason, "had_results": bool(finished)})
    return {"message": "方案已解锁，原版本已归档", "version": plan["version"] + 1,
            "affected": [dict(f) for f in finished]}


@route("GET", r"/api/plans/(?P<plan_id>\d+)/impact")
def plan_impact(ctx):
    """变更影响：列出依赖已确认结果的后续场次。"""
    plan = get_or_404(ctx.conn, "plans", int(ctx.params["plan_id"]), "编排方案")
    finished = db.q(ctx.conn,
                    "SELECT id, round_label FROM matches WHERE plan_id = ? AND status = 'finished'",
                    (plan["id"],))
    out = []
    for f in finished:
        down = advancement.downstream_matches(ctx.conn, f["id"])
        if down:
            out.append({"match_id": f["id"], "round_label": f["round_label"], "downstream": down})
    notes = db.q(ctx.conn,
                 """SELECT m.id, m.round_label, m.note FROM matches m
                     WHERE m.plan_id = ? AND m.status = 'pending' AND m.note <> ''""",
                 (plan["id"],))
    return {"dependency": out, "pending_notes": db.rows_to_dicts(notes)}


@route("PUT", r"/api/pools/(?P<pool_id>\d+)/members", roles=ORG)
def set_pool_members(ctx):
    """锁定前调整小组成员（不静默补造队伍）。

    该阶段一旦已生成比赛，成员与场次就会不一致，必须先清空未确认场次或重新生成。
    """
    pool_id = int(ctx.params["pool_id"])
    pool = get_or_404(ctx.conn, "pools", pool_id, "比赛小组")
    stage = get_or_404(ctx.conn, "stages", pool["stage_id"], "阶段")
    plan = get_or_404(ctx.conn, "plans", stage["plan_id"], "编排方案")
    if plan["status"] in ("locked", "running"):
        raise forbidden("方案已锁定，不能调整小组")
    generated = db.q1(ctx.conn, "SELECT COUNT(*) AS n FROM matches WHERE stage_id = ?",
                      (stage["id"],))
    if generated["n"]:
        raise conflict("该阶段已生成比赛，请先清空未确认场次或重新生成赛程后再调整分组",
                       code="has_matches")
    stage_cat = db.q1(ctx.conn, "SELECT category_id FROM stages WHERE id = ?", (stage["id"],))
    category_id = stage_cat["category_id"] if stage_cat else plan["category_id"]
    ids: list[int] = []
    for raw in (ctx.body.get("participation_ids") or []):
        pid = int(raw)
        if pid in ids:
            raise bad_request(f"参赛主体 {pid} 在同一小组中重复")
        part = db.q1(ctx.conn, "SELECT * FROM participations WHERE id = ?", (pid,))
        if part is None or part["category_id"] != category_id:
            raise bad_request(f"参赛主体 {pid} 不属于本项目，不能加入该小组")
        ids.append(pid)
    with db.tx(ctx.conn):
        db.run(ctx.conn, "DELETE FROM pool_members WHERE pool_id = ?", (pool_id,))
        for i, pid in enumerate(ids, start=1):
            ctx.conn.execute("INSERT OR IGNORE INTO pool_members (pool_id, participation_id, seed_no)"
                             " VALUES (?, ?, ?)", (pool_id, pid, i))
        db.update(ctx.conn, "pools", pool_id, {"status": "pending"})
    return {"message": "小组成员已更新"}


# ------------------------------------------------------------------ 动态轮次
@route("POST", r"/api/stages/(?P<stage_id>\d+)/next-round", roles=ORG)
def next_round(ctx):
    """瑞士制等逐轮编排：按锁定方案生成下一轮对阵。"""
    stage = get_or_404(ctx.conn, "stages", int(ctx.params["stage_id"]), "阶段")
    plan = get_or_404(ctx.conn, "plans", stage["plan_id"], "编排方案")
    if plan["status"] not in ("locked", "running"):
        raise forbidden("方案未锁定，不能生成正式轮次")
    if stage["kind"] != "swiss":
        raise bad_request("只有瑞士制阶段需要逐轮生成对阵")
    params = _loads(stage["params_json"])
    rounds_planned = int(params.get("rounds") or 0)
    existing = db.q1(ctx.conn, "SELECT MAX(round_no) AS r, COUNT(*) AS n FROM matches WHERE stage_id = ?",
                     (stage["id"],))
    done_rounds = existing["r"] or 0
    if rounds_planned and done_rounds >= rounds_planned:
        raise bad_request(f"方案设定 {rounds_planned} 轮，已全部生成")
    unfinished = db.q1(ctx.conn,
                       """SELECT COUNT(*) AS n FROM matches WHERE stage_id = ? AND round_no = ?
                           AND status NOT IN ('finished','void')""", (stage["id"], done_rounds))
    if done_rounds and unfinished["n"]:
        raise conflict("上一轮还有未确认的场次，请先完成后再生成下一轮", code="round_incomplete")

    pool = db.q1(ctx.conn, "SELECT * FROM pools WHERE stage_id = ? ORDER BY seq, id LIMIT 1",
                 (stage["id"],))
    if pool is None:
        raise not_found("阶段没有比赛小组")
    from .standings import pool_standings_payload
    standings = pool_standings_payload(ctx.conn, pool, include_excluded=False)
    ordered_ids = [r["participation_id"] for r in standings["rows"]]
    played = set()
    for m in db.q(ctx.conn,
                  "SELECT home_actual, away_actual FROM matches WHERE stage_id = ? AND home_actual IS NOT NULL AND away_actual IS NOT NULL",
                  (stage["id"],)):
        played.add(tuple(sorted((m["home_actual"], m["away_actual"]))))
    byes = {r["participation_id"] for r in db.q(
        ctx.conn,
        """SELECT COALESCE(home_actual, away_actual) AS participation_id FROM matches
            WHERE stage_id = ? AND status = 'void'""", (stage["id"],))}
    sources = [SlotSpec("participation", participation_id=pid) for pid in ordered_ids]
    gen = formats.generate_stage("swiss", sources, params, stage["seq"], stage["name"],
                                 swiss_history={"played": played, "byes": byes,
                                                "round_no": done_rounds + 1})
    if not gen.matches:
        raise bad_request("没有可生成的配对")
    with db.tx(ctx.conn):
        seq_base = db.q1(ctx.conn, "SELECT COALESCE(MAX(seq),0) AS s FROM matches WHERE stage_id = ?",
                         (stage["id"],))["s"]
        for i, m in enumerate(gen.matches, start=1):
            cols = {
                "category_id": plan["category_id"], "plan_id": plan["id"],
                "plan_version": plan["version"], "stage_id": stage["id"], "pool_id": pool["id"],
                "seq": seq_base + i, "round_no": m.round_no, "round_label": m.round_label,
                "status": "ready", "note": ""}
            cols.update(m.home.to_columns("home"))
            cols.update(m.away.to_columns("away"))
            db.insert(ctx.conn, "matches", cols)
        if gen.bye_participation:
            award = "win" if params.get("bye_award") == "win" else "none"
            db.insert(ctx.conn, "matches", {
                "category_id": plan["category_id"], "plan_id": plan["id"],
                "plan_version": plan["version"], "stage_id": stage["id"], "pool_id": pool["id"],
                "seq": seq_base + len(gen.matches) + 1, "round_no": done_rounds + 1,
                "round_label": f"第{done_rounds + 1}轮", "status": "void",
                "home_source_type": "participation",
                "home_participation": gen.bye_participation,
                "away_source_type": "bye", "home_actual": gen.bye_participation,
                "note": "轮空：" + ("按方案授予积分" if award == "win" else "不计积分")})
        advancement.refresh_plan(ctx.conn, plan["id"])
        if plan["status"] == "locked":
            db.update(ctx.conn, "plans", plan["id"], {"status": "running"})
    security.audit(ctx.conn, ctx.user, "swiss_next_round", "stage", stage["id"],
                   {"round": done_rounds + 1})
    return {"message": f"已生成第{done_rounds + 1}轮对阵", "round": done_rounds + 1,
            "warnings": gen.warnings, "note": gen.note}
