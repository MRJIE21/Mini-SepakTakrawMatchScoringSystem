"""历史赛程数据经正式读取接口回放的回归用例（FIX-11 / R-P3-03）。

背景：上一轮回归审计发现 34/530 个测试方法依赖
``tests/helpers/historical_schedule.py`` 直接写 SQLite 构造历史 ``/plan`` 数据，
而真实生产写接口 ``/api/categories/{id}/plan`` 已退役（410 planner_retired）。
本用例在夹具构造历史数据后，通过**正式读取接口**（而非直读数据库）验证
历史方案、阶段、小组与场次仍可被 1.5.0 正常读取，弥补"测试通过但 HTTP
读取路径无人覆盖"的盲区。

本文件不依赖 test_api.ApiTest（避免继承其全部用例重复执行），
自带隔离数据目录、真实 HTTP 服务与管理员会话。
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TMP = Path(os.environ["STSS_TEST_DATA_DIR"]) if os.environ.get("STSS_TEST_DATA_DIR") \
    else Path(tempfile.mkdtemp(prefix="stss_hist_read_"))
TMP.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("STSS_DATA_DIR", str(TMP))
os.environ.setdefault("STSS_DB", str(TMP / "registry.db"))
os.environ.setdefault("STSS_EVENTS_DIR", str(TMP / "events"))
os.environ.setdefault("STSS_ADMIN_PASSWORD", "admin123")

from app import config, db, security  # noqa: E402
from app.http_server import Handler, create_server, load_routes  # noqa: E402
from helpers.historical_schedule import fixture_schedule  # noqa: E402

load_routes()


class HistoricalPlanReadbackTest(unittest.TestCase):
    """历史 plan 数据 -> 官方读取接口的兼容性回放。"""

    fixture_schedule = fixture_schedule

    @classmethod
    def setUpClass(cls):
        db.init_db()
        conn = db.connect()
        try:
            security.ensure_default_users(conn)
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
        self.base = f"http://127.0.0.1:{self.port}"
        self.event_headers = {}
        parsed = self.request("POST", "/api/login",
                              {"username": "admin", "password": "admin123"},
                              token="", expect=200)
        self.token = parsed["token"]

    def request(self, method, path, body=None, token=None, expect=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Client-Protocol", "3")
        for key, value in self.event_headers.items():
            req.add_header(key, value)
        tok = self.token if token is None else (token or None)
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        try:
            with urllib.request.urlopen(req) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                status = resp.status
        except urllib.error.HTTPError as exc:
            payload = json.loads(exc.read().decode("utf-8"))
            status = exc.code
        if expect is not None:
            self.assertEqual(status, expect, f"{method} {path} -> {payload}")
        return payload

    def ok(self, method, path, body=None):
        return self.request(method, path, body, expect=200)

    def test_historical_plan_readable_through_http_read_apis(self):
        event = self.ok("POST", "/api/events", {"name": "历史回放赛", "start_date": "2026-09-20"})
        event_id = event["event_id"]
        self.event_headers = {"X-Event-ID": str(event_id), "X-Event-UUID": event["event_uuid"]}
        self.ok("POST", f"/api/events/{event_id}/bootstrap")
        structure = self.ok("GET", f"/api/events/{event_id}/structure")
        group_a = structure["groups"][0]
        cats = {(c["gender"], c["kind"]): c["id"] for c in group_a["categories"]}
        team_cat = cats[("male", "team")]
        for i in range(2):
            school = self.ok("POST", f"/api/events/{event_id}/schools",
                             {"name": f"历史{i + 1}校", "short_name": f"历{i + 1}",
                              "group_id": group_a["id"]})
            team = self.ok("POST", f"/api/categories/{team_cat}/teams",
                           {"school_id": school["school_id"], "name": f"历{i + 1}队"})
            self.ok("POST", f"/api/categories/{team_cat}/participations",
                    {"team_id": team["team_id"], "seed_no": i + 1})

        # 夹具：直接写 SQLite 构造历史 /plan 数据（模拟旧版本库）
        plan_id = self.fixture_schedule(
            "POST", f"/api/categories/{team_cat}/plan",
            {"name": "历史数据回放", "stages": [
                {"kind": "round_robin", "name": "历史单循环", "params": {}}]})["plan_id"]
        self.fixture_schedule("POST", f"/api/plans/{plan_id}/generate")

        # 1) 项目赛程读取接口能看到历史方案与阶段
        plan = self.ok("GET", f"/api/categories/{team_cat}/plan")["plan"]
        self.assertEqual(plan["id"], plan_id)
        self.assertEqual(len(plan["stages"]), 1)
        self.assertEqual(plan["stages"][0]["kind"], "round_robin")
        self.assertTrue(plan["stages"][0]["pools"], "历史阶段应包含小组")
        # 2) 方案详情读取接口可用
        detail = self.ok("GET", f"/api/plans/{plan_id}")["plan"]
        self.assertEqual(detail["id"], plan_id)
        self.assertEqual(len(detail["stages"]), 1)
        # 3) 场次列表读取接口能看到历史生成的场次
        matches = self.ok("GET", f"/api/matches?category_id={team_cat}")["matches"]
        self.assertGreaterEqual(len(matches), 1)
        self.assertTrue(all(m["category_id"] == team_cat for m in matches))
        # 4) 赛程读取接口可用且不抛异常
        schedule = self.ok("GET", f"/api/categories/{team_cat}/schedule")
        self.assertEqual(schedule["category"]["id"], team_cat)


if __name__ == "__main__":
    unittest.main()
