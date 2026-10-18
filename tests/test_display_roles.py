"""Role-boundary checks for the dedicated display operator."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="stss-display-role-"))

from app import access, config, db, security  # noqa: E402
from app.http_server import Handler, create_server, load_routes  # noqa: E402

load_routes()


@unittest.skipIf(os.environ.get("STSS_COMBINED_SUITE") == "1",
                 "display HTTP tests run in an isolated process")
class DisplayOperatorRoleTest(unittest.TestCase):
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
            for conn in (registry, event):
                conn.execute("INSERT INTO events(id, uuid, name) VALUES(1, ?, ?)",
                             ("event-uuid-role", "大屏角色测试赛事"))
            security.create_user(registry, "admin", "admin123", "admin", "管理员")
            security.create_user(event, "admin", "admin123", "admin", "管理员")
            security.create_user(registry, "screenop", "screen123", "display_operator", "大屏操作员")
            security.create_user(event, "screenop", "screen123", "display_operator", "大屏操作员")
            security.create_user(registry, "viewer", "viewer123", "viewer", "查看者")
            security.create_user(event, "viewer", "viewer123", "viewer", "查看者")
            security.create_user(registry, "unassigned", "screen123", "display_operator", "未分配操作员")
            security.create_user(event, "unassigned", "screen123", "display_operator", "未分配操作员")
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
        from app import display_store
        display_store.reset_rate_limits()
        self.base = f"http://127.0.0.1:{self.port}"
        self.admin = self.login("admin", "admin123")
        self.operator = self.login("screenop", "screen123")
        self.viewer = self.login("viewer", "viewer123")

    def login(self, username, password):
        return self.request("POST", "/api/login", {"username": username, "password": password})["token"]

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

    def event_headers(self):
        return {"X-Event-ID": "1"}

    def test_operator_can_control_assigned_event_only(self):
        console = self.request("GET", "/api/display/console?event_id=1", token=self.operator)
        self.assertEqual(console["config"]["layout"], 8)

        preview = self.request("GET", "/api/display/preview?event_id=1", token=self.operator)
        self.assertTrue(preview["ok"])

        published = self.request("POST", "/api/display/publish", {
            "event_id": 1, "layout": 1, "mode": "score", "poll_ms": 250,
            "slots": [], "visible_slots": [0],
        }, token=self.operator)
        self.assertEqual(published["config"]["layout"], 1)

        matches = self.request("GET", "/api/matches?kind=team&limit=10", token=self.operator,
                               headers=self.event_headers())
        self.assertIn("matches", matches)
        events = self.request("GET", "/api/events", token=self.operator)
        self.assertEqual([item["id"] for item in events["events"]], [1])

        started = self.request("POST", "/api/display/pair/start",
                               {"device_secret": "operator-device-secret-123"})
        claimed = self.request("POST", "/api/display/pair/claim",
                               {"code": started["code"], "event_id": 1, "name": "操作员屏"},
                               token=self.operator)
        self.assertTrue(claimed["screen"]["id"])
        revoked = self.request("POST", "/api/display/revoke",
                               {"screen_id": claimed["screen"]["id"]}, token=self.operator)
        self.assertTrue(revoked["revoked"])

    def test_operator_cannot_score_or_manage_accounts(self):
        live = self.request("POST", "/api/display/live", {
            "match_id": 1, "event_seq": 1,
        }, token=self.operator, headers=self.event_headers())
        self.assertEqual(live.get("_status"), 403)
        users = self.request("GET", "/api/users", token=self.operator)
        self.assertEqual(users.get("_status"), 403)

    def test_unassigned_operator_and_viewer_are_rejected(self):
        unassigned = self.login("unassigned", "screen123")
        denied = self.request("GET", "/api/display/console?event_id=1", token=unassigned)
        self.assertEqual(denied.get("_status"), 403)
        viewer_console = self.request("GET", "/api/display/console?event_id=1", token=self.viewer)
        self.assertEqual(viewer_console.get("_status"), 403)
        viewer_publish = self.request("POST", "/api/display/publish", {
            "event_id": 1, "layout": 1, "slots": [], "visible_slots": [0],
        }, token=self.viewer)
        self.assertEqual(viewer_publish.get("_status"), 403)


if __name__ == "__main__":
    unittest.main()
