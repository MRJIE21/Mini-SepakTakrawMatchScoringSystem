"""Conservative, repeatable migration of historical result confirmation."""
from __future__ import annotations

import json

from . import db, security
from .domain import advancement


def install(conn):
    # Structure additions happen before this function. No historical manual rank
    # or recorded score is rewritten; uncertain derived confirmations are revoked.
    with db.tx(conn):
        if db.q1(conn, "SELECT v FROM settings WHERE k='result_safety_migration_v2'"):
            return
        changed_categories = set()
        old_pools = db.q(conn, """SELECT p.id,s.plan_id,pl.category_id FROM pools p
            JOIN stages s ON s.id=p.stage_id JOIN plans pl ON pl.id=s.plan_id
            WHERE p.status='confirmed' AND p.confirmation_basis=''""")
        for pool in old_pools:
            db.update(conn, "pools", pool["id"], {"status": "finished", "confirmed_by": None,
                                                  "confirmed_at": None})
            db.run(conn, "UPDATE pool_rank_snapshots SET status='pending' WHERE pool_id=?", (pool["id"],))
            changed_categories.add(pool["category_id"])
            security.audit(conn, None, "migrate_pool_confirmation_review", "pool", pool["id"],
                           {"reason": "历史确认没有稳定源依据，需重新确认；保留人工名次"})
        # Populate only already recorded/resolved membership, before a future
        # confirmation captures its source basis. This does not assign new ranks.
        for row in db.q(conn, "SELECT pool_id,home_actual,away_actual FROM matches WHERE pool_id IS NOT NULL"):
            for pid in (row["home_actual"], row["away_actual"]):
                if pid:
                    db.run(conn, "INSERT OR IGNORE INTO pool_members(pool_id,participation_id,seed_no) VALUES(?,?,NULL)",
                           (row["pool_id"], pid))
        legacy = db.q(conn, """SELECT m.* FROM matches m JOIN stages s ON s.id=m.stage_id
            WHERE m.round_no=201 AND m.reset_state='none' AND s.kind='double_elim'""")
        for row in legacy:
            candidates = db.q(conn, "SELECT * FROM matches WHERE stage_id=? AND round_no=200", (row["stage_id"],))
            siblings = [r for r in legacy if r["stage_id"] == row["stage_id"]]
            parent = candidates[0] if len(candidates) == 1 and len(siblings) == 1 else None
            stage = db.q1(conn, "SELECT params_json FROM stages WHERE id=?", (row["stage_id"],))
            try:
                configured = json.loads(stage["params_json"] or "{}").get("grand_final_reset")
            except (ValueError, AttributeError):
                configured = False
            fields = [f"{side}_{suffix}" for side in ("home", "away")
                      for suffix in ("source_type", "source_pool", "source_rank", "source_match", "participation")]
            proven = bool(parent and configured and parent["category_id"] == row["category_id"]
                          and parent["plan_id"] == row["plan_id"]
                          and all(parent[k] == row[k] for k in fields)
                          and (row["home_actual"], row["away_actual"]) ==
                              (parent["home_actual"], parent["away_actual"]))
            history = (row["status"] == "finished" or
                       db.q1(conn, "SELECT id FROM submissions WHERE match_id=? LIMIT 1", (row["id"],)) or
                       db.q1(conn, "SELECT id FROM score_events WHERE match_id=? LIMIT 1", (row["id"],)) or
                       db.q1(conn, "SELECT id FROM match_sets WHERE match_id=? LIMIT 1", (row["id"],)) or
                       db.q1(conn, "SELECT k FROM settings WHERE k=?", (f"recording:match:{row['id']}",)))
            state = "review"
            updates = {}
            if proven:
                updates = {"reset_parent_id": parent["id"], "reset_parent_version": parent["result_version"]}
                if not history:
                    state = "active" if advancement.result_winner_side(conn, parent) == "away" else "inactive"
            updates["reset_state"] = state
            db.update(conn, "matches", row["id"], updates)
            changed_categories.add(row["category_id"])
            security.audit(conn, None, "migrate_reset_review", "match", row["id"],
                           {"parent_id": updates.get("reset_parent_id"), "state": state,
                            "reason": "唯一父关系由签位与对阵核实；有历史或关系歧义须显式复核"})
        # Cancellation must not preserve an automatic championship from retained
        # sets. Invalidate conservatively; future explicit derivation can restore.
        for row in db.q(conn, "SELECT DISTINCT category_id FROM matches WHERE status='finished' AND result_status IN ('cancelled','unfinished')"):
            if db.q1(conn, "SELECT id FROM placements WHERE category_id=? AND source IN ('auto','standings') AND status='confirmed' LIMIT 1", (row[0],)):
                changed_categories.add(row[0])
        for category_id in changed_categories:
            db.run(conn, """UPDATE placements SET status='pending',rank_no=NULL,version=version+1,
                confirmed_by=NULL,confirmed_at=NULL,note='升级后需复核比赛与小组确认依据'
                WHERE category_id=? AND source IN ('auto','standings') AND (status='confirmed' OR rank_no IS NOT NULL)""",
                   (category_id,))
            db.run(conn, """DELETE FROM school_points WHERE placement_id IN
                (SELECT id FROM placements WHERE category_id=? AND source IN ('auto','standings') AND status='pending')""",
                   (category_id,))
        db.run(conn, "INSERT INTO settings(k,v) VALUES('result_safety_migration_v2','completed')")
