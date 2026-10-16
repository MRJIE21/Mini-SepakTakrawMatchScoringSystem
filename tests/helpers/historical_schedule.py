"""Prepare historical schedule records ONLY in isolated regression databases.

These are data fixtures for scoring/correction/exports compatibility. This module
is never registered with the HTTP router; real retired requests still return410.
"""
import json
import re
from pathlib import Path
from app import db,config,security
from app.domain import advancement
from app.domain.slots import SlotSpec
from app.errors import bad_request
from helpers import legacy_formats as formats


def fixture_schedule(test, method, path, body=None, token=None, **kwargs):
    """Explicit fixture preparation, not an HTTP request or production fallback."""
    product_data = Path(__file__).resolve().parents[2] / 'data'
    if config.DB_PATH.resolve().is_relative_to(product_data.resolve()):
        raise RuntimeError('Historical fixtures cannot write application data')
    headers = getattr(test, 'event_headers', None) or getattr(test, 'headers', {})
    eid = headers.get('X-Event-ID')
    path_db = db.event_db_path(int(eid)) if eid else config.DB_PATH
    conn = db.connect(path_db)
    body = body or {}
    try:
        with db.tx(conn):
            if path.startswith('/api/categories/') and path.endswith('/plan'):
                cid = int(path.split('/')[3])
                plan = db.q1(conn, 'SELECT * FROM plans WHERE category_id=? ORDER BY id DESC LIMIT 1', (cid,))
                values = {'params_json': json.dumps({'stages': body.get('stages', [])}), 'name': body.get('name', '历史数据夹具'), 'status': 'draft'}
                if plan:
                    db.update(conn, 'plans', plan['id'], values)
                    pid = plan['id']
                else:
                    pid = db.insert(conn, 'plans', {'category_id': cid, **values})
                return {'plan_id': pid}
            if path.startswith('/api/plans/'):
                pid = int(path.split('/')[3])
                plan = db.q1(conn, 'SELECT * FROM plans WHERE id=?', (pid,))
                action = path.split('/')[-1]
                if action == 'stages':
                    db.update(conn, 'plans', pid, {'params_json': json.dumps({'stages': body['stages']})})
                    return {'stages': body['stages']}
                if action == 'generate':
                    db.run(conn, 'DELETE FROM stages WHERE plan_id=?', (pid,))
                    config_stages = json.loads(plan['params_json'])['stages']
                    pids = [p['id'] for p in db.q(conn, "SELECT id FROM participations WHERE category_id=? AND status='active' ORDER BY seed_no IS NULL,seed_no,id", (plan['category_id'],))]
                    for seq, cfg in enumerate(config_stages, 1):
                        params = dict(cfg.get('params') or {})
                        if params.get('draw_id'):
                            from app.api.group_draw import fixed_pools
                            params['pools'] = fixed_pools(conn, plan['category_id'], params)
                        if params.get('pools'):
                            for pool in params['pools']:
                                pool['members'] = [pids.index(m) for m in pool.get('members', []) if m in pids]
                        sources, _ = _expand_sources(conn, pid, cfg['kind'], params, seq, pids)
                        gen = formats.generate_stage(cfg['kind'], sources, params, seq, cfg.get('name') or cfg['kind'])
                        _persist_stage(conn, plan, gen)
                    advancement.refresh_plan(conn, pid)
                    db.update(conn, 'plans', pid, {'status': 'previewed'})
                    counts = dict(db.q1(conn, "SELECT COUNT(*) AS matches_total,SUM(status='pending') AS matches_pending,SUM(status='void') AS matches_void FROM matches WHERE plan_id=?", (pid,)))
                    return {**counts, 'warnings': []}
                if action in ('lock', 'unlock'):
                    db.update(conn, 'plans', pid, {'status': 'locked' if action == 'lock' else 'previewed'})
                    return {'version': plan['version'], 'affected': [], 'message': '历史数据夹具状态已准备'}
            raise AssertionError('Unsupported historical fixture action: ' + method + ' ' + path)
    finally:
        conn.close()
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



