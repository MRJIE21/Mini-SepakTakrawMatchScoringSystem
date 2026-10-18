"""HTTP checks for live snapshots feeding the display state."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="stss-display-live-"))

from app import access, config, db, security  # noqa: E402
from app.http_server import Handler, create_server, load_routes  # noqa: E402

load_routes()


def insert_fixture(conn):
    conn.execute("INSERT INTO events(id, uuid, name) VALUES(1, ?, ?)",
                 ("event-uuid-live", "直播测试赛事"))
    conn.execute("INSERT INTO groups(id, event_id, code, name, seq) VALUES(1, 1, 'A', '甲组', 1)")
    conn.execute("INSERT INTO categories(id, group_id, gender, kind, name, seq) "
                 "VALUES(1, 1, 'male', 'team', '男子三人赛', 1)")
    conn.execute("INSERT INTO schools(id, event_id, name, short_name) VALUES(1, 1, '机械学院', '机械')")
    conn.execute("INSERT INTO schools(id, event_id, name, short_name) VALUES(2, 1, '电气学院', '电气')")
    conn.execute("INSERT INTO teams(id, category_id, school_id, name) VALUES(1, 1, 1, '机械学院')")
    conn.execute("INSERT INTO teams(id, category_id, school_id, name) VALUES(2, 1, 2, '电气学院')")
    conn.execute("INSERT INTO participations(id, category_id, team_id) VALUES(1, 1, 1)")
    conn.execute("INSERT INTO participations(id, category_id, team_id) VALUES(2, 1, 2)")
    conn.execute("INSERT INTO plans(id, category_id, name, status, version) VALUES(1, 1, '默认方案', 'locked', 1)")
    conn.execute(
        "INSERT INTO matches(id, category_id, plan_id, plan_version, seq, round_no, round_label, "
        "home_source_type, home_participation, away_source_type, away_participation, "
        "home_actual, away_actual, status) "
        "VALUES(1, 1, 1, 1, 1, 1, '决赛', 'participation', 1, 'participation', 2, 1, 2, 'ready')")
    conn.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('recording:match:1', ?)",
                 (json.dumps({"user_id": 2}),))


@unittest.skipIf(os.environ.get("STSS_COMBINED_SUITE") == "1",
                 "display HTTP tests run in an isolated process")
class DisplayLiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config.DATA_DIR = TMP
        config.DB_PATH = TMP / "registry.db"
        config.EVENTS_DIR = TMP / "events"
        config.EVENTS_DIR.mkdir(parents=True, exist_ok=True)
        db.init_db()
        event_path = config.EVENTS_DIR / "event_1.db"
        db.init_db(event_path)
        registry = db.connect()
        event = db.connect(event_path)
        try:
            insert_fixture(registry)
            insert_fixture(event)
            security.create_user(registry, "admin", "admin123", "admin", "管理员")
            security.create_user(event, "admin", "admin123", "admin", "管理员")
            security.create_user(registry, "recorder", "recorder123", "recorder", "记录员")
            security.create_user(event, "recorder", "recorder123", "recorder", "记录员")
            access.set_events(registry, 2, [1])
        finally:
            registry.close()
            event.close()
        cls.server = create_server(("127.0.0.1", 0), Handler, background_sync=False)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.base = f"http://127.0.0.1:{self.port}"
        self.admin = self.login("admin", "admin123")
        self.recorder = self.login("recorder", "recorder123")

    def login(self, username, password):
        return self.request("POST", "/api/login", {"username": username, "password": password}, token="")["token"]

    def request(self, method, path, body=None, token=None, headers=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Client-Protocol", "2")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            payload = json.loads(exc.read().decode("utf-8") or "{}")
            payload["_status"] = exc.code
            return payload

    def pair_display(self):
        started = self.request("POST", "/api/display/pair/start", {"device_secret": "device-secret-live-123"})
        claimed = self.request("POST", "/api/display/pair/claim",
                               {"code": started["code"], "event_id": 1, "name": "1 号屏"}, token=self.admin)
        status = self.request(
            "GET", f"/api/display/pair/status?id={started['id']}&device_secret=device-secret-live-123")
        return claimed, status["token"]

    def test_live_snapshot_updates_state_and_marks_stale(self):
        claimed, display_token = self.pair_display()
        published = self.request("POST", "/api/display/publish", {
            "event_id": 1, "layout": 1, "mode": "score",
            "slots": [{"match_id": 1, "label": "1 号场"}],
            "visible_slots": [0],
        }, token=self.admin)
        self.assertEqual(published["config"]["layout"], 1)

        synced = self.request("POST", "/api/display/live", {
            "match_id": 1, "event_seq": 1, "status": "live", "current_set": 1,
            "home_points": 5, "away_points": 3, "home_sets": 0, "away_sets": 0,
            "sets": [{"set_no": 1, "home_points": 5, "away_points": 3, "winner_side": ""}],
            "draft_uid": "draft-1", "lineup_hash": "lineup-1",
        }, token=self.recorder, headers={"X-Event-ID": "1"})
        self.assertEqual(synced["home_points"], 5)

        state = self.request("GET", "/api/display/state",
                             headers={"Authorization": f"Display {display_token}"})
        tile = state["slots"][0]
        self.assertEqual(tile["match_id"], 1)
        self.assertEqual(tile["status"], "live")
        self.assertEqual(tile["home"]["name"], "机械")
        self.assertEqual(tile["away"]["name"], "电气")
        self.assertEqual(tile["home"]["points"], 5)
        self.assertEqual(tile["away"]["points"], 3)
        self.assertEqual(tile["sets"][0]["label"], "第1局 5:3")
        self.assertEqual(state["visible_slots"], [0])
        self.assertEqual(state["poll_ms"], 500)

        event = db.connect(config.EVENTS_DIR / "event_1.db", existing=True)
        try:
            db.run(event, "UPDATE display_live SET expires_at = '2000-01-01 00:00:00' WHERE match_id = 1")
        finally:
            event.close()
        stale = self.request("GET", "/api/display/state",
                             headers={"Authorization": f"Display {display_token}"})
        self.assertEqual(stale["slots"][0]["status"], "stale")
        self.assertEqual(stale["slots"][0]["home"]["points"], 5)

        event = db.connect(config.EVENTS_DIR / "event_1.db", existing=True)
        try:
            db.run(event, "UPDATE matches SET status='finished', result_status='normal', result_version=1 "
                          "WHERE id = 1")
            db.insert(event, "match_sets", {"match_id": 1, "set_no": 1, "home_points": 15,
                                            "away_points": 9, "winner_side": "home"})
            db.insert(event, "match_sets", {"match_id": 1, "set_no": 2, "home_points": 15,
                                            "away_points": 9, "winner_side": "home"})
        finally:
            event.close()
        finished = self.request("GET", "/api/display/state",
                                headers={"Authorization": f"Display {display_token}"})
        tile = finished["slots"][0]
        self.assertEqual(tile["status"], "finished")
        self.assertEqual(tile["home"]["sets"], 2)
        self.assertEqual(tile["away"]["sets"], 0)
        self.assertEqual(tile["home"]["points"], 15)
        self.assertEqual(tile["away"]["points"], 9)
        self.assertEqual(tile["sets"][0]["label"], "第1局 15:9")
        self.assertEqual(tile["sets"][0]["state"], "done")


if __name__ == "__main__":
    unittest.main()
