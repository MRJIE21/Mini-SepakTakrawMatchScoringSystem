"""Unit checks for the live-display store (screens, pairing, config)."""
import json
import tempfile
import unittest
from pathlib import Path

from app import db, display_store
from app.errors import ApiError
from helpers.backups import find_backup


class DisplayStoreTest(unittest.TestCase):
    def setUp(self):
        display_store.reset_rate_limits()
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-display-store-")
        self.path = Path(self.tmp.name) / "display.db"
        db.init_db(self.path)
        self.conn = db.connect(self.path)
        self.conn.execute("INSERT INTO events(id, uuid, name) VALUES(1, ?, ?)",
                          ("event-uuid-1", "测试赛事"))
        self.conn.execute(
            "INSERT INTO users(id, username, password_hash, salt, display_name, role, active) "
            "VALUES(7, 'display-admin', 'x', 'x', '大屏管理员', 'admin', 1)")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_config_default_and_publish(self):
        config = display_store.get_config(self.conn)
        self.assertEqual(config["layout"], 8)
        self.assertEqual(config["revision"], 0)
        self.assertEqual(config["poll_ms"], 500)
        self.assertEqual(config["slots"], [None] * 8)

        published = display_store.publish_config(self.conn, 7, {
            "layout": 2, "mode": "score", "poll_ms": 250,
            "slots": [{"match_id": 11, "label": "1 号场"}, None, {"match_id": 12, "label": ""}],
            "visible_slots": [2, 0],
            "announcement_title": "", "announcement_body": "",
        })
        self.assertEqual(published["layout"], 2)
        self.assertEqual(published["poll_ms"], 250)
        self.assertEqual(published["revision"], 1)
        self.assertEqual(published["visible_slots"], [0, 2])
        self.assertEqual(published["slots"][0]["match_id"], 11)
        self.assertEqual(published["slots"][2]["match_id"], 12)
        self.assertEqual(published["updated_by"], 7)

        second = display_store.publish_config(self.conn, 7, {
            "layout": 8, "mode": "announce",
            "announcement_title": "请各队检录", "announcement_body": "下一场 10 分钟后开始",
        })
        self.assertEqual(second["layout"], 8)
        self.assertEqual(second["visible_slots"], list(range(8)))
        self.assertEqual(second["revision"], 2)
        self.assertEqual(second["mode"], "announce")
        self.assertEqual(second["poll_ms"], 250)

    def test_config_rejects_invalid_slots(self):
        with self.assertRaises(ApiError):
            display_store.publish_config(self.conn, 1, {"layout": 5})
        with self.assertRaises(ApiError):
            display_store.publish_config(self.conn, 1, {"layout": 4, "visible_slots": [0, 1]})
        with self.assertRaises(ApiError):
            display_store.publish_config(self.conn, 1, {
                "layout": 8, "slots": [{"match_id": 3}, {"match_id": 3}]})
        with self.assertRaises(ApiError):
            display_store.publish_config(self.conn, 1, {"layout": 1, "visible_slots": [9]})
        for poll_ms in (99, 1001, "fast"):
            with self.assertRaises(ApiError):
                display_store.publish_config(self.conn, 1, {"layout": 1, "poll_ms": poll_ms})
        accepted = display_store.publish_config(self.conn, 7, {"layout": 1, "poll_ms": 100})
        self.assertEqual(accepted["poll_ms"], 100)
        accepted = display_store.publish_config(self.conn, 7, {"layout": 1, "poll_ms": 1000})
        self.assertEqual(accepted["poll_ms"], 1000)

    def test_screen_token_and_revoke(self):
        screen = display_store.create_screen(self.conn, 1, "1 号屏")
        self.assertTrue(screen["token"])
        found = display_store.screen_for_token(self.conn, screen["token"])
        self.assertIsNotNone(found)
        self.assertEqual(found["id"], screen["id"])
        self.assertEqual(found["event_id"], 1)
        self.assertIsNone(display_store.screen_for_token(self.conn, "wrong-token"))
        display_store.revoke_screen(self.conn, screen["id"])
        self.assertIsNone(display_store.screen_for_token(self.conn, screen["token"]))

    def test_pair_flow_and_expiry(self):
        secret = "device-secret-123456"
        started = display_store.start_pair(self.conn, secret)
        self.assertEqual(len(started["code"]), 6)
        self.assertEqual(display_store.pair_status(self.conn, started["id"], secret)["status"], "pending")
        with self.assertRaises(ApiError):
            display_store.pair_status(self.conn, started["id"], "other-device-secret")

        claimed = display_store.claim_pair(self.conn, started["code"], 1, "体育馆大屏")
        self.assertTrue(claimed["token"])
        status = display_store.pair_status(self.conn, started["id"], secret)
        self.assertEqual(status["status"], "claimed")
        self.assertEqual(status["token"], claimed["token"])
        self.assertEqual(display_store.screen_for_token(self.conn, claimed["token"])["name"], "体育馆大屏")
        with self.assertRaises(ApiError):
            display_store.claim_pair(self.conn, started["code"], 1, "重复")

        expired = display_store.start_pair(self.conn, "device-secret-expired")
        db.run(self.conn, "UPDATE display_pair_codes SET expires_at = '2000-01-01 00:00:00', "
                          "expires_at_epoch = 0 WHERE id = ?",
               (expired["id"],))
        with self.assertRaises(ApiError) as ctx:
            display_store.claim_pair(self.conn, expired["code"], 1, "过期屏")
        self.assertEqual(ctx.exception.code, "pair_expired")

    def test_pair_rate_limit_and_online_status(self):
        ip = "203.0.113.10"
        starts = [display_store.start_pair(self.conn, f"device-secret-{index}-abcdef",
                                           client_ip=ip) for index in range(5)]
        with self.assertRaises(ApiError) as ctx:
            display_store.start_pair(self.conn, "device-secret-over-limit", client_ip=ip)
        self.assertEqual(ctx.exception.status, 429)
        self.assertEqual(ctx.exception.code, "rate_limited")
        other = display_store.start_pair(self.conn, "device-secret-other-ip", client_ip="203.0.113.11")
        self.assertEqual(len(other["code"]), 6)

        claimed = display_store.claim_pair(self.conn, starts[0]["code"], 1, "1 号屏",
                                            user_id=7, client_ip=ip)
        screen = display_store.screen_by_id(self.conn, claimed["screen"]["id"])
        self.assertFalse(display_store.screen_online(screen))
        self.assertIsNotNone(display_store.screen_for_token(self.conn, claimed["token"]))
        self.assertTrue(display_store.screen_online(display_store.screen_by_id(
            self.conn, claimed["screen"]["id"])))
        db.run(self.conn, "UPDATE display_screens SET last_seen_at = '2000-01-01 00:00:00', "
                          "last_seen_epoch = 0 WHERE id = ?",
               (claimed["screen"]["id"],))
        self.assertFalse(display_store.screen_online(display_store.screen_by_id(
            self.conn, claimed["screen"]["id"])))

    def test_claim_replaces_previous_active_screen(self):
        first = display_store.start_pair(self.conn, "device-secret-first-123",
                                         client_ip="198.51.100.1")
        claimed_first = display_store.claim_pair(self.conn, first["code"], 1, "旧屏",
                                                  user_id=7, client_ip="198.51.100.1")
        second = display_store.start_pair(self.conn, "device-secret-second-456",
                                          client_ip="198.51.100.2")
        claimed_second = display_store.claim_pair(self.conn, second["code"], 1, "新屏",
                                                   user_id=7, client_ip="198.51.100.2")
        self.assertIsNone(display_store.screen_for_token(self.conn, claimed_first["token"]))
        self.assertIsNotNone(display_store.screen_for_token(self.conn, claimed_second["token"]))
        active = db.q(self.conn, "SELECT id, name FROM display_screens "
                                 "WHERE event_id = 1 AND revoked_at IS NULL")
        self.assertEqual([row["name"] for row in active], ["新屏"])

    def test_poll_ms_migration_defaults_old_config(self):
        db.run(self.conn, "DROP TABLE display_config")
        self.conn.executescript("""
            CREATE TABLE display_config (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              layout INTEGER NOT NULL DEFAULT 8,
              mode TEXT NOT NULL DEFAULT 'score',
              slots_json TEXT NOT NULL DEFAULT '[]',
              visible_slots_json TEXT NOT NULL DEFAULT '[]',
              announcement_title TEXT NOT NULL DEFAULT '',
              announcement_body TEXT NOT NULL DEFAULT '',
              revision INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL DEFAULT '',
              updated_by INTEGER REFERENCES users(id)
            );
            INSERT INTO display_config(id, layout, mode, revision) VALUES(1, 4, 'score', 3);
        """)
        db._migrate(self.conn)
        columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(display_config)")}
        self.assertIn("poll_ms", columns)
        config = display_store.get_config(self.conn)
        self.assertEqual(config["poll_ms"], 500)
        self.assertEqual(config["layout"], 4)
        self.assertEqual(config["revision"], 3)

    def test_user_role_migration_adds_display_operator(self):
        old_path = Path(self.tmp.name) / "old-users.db"
        old = db.connect(old_path)
        try:
            old.execute("""CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL CHECK (role IN ('admin','organizer','recorder','viewer')),
                active INTEGER NOT NULL DEFAULT 1,
                snapshot_revision INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )""")
            old.execute("INSERT INTO users(id, username, password_hash, salt, role) "
                        "VALUES(1, 'old-admin', 'x', 'x', 'admin')")
            db._migrate_user_roles(old)
            old.execute("INSERT INTO users(username, password_hash, salt, role) "
                        "VALUES('screenop', 'x', 'x', 'display_operator')")
            rows = old.execute("SELECT username, role FROM users ORDER BY id").fetchall()
            self.assertEqual([(row["username"], row["role"]) for row in rows],
                             [("old-admin", "admin"), ("screenop", "display_operator")])
        finally:
            old.close()

    def test_backup_is_created_and_valid(self):
        for table in ("display_config", "display_live", "display_pair_codes", "display_screens"):
            db.run(self.conn, f"DROP TABLE {table}")
        display_store.backup_before_upgrade(self.conn)
        backup = find_backup(self.path, 'before-display-v1')
        self.assertIsNotNone(backup)
        self.assertTrue(backup.is_file())
        saved = db.connect(backup, existing=True)
        try:
            self.assertEqual(saved.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertTrue(saved.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='categories'").fetchone())
        finally:
            saved.close()

    def test_live_snapshot_purge_requires_match(self):
        with self.assertRaises(ApiError):
            display_store.sync_live(self.conn, 999, {"event_seq": 1})
        display_store.purge_expired(self.conn)
        self.assertEqual(display_store.live_rows(self.conn), [])


if __name__ == "__main__":
    unittest.main()
