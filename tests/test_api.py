"""端到端接口测试：从建赛事到学校总分的完整流程。

使用标准库 http.client 直接访问内置 HTTP 服务，覆盖：
  名单 → 编排 → 生成 → 锁定 → 计分 → 提交 → 确认小组名次 → 晋级 → 名次 → 学校总分
以及幂等提交、版本冲突、15 分制校验、轮空/待定区分、甲乙丙隔离。
"""
from __future__ import annotations
from helpers.reviewed_result import reviewed_result
from helpers.historical_schedule import fixture_schedule

import json
import os
import re
import sqlite3
import tempfile
import threading
import unittest
import uuid
import urllib.error
import urllib.request
from pathlib import Path

TMP = Path(os.environ["STSS_TEST_DATA_DIR"]) if os.environ.get("STSS_TEST_DATA_DIR") else Path(tempfile.mkdtemp(prefix="stss_test_"))
if TMP.resolve().is_relative_to(Path(__file__).resolve().parents[1] / "data"):
    raise RuntimeError("接口测试必须使用独立数据库，不能指向实际赛事目录")
TMP.mkdir(parents=True, exist_ok=True)
os.environ["STSS_DB"] = str(TMP / "test.db")
os.environ["STSS_DATA_DIR"] = str(TMP)
os.environ["STSS_ADMIN_PASSWORD"] = "admin123"

from app import config, db, security  # noqa: E402
from app.http_server import Handler, load_routes, create_server  # noqa: E402

config.DATA_DIR = TMP
config.DB_PATH = TMP / "test.db"
config.EVENTS_DIR = TMP / "events"
load_routes()


class ApiTest(unittest.TestCase):
    fixture_schedule = fixture_schedule
    @classmethod
    def setUpClass(cls):
        if config.DB_PATH.exists():
            config.DB_PATH.unlink()
        db.init_db()
        conn = db.connect()
        try:
            cls.initial_password = security.ensure_default_users(conn)
            cls.bootstrap_users = [r["username"] for r in db.q(conn, "SELECT username FROM users")]
        finally:
            conn.close()
        cls.server = create_server(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        # 每个用例各自建立赛事与名单，互不影响；数据库在整个测试类期间保持同一份
        self.base = f"http://127.0.0.1:{self.port}"
        self.event_headers = {}
        # Review mutations require explicit event context and an event business
        # database. Keep the original business vectors in that supported scope.
        self.use_event_database = True
        self.token = self.login("admin", "admin123")

    # ------------------------------------------------------------ HTTP 工具
    def request(self, method, path, body=None, token=None, expect=None, raw=False):
        """token=None 使用当前会话；token="" 表示匿名请求。"""
        url = self.base + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Client-Protocol", "3")
        for key, value in self.event_headers.items():
            req.add_header(key, value)
        tok = self.token if token is None else (token or None)
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        try:
            with urllib.request.urlopen(req) as resp:
                payload = resp.read()
                status = resp.status
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            status = exc.code
        if raw:
            return status, payload
        parsed = json.loads(payload.decode("utf-8")) if payload else {}
        if expect is not None:
            self.assertEqual(status, expect,
                             f"{method} {path} 期望 {expect}，实际 {status}：{parsed}")
        return parsed

    def ok(self, method, path, body=None, token=None):
        # Legacy flow fixtures model a freshly loaded v2 client. Negative and
        # stale-package tests use request/err directly and keep their own body.
        if method == "POST" and re.fullmatch(r"/api/pools/\d+/(confirm|lots)", path):
            body = dict(body or {})
            data = self.request("GET", path.rsplit("/", 1)[0] + "/standings", token=token, expect=200)
            body.setdefault("base_results", data["base_results"])
            if path.endswith("/confirm"):
                body.setdefault("base_confirmation", data["base_confirmation"])
        if method == "POST" and re.fullmatch(r"/api/matches/\d+/(correction|cancel)", path):
            body = dict(body or {})
            current = self.request("GET", path.rsplit("/", 1)[0], token=token, expect=200)["match"]
            body.setdefault("request_uid", str(uuid.uuid4()))
            body.setdefault("base_version", current["result_version"])
            if self.event_headers:
                body.setdefault("event_identity", self.event_identity)
        return self.request(method, path, body, token, expect=200)

    def err(self, method, path, body=None, token=None, expect=400, code=None):
        parsed = self.request(method, path, body, token, expect=expect)
        if code:
            self.assertEqual(parsed.get("code"), code, parsed)
        return parsed

    def login(self, username, password) -> str:
        parsed = self.request("POST", "/api/login", {"username": username, "password": password},
                              token="", expect=200)
        return parsed["token"]

    _user_seq = 0

    def make_user(self, role: str, password: str = "测试密码123") -> str:
        """按角色建账号并登录：系统不再内置固定密码的演示账号。"""
        ApiTest._user_seq += 1
        username = f"{role}{ApiTest._user_seq}"
        self.ok("POST", "/api/users", {"username": username, "password": password,
                                       "role": role, "display_name": username,
                                       "event_ids": [int(self.event_headers['X-Event-ID'])] if self.event_headers else []})
        return self.login(username, password)

    # ------------------------------------------------------------ 数据准备
    def build_event(self, team_count=6, individual_count=3):
        """建立赛事、三个大组别、甲组名单（三人赛 6 队、个人赛 3 人）与场地。"""
        event = self.ok("POST", "/api/events", {"name": "测试赛事", "start_date": "2026-09-20"})
        event_id = event["event_id"]
        if self.use_event_database:
            self.event_headers = {'X-Event-ID': str(event_id), 'X-Event-UUID': event['event_uuid']}
            self.event_identity = {"event_id": event_id, "event_uuid": event["event_uuid"],
                                   "deployment_id": self.ok("GET", "/api/events")["deployment_id"]}
        self.ok("POST", f"/api/events/{event_id}/bootstrap")
        structure = self.ok("GET", f"/api/events/{event_id}/structure")
        groups = {g["code"]: g for g in structure["groups"]}
        self.assertEqual(set(groups), {"甲", "乙", "丙"})
        for code, g in groups.items():
            self.assertEqual(len(g["categories"]), 4, f"{code}组应有四个项目")
        group_a = groups["甲"]
        cats = {(c["gender"], c["kind"]): c["id"] for c in group_a["categories"]}
        team_cat = cats[("male", "team")]
        indiv_cat = cats[("male", "individual")]
        team_ids, part_ids, school_ids = [], [], []
        for i in range(team_count):
            school = self.ok("POST", f"/api/events/{event_id}/schools",
                             {"name": f"甲{i + 1}校", "short_name": f"甲{i + 1}",
                              "group_id": group_a["id"]})
            school_ids.append(school["school_id"])
            team = self.ok("POST", f"/api/categories/{team_cat}/teams",
                           {"school_id": school["school_id"], "name": f"甲{i + 1}校代表队"})
            team_ids.append(team["team_id"])
            part = self.ok("POST", f"/api/categories/{team_cat}/participations",
                           {"team_id": team["team_id"], "seed_no": i + 1})
            part_ids.append(part["participation_id"])
        indiv_parts = []
        for i in range(individual_count):
            school = self.ok("POST", f"/api/events/{event_id}/schools",
                             {"name": f"个人{i + 1}校", "short_name": f"个{i + 1}",
                              "group_id": group_a["id"]})
            ath = self.ok("POST", f"/api/schools/{school['school_id']}/athletes",
                          {"name": f"选手{i + 1}", "gender": "male"})
            part = self.ok("POST", f"/api/categories/{indiv_cat}/participations",
                           {"athlete_id": ath["athlete_id"]})
            indiv_parts.append(part["participation_id"])
        # 乙组：一所学校，用于验证隔离
        group_b = groups["乙"]
        cat_b = {(c["gender"], c["kind"]): c["id"] for c in group_b["categories"]}[("male", "team")]
        school_b = self.ok("POST", f"/api/events/{event_id}/schools",
                           {"name": "乙1校", "short_name": "乙1", "group_id": group_b["id"]})
        team_b = self.ok("POST", f"/api/categories/{cat_b}/teams",
                         {"school_id": school_b["school_id"], "name": "乙1校代表队"})
        part_b = self.ok("POST", f"/api/categories/{cat_b}/participations",
                         {"team_id": team_b["team_id"]})
        return {
            "event_id": event_id, "groups": groups, "team_cat": team_cat, "indiv_cat": indiv_cat,
            "team_parts": part_ids, "indiv_parts": indiv_parts, "schools": school_ids,
            "part_b": part_b["participation_id"],
        }

    def build_plan(self, fx):
        """两组循环 + 交叉淘汰（含三四名）+ 五、六名评次。"""
        stages = [
            {"kind": "round_robin", "name": "小组赛",
             "params": {"legs": 1, "pool_count": 2, "assign": "snake"}},
            {"kind": "single_elim", "name": "淘汰赛",
             "params": {"third_place": True, "sources": [
                 {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 1},
                 {"type": "pool_rank", "stage": 1, "pool": 1, "rank": 1},
                 {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 2},
                 {"type": "pool_rank", "stage": 1, "pool": 1, "rank": 2}]}},
            {"kind": "placement", "name": "五、六名比赛",
             "params": {"format": "round_robin", "rank_from": 5, "rank_to": 6, "sources": [
                 {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 3},
                 {"type": "pool_rank", "stage": 1, "pool": 1, "rank": 3}]}},
        ]
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"name": "甲组男三测试方案", "stages": stages})
        plan_id = plan["plan_id"]
        result = self.fixture_schedule("POST", f"/api/plans/{plan_id}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan_id}/lock")
        return plan_id, result

    # ------------------------------------------------------------ 计分工具
    def events_for(self, sets):
        events, seq = [], 0
        for index, s in enumerate(sets, start=1):
            hp, ap = s["home_points"], s["away_points"]
            ch = ca = 0
            order = ["away", "home"] if hp > ap else ["home", "away"]
            for side in order:
                target = hp if side == "home" else ap
                while (ch if side == "home" else ca) < target:
                    if side == "home":
                        ch += 1
                    else:
                        ca += 1
                    seq += 1
                    events.append({"seq": seq, "kind": "score", "set_no": index, "side": side,
                                   "home_after": ch, "away_after": ca})
        return events

    def play(self, match_id, scoreline, base_version=0, uid=None, expect=200, result_status="normal",
             lineup=None):
        sets = []
        for i, (hp, ap) in enumerate(scoreline, start=1):
            sets.append({"set_no": i, "home_points": hp, "away_points": ap,
                         "winner_side": "home" if hp > ap else "away"})
        stamp = "-".join(f"{hp}{ap}" for hp, ap in scoreline) or result_status
        recorded = lineup or self.lineup_for(match_id)
        body = {"submission_uid": uid or f"uid-{match_id}-{base_version}-{stamp}",
                "match_id": match_id, "device": "测试平板", "base_version": base_version,
                "result_status": result_status,
                "sets": sets, "events": self.events_for(sets) if result_status == "normal" else []}
        body.update(recorded)
        if self.event_headers and "event_identity" not in body:
            body["event_identity"] = self.event_identity
        return reviewed_result(self, "POST", "/api/scoring/submit", body, expected=expect)

    def lineup_for(self, match_id) -> dict:
        """记录端下载场次数据时拿到的方案版本与对阵双方，提交时必须原样带回。"""
        detail = self.ok("GET", f"/api/matches/{match_id}")["match"]
        return {"plan_version": detail["plan_version"],
                "home_participation": detail["home"]["participation_id"],
                "away_participation": detail["away"]["participation_id"]}

    _plan_cache: dict = {}

    def plan_version_for(self, match_id) -> int:
        detail = self.ok("GET", f"/api/matches/{match_id}")
        return detail["match"]["plan_version"]

    def match_status(self, match_id) -> str:
        return self.ok("GET", f"/api/matches/{match_id}")["match"]["status"]

    def match_list(self, **filters):
        query = "&".join(f"{k}={v}" for k, v in filters.items())
        return self.ok("GET", f"/api/matches?{query}")["matches"]

    # ------------------------------------------------------------ 主流程
    def test_category_workspace_derives_state_and_keeps_status_dimensions_separate(self):
        fx = self.build_event(team_count=2, individual_count=1)

        team = self.ok("GET", f"/api/categories/{fx['team_cat']}/workspace")
        self.assertEqual(team["category"]["event_id"], fx["event_id"])
        self.assertEqual(team["category"]["kind"], "team")
        self.assertEqual(team["counts"]["enrolled"], 2)
        self.assertEqual(team["counts"]["profiles_incomplete"], 2)
        self.assertEqual(team["primary_action"]["tab"], "groups")
        self.assertEqual([step["tab"] for step in team["steps"]],
                         ["registration", "groups", "schedule", "matches", "results"])
        self.assertEqual(team["blockers"], [])
        self.assertEqual(team["reminders"][0]["code"], "profiles_incomplete")
        self.assertEqual(len(team["reminders"][0]["items"]), 2)

        individual = self.ok("GET", f"/api/categories/{fx['indiv_cat']}/workspace")
        self.assertEqual(individual["category"]["kind"], "individual")
        self.assertEqual(individual["primary_action"], {"tab": "entry", "label": "录入成绩"})
        self.assertEqual(individual["counts"]["matches_total"], 0)
        self.assertIsNone(individual["plan"])

        empty_cat = next(c["id"] for c in fx["groups"]["甲"]["categories"]
                         if c["id"] not in (fx["team_cat"], fx["indiv_cat"]))
        empty = self.ok("GET", f"/api/categories/{empty_cat}/workspace")
        self.assertEqual(empty["primary_action"]["tab"], "registration")
        self.assertEqual(empty["blockers"][0]["code"], "no_entries")


    def test_workspace_manual_matches_are_recordable_without_auto_plan_confirmation(self):
        fx = self.build_event(team_count=2, individual_count=0)
        match_id = self.ok("POST", "/api/matches", {
            "category_id": fx["team_cat"], "home_participation": fx["team_parts"][0],
            "away_participation": fx["team_parts"][1], "round_label": "正式手工赛程",
        })["match_id"]
        workspace = self.ok("GET", f"/api/categories/{fx['team_cat']}/workspace")
        self.assertEqual(workspace["plan"]["status"], "draft")
        self.assertEqual(workspace["primary_action"]["tab"], "matches")
        self.assertEqual(workspace["counts"]["matches_scoreable"], 1)
        self.assertEqual(workspace["upcoming_matches"][0]["id"], match_id)
        self.assertEqual(workspace["tasks"][-1]["code"], "unscheduled")

    def test_workspace_prioritizes_finished_pool_rankings_before_downstream_matches(self):
        fx = self.build_event(team_count=6, individual_count=0)
        plan, _ = self.build_plan(fx)
        first_stage = self.ok("GET", f"/api/plans/{plan}")["plan"]["stages"][0]
        for match in self.match_list(stage_id=first_stage["id"]):
            self.play(match["id"], [(15, 9), (15, 8)])
        url = f"/api/categories/{fx['team_cat']}/workspace"
        waiting = self.ok("GET", url)
        self.assertEqual(waiting["counts"]["pools_to_confirm"], 2)
        self.assertEqual(waiting["counts"]["matches_scoreable"], 0)
        self.assertEqual(waiting["primary_action"]["tab"], "results")
        self.assertEqual(waiting["primary_action"]["pool"], first_stage["pools"][0]["id"])
        self.assertEqual(sum(t["code"] == "pool_confirmation" for t in waiting["tasks"]), 2)
        self.assertEqual(len(waiting["waiting_matches"]), 3)
        for pool in first_stage["pools"]:
            rows = self.ok("GET", f"/api/pools/{pool['id']}/standings")["rows"]
            self.ok("POST", f"/api/pools/{pool['id']}/confirm", {
                "resolutions": [{"participation_id": r["participation_id"], "rank": i}
                                for i, r in enumerate(rows, start=1)],
            })
        advanced = self.ok("GET", url)
        self.assertEqual(advanced["counts"]["pools_to_confirm"], 0)
        self.assertGreater(advanced["counts"]["matches_scoreable"], 0)
        self.assertEqual(advanced["primary_action"]["tab"], "matches")

    def test_workspace_excludes_byes_from_unfinished_match_count(self):
        fx = self.build_event(team_count=3, individual_count=0)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan", {
            "stages": [{"kind": "swiss", "name": "一轮瑞士赛", "params": {"rounds": 1, "bye_award": "none"}}],
        })["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        while True:
            ready = [m for m in self.match_list(category_id=fx["team_cat"]) if m["status"] == "ready"]
            if not ready:
                break
            for match in ready:
                self.play(match["id"], [(15, 9), (15, 8)])
        workspace = self.ok("GET", f"/api/categories/{fx['team_cat']}/workspace")
        self.assertEqual(workspace["counts"]["matches_void"], 1)
        self.assertEqual(workspace["counts"]["matches_total"], 1)
        self.assertEqual(workspace["counts"]["matches_finished"], 1)
        self.assertEqual(workspace["primary_action"]["tab"], "results")
        self.assertEqual(workspace["steps"][2]["state"], "complete")

    def test_workspace_individual_progress_requires_all_results_and_confirmation(self):
        fx = self.build_event(team_count=0, individual_count=2)
        url = f"/api/categories/{fx['indiv_cat']}/workspace"
        def submit(index, value, version=0, status="normal", **extra):
            return reviewed_result(self, "POST", "/api/scoring/individual", {
                "submission_uid": f"workspace-individual-{fx['event_id']}-{index}-{version}",
                "participation_id": fx["indiv_parts"][index], "base_version": version,
                "result_status": status, "result_value": value, "error_count": 0,
                "violation_count": 0, "rank_no": None, **extra,
            }, expected=200)
        submit(0, 20)
        partial = self.ok("GET", url)
        self.assertEqual(partial["counts"]["individual_results_missing"], 1)
        self.assertEqual(partial["primary_action"]["tab"], "entry")
        received = submit(1, None, status="pending")
        pending = self.ok("GET", url)
        self.assertEqual(pending["counts"]["individual_results_missing"], 1)
        self.assertEqual(pending["counts"]["candidates_pending"], 1)
        self.assertEqual(pending["primary_action"]["tab"], "review")
        self.request('POST', f"/api/result-candidates/{received['candidate_id']}/decision", {
            'decision_uid':str(uuid.uuid4()),'action':'return','revision':received['receipt']['revision'],
            'candidate_hash':received['receipt']['candidate_hash'],'base_version':0,'reason':'补全原始次数'},
            token=self._review_fixture_users['reviewer'],expect=200)
        submit(1, 10, version=0, submission_uid=str(uuid.uuid4()), reason="裁判已核对")
        complete = self.ok("GET", url)
        self.assertEqual(complete["primary_action"]["tab"], "results")
        self.assertEqual(complete["counts"]["placements_confirmed"], 0)
        self.ok("POST", f"/api/categories/{fx['indiv_cat']}/individual-rankings/confirm")
        confirmed = self.ok("GET", url)
        self.assertEqual(confirmed["counts"]["placements_confirmed"], 2)
        self.assertEqual(confirmed["steps"][-1]["state"], "complete")

    def test_workspace_two_member_team_remains_enrolled_but_needs_profile_completion(self):
        fx = self.build_event(team_count=0, individual_count=0)
        self.ok("POST", f"/api/categories/{fx['team_cat']}/enrollments", {
            "school": {"name": "待补第三名队员的学校"}, "captain_index": 0,
            "members": [{"name": "队长", "gender": "male"}, {"name": "队员", "gender": "male"}],
        })
        workspace = self.ok("GET", f"/api/categories/{fx['team_cat']}/workspace")
        self.assertEqual(workspace["counts"]["enrolled"], 1)
        self.assertEqual(workspace["counts"]["profiles_incomplete"], 1)
        self.assertEqual(workspace["blockers"], [])
        self.assertIn("不足 3 人", workspace["reminders"][0]["items"][0]["gaps"][0])


    def test_full_flow(self):
        fx = self.build_event()
        plan_id, gen = self.build_plan(fx)
        self.assertEqual(gen["matches_total"], 6 + 4 + 1)
        self.assertGreaterEqual(gen["matches_pending"], 5)
        matches = self.match_list(category_id=fx["team_cat"])
        self.assertEqual(len(matches), 11)
        stage1_id = self.ok("GET", f"/api/plans/{plan_id}")["plan"]["stages"][0]["id"]
        pool_matches = [m for m in matches if m["stage_id"] == stage1_id]
        self.assertEqual(len(pool_matches), 6)
        for m in pool_matches:
            self.assertEqual(m["status"], "ready")
        pending = [m for m in matches if m["status"] == "pending"]
        self.assertEqual(len(pending), 5)

        # 未锁定方案不能提交 —— 先解锁再锁定的路径在下面单独测试
        first = pool_matches[0]
        self.play(first["id"], [(15, 10), (15, 12)], uid="uid-first")
        detail = self.ok("GET", f"/api/matches/{first['id']}")["match"]
        self.assertEqual(detail["status"], "finished")
        self.assertEqual(detail["result_version"], 1)
        self.assertEqual(len(detail["sets"]), 2)

        # 重复提交（同 uid 同内容）幂等
        again = self.play(first["id"], [(15, 10), (15, 12)], uid="uid-first", expect=200)
        self.assertTrue(again["duplicate"])
        # 同 uid 不同内容 → 冲突
        reviewed_result(self, "POST", "/api/scoring/submit",
                 {"submission_uid": "uid-first", "match_id": first["id"],
                  "base_version": 0, "result_status": "normal",
                  "sets": [{"set_no": 1, "home_points": 15, "away_points": 1}], "events": []},
                 expected=409, code="uid_conflict")
        # 旧版本提交 → 冲突
        reviewed_result(self, "POST", "/api/scoring/submit",
                  {"submission_uid": "uid-stale", "match_id": first["id"], "base_version": 0,
                   "result_status": "normal", "sets": [], "events": []},
                  expected=409, code="version_conflict")
        # 16 分超出上限
        bad = {"submission_uid": "uid-16", "match_id": first["id"], "base_version": 1,
               "result_status": "normal",
               "sets": [{"set_no": 1, "home_points": 16, "away_points": 14, "winner_side": "home"}],
               "events": [], **self.lineup_for(first["id"])}
        reviewed_result(self, "POST", "/api/scoring/submit", bad, expected=422, code="invalid_package")
        # 过程与结果不一致
        mismatch = {"submission_uid": "uid-mismatch", "match_id": first["id"], "base_version": 1,
                    "result_status": "normal",
                    "sets": [{"set_no": 1, "home_points": 15, "away_points": 12, "winner_side": "home"}],
                    "events": self.events_for([{"home_points": 15, "away_points": 5}]),
                    **self.lineup_for(first["id"])}
        parsed = reviewed_result(self, "POST", "/api/scoring/submit", mismatch, expected=422, code="invalid_package")
        self.assertTrue(any("不一致" in e for e in parsed["detail"]["errors"]))

        # 待定的后续场次不能计分
        reviewed_result(self, "POST", "/api/scoring/submit",
                  {"submission_uid": "uid-pending", "match_id": pending[0]["id"],
                   "base_version": 0, "result_status": "normal", "sets": [], "events": []},
                  expected=409, code="not_ready")

        # 打完小组赛
        for m in pool_matches:
            if self.match_status(m["id"]) != "finished":
                self.play(m["id"], [(9, 15), (15, 13), (15, 11)])
        pools = self.ok("GET", f"/api/plans/{plan_id}")["plan"]["stages"][0]["pools"]
        for pool in pools:
            standings = self.ok("GET", f"/api/pools/{pool['id']}/standings")
            self.assertEqual(len(standings["rows"]), 3)
            confirmed = self.ok("POST", f"/api/pools/{pool['id']}/confirm", {})
            self.assertIn("已确认", confirmed["message"])

        # 小组名次确认后，淘汰赛签位应已解析
        after = {m["id"]: m for m in self.match_list(category_id=fx["team_cat"])}
        semis = [m for m in after.values() if m["round_label"] == "半决赛"]
        self.assertEqual(len(semis), 2)
        for m in semis:
            self.assertEqual(m["status"], "ready")
            self.assertTrue(m["home"]["label"] and m["away"]["label"])
        # 交叉对阵：两个小组第一不会在半决赛相遇
        pool_lookup = {p["id"]: p["name"] for p in pools}
        for m in semis:
            home_pool = self.pool_of(m["home"]["participation_id"], pools)
            away_pool = self.pool_of(m["away"]["participation_id"], pools)
            self.assertNotEqual(home_pool, away_pool, f"{m['round_label']} 应对不同小组")

        # 完成淘汰赛
        semi_ids = [m["id"] for m in semis]
        for mid in semi_ids:
            self.play(mid, [(15, 8), (15, 9)])
        third = [m for m in self.match_list(category_id=fx["team_cat"])
                 if m["round_label"] == "三、四名决赛"][0]
        final = [m for m in self.match_list(category_id=fx["team_cat"])
                 if m["round_label"] == "决赛"][0]
        self.assertEqual(self.match_status(third["id"]), "ready")
        self.play(third["id"], [(15, 7), (15, 13)])
        self.play(final["id"], [(15, 12), (12, 15), (15, 13)])
        # 五、六名比赛
        fifth = [m for m in self.match_list(category_id=fx["team_cat"])
                 if m["round_label"].startswith("第") and m["pool_id"] and
                 m["round_label"] == "第1轮" and m["status"] == "ready"]
        target = [m for m in self.match_list(category_id=fx["team_cat"], status="ready")]
        self.assertEqual(len(target), 1, target)
        self.play(target[0]["id"], [(15, 4), (15, 6)])

        # 评次赛小组名次确认后才计入项目名次
        placement_pool = self.ok("GET", f"/api/plans/{plan_id}")["plan"]["stages"][2]["pools"][0]
        confirmed = self.ok("POST", f"/api/pools/{placement_pool['id']}/confirm", {})
        self.assertIn("已确认", confirmed["message"])

        # 自动推导名次
        auto = self.ok("POST", f"/api/categories/{fx['team_cat']}/placements/auto", {})
        self.assertEqual(auto["saved"], 6)
        placements = self.ok("GET", f"/api/categories/{fx['team_cat']}/placements")["placements"]
        ranks = {p["rank_no"]: p for p in placements if p["status"] == "confirmed"}
        self.assertEqual(sorted(ranks), [1, 2, 3, 4, 5, 6])
        # 1、2 名来自决赛，3、4 名来自三四名决赛
        self.assertIn("决赛", ranks[1]["note"])
        self.assertIn("三四名", ranks[3]["note"])
        # 集体项目积分翻倍
        self.assertEqual(ranks[1]["points"], 18)
        self.assertEqual(ranks[6]["points"], 6)
        self.assertEqual(ranks[1]["multiplier"], 2)

        # 学校总分
        group_a_id = fx["groups"]["甲"]["id"]
        totals = self.ok("GET", f"/api/groups/{group_a_id}/school-totals")
        self.assertEqual(len(totals["rows"]), 6 + 3)
        top = totals["rows"][0]
        self.assertEqual(top["total"], 18)
        self.assertTrue(all(r["total"] >= 0 for r in totals["rows"]))
        # 乙组隔离
        group_b_id = fx["groups"]["乙"]["id"]
        totals_b = self.ok("GET", f"/api/groups/{group_b_id}/school-totals")
        self.assertEqual(len(totals_b["rows"]), 1)
        self.assertEqual(totals_b["rows"][0]["total"], 0)
        # 导出
        status, payload = self.request("GET", f"/api/exports/school-totals.csv?group_id={group_a_id}",
                                       expect=200, raw=True)
        self.assertIn("团体总分", payload.decode("utf-8-sig"))
        status, payload = self.request("GET", f"/api/exports/record-sheet.html?match_id={final['id']}",
                                       expect=200, raw=True)
        text = payload.decode("utf-8")
        self.assertIn("3局2胜", text)
        self.assertIn("15分", text)
        self.assertNotIn("11分", text)

        # 正式更正：改变决赛结果会提示受影响场次
        correction = reviewed_result(self, "POST", f"/api/matches/{final['id']}/correction",
                             {"reason": "记录错误：第三局比分登记有误",
                              "result_status": "normal",
                              "sets": [{"set_no": 1, "home_points": 15, "away_points": 12,
                                        "winner_side": "home"},
                                       {"set_no": 2, "home_points": 12, "away_points": 15,
                                        "winner_side": "away"},
                                       {"set_no": 3, "home_points": 13, "away_points": 15,
                                        "winner_side": "away"}],
                              "events": self.events_for([{"home_points": 15, "away_points": 12},
                                                         {"home_points": 12, "away_points": 15},
                                                         {"home_points": 13, "away_points": 15}])}, expected=200)
        self.assertEqual(correction["match"]["result_version"], 2)
        logs = self.ok("GET", "/api/audit-logs?entity_type=match&action=correct_match")
        self.assertEqual(len(logs["logs"]), 1)

    def pool_of(self, participation_id, pools):
        for pool in pools:
            members = self.ok("GET", f"/api/pools/{pool['id']}/standings")
            if any(r["participation_id"] == participation_id for r in members["rows"]):
                return pool["id"]
        return None

    # ------------------------------------------------------------ 排名细则
    def test_standings_c_z_and_lot(self):
        fx = self.build_event(team_count=3)
        stages = [{"kind": "round_robin", "name": "单循环", "params": {"legs": 1}}]
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": stages})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        matches = self.match_list(category_id=fx["team_cat"])
        self.assertEqual(len(matches), 3)
        # 三队形成 2:1 的循环胜负（A 胜 C、C 胜 B、B 胜 A）：
        # 每队 1 胜 1 负、积分都是 3、C 值相同，只能靠 Z 值区分
        cycle = {(0, 2), (2, 1), (1, 0)}          # 按种子序号表示的三方循环
        index = {pid: i for i, pid in enumerate(fx["team_parts"])}
        lines = [[(15, 10), (10, 15), (15, 10)],
                 [(15, 11), (11, 15), (15, 11)],
                 [(15, 12), (12, 15), (15, 12)]]
        for i, match in enumerate(matches):
            home, away = match["home"]["participation_id"], match["away"]["participation_id"]
            home_wins = (index[home], index[away]) in cycle
            line = lines[i % len(lines)]
            if not home_wins:
                line = [(a, b) for b, a in line]
            self.play(match["id"], line, uid=f"tie-{match['id']}")
        pool = self.ok("GET", f"/api/categories/{fx['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        standings = self.ok("GET", f"/api/pools/{pool['id']}/standings")
        # 三队积分相同、C 值相同，只能靠 Z 值区分
        self.assertEqual({r["points"] for r in standings["rows"]}, {3})
        totals = {(r["sets_won"], r["sets_lost"]) for r in standings["rows"]}
        self.assertEqual(totals, {(3, 3)})
        self.assertEqual(len({r["c_text"] for r in standings["rows"]}), 1, "C 值应完全相同")
        self.assertEqual(len({r["z_text"] for r in standings["rows"]}), 3, "Z 值应能区分")
        z_values = [r["z_number"] for r in standings["rows"]]
        self.assertEqual(z_values, sorted(z_values, reverse=True), "应按 Z 值从大到小排列")
        for row in standings["rows"]:
            self.assertIsNotNone(row["rank"])
        # 确认名次
        self.ok("POST", f"/api/pools/{pool['id']}/confirm", {})

    def test_full_tie_needs_lots(self):
        """积分、C 值、Z 值全部相同时，必须先录入抽签结果才能确认名次。"""
        fx = self.build_event(team_count=3)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        matches = self.match_list(category_id=fx["team_cat"])
        index = {pid: i for i, pid in enumerate(fx["team_parts"])}
        cycle = {(0, 2), (2, 1), (1, 0)}
        for match in matches:
            home, away = match["home"]["participation_id"], match["away"]["participation_id"]
            line = [(15, 10), (10, 15), (15, 10)]
            if (index[home], index[away]) not in cycle:
                line = [(a, b) for b, a in line]
            self.play(match["id"], line, uid=f"fulltie-{match['id']}")
        pool = self.ok("GET", f"/api/categories/{fx['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        standings = self.ok("GET", f"/api/pools/{pool['id']}/standings")
        self.assertEqual(len({(r["points"], r["c_text"], r["z_text"]) for r in standings["rows"]}), 1,
                         "三队应当完全并列")
        self.assertEqual(len(standings["unresolved"]), 1)
        for row in standings["rows"]:
            self.assertIsNone(row["rank"])
        # 未抽签不能确认
        parsed = self.err("POST", f"/api/pools/{pool['id']}/confirm", {
            "base_results": standings["base_results"], "base_confirmation": standings["base_confirmation"]},
            expect=409, code="tie_pending")
        self.assertEqual(len(parsed["detail"]["tie_sets"]), 1)
        # 录入现场抽签结果后可以确认
        order = [r["participation_id"] for r in standings["rows"]][::-1]
        recorded = self.ok("POST", f"/api/pools/{pool['id']}/lots", {"order": order})
        self.assertTrue(all(r["rank"] for r in recorded["standings"]["rows"]))
        confirmed = self.ok("POST", f"/api/pools/{pool['id']}/confirm", {})
        self.assertIn("已确认", confirmed["message"])
        self.assertEqual([s["rank_no"] for s in confirmed["standings"]["snapshot"]], [1, 2, 3])

    def test_two_tie_groups_keep_each_others_lot_results(self):
        fx = self.build_event(team_count=4, individual_count=0)
        cat = fx["team_cat"]
        plan = self.fixture_schedule("POST", f"/api/categories/{cat}/plan", {
            "stages": [{"kind": "round_robin", "name": "单循环",
                        "params": {"pool_count": 1}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        index = {pid: i for i, pid in enumerate(fx["team_parts"])}
        winners = {(0, 1): 0, (0, 2): 0, (0, 3): 3,
                   (1, 2): 1, (1, 3): 1, (2, 3): 2}
        for match in self.match_list(category_id=cat):
            home = index[match["home"]["participation_id"]]
            away = index[match["away"]["participation_id"]]
            winner = winners[tuple(sorted((home, away)))]
            score = [(15, 10), (15, 10)] if home == winner else [(10, 15), (10, 15)]
            self.play(match["id"], score, uid=f"multi-lot-{match['id']}")
        pool = self.ok("GET", f"/api/categories/{cat}/plan")["plan"]["stages"][0]["pools"][0]
        path = f"/api/pools/{pool['id']}/lots"
        standings = self.ok("GET", f"/api/pools/{pool['id']}/standings")
        self.assertEqual(len(standings["unresolved"]), 2)
        self.assertTrue(all("·" not in row["label"] for row in standings["rows"]),
                        "三人赛参赛主体应显示学校名称一次")
        first, second = standings["unresolved"]
        first_order = [m["participation_id"] for m in first["members"]][::-1]
        second_order = [m["participation_id"] for m in second["members"]][::-1]
        self.err("POST", path, {"order": ["无效编号"]}, expect=400)
        self.err("POST", path, {"order": [first_order[0]], "base_results": standings["base_results"]}, expect=400)
        self.err("POST", path, {"order": first_order * 2}, expect=400)
        after_first = self.ok("POST", path, {"order": first_order})["standings"]
        self.assertEqual(len(after_first["unresolved"]), 1)
        after_second = self.ok("POST", path, {"order": second_order})["standings"]
        self.assertFalse(after_second["unresolved"])
        rank_map = {r["participation_id"]: r["rank"] for r in after_second["rows"]}
        self.assertEqual([rank_map[pid] for pid in first_order],
                         list(range(first["rank_from"], first["rank_to"] + 1)))
        self.assertEqual([rank_map[pid] for pid in second_order],
                         list(range(second["rank_from"], second["rank_to"] + 1)))

    def test_tie_requires_lot(self):
        fx = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        match = self.match_list(category_id=fx["team_cat"])[0]
        # 1:2 负，两队积分 2:1，但 C 值 1/2 对 2/1 不同 → 无需抽签
        self.play(match["id"], [(15, 10), (10, 15), (10, 15)])
        pool = self.ok("GET", f"/api/categories/{fx['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        standings = self.ok("GET", f"/api/pools/{pool['id']}/standings")
        self.assertTrue(all(r["rank"] for r in standings["rows"]))
        # 弃权：一方 0 分，另一方 2 分，不补造局分
        fx2 = self.build_event(team_count=2)
        plan2 = self.fixture_schedule("POST", f"/api/categories/{fx2['team_cat']}/plan",
                        {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan2}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan2}/lock")
        match2 = self.match_list(category_id=fx2["team_cat"])[0]
        self.play(match2["id"], [], result_status="home_forfeit", uid="uid-forfeit")
        pool2 = self.ok("GET", f"/api/categories/{fx2['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        standings2 = self.ok("GET", f"/api/pools/{pool2['id']}/standings")
        points_map = {r["points"] for r in standings2["rows"]}
        self.assertEqual(points_map, {0, 2})
        # 未完成的比赛不计入排名
        fx3 = self.build_event(team_count=2)
        plan3 = self.fixture_schedule("POST", f"/api/categories/{fx3['team_cat']}/plan",
                        {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan3}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan3}/lock")
        match3 = self.match_list(category_id=fx3["team_cat"])[0]
        self.play(match3["id"], [], result_status="unfinished")
        pool3 = self.ok("GET", f"/api/categories/{fx3['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        standings3 = self.ok("GET", f"/api/pools/{pool3['id']}/standings")
        self.assertTrue(all(r["points"] == 0 for r in standings3["rows"]))

    def test_individual_flow(self):
        fx = self.build_event(team_count=2, individual_count=3)
        cat = fx["indiv_cat"]
        pids = fx["indiv_parts"]
        reviewed_result(self, "POST", "/api/scoring/individual",
                {"submission_uid": "ind-1", "participation_id": pids[0], "base_version": 0,
                 "result_status": "normal", "result_value": 42, "error_count": 1,
                 "violation_count": 0, "rank_no": None}, expected=200)
        reviewed_result(self, "POST", "/api/scoring/individual",
                {"submission_uid": "ind-2", "participation_id": pids[1], "base_version": 0,
                 "result_status": "normal", "result_value": 38, "error_count": 2,
                 "violation_count": 0, "rank_no": None}, expected=200)
        # 原始成绩接口不能逐人直接确认名次
        reviewed_result(self, "POST", "/api/scoring/individual",
                  {"submission_uid": "ind-3", "participation_id": pids[2], "base_version": 0,
                   "result_status": "normal", "result_value": 30, "error_count": 3,
                   "violation_count": 0, "rank_no": 2},
                  expected=400, code="rank_requires_project_confirmation")
        # 未完成不记名次
        reviewed_result(self, "POST", "/api/scoring/individual",
                  {"submission_uid": "ind-4", "participation_id": pids[2], "base_version": 0,
                   "result_status": "dnf", "rank_no": 3},
                  expected=400, code="rank_requires_project_confirmation")
        reviewed_result(self, "POST", "/api/scoring/individual",
                {"submission_uid": "ind-5", "participation_id": pids[2], "base_version": 0,
                 "result_status": "normal", "result_value": 30, "error_count": 3,
                 "violation_count": 0, "rank_no": None}, expected=200)
        self.ok("POST", f"/api/categories/{cat}/individual-rankings/confirm")
        placements = self.ok("GET", f"/api/categories/{cat}/placements")["placements"]
        self.assertEqual(len(placements), 3)
        self.assertEqual({p["rank_no"] for p in placements}, {1, 2, 3})
        self.assertEqual([p for p in placements if p["rank_no"] == 1][0]["points"], 9)
        # 未确认名次不计入正式积分
        group_a_id = fx["groups"]["甲"]["id"]
        totals = self.ok("GET", f"/api/groups/{group_a_id}/school-totals")
        top = {r["name"]: r for r in totals["rows"]}
        self.assertEqual(top["个人1校"]["total"], 9)
        self.assertEqual(top["个人2校"]["total"], 7)
        self.assertEqual(top["个人3校"]["total"], 6)
        # 提交查询
        found = self.ok("GET", "/api/candidate-receipts/ind-1")
        self.assertTrue(found["found"])
        self.assertFalse(self.ok("GET", "/api/candidate-receipts/not-exist")["found"])


    def test_roles(self):
        fx = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "小组赛", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        viewer = self.make_user("viewer")
        recorder = self.make_user("recorder")
        organizer = self.make_user("organizer")
        # 查看者不能锁定、不能提交
        self.err("POST", f"/api/plans/{plan}/lock", {}, token=viewer, expect=403)
        reviewed_result(self, "POST", "/api/scoring/submit",
                  {"submission_uid": "u1", "match_id": 1, "base_version": 0}, token=viewer, expected=403)
        # 记录员不能锁定方案
        self.err("POST", f"/api/plans/{plan}/lock", {}, token=recorder, expect=403)
        # 编排人员可以在管理员之外执行锁定以外的编排工作，但锁定必须由管理员完成
        self.err("POST", f"/api/plans/{plan}/lock", {}, token=organizer, expect=410, code="planner_retired")
        stage = self.ok("GET", f"/api/plans/{plan}")["plan"]["stages"][0]["id"]
        for unauthorized in (viewer, recorder, organizer):
            self.err("POST", f"/api/schedule-stages/{stage}/confirm", {}, token=unauthorized, expect=403)
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        match = self.match_list(category_id=fx["team_cat"])[0]
        # 记录员可以提交成绩
        self.play(match["id"], [(15, 9), (15, 9)], uid="u2")
        # 记录员不能做正式更正
        reviewed_result(self, "POST", f"/api/matches/{match['id']}/correction",
                  {"request_uid": str(uuid.uuid4()), "reason": "x", "sets": [], "events": []}, token=recorder, expected=403)
        # 匿名不能读取
        self.err("GET", "/api/events", token="", expect=401)

    def test_selection_and_bye_rules(self):
        """四队淘汰：轮空不计为比赛，小组人数为奇数时轮次空闲。"""
        fx = self.build_event(team_count=5)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "single_elim", "name": "淘汰赛", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        matches = self.match_list(category_id=fx["team_cat"])
        self.assertEqual(len(matches), 4)        # 5 队 → 8 签位，3 场轮空 → 4 场比赛
        first_round = [m for m in matches if m["round_no"] == 1]
        self.assertEqual(len(first_round), 1)
        second_round = [m for m in matches if m["round_no"] == 2]
        for m in second_round:
            labels = {m["home"]["type"], m["away"]["type"]}
            self.assertNotIn("bye", labels, "轮空不应生成场次")
        # 奇数人数循环
        fx2 = self.build_event(team_count=5)
        plan2 = self.fixture_schedule("POST", f"/api/categories/{fx2['team_cat']}/plan",
                        {"stages": [{"kind": "round_robin", "name": "小组赛", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan2}/generate")
        matches2 = self.match_list(category_id=fx2["team_cat"])
        self.assertEqual(len(matches2), 10)      # C(5,2)，轮次空闲不生成比赛
        self.assertEqual(len({m["round_no"] for m in matches2}), 5)


    def test_full_event_creation_is_atomic_and_uses_event_database(self):
        """向导最终确认后，赛事结构一次写入独立赛事库。"""
        result = self.ok("POST", "/api/events/full", {
            "event": {"name": "完整创建测试", "location": "测试地点"},
            "groups": [{"name": "测试组", "code": "T", "categories": [
                {"name": "男子项目", "gender": "male", "kind": "team"},
                {"name": "女子项目", "gender": "female", "kind": "individual"},
            ]}],
            "venues": [{"name": "测试场地"}],
        })
        event_id = result["event_id"]
        self.assertTrue(db.event_db_path(event_id).exists())
        conn = db.connect(db.event_db_path(event_id))
        try:
            self.assertEqual(db.q1(conn, "SELECT COUNT(*) AS n FROM groups")["n"], 1)
            self.assertEqual(db.q1(conn, "SELECT COUNT(*) AS n FROM categories")["n"], 2)
            self.assertEqual(db.q1(conn, "SELECT COUNT(*) AS n FROM venues")["n"], 1)
        finally:
            conn.close()

        before = db.q1(db.get_conn(), "SELECT COUNT(*) AS n FROM events")["n"]
        self.err("POST", "/api/events/full", {
            "event": {"name": "无效创建"}, "groups": [], "venues": [],
        }, expect=400)
        self.assertEqual(db.q1(db.get_conn(), "SELECT COUNT(*) AS n FROM events")["n"], before)

    def test_flexible_setup_flow(self):
        """向导式配置：自定义组别/项目/小组命名、手动分组、可配置排名积分。"""
        event = self.ok("POST", "/api/events", {"name": "灵活配置测试赛"})
        event_id = event["event_id"]
        self.event_headers = {'X-Event-ID': str(event_id), 'X-Event-UUID': event['event_uuid']}
        self.event_identity = {"event_id": event_id, "event_uuid": event["event_uuid"],
                               "deployment_id": self.ok("GET", "/api/events")["deployment_id"]}

        # 组别自定义命名 + 重命名
        group = self.ok("POST", f"/api/events/{event_id}/groups",
                        {"name": "高校组", "code": "G1"})
        self.ok("PUT", f"/api/groups/{group['group_id']}", {"name": "高校甲组"})
        structure = self.ok("GET", f"/api/events/{event_id}/structure")
        self.assertEqual(structure["groups"][0]["name"], "高校甲组")

        # 项目自定义命名
        cat = self.ok("POST", f"/api/groups/{group['group_id']}/categories",
                      {"name": "男子团体赛", "kind": "team", "gender": "male"})
        cat_id = cat["category_id"]
        self.ok("PUT", f"/api/categories/{cat_id}", {"name": "男子三人团体赛"})

        # 学校与参赛主体
        pids = []
        for i in range(4):
            school = self.ok("POST", f"/api/events/{event_id}/schools",
                             {"name": f"学校{i + 1}", "group_id": group["group_id"]})
            team = self.ok("POST", f"/api/categories/{cat_id}/teams",
                           {"school_id": school["school_id"], "name": f"学校{i + 1}队"})
            pids.append(self.ok("POST", f"/api/categories/{cat_id}/participations",
                                {"team_id": team["team_id"], "seed_no": i + 1})["participation_id"])

        # 阶段配置：手动分组 + 自定义积分（胜 3 负 1 弃权 0）
        plan = self.fixture_schedule("POST", f"/api/categories/{cat_id}/plan", {"stages": []})
        stages_cfg = [{
            "kind": "round_robin", "name": "预赛小组",
            "params": {"legs": 1, "assign": "manual",
                       "points": {"win": 3, "loss": 1, "forfeit": 0},
                       "pools": [{"name": "东区", "members": [pids[0], pids[1]]},
                                 {"name": "西区", "members": [pids[2], pids[3]]}]},
        }]
        self.fixture_schedule("PUT", f"/api/plans/{plan['plan_id']}/stages", {"stages": stages_cfg})
        self.fixture_schedule("POST", f"/api/plans/{plan['plan_id']}/generate")

        detail = self.ok("GET", f"/api/categories/{cat_id}/plan")["plan"]
        pools = detail["stages"][0]["pools"]
        self.assertEqual([p["name"] for p in pools], ["东区", "西区"])
        self.assertEqual([m["participation_id"] for m in pools[0]["members"]], [pids[0], pids[1]])

        # 已生成比赛后不能直接改分组
        self.err("PUT", f"/api/pools/{pools[0]['id']}/members",
                 {"participation_ids": [pids[0], pids[2]]}, expect=410, code="planner_retired")

        # 小组自定义命名
        self.err("PUT", f"/api/pools/{pools[0]['id']}", {"name": "东区A"}, expect=410, code="planner_retired")
        detail = self.ok("GET", f"/api/categories/{cat_id}/plan")["plan"]
        self.assertEqual(detail["stages"][0]["pools"][0]["name"], "东区")

        self.fixture_schedule("POST", f"/api/plans/{plan['plan_id']}/lock")

        # 自定义积分生效：胜一场 3 分
        matches = [m for m in self.match_list(category_id=cat_id) if m["pool_id"] == pools[0]["id"]]
        self.assertEqual(len(matches), 1, "两支队伍单循环应为 1 场")
        self.play(matches[0]["id"], [(15, 5), (15, 6)], uid="flex-1")
        standings = self.ok("GET", f"/api/pools/{pools[0]['id']}/standings")
        self.assertEqual(standings["points_scheme"]["win"], 3)
        winner_row = [r for r in standings["rows"] if r["rank"] == 1][0]
        self.assertEqual(winner_row["points"], 3, "应使用自定义积分方案（胜 3 分）")

        # 有项目/学校的组别不能删除
        self.err("DELETE", f"/api/groups/{group['group_id']}", expect=409, code="in_use")

    def test_scoring_queue_filters_by_project(self):
        fx = self.build_event(team_count=2, individual_count=0)
        a = fx["team_cat"]
        b_group = fx["groups"]["乙"]
        b = next(c["id"] for c in b_group["categories"]
                 if c["kind"] == "team" and c["gender"] == "male")
        school = self.ok("POST", f"/api/events/{fx['event_id']}/schools", {
            "name": "乙2校", "short_name": "乙2", "group_id": b_group["id"]})
        team = self.ok("POST", f"/api/categories/{b}/teams", {
            "school_id": school["school_id"], "name": "乙2校"})
        part = self.ok("POST", f"/api/categories/{b}/participations", {
            "team_id": team["team_id"]})
        self.ok("POST", "/api/matches", {"category_id": a,
            "home_participation": fx["team_parts"][0],
            "away_participation": fx["team_parts"][1]})
        self.ok("POST", "/api/matches", {"category_id": b,
            "home_participation": fx["part_b"],
            "away_participation": part["participation_id"]})
        all_rows = self.ok("GET", f"/api/scoring/queue?event_id={fx['event_id']}")["matches"]
        filtered = self.ok("GET", f"/api/scoring/queue?event_id={fx['event_id']}"
                           f"&category_id={a}")["matches"]
        self.assertEqual({m["category_id"] for m in all_rows}, {a, b})
        self.assertEqual({m["category_id"] for m in filtered}, {a})
        self.assertEqual(len(filtered), 1)
        self.assertNotIn("·", filtered[0]["home"]["label"])
        self.assertNotIn("·", filtered[0]["away"]["label"])

    def test_manual_matches(self):
        """手动添加比赛：不需要编排生成与锁定，直接选双方开赛，并支持删除。"""
        fx = self.build_event(team_count=3)
        parts = fx["team_parts"]
        # 未做任何编排时也能直接建比赛
        created = self.ok("POST", "/api/matches", {
            "category_id": fx["team_cat"],
            "home_participation": parts[0], "away_participation": parts[1],
            "round_label": "半决赛", "scheduled_at": "2026-09-20 09:00",
        })
        match_id = created["match_id"]
        detail = self.ok("GET", f"/api/matches/{match_id}")["match"]
        self.assertEqual(detail["status"], "ready")
        self.assertEqual(detail["round_label"], "半决赛")
        self.assertTrue(detail["home"]["label"] and detail["away"]["label"])
        self.assertEqual(detail["plan_status"], "draft")

        # 未锁定的方案下，手动比赛也能提交成绩
        self.play(match_id, [(15, 10), (15, 12)], uid="manual-1")
        self.assertEqual(self.match_status(match_id), "finished")

        # 已确认的场次不能删除
        parsed = self.err("DELETE", f"/api/matches/{match_id}", expect=409, code="has_result")
        self.assertTrue(parsed["message"])

        # 另建两场：一场保留（用于验证清空时的拦截），一场删除
        keep = self.ok("POST", "/api/matches", {
            "category_id": fx["team_cat"],
            "home_participation": parts[1], "away_participation": parts[2],
        })["match_id"]
        drop = self.ok("POST", "/api/matches", {
            "category_id": fx["team_cat"],
            "home_participation": parts[0], "away_participation": parts[2],
        })["match_id"]
        self.ok("DELETE", f"/api/matches/{drop}")
        self.err("GET", f"/api/matches/{drop}", expect=404)

        # 双方不能相同、不能跨项目
        self.err("POST", "/api/matches", {
            "category_id": fx["team_cat"],
            "home_participation": parts[0], "away_participation": parts[0],
        }, expect=400)

        # 阶段清空：删除未确认场次
        stage_id = self.ok("GET", f"/api/matches/{keep}")["match"]["stage_id"]
        cleared = self.ok("POST", f"/api/stages/{stage_id}/clear")
        self.assertEqual(cleared["deleted"], 1)      # 仅未确认的那场被删除
        self.err("GET", f"/api/matches/{keep}", expect=404)
        self.assertEqual(self.match_status(match_id), "finished")

        # 记分员只能记录，不能增删比赛
        recorder = self.make_user("recorder")
        self.err("POST", "/api/matches", {
            "category_id": fx["team_cat"],
            "home_participation": parts[0], "away_participation": parts[1],
        }, token=recorder, expect=403)
        self.err("DELETE", f"/api/matches/{match_id}", token=recorder, expect=403)

    def play_all_ready(self, category_id, limit=60):
        """把该项目所有“待记录”的场次依次打完，返回完成的场次数。"""
        played = 0
        for _ in range(limit):
            ready = [m for m in self.match_list(category_id=category_id, status="ready")]
            if not ready:
                break
            for m in ready:
                self.play(m["id"], [(15, 8), (15, 9)], uid=f"auto-{m['id']}")
                played += 1
        return played

    def test_gauntlet_ranks_are_complete(self):
        """阶梯淘汰：4 队必须得到 1、2、3、4 四个不同名次。"""
        fx = self.build_event(team_count=4)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "gauntlet", "name": "阶梯淘汰", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        matches = self.match_list(category_id=fx["team_cat"])
        self.assertEqual(len(matches), 3)
        played = self.play_all_ready(fx["team_cat"])
        self.assertEqual(played, 3)
        auto = self.ok("POST", f"/api/categories/{fx['team_cat']}/placements/auto", {})
        ranks = sorted(p["rank_no"] for p in auto["placements"])
        self.assertEqual(ranks, [1, 2, 3, 4], f"阶梯淘汰名次不完整：{auto['placements']}")

    def test_double_elim_grand_final_reset(self):
        """双淘汰开启决赛重置：败者区队伍赢下决赛后必须生成可用的重置场次。"""
        fx = self.build_event(team_count=4)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "double_elim", "name": "双淘汰",
                                    "params": {"grand_final_reset": True}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        # 先打完胜者区与败者区，留下决赛
        for _ in range(20):
            ready = [m for m in self.match_list(category_id=fx["team_cat"], status="ready")]
            gf = [m for m in ready if m["round_no"] == 200]
            if gf:
                break
            self.assertGreater(len(ready), 0, "应还有待记录场次")
            for m in ready:
                self.play(m["id"], [(15, 8), (15, 9)], uid=f"de-{m['id']}")
        gf = [m for m in self.match_list(category_id=fx["team_cat"]) if m["round_no"] == 200]
        self.assertEqual(len(gf), 1, "应有决赛场次")
        # 让客队（败者区冠军）赢下决赛，触发重置
        self.play(gf[0]["id"], [(9, 15), (8, 15)], uid="de-gf")
        reset = [m for m in self.match_list(category_id=fx["team_cat"]) if m["round_no"] == 201]
        self.assertEqual(len(reset), 1, "败者区队伍赢下决赛后应生成决赛重置场次")
        self.assertEqual(reset[0]["status"], "ready", "重置场次应可直接记录")
        self.assertTrue(reset[0]["home"]["label"] and reset[0]["away"]["label"],
                        "重置场次的双方应已解析")
        self.play(reset[0]["id"], [(15, 5), (15, 6)], uid="de-reset")
        auto = self.ok("POST", f"/api/categories/{fx['team_cat']}/placements/auto", {})
        ranks = sorted(p["rank_no"] for p in auto["placements"])
        self.assertEqual(ranks, [1, 2], f"双淘汰决赛名次应来自重置场次：{auto['placements']}")
        notes = " ".join(p["note"] for p in auto["placements"])
        self.assertIn("重置", notes)


    def test_result_change_updates_placements_and_points(self):
        """成绩变更必须联动名次与学校积分：个人赛取消成绩、三人赛决赛更正。"""
        # ① 个人赛：取消成绩后旧名次与积分必须释放
        fx = self.build_event(team_count=2, individual_count=2)
        pids = fx["indiv_parts"]
        reviewed_result(self, "POST", "/api/scoring/individual",
                {"submission_uid": "ind-champ", "participation_id": pids[0], "base_version": 0,
                 "result_status": "normal", "result_value": 40, "error_count": 1,
                 "violation_count": 0, "rank_no": None}, expected=200)
        reviewed_result(self, "POST", "/api/scoring/individual",
                {"submission_uid": "ind-runner", "participation_id": pids[1], "base_version": 0,
                 "result_status": "normal", "result_value": 30, "error_count": 1,
                 "violation_count": 0, "rank_no": None}, expected=200)
        self.ok("POST", f"/api/categories/{fx['indiv_cat']}/individual-rankings/confirm")
        group_a = fx["groups"]["甲"]["id"]
        totals = {r["name"]: r for r in self.ok("GET", f"/api/groups/{group_a}/school-totals")["rows"]}
        self.assertEqual(totals["个人1校"]["total"], 9)
        # 改为取消成绩：名次退回待确认，积分归零
        reviewed_result(self, "POST", "/api/scoring/individual",
                {"submission_uid": "ind-dsq", "participation_id": pids[0], "base_version": 1,
                 "result_status": "dsq", "rank_no": None, "reason": "裁判复核后取消成绩"}, expected=200)
        placements = self.ok("GET", f"/api/categories/{fx['indiv_cat']}/placements")["placements"]
        row = [p for p in placements if p["participation_id"] == pids[0]][0]
        self.assertIsNone(row["rank_no"])
        self.assertEqual(row["status"], "pending")
        totals = {r["name"]: r for r in self.ok("GET", f"/api/groups/{group_a}/school-totals")["rows"]}
        self.assertEqual(totals["个人1校"]["total"], 0, "取消成绩后不应再计 9 分")

        # ② 三人赛：更正决赛胜负后，1、2 名与积分必须翻转
        fx2 = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx2['team_cat']}/plan",
                       {"stages": [{"kind": "single_elim", "name": "决赛",
                                    "params": {"sources": [
                                        {"type": "participations"}]}}]})["plan_id"]
        # 两支队伍直接打一场决赛
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        final = self.match_list(category_id=fx2["team_cat"])[0]
        self.play(final["id"], [(15, 5), (15, 6)], uid="final-1")
        auto = self.ok("POST", f"/api/categories/{fx2['team_cat']}/placements/auto", {})
        ranks_before = {p["participation_id"]: p["rank_no"] for p in auto["placements"]}
        winner_before = [pid for pid, r in ranks_before.items() if r == 1][0]
        group = fx2["groups"]["甲"]["id"]
        totals = {r["name"]: r for r in self.ok("GET", f"/api/groups/{group}/school-totals")["rows"]}
        self.assertEqual(totals["甲1校"]["total"], 18, "冠军学校应有 18 分")
        # 正式更正：改为对手获胜
        reviewed_result(self, "POST", f"/api/matches/{final['id']}/correction",
                {"reason": "记录错误：胜负登记反了", "result_status": "normal",
                 "sets": [{"set_no": 1, "home_points": 5, "away_points": 15, "winner_side": "away"},
                          {"set_no": 2, "home_points": 6, "away_points": 15, "winner_side": "away"}]}, expected=200)
        placements = self.ok("GET", f"/api/categories/{fx2['team_cat']}/placements")["placements"]
        ranks_after = {p["participation_id"]: (p["rank_no"], p["status"]) for p in placements}
        winner_after = [pid for pid, (r, st) in ranks_after.items() if r == 1 and st == "confirmed"]
        self.assertEqual(len(winner_after), 1)
        self.assertNotEqual(winner_before, winner_after[0], "更正后冠军应换人")
        for pid, rank in ranks_before.items():
            self.assertEqual(ranks_after[pid][0], 3 - rank, "更正后名次应互换")
        totals = {r["name"]: r for r in self.ok("GET", f"/api/groups/{group}/school-totals")["rows"]}
        self.assertEqual(totals["甲1校"]["total"] + totals["甲2校"]["total"], 18 + 14,
                         "两校积分合计不变，但归属应对调")
        self.assertEqual(totals["甲2校"]["total"], 18, "更正后冠军学校应为甲2校")

    def test_stale_pool_requires_reconfirm_after_correction(self):
        """小组名次确认后若成绩被更正，快照必须退回待确认，下游签位随之等待。"""
        fx = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "小组赛", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        match = self.match_list(category_id=fx["team_cat"])[0]
        self.play(match["id"], [(15, 5), (15, 6)], uid="rr-1")
        pool = self.ok("GET", f"/api/categories/{fx['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        self.ok("POST", f"/api/pools/{pool['id']}/confirm", {})
        self.assertEqual(self.ok("GET", f"/api/pools/{pool['id']}/standings")["confirmed"], True)
        # 更正比赛结果（双方比分对调）→ 小组名次快照失效
        reviewed_result(self, "POST", f"/api/matches/{match['id']}/correction",
                {"reason": "比分登记方向错误", "result_status": "normal",
                 "sets": [{"set_no": 1, "home_points": 5, "away_points": 15, "winner_side": "away"},
                          {"set_no": 2, "home_points": 6, "away_points": 15, "winner_side": "away"}]}, expected=200)
        after = self.ok("GET", f"/api/pools/{pool['id']}/standings")
        self.assertFalse(after["confirmed"], "成绩变化后小组名次应退回待确认")
        self.assertTrue(after["needs_reconfirm"])

    def test_lineup_change_blocks_stale_record(self):
        """设备载入对阵后编排变化导致双方改变：旧记录必须被拒，按新对阵重记才能提交。"""
        fx = self.build_event(team_count=2)
        stages = [
            {"kind": "round_robin", "name": "小组赛", "params": {"legs": 1, "pool_count": 1}},
            {"kind": "single_elim", "name": "决赛", "params": {"sources": [
                {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 1},
                {"type": "pool_rank", "stage": 1, "pool": 0, "rank": 2}]}},
        ]
        plan_id = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                          {"stages": stages})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan_id}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan_id}/lock")
        plan = self.ok("GET", f"/api/plans/{plan_id}")["plan"]
        pool_id = plan["stages"][0]["pools"][0]["id"]
        stage_ids = [s["id"] for s in plan["stages"]]
        matches = self.match_list(category_id=fx["team_cat"])
        rr = next(m for m in matches if m["stage_id"] == stage_ids[0])
        final = next(m for m in matches if m["stage_id"] == stage_ids[1])

        self.play(rr["id"], [(15, 10), (15, 11)], uid="rr-lineup")
        self.ok("POST", f"/api/pools/{pool_id}/confirm", {})
        loaded = self.ok("GET", f"/api/scoring/match/{final['id']}")["match"]
        self.assertEqual(loaded["status"], "ready")
        old_lineup = (loaded["home"]["participation_id"], loaded["away"]["participation_id"])

        # 更正小组赛结果 → 小组名次退回待确认，决赛签位随之失效；重新确认后双方对调
        reviewed_result(self, "POST", f"/api/matches/{rr['id']}/correction",
                {"reason": "比分登记方向错误", "result_status": "normal",
                 "sets": [{"set_no": 1, "home_points": 10, "away_points": 15, "winner_side": "away"},
                          {"set_no": 2, "home_points": 11, "away_points": 15, "winner_side": "away"}]}, expected=200)
        self.assertEqual(self.ok("GET", f"/api/matches/{final['id']}")["match"]["status"], "pending")
        self.ok("POST", f"/api/pools/{pool_id}/confirm", {})
        current = self.ok("GET", f"/api/matches/{final['id']}")["match"]
        new_lineup = (current["home"]["participation_id"], current["away"]["participation_id"])
        self.assertEqual(set(new_lineup), set(old_lineup))
        self.assertNotEqual(new_lineup, old_lineup)

        stale = {"submission_uid": "uid-stale-lineup", "match_id": final["id"], "device": "测试平板",
                 "base_version": 0, "plan_version": current["plan_version"],
                 "home_participation": old_lineup[0], "away_participation": old_lineup[1],
                 "result_status": "normal",
                 "sets": [{"set_no": 1, "home_points": 15, "away_points": 9, "winner_side": "home"}],
                 "events": []}
        parsed = reviewed_result(self, "POST", "/api/scoring/submit", stale, expected=409, code="lineup_changed")
        self.assertEqual(parsed["detail"]["recorded"], list(old_lineup))
        self.assertEqual(parsed["detail"]["current"], list(new_lineup))
        self.assertEqual(self.match_status(final["id"]), "ready", "被拒的提交不得改变场次状态")
        # 缺少对阵标识的提交包同样被拒
        missing = {k: v for k, v in stale.items()
                   if k not in ("home_participation", "away_participation")}
        missing["submission_uid"] = "uid-no-lineup"
        reviewed_result(self, "POST", "/api/scoring/submit", missing, expected=400, code="missing_lineup")
        # 按当前对阵重新记录即可提交
        self.play(final["id"], [(15, 9), (15, 8)], uid="uid-new-lineup")
        self.assertEqual(self.match_status(final["id"]), "finished")

    def test_pool_confirmation_blocks_on_tie(self):
        """并列未抽签时不能确认名次。"""
        fx = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        match = self.match_list(category_id=fx["team_cat"])[0]
        self.play(match["id"], [], result_status="unfinished")
        pool = self.ok("GET", f"/api/categories/{fx['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        parsed = self.ok("GET", f"/api/pools/{pool['id']}/standings")
        self.assertTrue(all(r["points"] == 0 for r in parsed["rows"]))
        # 两队 0 分、C 值 0/0 不可计算 → 确认被拒绝
        self.err("POST", f"/api/pools/{pool['id']}/confirm", {
            "base_results": parsed["base_results"], "base_confirmation": parsed["base_confirmation"]},
            expect=409, code="tie_pending")


    # ------------------------------------------------------------ 权限边界
    def test_locked_plan_write_boundaries(self):
        """方案锁定后：编排人员不能删改自动生成的场次，管理员删除必须写原因。"""
        self.use_event_database = True
        fx = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        match = self.match_list(category_id=fx["team_cat"])[0]
        organizer = self.make_user("organizer")
        self.err("DELETE", f"/api/matches/{match['id']}", {}, token=organizer, expect=403)
        self.err("POST", f"/api/stages/{match['stage_id']}/clear", {}, token=organizer, expect=403)
        self.err("DELETE", f"/api/matches/{match['id']}", {}, expect=400, code="reason_required")
        self.ok("DELETE", f"/api/matches/{match['id']}", {"reason": "场地冲突，该场取消"})
        self.assertEqual(self.match_list(category_id=fx["team_cat"]), [])
        # 自定义比赛阶段不受锁定限制：编排人员可自行增删
        created = self.ok("POST", "/api/matches", {
            "category_id": fx["team_cat"], "home_participation": fx["team_parts"][0],
            "away_participation": fx["team_parts"][1], "round_label": "补赛"}, token=organizer)
        self.ok("DELETE", f"/api/matches/{created['match_id']}", {}, token=organizer)

    def test_cross_category_writes_rejected(self):
        """名次与参赛名单的写入必须限定在本项目内。"""
        # 事件作用域接口现在强制携带 X-Event-ID，跨项目/跨赛事隔离在事件库上验证。
        fx = self.build_event(team_count=2)
        # 乙组的参赛主体不能写进甲组项目的名次
        self.err("POST", f"/api/categories/{fx['team_cat']}/placements",
                 {"participation_id": fx["part_b"], "rank_no": 1}, expect=400)
        self.err("POST", f"/api/categories/{fx['team_cat']}/placements",
                 {"participation_id": 999999, "rank_no": 1}, expect=404)
        # 已生成对阵的参赛主体不能直接删除（含尚未解析的签位来源）
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        pid = fx["team_parts"][0]
        self.err("DELETE", f"/api/participations/{pid}", {}, expect=409, code="in_use")
        # 报名重构后，锁定赛程内的退出也必须先解锁并重新核对，不能绕过变更保护。
        self.err("PUT", f"/api/participations/{pid}", {"status": "withdrawn"}, expect=409, code="plan_locked")
        # 抽签结果只能录入本项目、本小组的参赛主体
        pool = self.ok("GET", f"/api/categories/{fx['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        self.err("POST", f"/api/pools/{pool['id']}/lots", {"order": [fx["part_b"]],
            "base_results": self.ok("GET", f"/api/pools/{pool['id']}/standings")["base_results"]}, expect=400)
        self.ok("POST", f"/api/pools/{pool['id']}/lots", {"order": fx["team_parts"][:2]})
        # 学校总分并列的现场确认只能录入本大组别报名的学校
        self.err("POST", f"/api/groups/{fx['groups']['甲']['id']}/school-tiebreak",
                 {"school_ids": [fx["schools"][0], 999999]}, expect=400)
        # 场地不能跨赛事安排：赛事作用域接口要求头与路径一致，
        # 用 A 的身份写 B 的场地会被拒绝（此前会错写进 A 的赛事库造成数据源错位）。
        other = self.ok("POST", "/api/events", {"name": "另一赛事", "start_date": "2026-09-21"})
        self.err("POST", f"/api/events/{other['event_id']}/venues", {"name": "外校场地"},
                 expect=409, code="event_identity_mismatch")
        match_id = self.match_list(category_id=fx['team_cat'])[0]['id']
        saved_headers, saved_identity = self.event_headers, self.event_identity
        self.event_headers = {'X-Event-ID': str(other['event_id']), 'X-Event-UUID': other['event_uuid']}
        try:
            # 换成 B 的身份后，A 的比赛在所选事件库中不存在，不能跨赛事混用数据。
            self.err("PUT", f"/api/matches/{match_id}", {"venue_id": 1}, expect=404)
        finally:
            self.event_headers, self.event_identity = saved_headers, saved_identity
        self.err("POST", "/api/matches/bulk-schedule",
                 {"match_ids": [999999], "venue_id": 1}, expect=404)

    def test_pool_confirm_requires_finished_matches(self):
        """小组还有未打场次时不能确认名次；强制确认必须写原因并记入审计。"""
        fx = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        pool = self.ok("GET", f"/api/categories/{fx['team_cat']}/plan")["plan"]["stages"][0]["pools"][0]
        self.err("POST", f"/api/pools/{pool['id']}/confirm", {}, expect=409, code="matches_incomplete")
        self.err("POST", f"/api/pools/{pool['id']}/confirm", {"force": True},
                 expect=409, code="matches_incomplete")
        parts = fx["team_parts"][:2]
        self.err("POST", f"/api/pools/{pool['id']}/confirm", {
            "force": True, "reason": "剩余场次经裁判组判定不再进行",
            "resolutions": [{"participation_id": parts[0], "rank": 1},
                            {"participation_id": parts[1], "rank": 2}]},
                 expect=409, code="matches_incomplete")
        # 场次打完后正常确认不需要 force
        match = self.match_list(category_id=fx["team_cat"])[0]
        self.play(match["id"], [(15, 10), (15, 12)], uid="confirm-1")
        self.assertIn("已确认", self.ok("POST", f"/api/pools/{pool['id']}/confirm", {})["message"])

    # ------------------------------------------------------------ 安全与导出
    def test_bootstrap_creates_only_admin(self):
        """首次初始化只建立 admin，不再内置固定密码的其他角色账号。"""
        self.assertEqual(self.bootstrap_users, ["admin"])
        self.assertIsNone(self.initial_password,
                          "已由 STSS_ADMIN_PASSWORD 指定密码时不应再生成随机密码")
        usernames = [u["username"] for u in self.ok("GET", "/api/users")["users"]]
        for legacy in ("organizer", "recorder", "viewer"):
            self.assertNotIn(legacy, usernames)

    def test_exports_reject_token_in_url(self):
        """导出接口只认请求头令牌：URL 中的 token 会被浏览器历史与日志泄露。"""
        fx = self.build_event(team_count=2)
        status, _ = self.request(
            "GET", f"/api/exports/schedule.csv?event_id={fx['event_id']}&token={self.token}",
            token="", raw=True)
        self.assertEqual(status, 401)
        status, body = self.request("GET",
                                    f"/api/exports/schedule.csv?event_id={fx['event_id']}", raw=True)
        self.assertEqual(status, 200)
        self.assertIn("大组别".encode("utf-8"), body)

    def test_record_sheet_escapes_and_csv_blocks_formulas(self):
        """打印页转义录入内容（防存储型 XSS），CSV 阻断公式注入。"""
        event = self.ok("POST", "/api/events", {"name": "转义校验赛事", "start_date": "2026-09-20"})
        event_id = event["event_id"]
        # 事件作用域接口必须携带所选赛事身份（与真实客户端一致）。
        self.event_headers = {'X-Event-ID': str(event_id), 'X-Event-UUID': event['event_uuid']}
        self.ok("POST", f"/api/events/{event_id}/bootstrap")
        group = self.ok("GET", f"/api/events/{event_id}/structure")["groups"][0]
        cat = next(c for c in group["categories"] if c["kind"] == "team")
        school = self.ok("POST", f"/api/events/{event_id}/schools",
                         {"name": "转义校验学校",
                          "short_name": "<script>alert('x')</script><img src=x onerror=alert(1)>",
                          "group_id": group["id"]})
        school2 = self.ok("POST", f"/api/events/{event_id}/schools",
                          {"name": "公式校验学校", "short_name": "=1+1cmd", "group_id": group["id"]})
        for sch, name in ((school, "<img src=x onerror=alert(1)>"), (school2, "T2")):
            team = self.ok("POST", f"/api/categories/{cat['id']}/teams",
                           {"school_id": sch["school_id"], "name": name})
            self.ok("POST", f"/api/categories/{cat['id']}/participations",
                    {"team_id": team["team_id"]})
        plan = self.fixture_schedule("POST", f"/api/categories/{cat['id']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环",
                                    "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan}/lock")
        match = self.match_list(category_id=cat["id"])[0]

        status, body = self.request("GET",
                                    f"/api/exports/record-sheet.html?match_id={match['id']}", raw=True)
        self.assertEqual(status, 200)
        page = body.decode("utf-8")
        self.assertNotIn("<script>alert", page)
        self.assertNotIn("<img src=x", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertIn("&lt;img src=x", page)

        status, body = self.request("GET", f"/api/exports/schedule.csv?category_id={cat['id']}",
                                    raw=True)
        self.assertEqual(status, 200)
        self.assertIn("'=1+1cmd", body.decode("utf-8"))

    def test_backup_is_consistent_snapshot(self):
        """备份必须是可读的一致性快照：刚写入、仍在 WAL 中的数据也要能读到。"""
        fx = self.build_event(team_count=2)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan",
                       {"stages": [{"kind": "round_robin", "name": "单循环",
                                    "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan}/generate")
        status, body = self.request("GET", "/api/admin/backup", raw=True)
        self.assertEqual(status, 200)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.db")
            with open(path, "wb") as fh:
                fh.write(body)
            conn = sqlite3.connect(path)
            try:
                self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
                matches = conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
            finally:
                conn.close()
        self.assertGreaterEqual(events, 1)
        self.assertGreaterEqual(matches, 1)
        recorder = self.make_user("recorder")
        self.err("GET", "/api/admin/backup", token=recorder, expect=403)

    # ============================================================ 改进方案第一阶段
    # 覆盖 §18.1 的 T01/T02/T04/T05/T07/T18/T26 与 §15.3/§15.5 的接口约定。

    def make_roster(self, event_id, group_id, count=3, prefix="队员"):
        """建一所学校与若干运动员，返回 school_id 与 athlete_id 列表。"""
        school = self.ok("POST", f"/api/events/{event_id}/schools",
                         {"name": f"{prefix}学校", "short_name": prefix, "group_id": group_id})
        athletes = []
        for i in range(count):
            ath = self.ok("POST", f"/api/schools/{school['school_id']}/athletes",
                          {"name": f"{prefix}{i + 1}", "gender": "male", "jersey_no": str(i + 1)})
            athletes.append(ath["athlete_id"])
        return school["school_id"], athletes

    def test_phase1_captain_is_explicit_and_survives_reorder(self):
        """T07：队长由显式 ID 决定；成员顺序变化不改变队长；移除队长后清空。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, (a1, a2, a3) = self.make_roster(fx["event_id"], group_a["id"])

        team = self.ok("POST", f"/api/categories/{fx['team_cat']}/teams", {
            "school_id": school_id, "name": "显式队长队",
            "members": [{"athlete_id": a1}, {"athlete_id": a2}, {"athlete_id": a3}],
            "captain_id": a2,
        })
        teams = self.ok("GET", f"/api/categories/{fx['team_cat']}/teams")["teams"]
        me = next(t for t in teams if t["id"] == team["team_id"])
        self.assertEqual(me["captain_id"], a2, "队长应是显式指定的第二人，而不是第一人")
        self.assertEqual([m["is_captain"] for m in me["members"]], [0, 1, 0])

        # 勾选顺序反过来，队长仍是同一人
        self.ok("PUT", f"/api/teams/{team['team_id']}", {
            "member_ids": [a3, a2, a1],
        })
        me = next(t for t in self.ok("GET", f"/api/categories/{fx['team_cat']}/teams")["teams"]
                  if t["id"] == team["team_id"])
        self.assertEqual(me["captain_id"], a2, "成员重排不应改变队长")
        self.assertEqual([m["name"] for m in me["members"]], [f"队员3", "队员2", "队员1"])

        # 把队长移出名单：清空队长并明确提示需要重新指定
        res = self.ok("PUT", f"/api/teams/{team['team_id']}", {"member_ids": [a1, a3]})
        self.assertIsNone(res["captain_id"])
        self.assertTrue(res["captain_cleared"], "队长被移出时应告知已清空")
        self.assertIn("待补充队长", "、".join(res["profile_gaps"]))

    def test_phase1_captain_must_be_a_member(self):
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, athletes = self.make_roster(fx["event_id"], group_a["id"])
        other_school, (outsider,) = self.make_roster(fx["event_id"], group_a["id"],
                                                     count=1, prefix="外校")
        parsed = self.err("POST", f"/api/categories/{fx['team_cat']}/teams", {
            "school_id": school_id, "member_ids": athletes, "captain_id": outsider,
        }, expect=400)
        self.assertEqual(parsed["code"], "invalid_field")
        self.assertIn("captain_id", parsed["detail"]["fields"], "T04：错误要能定位到队长字段")

    def test_phase1_member_from_other_school_rejected_with_field_error(self):
        """T04：跨校队员被拒绝，并返回可定位的字段错误。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, athletes = self.make_roster(fx["event_id"], group_a["id"])
        other_school, (outsider,) = self.make_roster(fx["event_id"], group_a["id"],
                                                     count=1, prefix="别校")
        parsed = self.err("POST", f"/api/categories/{fx['team_cat']}/teams", {
            "school_id": school_id, "member_ids": athletes + [outsider],
        }, expect=400)
        self.assertIn("members", parsed["detail"]["fields"])
        self.assertIn("不属于该学校", parsed["detail"]["fields"]["members"])

    def test_phase1_team_jersey_does_not_overwrite_athlete_profile(self):
        """§6.2：本队报名号码与运动员常用号码分开，改本队号码不回写档案。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, (a1, _, _) = self.make_roster(fx["event_id"], group_a["id"])
        self.ok("POST", f"/api/categories/{fx['team_cat']}/teams", {
            "school_id": school_id, "members": [{"athlete_id": a1, "jersey_no": "18"}],
        })
        athletes = self.ok("GET", f"/api/schools/{school_id}/athletes")["athletes"]
        self.assertEqual(next(x for x in athletes if x["id"] == a1)["jersey_no"], "1",
                         "运动员档案里的常用号码不应被队伍报名号码覆盖")
        teams = self.ok("GET", f"/api/categories/{fx['team_cat']}/teams")["teams"]
        member = teams[0]["members"][0]
        self.assertEqual(member["jersey_no"], "18")
        self.assertEqual(member["athlete_jersey"], "1")

    def test_phase1_combined_enrollment_creates_everything_once(self):
        """T01：一次提交完成建校、建人、建队与报名，不跳其他页面。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        res = self.ok("POST", f"/api/categories/{fx['team_cat']}/enrollments", {
            "school": {"name": "新建综合大学", "short_name": "新建"},
            "team_name": "新建大学队",
            "members": [
                {"name": "甲一", "gender": "male", "jersey_no": "4"},
                {"name": "甲二", "gender": "male"},
                {"name": "甲三", "gender": "male"},
            ],
            "captain_index": 0,
            "seed_no": 7,
        })
        self.assertIn("participation_id", res)
        self.assertEqual(len(res["created"]["schools"]), 1)
        self.assertEqual(len(res["created"]["athletes"]), 3)
        self.assertEqual(len(res["created"]["teams"]), 1)
        self.assertEqual(res["profile_gaps"], [], "名单齐备时不应有待补充项")

        parts = self.ok("GET", f"/api/categories/{fx['team_cat']}/participations")["participations"]
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]["seed_no"], 7)
        self.assertEqual(parts[0]["captain_name"], "甲一")
        self.assertEqual(parts[0]["profile_status"], "complete")

    def test_phase1_enrollment_allows_incomplete_roster(self):
        """T26：名单未齐也允许正式报名，只给缺项提醒，不退回草稿。"""
        fx = self.build_event(team_count=0, individual_count=0)
        res = self.ok("POST", f"/api/categories/{fx['team_cat']}/enrollments", {
            "school": {"name": "空名单学校"},
            "members": [],
        })
        self.assertIn("participation_id", res, "缺少队员不应阻断报名")
        self.assertIn("尚未选择队员", "、".join(res["profile_gaps"]))
        parts = self.ok("GET", f"/api/categories/{fx['team_cat']}/participations")["participations"]
        self.assertEqual(parts[0]["status"], "active")
        self.assertEqual(parts[0]["profile_status"], "incomplete")

    def test_phase1_combined_enrollment_is_idempotent(self):
        """T05：连点保存或超时重试只产生一个业务项。"""
        fx = self.build_event(team_count=0, individual_count=0)
        body = {
            "request_uid": "uid-team-001",
            "school": {"name": "幂等学校"},
            "members": [{"name": "唯一队员", "gender": "male"}],
        }
        first = self.ok("POST", f"/api/categories/{fx['team_cat']}/enrollments", body)
        second = self.ok("POST", f"/api/categories/{fx['team_cat']}/enrollments", body)
        self.assertEqual(first["team_id"], second["team_id"])
        self.assertEqual(first["participation_id"], second["participation_id"])
        self.assertTrue(second.get("replayed"), "重放应标记为 replayed")
        parts = self.ok("GET", f"/api/categories/{fx['team_cat']}/participations")["participations"]
        self.assertEqual(len(parts), 1, "同一请求标识不能产生两条报名")
        schools = self.ok("GET",
                          f"/api/events/{fx['event_id']}/schools?group_id={fx['groups']['甲']['id']}")
        self.assertEqual(len([s for s in schools["schools"] if s["name"] == "幂等学校"]), 1)

    def test_phase1_reused_uid_with_different_payload_conflicts(self):
        """§15.3：同一标识但内容不同属于冲突，不能静默改内容。"""
        fx = self.build_event(team_count=0, individual_count=0)
        self.ok("POST", f"/api/categories/{fx['team_cat']}/enrollments", {
            "request_uid": "uid-clash", "school": {"name": "甲内容学校"},
        })
        parsed = self.err("POST", f"/api/categories/{fx['team_cat']}/enrollments", {
            "request_uid": "uid-clash", "school": {"name": "乙内容学校"},
        }, expect=409)
        self.assertEqual(parsed["code"], "request_uid_reused")

    def test_phase1_duplicate_enrollment_reports_existing_participation(self):
        """T02：同校同项目再次报名被识别，不新增重复记录。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, athletes = self.make_roster(fx["event_id"], group_a["id"])
        team = self.ok("POST", f"/api/categories/{fx['team_cat']}/teams",
                       {"school_id": school_id, "member_ids": athletes})
        first = self.ok("POST", f"/api/categories/{fx['team_cat']}/participations",
                        {"team_id": team["team_id"]})
        parsed = self.err("POST", f"/api/categories/{fx['team_cat']}/enrollments", {
            "school_id": school_id, "team_id": team["team_id"],
        }, expect=409)
        self.assertEqual(parsed["code"], "duplicate")
        self.assertEqual(parsed["detail"]["participation_id"], first["participation_id"],
                         "重复时应回传已有报名，供界面直接跳转编辑")

    def test_phase1_revision_conflict_blocks_blind_overwrite(self):
        """§4.3：带 base_rev 的更新在版本不一致时被拒绝，不覆盖别人的修改。"""
        fx = self.build_event(team_count=1, individual_count=0)
        pid = fx["team_parts"][0]
        parsed = self.err("PUT", f"/api/participations/{pid}",
                          {"seed_no": 9, "base_rev": 999}, expect=409)
        self.assertEqual(parsed["code"], "stale_revision")
        self.assertEqual(parsed["detail"]["current"], 1)
        res = self.ok("PUT", f"/api/participations/{pid}", {"seed_no": 9, "base_rev": 1})
        self.assertEqual(res["rev"], 2)
        self.err("PUT", f"/api/participations/{pid}", {"seed_no": 5, "base_rev": 1}, expect=409)

    def test_phase1_seed_must_be_positive_integer(self):
        """§9.1：种子序号只接受正整数，空值表示未指定。"""
        fx = self.build_event(team_count=1, individual_count=0)
        pid = fx["team_parts"][0]
        for bad in ("abc", 0, -3):
            parsed = self.err("PUT", f"/api/participations/{pid}", {"seed_no": bad}, expect=400)
            self.assertIn("seed_no", parsed["detail"]["fields"])
        self.ok("PUT", f"/api/participations/{pid}", {"seed_no": ""})
        parts = self.ok("GET", f"/api/categories/{fx['team_cat']}/participations")["participations"]
        self.assertIsNone(parts[0]["seed_no"])

    def test_phase1_candidates_are_read_only_and_classified(self):
        """§8.3：候选核对先分类，不写入；已退出者不自动恢复。"""
        fx = self.build_event(team_count=3, individual_count=0)
        before = len(self.ok("GET",
                             f"/api/categories/{fx['team_cat']}/participations")["participations"])
        data = self.ok("GET", f"/api/categories/{fx['team_cat']}/enrollment-candidates")
        self.assertEqual(len(self.ok("GET", f"/api/categories/{fx['team_cat']}/participations")
                             ["participations"]), before, "候选检查不能写数据")
        self.assertEqual(data["counts"].get("enrolled"), 3)
        self.assertNotIn("addable", data["counts"], "全部已报名时不应有可加入项")

        pid = fx["team_parts"][0]
        self.ok("PUT", f"/api/participations/{pid}", {"status": "withdrawn"})
        data = self.ok("GET", f"/api/categories/{fx['team_cat']}/enrollment-candidates")
        withdrawn = [c for c in data["candidates"] if c["action"] == "withdrawn"]
        self.assertEqual(len(withdrawn), 1)
        self.assertIn("自动恢复", withdrawn[0]["reason"])

    def test_phase1_batch_enroll_reports_per_item_results(self):
        """T18：批量报名允许部分成功，逐项给结果，一项失败不回滚其他项。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        team_ids = []
        for i in range(3):
            school = self.ok("POST", f"/api/events/{fx['event_id']}/schools",
                             {"name": f"批量{i}校", "short_name": f"批{i}",
                              "group_id": group_a["id"]})
            team = self.ok("POST", f"/api/categories/{fx['team_cat']}/teams",
                           {"school_id": school["school_id"], "name": f"批量队{i + 1}"})
            team_ids.append(team["team_id"])
        self.ok("POST", f"/api/categories/{fx['team_cat']}/participations",
                {"team_id": team_ids[0]})
        res = self.ok("POST", f"/api/categories/{fx['team_cat']}/participations/batch", {
            "items": [{"team_id": team_ids[0]}, {"team_id": team_ids[1]}, {"team_id": 999999}],
        })
        self.assertEqual(res["created"], 1)
        statuses = [r["status"] for r in res["results"]]
        self.assertEqual(statuses, ["duplicate", "created", "error"],
                         "每项应各自报告结果，一项失败不影响其他项")
        parts = self.ok("GET", f"/api/categories/{fx['team_cat']}/participations")["participations"]
        self.assertEqual(len(parts), 2, "失败项不能把整批回滚")

    def test_phase1_batch_rejects_empty_selection(self):
        fx = self.build_event(team_count=0, individual_count=0)
        parsed = self.err("POST", f"/api/categories/{fx['team_cat']}/participations/batch",
                          {"items": []}, expect=400)
        self.assertIn("items", parsed["detail"]["fields"])

    def test_phase1_individual_enrollment_can_create_athlete_inline(self):
        """Q04：个人赛一次完成建人与报名，不需要另找报名入口。"""
        fx = self.build_event(team_count=0, individual_count=0)
        res = self.ok("POST", f"/api/categories/{fx['indiv_cat']}/enrollments/individual", {
            "school": {"name": "个人赛新校"},
            "athlete": {"name": "临时新建选手", "gender": "male", "jersey_no": "11"},
        })
        self.assertIn("participation_id", res)
        self.assertEqual(len(res["created"]["athletes"]), 1)
        parts = self.ok("GET",
                        f"/api/categories/{fx['indiv_cat']}/participations")["participations"]
        self.assertEqual(parts[0]["subject"], "临时新建选手")

    def test_individual_same_name_requires_review_and_preserves_original(self):
        fx = self.build_event(team_count=0, individual_count=0)
        school = self.ok('POST', f"/api/events/{fx['event_id']}/schools",
                         {'name': '同名学校', 'group_id': fx['groups']['甲']['id']})['school_id']
        original = self.ok('POST', f'/api/schools/{school}/athletes',
                           {'name': '同名选手', 'gender': 'male', 'jersey_no': '7', 'note': '一年级 1 班'})
        path = f"/api/categories/{fx['indiv_cat']}/enrollments/individual"
        source = {'name': ' 同名选手 ', 'gender': 'male', 'note': '二年级 3 班'}
        body = {'school_id': school, 'athlete': source, 'request_uid': 'same-name-reviewed'}
        self.err('POST', path, body)
        source['confirm_distinct_person'] = True
        self.err('POST', path, body)  # 不能只传确认标志，必须核对具体的档案版本。
        source['same_name_candidates'] = [{'id': original['athlete_id'], 'rev': original['rev']}]
        for note in ('', ' 一年级 1 班 '):
            source['note'] = note
            rejected = self.err('POST', path, body)
            self.assertIn('athlete_note', rejected['detail']['fields'])
        self.assertEqual(len(self.ok('GET', f'/api/schools/{school}/athletes')['athletes']), 1)
        source['note'] = '二年级 3 班'
        first = self.ok('POST', path, body)
        replay = self.ok('POST', path, body)
        self.assertTrue(replay['replayed'])
        self.assertEqual(first['athlete_id'], replay['athlete_id'])
        self.assertNotEqual(first['athlete_id'], original['athlete_id'])
        people = self.ok('GET', f'/api/schools/{school}/athletes')['athletes']
        self.assertEqual(len(people), 2)
        old = next(p for p in people if p['id'] == original['athlete_id'])
        self.assertEqual((old['note'], old['jersey_no'], old['rev']), ('一年级 1 班', '7', 1))
        self.assertEqual(next(p for p in people if p['id'] == first['athlete_id'])['note'], '二年级 3 班')
        candidates = self.ok('GET', f"/api/categories/{fx['indiv_cat']}/enrollment-candidates")['candidates']
        candidate = next(c for c in candidates if c['subject_id'] == original['athlete_id'])
        self.assertEqual((candidate['note'], candidate['jersey_no'], candidate['rev']), ('一年级 1 班', '7', 1))
        # 新建不同身份也不能绕过每校限报 1 人；失败不留下新的人员档案。
        source.update(note='三年级', same_name_candidates=[{'id': p['id'], 'rev': p['rev']} for p in people])
        body['request_uid'] = 'same-name-school-limit'
        self.err('POST', path, body, expect=409)
        self.assertEqual(len(self.ok('GET', f'/api/schools/{school}/athletes')['athletes']), 2)

    def test_individual_same_name_rejects_stale_candidates_and_versions(self):
        fx = self.build_event(team_count=0, individual_count=0)
        school = self.ok('POST', f"/api/events/{fx['event_id']}/schools",
                         {'name': '核对学校', 'group_id': fx['groups']['甲']['id']})['school_id']
        person = self.ok('POST', f'/api/schools/{school}/athletes', {'name': '张三', 'gender': 'male'})
        path = f"/api/categories/{fx['indiv_cat']}/enrollments/individual"
        source = {'name': '张三', 'gender': 'male', 'note': '二年级', 'confirm_distinct_person': True,
                  'same_name_candidates': [{'id': person['athlete_id'], 'rev': 1}]}
        body = {'school_id': school, 'athlete': source}
        # 候选资料修改后必须重核，不能继续使用旧版本的确认。
        self.ok('PUT', f"/api/athletes/{person['athlete_id']}", {'rev': 1, 'note': '一年级'})
        self.err('POST', path, body, expect=409, code='same_name_changed')
        source['same_name_candidates'][0]['rev'] = 2
        second = self.ok('POST', f'/api/schools/{school}/athletes', {'name': '张三', 'gender': 'female'})
        self.err('POST', path, body, expect=409, code='same_name_changed')
        self.assertEqual(len(self.ok('GET', f'/api/schools/{school}/athletes')['athletes']), 2)
        source['same_name_candidates'].append({'id': second['athlete_id'], 'rev': 1})
        self.ok('POST', path, body)

    def test_individual_first_person_detects_a_new_same_name_since_loading(self):
        fx = self.build_event(team_count=0, individual_count=0)
        school = self.ok('POST', f"/api/events/{fx['event_id']}/schools",
                         {'name': '新档案学校', 'group_id': fx['groups']['甲']['id']})['school_id']
        path = f"/api/categories/{fx['indiv_cat']}/enrollments/individual"
        body = {'school_id': school, 'athlete': {'name': '李四', 'gender': 'male',
                'same_name_candidates': [], 'confirm_distinct_person': False}}
        self.ok('POST', f'/api/schools/{school}/athletes', {'name': '李四', 'gender': 'male'})
        self.err('POST', path, body, expect=409, code='same_name_changed')
        self.assertEqual(len(self.ok('GET', f'/api/schools/{school}/athletes')['athletes']), 1)
        self.assertEqual(self.ok('GET', f"/api/categories/{fx['indiv_cat']}/participations")['participations'], [])

    def test_phase1_individual_enrollment_rejects_gender_mismatch(self):
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, _ = self.make_roster(fx["event_id"], group_a["id"])
        ath = self.ok("POST", f"/api/schools/{school_id}/athletes",
                      {"name": "女子选手", "gender": "female"})
        parsed = self.err("POST", f"/api/categories/{fx['indiv_cat']}/enrollments/individual", {
            "school_id": school_id, "athlete_id": ath["athlete_id"],
        }, expect=400)
        self.assertIn("athlete", str(parsed["detail"]["fields"]))

    def test_phase1_unknown_gender_is_a_reminder_not_a_block(self):
        """§6.7：性别未填只作缺项提醒，不阻断报名，但批量加入前需要确认。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, _ = self.make_roster(fx["event_id"], group_a["id"])
        ath = self.ok("POST", f"/api/schools/{school_id}/athletes", {"name": "性别未填选手"})
        cand = self.ok("GET", f"/api/categories/{fx['indiv_cat']}/enrollment-candidates")["candidates"]
        match = next(c for c in cand if c["subject_id"] == ath["athlete_id"])
        self.assertEqual(match["action"], "needs_review", "报名前应先被标为需确认")
        res = self.ok("POST", f"/api/categories/{fx['indiv_cat']}/enrollments/individual", {
            "school_id": school_id, "athlete_id": ath["athlete_id"],
        })
        self.assertEqual(res["profile_gaps"], ["性别待补充"], "报名成功但列出缺项")

    def test_phase1_delete_guards_protect_referenced_records(self):
        """§8.6：删除档案不能隐式带走历史引用。"""
        fx = self.build_event(team_count=0, individual_count=0)
        group_a = fx["groups"]["甲"]
        school_id, athletes = self.make_roster(fx["event_id"], group_a["id"])
        team = self.ok("POST", f"/api/categories/{fx['team_cat']}/teams",
                       {"school_id": school_id, "member_ids": athletes})
        parsed = self.err("DELETE", f"/api/athletes/{athletes[0]}", {}, expect=409)
        self.assertIn("三人赛项目名单", parsed["message"])
        self.ok("POST", f"/api/categories/{fx['team_cat']}/participations",
                {"team_id": team["team_id"]})
        parsed = self.err("DELETE", f"/api/schools/{school_id}", {}, expect=409)
        self.assertEqual(parsed["code"], "in_use")

    def test_phase1_school_group_migration_blocked_when_enrolled(self):
        """§8.1：已有参赛引用时不能直接改学校所属组别。"""
        fx = self.build_event(team_count=1, individual_count=0)
        school_id = fx["schools"][0]
        group_b = fx["groups"]["乙"]["id"]
        parsed = self.err("PUT", f"/api/schools/{school_id}", {"group_id": group_b}, expect=409)
        self.assertEqual(parsed["code"], "in_use")

    def test_phase1_plan_locked_blocks_new_enrollment(self):
        """§15.3：方案锁定并已生成赛程后，不接受静默新增报名。"""
        fx = self.build_event(team_count=6, individual_count=0)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan", {"stages": [
            {"kind": "round_robin", "name": "小组赛",
             "params": {"legs": 1, "pool_count": 2, "assign": "snake"}}]})
        self.fixture_schedule("POST", f"/api/plans/{plan['plan_id']}/generate")
        self.fixture_schedule("POST", f"/api/plans/{plan['plan_id']}/lock")
        parsed = self.err("POST", f"/api/categories/{fx['team_cat']}/enrollments", {
            "school": {"name": "锁定后想插队的学校"},
        }, expect=409)
        self.assertEqual(parsed["code"], "plan_locked")

    def test_phase1_team_impact_lists_references(self):
        """§15.2：修改影响预检查只读地列出受影响场次与名次。"""
        fx = self.build_event(team_count=6, individual_count=0)
        plan = self.fixture_schedule("POST", f"/api/categories/{fx['team_cat']}/plan", {"stages": [
            {"kind": "round_robin", "name": "小组赛",
             "params": {"legs": 1, "pool_count": 2, "assign": "snake"}}]})
        self.fixture_schedule("POST", f"/api/plans/{plan['plan_id']}/generate")
        teams = self.ok("GET", f"/api/categories/{fx['team_cat']}/teams")["teams"]
        impact = self.ok("GET", f"/api/teams/{teams[0]['id']}/impact")
        self.assertEqual(impact["participation_id"], fx["team_parts"][0])
        self.assertGreater(impact["matches"], 0, "已生成赛程后应统计到对阵")

    def test_phase1_school_detail_exposes_teams_and_entries(self):
        """Q10：学校详情能看到已有代表队及其报名状态。"""
        fx = self.build_event(team_count=2, individual_count=0)
        detail = self.ok("GET", f"/api/schools/{fx['schools'][0]}/detail")
        self.assertEqual(len(detail["teams"]), 1)
        team = detail["teams"][0]
        self.assertIsNotNone(team["participation"], "已报名的队伍应显示报名状态")
        self.assertEqual(team["participation"]["status"], "active")
        self.assertIsInstance(team["profile_gaps"], list)

    def test_phase1_migration_preserves_ids_and_captains(self):
        """§15.5：在副本上重复执行迁移，保留主键、成绩引用与既有队长。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "legacy.db")
            db.init_db(path)
            conn = db.connect(path)
            try:
                ev = db.insert(conn, "events", {"name": "旧赛事"})
                g = db.insert(conn, "groups", {"event_id": ev, "code": "甲", "name": "甲组"})
                c = db.insert(conn, "categories", {"group_id": g, "gender": "male",
                                                   "kind": "team", "name": "男子三人赛"})
                s = db.insert(conn, "schools", {"event_id": ev, "name": "旧学校"})
                a1 = db.insert(conn, "athletes", {"group_id": g, "school_id": s, "name": "旧队长"})
                a2 = db.insert(conn, "athletes", {"group_id": g, "school_id": s, "name": "旧队员"})
                t = db.insert(conn, "teams", {"category_id": c, "school_id": s, "name": "旧队"})
                # 旧规则：按成员顺序把“第二人”标成队长。迁移不得按新排序重算。
                db.insert(conn, "team_members", {"team_id": t, "athlete_id": a1, "is_captain": 0})
                db.insert(conn, "team_members", {"team_id": t, "athlete_id": a2, "is_captain": 1})
                p = db.insert(conn, "participations", {"category_id": c, "team_id": t})
                # Simulate the old schema before school-level project decisions existed.
                db.run(conn, 'DROP TABLE school_registration_choices')
                db.run(conn, 'DROP TABLE school_registration_drafts')
            finally:
                conn.close()

            db.init_db(path)          # 第二次执行＝旧库升级

            conn = db.connect(path)
            try:
                self.assertEqual(db.q1(conn, "SELECT id FROM teams")["id"], t, "主键必须保留")
                self.assertEqual(db.q1(conn, "SELECT id FROM participations")["id"], p)
                cap = db.q1(conn, "SELECT athlete_id FROM team_members WHERE is_captain = 1")
                self.assertEqual(cap["athlete_id"], a2, "迁移不能重算队长")
                self.assertEqual(db.q1(conn, "SELECT rev FROM teams")["rev"], 1)
                self.assertEqual(db.q1(conn, "SELECT rev FROM participations")["rev"], 1)
                self.assertEqual(db.q1(conn, 'SELECT COUNT(*) AS n FROM school_registration_choices')['n'], 0)
                self.assertEqual(db.q1(conn, 'SELECT COUNT(*) AS n FROM school_registration_drafts')['n'], 0)
                self.assertIsNotNone(db.q1(
                    conn, "SELECT name FROM sqlite_master WHERE name = 'request_log'"))
            finally:
                conn.close()


    def test_organizer_preview_cannot_claim_or_start_recording(self):
        fx = self.build_event(team_count=2, individual_count=0)
        plan = self.fixture_schedule('POST', f"/api/categories/{fx['team_cat']}/plan", {
            'stages': [{'kind': 'round_robin', 'name': '小组赛', 'params': {'pool_count': 1}}]})
        self.fixture_schedule('POST', f"/api/plans/{plan['plan_id']}/generate")
        mid = self.match_list(category_id=fx['team_cat'])[0]['id']
        package = self.ok('GET', f'/api/scoring/match/{mid}')['match']
        self.assertFalse(package['can_score'])
        self.assertIn('确认', package['blocked_reason'])
        self.assertFalse(self.match_list(category_id=fx['team_cat'])[0]['scoreable'])
        self.err('POST', f'/api/recording/match/{mid}/claim', {}, expect=409, code='plan_not_locked')
        manual = self.ok('POST', '/api/matches', {'category_id': fx['team_cat'],
            'home_participation': fx['team_parts'][0], 'away_participation': fx['team_parts'][1]})['match_id']
        self.assertTrue(self.ok('GET', f'/api/scoring/match/{manual}')['match']['can_score'])
        self.play(manual, [(15, 0), (15, 0)])
        self.assertFalse(self.ok('GET', f'/api/scoring/match/{mid}')['match']['can_score'],
                         '手工比赛不能令同方案内的自动预览场次生效')
        self.err('POST', f'/api/recording/match/{mid}/claim', {}, expect=409, code='plan_not_locked')
        rejected = self.play(mid, [(15, 0), (15, 0)], expect=409)
        self.assertEqual(rejected['code'], 'plan_not_locked')
        self.fixture_schedule('POST', f"/api/plans/{plan['plan_id']}/lock")
        self.ok('POST', f'/api/recording/match/{mid}/claim', {})
        self.assertTrue(self.ok('GET', f'/api/scoring/match/{mid}')['match']['can_score'])

    def test_organizer_schedule_collisions_and_atomic_bulk(self):
        fx = self.build_event(team_count=4, individual_count=0)
        venue = self.ok('POST', f"/api/events/{fx['event_id']}/venues", {'name': '场地一'})['venue_id']
        other_venue = self.ok('POST', f"/api/events/{fx['event_id']}/venues", {'name': '场地二'})['venue_id']

        def create(a, b, **extra):
            return self.ok('POST', '/api/matches', {'category_id': fx['team_cat'],
                'home_participation': fx['team_parts'][a], 'away_participation': fx['team_parts'][b], **extra})['match_id']

        one = create(0, 1, venue_id=venue, scheduled_at='2026-10-07T08:00')
        self.assertTrue(self.ok('GET', f'/api/scoring/match/{one}')['match']['can_score'], '手工比赛仍可直接开赛')
        two = create(2, 3)
        self.err('PUT', f'/api/matches/{two}', {'venue_id': venue, 'scheduled_at': '2026-10-07 08:00'},
                 expect=409, code='schedule_conflict')
        three = create(0, 1, venue_id=other_venue, scheduled_at='2026-10-07 09:30')
        self.err('PUT', f'/api/matches/{three}', {'scheduled_at': '2026-10-07 08:00'},
                 expect=409, code='schedule_conflict')
        before = self.match_list(category_id=fx['team_cat'])
        self.err('POST', '/api/matches', {'category_id': fx['team_cat'],
            'home_participation': fx['team_parts'][2], 'away_participation': fx['team_parts'][3],
            'venue_id': venue, 'scheduled_at': '2026-10-07 08:00'}, expect=409, code='schedule_conflict')
        self.assertEqual(len(self.match_list(category_id=fx['team_cat'])), len(before))
        self.err('POST', '/api/matches/bulk-schedule', {'match_ids': [one, two], 'venue_id': other_venue,
            'start_at': '2026-10-07 09:00', 'interval_minutes': 30}, expect=409, code='schedule_conflict')
        after = {r['id']: r for r in self.match_list(category_id=fx['team_cat'])}
        self.assertEqual(after[one]['scheduled_at'], '2026-10-07 08:00')
        self.assertEqual(after[two]['scheduled_at'], '')
        self.ok('POST', '/api/matches/bulk-schedule', {'match_ids': [one, two], 'venue_id': other_venue,
            'start_at': '2026-10-07 10:00', 'interval_minutes': 30})
        changed = self.ok('PUT', f'/api/matches/{two}', {'scheduled_at': ''})['match']
        self.assertEqual(changed['scheduled_at'], '')
        self.assertEqual(changed['venue_id'], other_venue)
        ordered = self.match_list(category_id=fx['team_cat'])
        self.assertEqual(ordered[-1]['id'], two, '未安排时间的场次统一置后')

    def test_organizer_knockout_and_dependency_schedule(self):
        fx = self.build_event(team_count=4, individual_count=0)
        plan = self.fixture_schedule('POST', f"/api/categories/{fx['team_cat']}/plan", {'stages': [
            {'kind': 'round_robin', 'name': '小组赛', 'params': {'pool_count': 2}},
            {'kind': 'single_elim', 'name': '淘汰赛', 'params': {'third_place': True, 'sources': [
                {'type': 'pool_rank', 'stage': 1, 'pool': p, 'rank': r} for r in (1, 2) for p in (0, 1)]}}]})
        self.fixture_schedule('POST', f"/api/plans/{plan['plan_id']}/generate")
        self.fixture_schedule('POST', f"/api/plans/{plan['plan_id']}/lock")
        full = self.ok('GET', f"/api/plans/{plan['plan_id']}")['plan']
        bracket = full['stages'][1]['pools'][0]['id']
        self.err('GET', f'/api/pools/{bracket}/standings', code='not_standings_pool')
        self.err('POST', f'/api/pools/{bracket}/lots', {'order': fx['team_parts']}, code='not_standings_pool')
        self.err('POST', f'/api/pools/{bracket}/confirm', {}, code='not_standings_pool')
        matches = self.match_list(category_id=fx['team_cat'])
        group_matches = [m for m in matches if m['stage_id'] == full['stages'][0]['id']]
        for m in group_matches:
            self.ok('PUT', f"/api/matches/{m['id']}", {'scheduled_at': '2026-10-07 09:00'})
        semifinal = next(m for m in matches if m['home']['type'] == 'pool_rank')
        self.err('PUT', f"/api/matches/{semifinal['id']}", {'scheduled_at': '2026-10-07 08:30'},
                 expect=409, code='schedule_dependency_conflict')
        self.ok('PUT', f"/api/matches/{semifinal['id']}", {'scheduled_at': '2026-10-07 11:00'})
        self.err('PUT', f"/api/matches/{group_matches[0]['id']}", {'scheduled_at': '2026-10-07 12:00'},
                 expect=409, code='schedule_dependency_conflict')

    def test_organizer_completion_correction_and_export_notes(self):
        fx = self.build_event(team_count=2, individual_count=2)
        mid = self.ok('POST', '/api/matches', {'category_id': fx['team_cat'],
            'home_participation': fx['team_parts'][0], 'away_participation': fx['team_parts'][1],
            'note': '裁判手工说明'})['match_id']
        self.play(mid, [(15, 0), (15, 0)])
        self.assertEqual(self.ok('GET', f'/api/matches/{mid}')['match']['note'], '裁判手工说明')
        for rank, pid in enumerate(fx['team_parts'], 1):
            self.ok('POST', f"/api/categories/{fx['team_cat']}/placements", {'participation_id': pid, 'rank_no': rank})
        for i, pid in enumerate(fx['indiv_parts']):
            reviewed_result(self, 'POST', '/api/scoring/individual', {'submission_uid': f'audit-ind-{pid}',
                'participation_id': pid, 'base_version': 0, 'result_value': 20-i,
                'error_count': 0, 'violation_count': 0, 'result_status': 'normal'}, expected=200)
        def category(cid):
            data = self.ok('GET', f"/api/events/{fx['event_id']}/dashboard")
            return next(c for g in data['groups'] for c in g['categories'] if c['id'] == cid)
        self.assertTrue(category(fx['team_cat'])['completed'])
        self.assertEqual(category(fx['indiv_cat'])['individual_confirmed'], 2)
        self.assertFalse(category(fx['indiv_cat'])['completed'])
        self.ok('POST', f"/api/categories/{fx['indiv_cat']}/individual-rankings/confirm", {})
        self.assertTrue(category(fx['indiv_cat'])['completed'])
        reviewed_result(self, 'POST', '/api/scoring/individual', {'submission_uid': f"audit-correction-{fx['indiv_parts'][0]}",
            'participation_id': fx['indiv_parts'][0], 'base_version': 1, 'result_value': 22,
            'error_count': 0, 'violation_count': 0, 'result_status': 'normal', 'reason': '核对原始记录'}, expected=200)
        self.assertFalse(category(fx['indiv_cat'])['completed'], '更正后需要重新确认名次')
        self.ok('PUT', f'/api/matches/{mid}', {'note': '等待前序场次结果确认'})
        self.assertEqual(self.ok('GET', f'/api/matches/{mid}')['match']['note'], '')
        status, data = self.request('GET', f"/api/exports/schedule.csv?event_id={fx['event_id']}", raw=True)
        self.assertEqual(status, 200)
        self.assertNotIn('等待前序场次结果确认', data.decode('utf-8-sig'))


    def test_result_receipts_survive_reassignment_and_later_versions(self):
        """Real event-scoped HTTP acknowledgments keep the original UID and version."""
        self.use_event_database = True
        fx = self.build_event(team_count=2, individual_count=0)
        mid = self.ok('POST', '/api/matches', {'category_id': fx['team_cat'],
            'home_participation': fx['team_parts'][0], 'away_participation': fx['team_parts'][1]})['match_id']
        recorder = self.make_user('recorder')
        other = self.make_user('recorder')
        self.ok('POST', f'/api/recording/match/{mid}/claim', {}, token=recorder)
        sets = [{'set_no': i, 'home_points': 15, 'away_points': 5, 'winner_side': 'home'} for i in (1, 2)]
        package = {'submission_uid': f'receipt-score-{mid}', 'match_id': mid, 'base_version': 0,
                   'result_status': 'normal', 'sets': sets, 'events': self.events_for(sets),
                   'event_identity': dict(self.event_identity), **self.lineup_for(mid)}
        saved = reviewed_result(self, 'POST', '/api/scoring/submit', package, token=recorder, expected=200)
        original_receipt = saved['receipt']
        self.assertEqual(original_receipt['applied_version'], 1)
        conn = db.connect(db.event_db_path(fx['event_id']))
        try:
            other_id = self.ok('GET', '/api/me', token=other)['user']['id']
            db.run(conn, 'UPDATE settings SET v=? WHERE k=?',
                   (json.dumps({'user_id': other_id}), f'recording:match:{mid}'))
        finally:
            conn.close()
        # Original candidate retries remain readable after transfer, independently
        # of formal decision receipts belonging to the independent reviewer.
        replayed = reviewed_result(self, 'POST', '/api/scoring/submit', package, token=recorder, expected=200)
        self.assertEqual(replayed['receipt'], original_receipt)
        queried = self.ok('GET', f"/api/candidate-receipts/{package['submission_uid']}", token=recorder)
        self.assertEqual(queried['receipt'], saved['candidate_receipt'])
        self.assertFalse(self.ok('GET', f"/api/candidate-receipts/{package['submission_uid']}", token=other)['found'])
        correction = {'request_uid': f'receipt-correct-{mid}', 'base_version': 1, 'reason': 'review',
                      'event_identity': dict(self.event_identity), 'result_status': 'away_forfeit',
                      'sets': [], 'events': []}
        corrected = reviewed_result(self, 'POST', f'/api/matches/{mid}/correction', correction, expected=200)
        reviewed_result(self, 'POST', f'/api/matches/{mid}/cancel', {'request_uid': f'receipt-cancel-{mid}',
            'base_version': 2, 'reason': 'cancel', 'event_identity': dict(self.event_identity)}, expected=200)
        replay = reviewed_result(self, 'POST', f'/api/matches/{mid}/correction', correction, expected=200)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['receipt'], corrected['receipt'])
        self.assertEqual(replay['receipt']['applied_version'], 2)
        self.assertEqual(self.ok('GET', f'/api/matches/{mid}')['match']['result_version'], 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
