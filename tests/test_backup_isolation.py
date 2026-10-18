"""Pre-upgrade snapshots stay outside events/ and never enter startup migration."""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from app import backup, config, db
from app.http_server import init_event_databases


class BackupIsolationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='stss-backup-isolation-')
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        self.addCleanup(self._restore_config)
        config.DATA_DIR = root
        config.DB_PATH = root / 'registry.db'
        config.EVENTS_DIR = root / 'events'
        config.EVENTS_DIR.mkdir(parents=True)
        db.init_db(config.DB_PATH)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    def test_online_backup_is_written_outside_events_directory(self):
        conn = db.connect(config.DB_PATH)
        try:
            target = backup.online_backup(conn, '.before-test-v1.db')
        finally:
            conn.close()
        self.assertIsNotNone(target)
        self.assertEqual(target.parent, config.backups_dir())
        self.assertNotEqual(target.parent, config.EVENTS_DIR)
        self.assertTrue(target.is_file())
        self.assertFalse(list(config.EVENTS_DIR.glob('*before-test-v1*')))

    def test_restart_does_not_rewrite_backup_or_scan_stray_files(self):
        event_path = config.EVENTS_DIR / 'event_1.db'
        db.init_db(event_path)
        stray = config.EVENTS_DIR / 'event_1.db.before-display-v1.db'
        stray.write_bytes(b'not a database; must stay untouched')
        conn = db.connect(event_path)
        try:
            snapshot = backup.online_backup(conn, '.before-restart-check.db')
        finally:
            conn.close()
        before = snapshot.read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            canonical = init_event_databases()
        self.assertEqual(canonical, [event_path])
        self.assertEqual(snapshot.read_bytes(), before)
        self.assertEqual(stray.read_bytes(), b'not a database; must stay untouched')
        self.assertIn('非赛事库文件', output.getvalue())

    def test_corrupt_real_event_database_fails_with_filename(self):
        corrupt = config.EVENTS_DIR / 'event_2.db'
        corrupt.write_bytes(b'this is not a database')
        with self.assertRaises(RuntimeError) as caught:
            init_event_databases()
        self.assertIn('event_2.db', str(caught.exception))
        self.assertIn('backups', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
