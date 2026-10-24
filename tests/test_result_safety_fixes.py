"""Result correctness and caught-failure boundaries, using isolated SQLite only."""
from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from app import db, idempotency, result_migrations, result_candidates
from app.api import scoring, standings
from helpers.historical_materialization import correction, cancel, reset_review
from app.domain import advancement, ranking, validation
from app.errors import ApiError
from app.http_server import Context


class ResultSafetyTest(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        self.conn.executescript((Path(__file__).resolve().parents[1] / "app/schema.sql").read_text(encoding="utf-8"))
        self.users = []
        for i, role in enumerate(("admin", "organizer", "recorder", "recorder"), 1):
            uid = db.insert(self.conn, "users", {"username": f"u{i}", "password_hash": "unused",
                                               "salt": "unused", "display_name": f"U{i}", "role": role})
            self.users.append(dict(db.q1(self.conn, "SELECT * FROM users WHERE id=?", (uid,))))
        self.event = db.insert(self.conn, "events", {"name": "Safety fixture", "uuid": "fixture-uuid"})
        db.insert(self.conn, "settings", {"k": "deployment_id", "v": "fixture-deploy"})
        group = db.insert(self.conn, "groups", {"event_id": self.event, "code": "A", "name": "A"})
        self.cat = db.insert(self.conn, "categories", {"group_id": group, "gender": "male", "kind": "team", "name": "Team"})
        self.parts = []
        for i in range(4):
            school = db.insert(self.conn, "schools", {"event_id": self.event, "name": f"S{i}"})
            team = db.insert(self.conn, "teams", {"category_id": self.cat, "school_id": school, "name": f"T{i}"})
            self.parts.append(db.insert(self.conn, "participations", {"category_id": self.cat, "team_id": team, "seed_no": i+1}))
        self.plan = db.insert(self.conn, "plans", {"category_id": self.cat, "name": "Plan", "status": "locked"})
        self.stage = self.make_stage("single_elim")
        self.pool = self.make_pool(self.stage, "bracket")
        self.mid = self.make_match(self.stage, self.pool, result="home", label="决赛")
        result_candidates.initialize(self.conn)

    def tearDown(self):
        self.conn.close()

    def make_stage(self, kind, params=None):
        seq = db.q1(self.conn, "SELECT COALESCE(MAX(seq),0)+1 FROM stages WHERE plan_id=?", (self.plan,))[0]
        return db.insert(self.conn, "stages", {"plan_id": self.plan, "seq": seq, "kind": kind,
                                               "name": kind, "params_json": json.dumps(params or {})})

    def make_pool(self, stage, kind="group", rank_from=1, rank_to=2):
        return db.insert(self.conn, "pools", {"stage_id": stage, "kind": kind, "name": f"Pool {stage}",
                                              "rank_from": rank_from, "rank_to": rank_to})

    def make_match(self, stage, pool, result=None, label="", round_no=1, pair=None):
        home, away = pair or self.parts[:2]
        mid = db.insert(self.conn, "matches", {"category_id": self.cat, "plan_id": self.plan,
            "stage_id": stage, "pool_id": pool, "round_no": round_no, "round_label": label,
            "status": "finished" if result else "ready", "result_status": "normal" if result else None,
            "result_version": int(bool(result)), "home_source_type": "participation", "home_participation": home,
            "away_source_type": "participation", "away_participation": away, "home_actual": home, "away_actual": away})
        for pid in (home, away):
            db.run(self.conn, "INSERT OR IGNORE INTO pool_members(pool_id,participation_id) VALUES(?,?)", (pool, pid))
        if result:
            for s in self.sets(result):
                db.insert(self.conn, "match_sets", {"match_id": mid, **s})
        return mid

    @staticmethod
    def sets(winner="home"):
        return [{"set_no": i, "home_points": 15 if winner == "home" else 5,
                 "away_points": 5 if winner == "home" else 15, "winner_side": winner} for i in (1, 2)]

    def ctx(self, body=None, mid=None, action="correction", user=None, conn=None, params=None):
        mid = mid or self.mid
        return Context(conn or self.conn, user or self.users[0], body or {}, {},
                       params or {"match_id": str(mid)}, {}, "POST", f"/api/matches/{mid}/{action}")

    def correction(self, uid="c1", version=1, winner="away", **extra):
        return {"request_uid": uid, "base_version": version, "reason": "referee review",
                "sets": self.sets(winner), "events": [], "result_status": "normal", **extra}

    def error(self, fn, ctx, code):
        with self.assertRaises(ApiError) as caught:
            fn(ctx)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def row(self, mid=None):
        return db.q1(self.conn, "SELECT * FROM matches WHERE id=?", (mid or self.mid,))

    def ranks(self):
        return [(r["participation_id"], r["rank_no"], r["status"], r["source"])
                for r in db.q(self.conn, "SELECT * FROM placements ORDER BY participation_id")]

    def pool_data(self, pid):
        return standings.pool_standings_payload(self.conn, db.q1(self.conn, "SELECT * FROM pools WHERE id=?", (pid,)))

    def pool_ctx(self, pid, body):
        body = dict(body)
        body.setdefault("base_confirmation", self.pool_data(pid)["base_confirmation"])
        return self.ctx(body, params={"pool_id": str(pid)})

    def test_correction_version_replay_actor_and_scope(self):
        self.error(correction, self.ctx({"reason": "review"}), "client_upgrade_required")
        body = self.correction()
        saved = correction(self.ctx(body))
        self.assertEqual(saved["receipt"]["applied_version"], 2)
        replay = correction(self.ctx(body))
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["receipt"], saved["receipt"])
        self.error(correction, self.ctx(self.correction(uid="other")), "version_conflict")
        self.error(correction, self.ctx(body, user=self.users[1]), "request_uid_reused")
        self.error(cancel, self.ctx(body, action="cancel"), "request_uid_reused")
        self.assertEqual(self.row()["result_version"], 2)
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM request_log")[0], 1)
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM audit_logs WHERE action='correct_match'")[0], 1)

    def test_frozen_event_identity_and_full_payload_hash(self):
        body = self.correction(event_identity={"event_id": self.event, "event_uuid": "fixture-uuid",
                                              "deployment_id": "fixture-deploy"})
        saved = correction(self.ctx(body))
        self.assertEqual(saved["receipt"]["payload_hash"], validation.payload_hash(body))
        changed = {**body, "event_identity": {**body["event_identity"], "deployment_id": "elsewhere"}}
        self.error(correction, self.ctx(changed), "event_identity_mismatch")
        self.error(correction, self.ctx({**body, "reason": "different"}), "request_uid_reused")

    def test_cancel_preserves_history_but_revokes_automatic_points(self):
        standings.auto_placements(self.ctx({}, params={"category_id": str(self.cat)}))
        self.assertEqual(db.q1(self.conn, "SELECT SUM(points) FROM school_points")[0], 32)
        with db.tx(self.conn):
            cancel(self.ctx({"request_uid": "cancel", "base_version": 1, "reason": "cancel"}, action="cancel"))
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM match_sets WHERE match_id=?", (self.mid,))[0], 2)
        self.assertTrue(all(r[2] == "pending" and r[1] is None for r in self.ranks()))
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM school_points")[0], 0)
        self.assertIsNone(ranking.match_winner_side({"result_status": "cancelled", "sets": self.sets()}))
        self.assertIsNone(ranking.match_winner_side({"result_status": "normal", "sets": [self.sets()[0], self.sets("away")[1]]}))

    def test_caught_audit_failure_inside_outer_transaction_is_atomic(self):
        standings.auto_placements(self.ctx({}, params={"category_id": str(self.cat)}))
        ranks_before = self.ranks()
        with db.tx(self.conn):
            with patch.object(scoring.security, "audit", side_effect=RuntimeError("audit fault")):
                with self.assertRaises(RuntimeError):
                    correction(self.ctx(self.correction()))
            db.insert(self.conn, "settings", {"k": "unrelated", "v": "committed"})
        self.assertEqual(self.row()["result_version"], 1)
        self.assertEqual(self.ranks(), ranks_before)
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM request_log")[0], 0)
        self.assertEqual(db.q1(self.conn, "SELECT v FROM settings WHERE k='unrelated'")[0], "committed")
        self.assertFalse(self.conn.in_transaction)

    def test_receipt_insert_failure_rolls_back_business_and_audit(self):
        original_insert = db.insert
        def failing_insert(conn, table, data):
            if table == "request_log":
                raise RuntimeError("log fault")
            return original_insert(conn, table, data)
        with patch.object(db, "insert", side_effect=failing_insert):
            with self.assertRaises(RuntimeError):
                correction(self.ctx(self.correction()))
        self.assertEqual(self.row()["result_version"], 1)
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM audit_logs WHERE action='correct_match'")[0], 0)
        self.assertFalse(self.conn.in_transaction)

    def test_receipt_read_survives_assignment_change_and_is_private(self):
        body = self.correction()
        result = correction(self.ctx(body, user=self.users[1]))
        db.insert(self.conn, "settings", {"k": f"recording:match:{self.mid}", "v": json.dumps({"user_id": self.users[3]["id"]})})
        owner_ctx = self.ctx(user=self.users[1], params={"uid": "c1"})
        self.assertEqual(scoring.result_receipt(owner_ctx)["receipt"], result["receipt"])
        other = self.ctx(user=self.users[2], params={"uid": "c1"})
        self.assertFalse(scoring.result_receipt(other)["found"])

    def test_concurrent_same_base_and_same_uid_use_one_committed_version(self):
        temp_root = Path(__file__).resolve().parents[2] / "tmp"
        temp_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="stss_safety_", dir=temp_root) as directory:
            path = Path(directory) / "fixture.db"
            target = db.connect(path)
            self.conn.backup(target)
            target.close()
            def submit(body):
                conn = db.connect(path)
                try:
                    try:
                        result = correction(self.ctx(body, conn=conn))
                        return (200, result.get("replayed", False))
                    except ApiError as exc:
                        return (exc.status, exc.code)
                finally:
                    conn.close()
            with ThreadPoolExecutor(max_workers=2) as executor:
                responses = list(executor.map(submit, [self.correction(uid="first"), self.correction(uid="second")]))
            self.assertEqual(sorted(r[0] for r in responses), [200, 409])
            check = db.connect(path)
            try:
                saved_uid = db.q1(check, "SELECT uid FROM request_log")[0]
            finally:
                check.close()
            with ThreadPoolExecutor(max_workers=8) as executor:
                replays = list(executor.map(submit, [self.correction(uid=saved_uid)] * 8))
            self.assertEqual(replays, [(200, True)] * 8)
            check = db.connect(path)
            try:
                self.assertEqual(db.q1(check, "SELECT result_version FROM matches WHERE id=?", (self.mid,))[0], 2)
                self.assertEqual(db.q1(check, "SELECT COUNT(*) FROM request_log")[0], 1)
                self.assertEqual(db.q1(check, "PRAGMA integrity_check")[0], "ok")
            finally:
                check.close()

    def test_offset_confirmation_revalidation_and_no_self_stale(self):
        db.run(self.conn, "DELETE FROM stages WHERE id=?", (self.stage,))
        stage = self.make_stage("placement", {"format": "round_robin"})
        pool = self.make_pool(stage, rank_from=5, rank_to=6)
        mid = self.make_match(stage, pool, result="home")
        basis = self.pool_data(pool)["base_results"]
        confirmed = standings.confirm_pool(self.pool_ctx(pool, {"base_results": basis}))
        self.assertFalse(confirmed["standings"]["needs_reconfirm"])
        self.assertEqual(confirmed["standings"]["base_results"], basis)
        standings.auto_placements(self.ctx({}, params={"category_id": str(self.cat)}))
        correction(self.ctx(self.correction(uid="placement", winner="away"), mid=mid))
        self.assertEqual(db.q1(self.conn, "SELECT status FROM pools WHERE id=?", (pool,))[0], "finished")
        self.assertTrue(all(r[0] == "pending" for r in db.q(self.conn, "SELECT status FROM pool_rank_snapshots WHERE pool_id=?", (pool,))))
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM school_points")[0], 0)
        self.error(standings.confirm_pool, self.pool_ctx(pool, {"base_results": basis}), "ranking_changed")
        fresh = self.pool_data(pool)["base_results"]
        standings.confirm_pool(self.pool_ctx(pool, {"base_results": fresh}))
        self.assertEqual([(r[0], r[1]) for r in self.ranks()], [(self.parts[0], 6), (self.parts[1], 5)])
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM school_points")[0], 2)

    def test_manual_tie_basis_survives_refresh_and_rejects_bad_order(self):
        db.run(self.conn, "DELETE FROM stages WHERE id=?", (self.stage,))
        stage = self.make_stage("placement", {"format": "round_robin"})
        pool = self.make_pool(stage, rank_from=5, rank_to=6)
        mid = self.make_match(stage, pool, result="home")
        db.update(self.conn, "matches", mid, {"result_status": "cancelled"})
        basis = self.pool_data(pool)["base_results"]
        bad = {"base_results": basis, "resolutions": [{"participation_id": pid, "rank": 5} for pid in self.parts[:2]]}
        self.error(standings.confirm_pool, self.pool_ctx(pool, bad), "bad_request")
        good = {"base_results": basis, "resolutions": [{"participation_id": pid, "rank": rank}
                                                      for pid, rank in zip(self.parts[:2], (6, 5))]}
        standings.confirm_pool(self.pool_ctx(pool, good))
        advancement.refresh_plan(self.conn, self.plan)
        self.assertFalse(self.pool_data(pool)["needs_reconfirm"])
        self.assertEqual(self.pool_data(pool)["base_results"], basis)
        db.update(self.conn, "participations", self.parts[0], {"status": "withdrawn"})
        self.assertTrue(self.pool_data(pool)["needs_reconfirm"])
        stale = scoring._stale_pools(self.conn, self.plan)
        self.assertEqual([item["pool_id"] for item in stale], [pool])

    def test_old_manual_confirmation_cannot_replace_a_new_confirmation(self):
        db.run(self.conn, "DELETE FROM stages WHERE id=?", (self.stage,))
        stage = self.make_stage("placement", {"format": "round_robin"})
        pool = self.make_pool(stage)
        mid = self.make_match(stage, pool, result="home")
        db.update(self.conn, "matches", mid, {"result_status": "cancelled"})
        initial = self.pool_data(pool)
        original = {"base_results": initial["base_results"], "base_confirmation": initial["base_confirmation"],
                    "resolutions": [{"participation_id": pid, "rank": rank}
                                    for pid, rank in zip(self.parts[:2], (1, 2))]}
        standings.confirm_pool(self.pool_ctx(pool, original))
        different = {**original, "resolutions": [{"participation_id": pid, "rank": rank}
                                               for pid, rank in zip(self.parts[:2], (2, 1))]}
        self.error(standings.confirm_pool, self.pool_ctx(pool, different), "ranking_changed")
        self.assertEqual([(s["participation_id"], s["rank_no"]) for s in self.pool_data(pool)["snapshot"]],
                         [(self.parts[0], 1), (self.parts[1], 2)])

    def test_manual_rank_is_never_overwritten_or_duplicated_by_auto(self):
        standings.auto_placements(self.ctx({}, params={"category_id": str(self.cat)}))
        row = db.q1(self.conn, "SELECT * FROM placements WHERE participation_id=?", (self.parts[0],))
        db.update(self.conn, "placements", row["id"], {"source": "manual"})
        correction(self.ctx(self.correction()))
        stored = self.ranks()
        self.assertEqual(stored[0][1:], (1, "confirmed", "manual"))
        self.assertEqual(stored[1][1:3], (None, "pending"))
        standings.auto_placements(self.ctx({}, params={"category_id": str(self.cat)}))
        self.assertEqual(self.ranks()[0][1:], (1, "confirmed", "manual"))
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM school_points")[0], 1)

    def test_reset_history_and_claim_require_explicit_resolution(self):
        stage = self.make_stage("double_elim", {"grand_final_reset": True})
        pool = self.make_pool(stage, "bracket")
        parent = self.make_match(stage, pool, result="away", label="决赛", round_no=200)
        self.assertTrue(scoring._maybe_create_reset_match(self.conn, self.row(parent)))
        advancement.refresh_plan(self.conn, self.plan)
        reset = db.q1(self.conn, "SELECT * FROM matches WHERE reset_parent_id=?", (parent,))
        self.assertEqual(reset["stage_id"], stage)
        self.assertEqual(reset["home_participation"], self.parts[0])
        db.insert(self.conn, "settings", {"k": f"recording:match:{reset['id']}", "v": json.dumps({"user_id": self.users[2]["id"]})})
        self.error(correction, self.ctx(self.correction(uid="parent", winner="home"), mid=parent), "reset_requires_review")
        self.assertEqual(self.row(parent)["result_version"], 1)
        self.assertEqual(self.row(reset["id"])["reset_state"], "active")
        for s in self.sets("away"):
            db.insert(self.conn, "match_sets", {"match_id": reset["id"], **s})
        db.update(self.conn, "matches", reset["id"], {"status": "finished", "result_status": "normal", "result_version": 1})
        body = self.correction(uid="resolved", winner="home", reset_resolutions=[{
            "match_id": reset["id"], "base_version": 1, "action": "deactivate", "reason": "parent reversed"}])
        correction(self.ctx(body, mid=parent))
        self.assertEqual(self.row(reset["id"])["reset_state"], "inactive")
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM match_sets WHERE match_id=?", (reset["id"],))[0], 2)
        self.error(correction, self.ctx(self.correction(uid="again", version=2), mid=parent), "reset_requires_review")
        new_body = self.correction(uid="fresh-reset", version=2, reset_resolutions=[{
            "match_id": reset["id"], "base_version": 2, "action": "replace", "reason": "new reset identity"}])
        correction(self.ctx(new_body, mid=parent))
        active = db.q1(self.conn, "SELECT * FROM matches WHERE reset_parent_id=? AND reset_state='active'", (parent,))
        self.assertNotEqual(active["id"], reset["id"])
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM match_sets WHERE match_id=?", (active["id"],))[0], 0)
        self.assertEqual(standings._ranks_from_double_elim(self.conn, db.q1(self.conn, "SELECT * FROM stages WHERE id=?", (stage,)), []), [])

    def test_legitimate_bye_advances_but_inactive_reset_cannot(self):
        bye = self.make_match(self.stage, self.pool)
        db.update(self.conn, "matches", bye, {"status": "void", "away_actual": None,
                  "away_source_type": "bye", "away_participation": None})
        downstream = self.make_match(self.stage, self.pool, pair=(self.parts[0], self.parts[2]))
        db.update(self.conn, "matches", downstream, {"home_source_type": "match_winner",
                  "home_source_match": bye, "home_participation": None})
        self.assertEqual(advancement.resolve_slot(self.conn, self.row(downstream), "home")[0], self.parts[0])
        db.update(self.conn, "matches", bye, {"reset_state": "inactive"})
        self.assertIsNone(advancement.resolve_slot(self.conn, self.row(downstream), "home")[0])

    def test_migration_preserves_manual_and_never_guesses_ambiguous_reset(self):
        standings.auto_placements(self.ctx({}, params={"category_id": str(self.cat)}))
        manual = db.q1(self.conn, "SELECT * FROM placements WHERE participation_id=?", (self.parts[0],))
        db.update(self.conn, "placements", manual["id"], {"source": "manual"})
        stage = self.make_stage("double_elim", {"grand_final_reset": True})
        pool = self.make_pool(stage, "bracket")
        self.make_match(stage, pool, result="away", round_no=200)
        self.make_match(stage, pool, result="home", round_no=200)
        reset = self.make_match(stage, pool, result="home", round_no=201)
        result_migrations.install(self.conn)
        self.assertEqual(self.row(reset)["reset_state"], "review")
        self.assertIsNone(self.row(reset)["reset_parent_id"])
        self.assertEqual(self.ranks()[0][1:], (1, "confirmed", "manual"))
        self.assertEqual(self.ranks()[1][1:3], (None, "pending"))
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM school_points")[0], 1)
        audit_count = db.q1(self.conn, "SELECT COUNT(*) FROM audit_logs")[0]
        result_migrations.install(self.conn)
        self.assertEqual(db.q1(self.conn, "SELECT COUNT(*) FROM audit_logs")[0], audit_count)
        resolved = reset_review(self.ctx({"request_uid": "review", "base_version": 1,
                    "action": "deactivate", "reason": "uncertain historical final"}, mid=reset, action="reset-review"))
        self.assertEqual(resolved["match"]["reset_state"], "inactive")


if __name__ == "__main__":
    unittest.main()
