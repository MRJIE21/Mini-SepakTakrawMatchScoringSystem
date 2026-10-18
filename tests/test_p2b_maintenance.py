"""REQ-008 数据保留维护任务测试（TEST-P2B-008）。

覆盖：默认 dry-run 只统计不写库；apply 数量正确、写 maintenance_cleanup 审计、
审计日志本身不删；request_log 保留期；过期令牌/配对码/大屏 live 清理；
dry-run 可在实例运行/锁占用时执行，apply 需要实例锁空闲；CLI 子进程行为。
"""
import json
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from app import config, db, instance_lock, maintenance
from helpers import backup_archive as archive_helper
from helpers.service_process import ServiceProcess, run_cli


def _past_text() -> str:
    return "2020-01-01 00:00:00"


def _future_text() -> str:
    return "2099-01-01 00:00:00"


def _seed_registry(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        now = int(time.time())
        conn.execute("INSERT INTO tokens(token,user_id,expires_at,expires_at_epoch) "
                     "SELECT 'expired-epoch', id, ?, ? FROM users LIMIT 1",
                     (_past_text(), now - 3600))
        conn.execute("INSERT INTO tokens(token,user_id,expires_at,expires_at_epoch) "
                     "SELECT 'expired-legacy', id, ?, 0 FROM users LIMIT 1", (_past_text(),))
        conn.execute("INSERT INTO tokens(token,user_id,expires_at,expires_at_epoch) "
                     "SELECT 'valid-epoch', id, ?, ? FROM users LIMIT 1",
                     (_future_text(), now + 86400))
        conn.execute("INSERT INTO display_pair_codes(code_hash,device_hash,expires_at,expires_at_epoch) "
                     "VALUES('pair-expired','d1',?,?)", (_past_text(), now - 60))
        conn.execute("INSERT INTO display_pair_codes(code_hash,device_hash,expires_at,expires_at_epoch,claimed_at) "
                     "VALUES('pair-claimed','d2',?,?,'2026-01-01 00:00:00')",
                     (_future_text(), now + 3600))
        conn.execute("INSERT INTO display_pair_codes(code_hash,device_hash,expires_at,expires_at_epoch) "
                     "VALUES('pair-active','d3',?,?)", (_future_text(), now + 3600))
        conn.execute("INSERT INTO request_log(uid,scope,status,created_at) "
                     "VALUES('log-old','auth','succeeded',?)", (_past_text(),))
        conn.execute("INSERT INTO request_log(uid,scope,status,created_at) "
                     "VALUES('log-recent','auth','succeeded',?)",
                     (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),))
        conn.execute("INSERT INTO audit_logs(action,entity_type) VALUES('keepme','system')")
        conn.commit()
    finally:
        conn.close()


def _seed_event(path: Path, event_id: int) -> None:
    conn = sqlite3.connect(str(path))
    try:
        now = int(time.time())
        conn.execute("PRAGMA foreign_keys=OFF")  # 仅测试夹具：live 快照需要 match 外键
        conn.execute("INSERT INTO display_live(match_id,expires_at,expires_at_epoch) "
                     "VALUES(?,?,?)", (event_id, _past_text(), now - 60))
        conn.execute("INSERT INTO display_live(match_id,expires_at,expires_at_epoch) "
                     "VALUES(?,?,?)", (event_id + 100, _future_text(), now + 3600))
        conn.execute("INSERT INTO display_pair_codes(code_hash,device_hash,expires_at,expires_at_epoch) "
                     "VALUES(?,?,?,?)", (f"evt-pair-{event_id}", "d", _past_text(), now - 60))
        conn.execute("INSERT INTO request_log(uid,scope,status,created_at) "
                     "VALUES(?,'scoring','succeeded',?)", (f"evt-log-{event_id}", _past_text()))
        conn.execute("INSERT INTO audit_logs(action,entity_type) VALUES('keepme','system')")
        conn.commit()
    finally:
        conn.close()


def _table_counts(db_path: Path) -> dict:
    return {table: archive_helper.count_rows(db_path, f'SELECT COUNT(*) FROM "{table}"')
            for table in maintenance.CLEANUP_TABLES}


class MaintenanceTest(unittest.TestCase):
    # registry：2 过期令牌；registry 2 + event1 1 + event2 1 个过期/已领取配对码；
    # 两个赛事库各 1 个过期 live；三个库各 1 条保留期外 request_log。
    expected_totals = {"tokens": 2, "display_pair_codes": 4,
                       "display_live": 2, "request_log": 3}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-maint-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        self.addCleanup(self._restore_config)
        config.DATA_DIR = self.root / "data"
        config.DB_PATH = config.DATA_DIR / "registry.db"
        config.EVENTS_DIR = config.DATA_DIR / "events"
        instance_lock.reset_for_tests()
        self.addCleanup(instance_lock.reset_for_tests)
        db.init_db(config.DB_PATH)
        conn = db.connect(config.DB_PATH)
        try:
            from app import security
            security.create_user(conn, "admin", "admin123", "admin", "管理员")
        finally:
            conn.close()
        self.event_paths = []
        for event_id in (1, 2):
            path = config.EVENTS_DIR / f"event_{event_id}.db"
            db.init_db(path)
            _seed_event(path, event_id)
            self.event_paths.append(path)
        _seed_registry(config.DB_PATH)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    def _all_counts(self) -> dict:
        result = {path.name: _table_counts(path) for path in self.event_paths}
        result["registry.db"] = _table_counts(config.DB_PATH)
        return result

    def test_dry_run_reports_counts_without_writing(self):
        before = self._all_counts()
        report = maintenance.run_maintenance(dry_run=True)
        self.assertTrue(report["dry_run"])
        self.assertFalse(report["audit_written"])
        self.assertEqual(report["totals"], self.expected_totals)
        self.assertEqual(report["total"], sum(self.expected_totals.values()))
        self.assertEqual(self._all_counts(), before)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM audit_logs WHERE action='maintenance_cleanup'"), 0)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM tokens WHERE token='expired-epoch'"), 1)

    def test_apply_deletes_expected_rows_and_writes_audit(self):
        report = maintenance.run_maintenance(dry_run=False)
        self.assertFalse(report["dry_run"])
        self.assertTrue(report["audit_written"])
        self.assertEqual(report["totals"], self.expected_totals)
        # registry：过期令牌（epoch/旧文本）删除，有效令牌保留。
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM tokens"), 1)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM tokens WHERE token='valid-epoch'"), 1)
        # 配对码：过期与已领取删除，未过期未领取保留。
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM display_pair_codes"), 1)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM display_pair_codes WHERE code_hash='pair-active'"), 1)
        # request_log：保留期外删除，近期保留；事件库同样生效。
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM request_log"), 1)
        self.assertEqual(archive_helper.count_rows(
            self.event_paths[0], "SELECT COUNT(*) FROM request_log"), 0)
        # display_live：过期删除、未过期保留。
        self.assertEqual(archive_helper.count_rows(
            self.event_paths[0], "SELECT COUNT(*) FROM display_live"), 1)
        # 审计日志本身不删：既有 keepme 保留，新增 maintenance_cleanup 一条。
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM audit_logs WHERE action='keepme'"), 1)
        audits = archive_helper.database_rows(
            config.DB_PATH, "SELECT detail_json FROM audit_logs WHERE action='maintenance_cleanup'")
        self.assertEqual(len(audits), 1)
        detail = json.loads(audits[0][0])
        self.assertEqual(detail["totals"], self.expected_totals)
        self.assertFalse(detail["dry_run"])
        # 审计不记录令牌等敏感值。
        self.assertNotIn("expired-epoch", audits[0][0])
        self.assertNotIn("pair-claimed", audits[0][0])

    def test_apply_is_idempotent(self):
        first = maintenance.run_maintenance(dry_run=False)
        self.assertEqual(first["total"], sum(self.expected_totals.values()))
        second = maintenance.run_maintenance(dry_run=False)
        self.assertEqual(second["total"], 0)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM audit_logs WHERE action='maintenance_cleanup'"), 2)

    def test_retention_days_controls_request_log(self):
        old = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        conn = sqlite3.connect(str(config.DB_PATH))
        try:
            conn.execute("INSERT INTO request_log(uid,scope,status,created_at) "
                         "VALUES('log-two-days','auth','succeeded',?)", (old,))
            conn.commit()
        finally:
            conn.close()
        report_1 = maintenance.run_maintenance(dry_run=True, retention_days=1)
        report_30 = maintenance.run_maintenance(dry_run=True, retention_days=30)
        self.assertEqual(report_1["totals"]["request_log"],
                         report_30["totals"]["request_log"] + 1)
        self.assertEqual(report_1["retention_days"], 1)
        # apply 使用显式保留期时只删该范围。
        maintenance.run_maintenance(dry_run=False, retention_days=1)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM request_log WHERE uid='log-two-days'"), 0)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM request_log WHERE uid='log-recent'"), 1)

    def test_dry_run_allowed_while_lock_held_but_apply_refused(self):
        holder = instance_lock.acquire(config.DATA_DIR, port=8130)
        try:
            report = maintenance.run_maintenance(dry_run=True)
            self.assertEqual(report["totals"], self.expected_totals)
            with self.assertRaises(instance_lock.InstanceLockError) as caught:
                maintenance.run_maintenance(dry_run=False)
            self.assertEqual(caught.exception.port, 8130)
        finally:
            holder.release()

    def test_apply_accepts_preheld_lock(self):
        holder = instance_lock.acquire(config.DATA_DIR)
        try:
            report = maintenance.run_maintenance(dry_run=False, lock=holder)
            self.assertEqual(report["totals"], self.expected_totals)
        finally:
            holder.release()

    def test_missing_registry_raises_clear_error(self):
        with self.assertRaises(maintenance.MaintenanceError):
            maintenance.run_maintenance(dry_run=True, db_path=self.root / "missing.db",
                                        events_dir=config.EVENTS_DIR)

    def test_invalid_retention_days_rejected(self):
        with self.assertRaises(maintenance.MaintenanceError):
            maintenance.run_maintenance(dry_run=True, retention_days=-1)


class MaintenanceCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-maint-cli-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        self.addCleanup(self._restore_config)
        config.DATA_DIR = self.root / "data"
        config.DB_PATH = config.DATA_DIR / "registry.db"
        config.EVENTS_DIR = config.DATA_DIR / "events"
        instance_lock.reset_for_tests()
        self.addCleanup(instance_lock.reset_for_tests)
        self.dataset = archive_helper.init_dataset(config.DATA_DIR)
        _seed_registry(config.DB_PATH)
        _seed_event(self.dataset["event_paths"][1], 1)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    def test_cli_default_dry_run_then_apply(self):
        before = archive_helper.count_rows(config.DB_PATH, "SELECT COUNT(*) FROM tokens")
        result = run_cli(config.DATA_DIR, ["maintenance"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("dry-run", result.stdout)
        self.assertIn("合计将清理", result.stdout)
        self.assertEqual(archive_helper.count_rows(config.DB_PATH, "SELECT COUNT(*) FROM tokens"), before)
        applied = run_cli(config.DATA_DIR, ["maintenance", "--apply"])
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertIn("已清理", applied.stdout)
        self.assertLess(archive_helper.count_rows(config.DB_PATH, "SELECT COUNT(*) FROM tokens"), before)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM audit_logs WHERE action='maintenance_cleanup'"), 1)
        again = run_cli(config.DATA_DIR, ["maintenance", "--apply"])
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("合计已清理 0 行", again.stdout)

    def test_cli_dry_run_with_retention_override(self):
        old = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        conn = sqlite3.connect(str(config.DB_PATH))
        try:
            conn.execute("INSERT INTO request_log(uid,scope,status,created_at) "
                         "VALUES('cli-old-2d','auth','succeeded',?)", (old,))
            conn.commit()
        finally:
            conn.close()
        result = run_cli(config.DATA_DIR,
                         ["maintenance", "--retention-days", "1"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("保留期 1 天", result.stdout)
        applied = run_cli(config.DATA_DIR,
                          ["maintenance", "--retention-days", "1", "--apply"])
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM request_log WHERE uid='cli-old-2d'"), 0)
        self.assertEqual(archive_helper.count_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM request_log WHERE uid='log-recent'"), 1)

    def test_cli_apply_refused_while_service_running_but_dry_run_allowed(self):
        with ServiceProcess(config.DATA_DIR,
                            extra_env={"STSS_ADMIN_PASSWORD": "admin123"}) as server:
            server.wait_ready()
            refused = run_cli(config.DATA_DIR, ["maintenance", "--apply"])
            dry = run_cli(config.DATA_DIR, ["maintenance"])
        self.assertEqual(refused.returncode, 1)
        self.assertIn("维护被拒绝", refused.stderr)
        self.assertIn("PID", refused.stderr)
        self.assertIn(str(server.port), refused.stderr)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn("dry-run", dry.stdout)


if __name__ == "__main__":
    unittest.main()
