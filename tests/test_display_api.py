"""HTTP checks for display pairing, state, publish and credential isolation."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="stss-display-api-"))

from app import config, db, display_store, security  # noqa: E402
from app.http_server import Handler, create_server, load_routes  # noqa: E402

load_routes()


@unittest.skipIf(os.environ.get("STSS_COMBINED_SUITE") == "1",
                 "display HTTP tests run in an isolated process")
class DisplayApiTest(unittest.TestCase):
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
                             ("event-uuid-display", "大屏测试赛事"))
            security.create_user(registry, "admin", "admin123", "admin", "管理员")
            security.create_user(event, "admin", "admin123", "admin", "管理员")
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
        display_store.reset_rate_limits()
        self.base = f"http://127.0.0.1:{self.port}"
        self.token = self.request("POST", "/api/login",
                                  {"username": "admin", "password": "admin123"}, token="")["token"]

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

    def test_pair_publish_state_revoke(self):
        start = self.request("POST", "/api/display/pair/start", {"device_secret": "device-secret-123456"})
        self.assertEqual(start["code"].__len__(), 6)
        code = start["code"]
        pending = self.request("GET",
                               f"/api/display/pair/status?id={start['id']}&device_secret=device-secret-123456")
        self.assertEqual(pending["status"], "pending")
        wrong = self.request("GET",
                             f"/api/display/pair/status?id={start['id']}&device_secret=wrong-device-secret")
        self.assertEqual(wrong.get("_status"), 400)

        claimed = self.request("POST", "/api/display/pair/claim",
                               {"code": code, "event_id": 1, "name": "1 号屏"}, token=self.token)
        self.assertTrue(claimed["screen"]["id"])
        status = self.request("GET",
                              f"/api/display/pair/status?id={start['id']}&device_secret=device-secret-123456")
        self.assertEqual(status["status"], "claimed")
        display_token = status["token"]

        state = self.request("GET", "/api/display/state", headers={"Authorization": f"Display {display_token}"})
        self.assertTrue(state["ok"])
        self.assertEqual(state["layout"], 8)
        self.assertEqual(state["mode"], "score")
        self.assertEqual(state["poll_ms"], 500)

        forbidden = self.request("GET", "/api/events", headers={"Authorization": f"Display {display_token}"})
        self.assertEqual(forbidden.get("_status"), 403)

        published = self.request("POST", "/api/display/publish", {
            "event_id": 1, "layout": 4, "mode": "announce", "poll_ms": 250,
            "slots": [], "visible_slots": [0, 1, 2, 3],
            "announcement_title": "请检录", "announcement_body": "下一场 10 分钟后开始",
        }, token=self.token)
        self.assertEqual(published["config"]["layout"], 4)
        self.assertEqual(published["config"]["poll_ms"], 250)
        self.assertEqual(published["config"]["revision"], 1)

        state = self.request("GET", "/api/display/state", headers={"Authorization": f"Display {display_token}"})
        self.assertEqual(state["layout"], 4)
        self.assertEqual(state["mode"], "announce")
        self.assertEqual(state["poll_ms"], 250)
        self.assertEqual(state["announcement"]["title"], "请检录")

        console = self.request("GET", "/api/display/console?event_id=1", token=self.token)
        self.assertEqual(len(console["screens"]), 1)
        self.assertEqual(console["config"]["layout"], 4)
        self.assertTrue(console["screens"][0]["online"])

        preview = self.request("GET", "/api/display/preview?event_id=1", token=self.token)
        self.assertTrue(preview["ok"])
        self.assertEqual(preview["layout"], 4)
        self.assertEqual(preview["mode"], "announce")
        forbidden_preview = self.request(
            "GET", "/api/display/preview?event_id=1",
            headers={"Authorization": f"Display {display_token}"})
        self.assertEqual(forbidden_preview.get("_status"), 403)

        self.request("POST", "/api/display/revoke", {"screen_id": claimed["screen"]["id"]}, token=self.token)
        revoked = self.request("GET", "/api/display/state", headers={"Authorization": f"Display {display_token}"})
        self.assertEqual(revoked.get("_status"), 401)

    def test_pair_start_is_rate_limited(self):
        statuses = []
        for index in range(6):
            result = self.request("POST", "/api/display/pair/start",
                                  {"device_secret": f"rate-limit-device-{index}-abcdef"})
            statuses.append(result)
        self.assertEqual([item.get("_status", 200) for item in statuses[:5]], [200] * 5)
        self.assertEqual(statuses[5].get("_status"), 429)
        self.assertEqual(statuses[5]["code"], "rate_limited")


if __name__ == "__main__":
    unittest.main()
