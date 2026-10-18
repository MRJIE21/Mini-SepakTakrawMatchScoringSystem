"""P2-B REQ-011: UTC clock, epoch migration, rollback protection and legacy compatibility."""
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import backup, clock, db, display_store, display_state, security


class UtcClockTest(unittest.TestCase):
    def setUp(self):
        self.task = Path(tempfile.mkdtemp(prefix='p2b-utc-'))
        self.db_path = self.task / 'event.db'
        db.init_db(self.db_path)
        self.conn = db.connect(self.db_path, existing=True)
        clock.reset_cache()
        security.reset_login_limits()

    def tearDown(self):
        self.conn.close()
        clock.reset_cache()

    def test_expired_token_cannot_revive_after_clock_rollback(self):
        base = 1_700_000_000
        user_id = security.create_user(self.conn, 'clockuser', 'ClockPass123', 'viewer', '时钟用户')
        with mock.patch.object(clock, 'utc_epoch', return_value=base):
            token = security.issue_token(self.conn, user_id)
        self.conn.execute("UPDATE tokens SET expires_at_epoch = ?, expires_at = '2000-01-01 00:00:00' "
                          "WHERE user_id = ?", (base + 10, user_id))
        self.conn.commit()
        with mock.patch.object(clock, 'utc_epoch', return_value=base + 100):
            self.assertGreaterEqual(clock.wall_epoch(self.conn), base + 100)
        with mock.patch.object(clock, 'utc_epoch', return_value=base + 5):
            self.assertIsNone(security.user_for_token(self.conn, token),
                              'rollback must not revive an expired token')
            self.assertGreaterEqual(clock.wall_epoch(self.conn), base + 100)

    def test_screen_online_uses_epoch_and_legacy_text_fallback(self):
        now = clock.utc_epoch()
        self.conn.execute("INSERT INTO events(id, uuid, name) VALUES(1, 'uuid-1', 'UTC 测试赛事')")
        screen_id = db.insert(self.conn, 'display_screens', {
            'name': '旧屏', 'event_id': 1, 'token_hash': 'x' * 64, 'last_seen_at': '',
            'last_seen_epoch': 0, 'revoked_at': None})
        self.conn.commit()
        screen = display_store.screen_by_id(self.conn, screen_id)
        self.assertFalse(display_store.screen_online(screen, self.conn))
        self.conn.execute("UPDATE display_screens SET last_seen_at = ?, last_seen_epoch = 0 WHERE id = ?",
                          (display_store._now(), screen_id))
        self.conn.commit()
        screen = display_store.screen_by_id(self.conn, screen_id)
        self.assertTrue(display_store.screen_online(screen, self.conn),
                        'legacy text-only rows must remain readable')
        db._migrate_epoch_times(self.conn)
        migrated = self.conn.execute("SELECT last_seen_epoch FROM display_screens WHERE id = ?",
                                     (screen_id,)).fetchone()['last_seen_epoch']
        self.assertGreater(migrated, 0, 'epoch backfill should populate legacy rows')
        self.assertLessEqual(abs(migrated - int(now)), 120)

    def test_display_state_server_time_is_utc_iso(self):
        value = display_state._now(None)
        self.assertRegex(value, r'Z$')
        self.assertIn('T', value)

    def test_backup_names_are_utc_and_unique(self):
        first = backup.online_backup(self.conn, '.p2b-utc-test.db')
        self.assertIsNotNone(first)
        self.assertRegex(first.name, r'-\d{8}-\d{6}-\d{6}\.db$')
        second = backup.online_backup(self.conn, '.p2b-utc-test.db')
        self.assertEqual(first, second, 'same label reuses the verified rollback point')

    def test_parse_local_text_and_format(self):
        self.assertIsNotNone(clock.parse_local_text('2026-10-18 12:00:00'))
        self.assertIsNone(clock.parse_local_text('not-a-time'))
        self.assertRegex(clock.utc_iso(), r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')


if __name__ == '__main__':
    unittest.main()
