"""REQ-007 成套备份/校验/恢复的真实测试（TEST-P2B-007）。

覆盖：备份清单哈希/完整性/外键/关键计数；篡改/缺文件/外键损坏校验失败；
restore 往返计数一致、pre-restore 快照、边车清理、清单外旧文件只告警、锁占用
拒绝、未通过校验不碰真实数据；备份不含明文令牌；以及 run.py CLI 子进程行为。
"""
import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import backup_restore, config, db, instance_lock
from helpers import backup_archive as archive_helper
from helpers.service_process import ServiceProcess, run_cli

PRODUCT = Path(__file__).resolve().parents[1]


class BackupRestoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-backup-")
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
        self.archive = self.root / "archive-1"
        self.built = backup_restore.build_archive(
            self.archive, data_dir=config.DATA_DIR, db_path=config.DB_PATH,
            events_dir=config.EVENTS_DIR)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    # -- helpers -------------------------------------------------------
    def live_path(self, relative: str) -> Path:
        if relative == backup_restore.REGISTRY_NAME:
            return config.DB_PATH
        return config.EVENTS_DIR / Path(relative).name

    def manifest(self) -> dict:
        return archive_helper.read_manifest(self.archive)

    def entry(self, relative: str) -> dict:
        for item in self.manifest()["files"]:
            if item["path"] == relative:
                return item
        raise AssertionError(f"备份清单缺少 {relative}")

    def live_counts(self) -> dict:
        return {relative: archive_helper.database_counts(self.live_path(relative))
                for relative in ("registry.db", "events/event_1.db", "events/event_2.db")}

    def live_hashes(self) -> dict:
        return {relative: archive_helper.sha256_file(self.live_path(relative))
                for relative in ("registry.db", "events/event_1.db", "events/event_2.db")}

    def make_fk_broken_archive(self) -> Path:
        broken = self.root / "fk-archive"
        import shutil
        shutil.copytree(self.archive, broken)
        event_path = broken / "events" / "event_1.db"
        conn = sqlite3.connect(str(event_path))
        try:
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute("INSERT INTO groups(id,event_id,code,name,seq) VALUES(999901,999,'BAD','坏组',9)")
            conn.commit()
        finally:
            conn.close()
        counts = archive_helper.database_counts(event_path)
        digest = archive_helper.sha256_file(event_path)
        size = event_path.stat().st_size

        def fix(manifest):
            for item in manifest["files"]:
                if item["path"] == "events/event_1.db":
                    item["counts"] = counts
                    item["sha256"] = digest
                    item["bytes"] = size

        archive_helper.mutate_manifest(broken, fix)
        return broken

    # -- 备份清单 ------------------------------------------------------
    def test_build_archive_writes_complete_manifest(self):
        manifest = self.manifest()
        self.assertEqual(manifest["version"], 1)
        self.assertTrue(manifest["created_at_utc"].endswith("Z"))
        self.assertEqual(manifest["deployment_id"], self.dataset["deployment_id"])
        self.assertEqual(manifest["source"]["db_path"], str(config.DB_PATH.resolve()))
        self.assertEqual(sorted(item["path"] for item in manifest["files"]),
                         ["events/event_1.db", "events/event_2.db", "registry.db"])
        for item in manifest["files"]:
            archived = self.archive / item["path"]
            live = self.live_path(item["path"])
            self.assertEqual(item["sha256"], archive_helper.sha256_file(archived))
            self.assertEqual(item["bytes"], archived.stat().st_size)
            self.assertEqual(len(item["sha256"]), 64)
            self.assertEqual(item["integrity"], "ok")
            self.assertEqual(item["foreign_keys"], 0)
            self.assertEqual(item["counts"], archive_helper.database_counts(live))
        # 归档目录只有清单与 3 个数据库，不含 backups/logs/锁/边车。
        self.assertEqual(archive_helper.archive_relative_files(self.archive),
                         ["events/event_1.db", "events/event_2.db", "manifest.json", "registry.db"])

    def test_build_archive_excludes_logs_lock_and_old_backups(self):
        (config.DATA_DIR / "logs").mkdir(parents=True, exist_ok=True)
        (config.DATA_DIR / "logs" / "server.log").write_text("log", encoding="utf-8")
        (config.DATA_DIR / "stss.instance.lock").write_text("{}", encoding="utf-8")
        (config.DATA_DIR / "backups").mkdir(parents=True, exist_ok=True)
        (config.DATA_DIR / "backups" / "old-backup.db").write_bytes(b"old")
        (config.DATA_DIR / "events" / "event_1.db.before-upgrade.db").write_bytes(b"stray")
        archive = self.root / "archive-excluded"
        backup_restore.build_archive(archive, data_dir=config.DATA_DIR,
                                     db_path=config.DB_PATH, events_dir=config.EVENTS_DIR)
        files = archive_helper.archive_relative_files(archive)
        self.assertEqual(files, ["events/event_1.db", "events/event_2.db",
                                 "manifest.json", "registry.db"])

    def test_build_refuses_nonempty_output_and_events_subdir(self):
        busy = self.root / "busy"
        busy.mkdir()
        (busy / "keep.txt").write_text("x", encoding="utf-8")
        with self.assertRaises(backup_restore.BackupError):
            backup_restore.build_archive(busy, data_dir=config.DATA_DIR,
                                         db_path=config.DB_PATH, events_dir=config.EVENTS_DIR)
        with self.assertRaises(backup_restore.BackupError):
            backup_restore.build_archive(config.EVENTS_DIR / "nested",
                                         data_dir=config.DATA_DIR,
                                         db_path=config.DB_PATH, events_dir=config.EVENTS_DIR)

    # -- 校验失败路径 ---------------------------------------------------
    def test_verify_detects_tampered_database(self):
        archive_helper.tamper_file(self.archive / "events" / "event_1.db")
        with self.assertRaises(backup_restore.VerifyError) as caught:
            backup_restore.verify_archive(self.archive)
        message = str(caught.exception)
        self.assertIn("events/event_1.db", message)
        self.assertTrue("哈希" in message or "大小" in message, message)

    def test_verify_detects_missing_file(self):
        (self.archive / "events" / "event_2.db").unlink()
        with self.assertRaises(backup_restore.VerifyError) as caught:
            backup_restore.verify_archive(self.archive)
        self.assertIn("events/event_2.db", str(caught.exception))

    def test_verify_detects_manifest_count_tamper(self):
        archive_helper.mutate_manifest(
            self.archive,
            lambda manifest: manifest["files"][1]["counts"].__setitem__("schools", 999))
        with self.assertRaises(backup_restore.VerifyError) as caught:
            backup_restore.verify_archive(self.archive)
        self.assertIn("计数", str(caught.exception))

    def test_verify_detects_hash_tamper(self):
        archive_helper.mutate_manifest(
            self.archive,
            lambda manifest: manifest["files"][0].__setitem__("sha256", "0" * 64))
        with self.assertRaises(backup_restore.VerifyError) as caught:
            backup_restore.verify_archive(self.archive)
        self.assertIn("哈希", str(caught.exception))

    def test_verify_detects_foreign_key_violation(self):
        broken = self.make_fk_broken_archive()
        with self.assertRaises(backup_restore.VerifyError) as caught:
            backup_restore.verify_archive(broken)
        self.assertIn("外键", str(caught.exception))

    def test_verify_rejects_manifest_without_registry(self):
        archive_helper.mutate_manifest(
            self.archive,
            lambda manifest: manifest.__setitem__(
                "files", [item for item in manifest["files"] if item["path"] != "registry.db"]))
        with self.assertRaises(backup_restore.VerifyError):
            backup_restore.verify_archive(self.archive)

    # -- 恢复往返 ------------------------------------------------------
    def test_restore_roundtrip_preserves_counts_and_cleans_sidecars(self):
        manifest = self.manifest()
        # 修改当前数据：新增行 + 摆出陈旧边车，恢复后都必须回到备份状态。
        conn = sqlite3.connect(str(config.DB_PATH))
        try:
            conn.execute("INSERT INTO users(username,password_hash,salt,role) "
                         "VALUES('tempuser','h','s','viewer')")
            conn.commit()
        finally:
            conn.close()
        conn = sqlite3.connect(str(config.EVENTS_DIR / "event_1.db"))
        try:
            conn.execute("INSERT INTO schools(event_id,name) VALUES(1,'恢复后不应存在')")
            conn.commit()
        finally:
            conn.close()
        Path(str(config.DB_PATH) + "-wal").write_bytes(b"stale")
        Path(str(config.DB_PATH) + "-shm").write_bytes(b"stale")
        result = backup_restore.restore_archive(self.archive)
        self.assertTrue(result["verified"])
        self.assertEqual(len(result["restored"]), 3)
        for item in manifest["files"]:
            target = self.live_path(item["path"])
            self.assertEqual(archive_helper.sha256_file(target), item["sha256"])
            self.assertEqual(archive_helper.database_counts(target), item["counts"])
            self.assertFalse(Path(str(target) + "-wal").exists())
            self.assertFalse(Path(str(target) + "-shm").exists())
        self.assertEqual(archive_helper.database_counts(config.DB_PATH),
                         self.entry("registry.db")["counts"])
        # 恢复前的临时行已消失。
        rows = archive_helper.database_rows(
            config.DB_PATH, "SELECT COUNT(*) FROM users WHERE username='tempuser'")
        self.assertEqual(rows[0][0], 0)
        rows = archive_helper.database_rows(
            config.EVENTS_DIR / "event_1.db", "SELECT COUNT(*) FROM schools")
        self.assertEqual(rows[0][0], 1)

    def test_restore_writes_pre_restore_snapshot_of_modified_state(self):
        conn = sqlite3.connect(str(config.DB_PATH))
        try:
            conn.execute("INSERT INTO request_log(uid,status) VALUES('pre-snapshot-marker','succeeded')")
            conn.commit()
        finally:
            conn.close()
        result = backup_restore.restore_archive(self.archive)
        snapshot = result["pre_restore_snapshot"]
        self.assertIsNotNone(snapshot)
        self.assertTrue(Path(snapshot).is_dir())
        snapshot_manifest = archive_helper.read_manifest(snapshot)
        self.assertIn("registry.db", [item["path"] for item in snapshot_manifest["files"]])
        rows = archive_helper.database_rows(
            Path(snapshot) / "registry.db",
            "SELECT COUNT(*) FROM request_log WHERE uid='pre-snapshot-marker'")
        self.assertEqual(rows[0][0], 1)
        # pre-restore 快照本身必须能通过 verify。
        backup_restore.verify_archive(snapshot)

    def test_restore_refuses_when_instance_lock_held(self):
        holder = instance_lock.acquire(config.DATA_DIR, port=8123)
        self.addCleanup(holder.release)
        with self.assertRaises(instance_lock.InstanceLockError) as caught:
            backup_restore.restore_archive(self.archive)
        self.assertEqual(caught.exception.port, 8123)
        self.assertIsNotNone(caught.exception.pid)

    def test_restore_refuses_tampered_archive_without_touching_live(self):
        before = self.live_hashes()
        archive_helper.tamper_file(self.archive / "events" / "event_2.db")
        with self.assertRaises(backup_restore.BackupError):
            backup_restore.restore_archive(self.archive)
        self.assertEqual(self.live_hashes(), before)
        # 校验在 pre-restore 快照之前失败，不应产生新备份目录。
        backups = list((config.DATA_DIR / "backups").glob("pre-restore-*"))
        self.assertEqual(backups, [])

    def test_restore_keeps_unlisted_old_event_database(self):
        extra = config.EVENTS_DIR / "event_9.db"
        db.init_db(extra)
        result = backup_restore.restore_archive(self.archive)
        self.assertTrue(extra.exists())
        warnings = "\n".join(result["warnings"])
        self.assertIn("event_9.db", warnings)

    def test_restore_repairs_missing_database_from_archive(self):
        (config.EVENTS_DIR / "event_2.db").unlink()
        result = backup_restore.restore_archive(self.archive)
        self.assertTrue(result["verified"])
        self.assertTrue((config.EVENTS_DIR / "event_2.db").is_file())

    # -- 安全：备份不含明文令牌 -----------------------------------------
    def test_archive_contains_no_plaintext_token(self):
        token = self.dataset["token"]
        secret = token.encode("utf-8")
        for relative in ("registry.db", "events/event_1.db", "events/event_2.db"):
            data = (self.archive / relative).read_bytes()
            self.assertNotIn(secret, data, f"{relative} 中出现明文令牌")
        self.assertNotIn(secret, (self.archive / "manifest.json").read_bytes())
        stored = archive_helper.database_rows(
            self.archive / "registry.db", "SELECT token FROM tokens")
        values = [row[0] for row in stored]
        self.assertIn(hashlib.sha256(secret).hexdigest(), values)
        self.assertNotIn(token, values)


class BackupCliTest(unittest.TestCase):
    """run.py backup/verify/restore 子进程真实行为。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-backup-cli-")
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
        self.archive = self.root / "cli-archive"
        backup_restore.build_archive(self.archive, data_dir=config.DATA_DIR,
                                     db_path=config.DB_PATH, events_dir=config.EVENTS_DIR)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    def test_cli_backup_verify_and_restore_require_confirmation(self):
        result = run_cli(config.DATA_DIR, ["backup"])
        self.assertEqual(result.returncode, 0, result.stderr)
        archives = sorted((config.DATA_DIR / "backups").glob("backup-*"))
        self.assertEqual(len(archives), 1)
        self.assertTrue((archives[0] / "manifest.json").is_file())
        self.assertIn("备份完成", result.stdout)

        verified = run_cli(config.DATA_DIR, ["verify", "--input", str(archives[0])])
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn("校验通过", verified.stdout)

        no_yes = run_cli(config.DATA_DIR, ["restore", "--input", str(archives[0])])
        self.assertNotEqual(no_yes.returncode, 0)
        self.assertIn("--yes", no_yes.stderr)

        restored = run_cli(config.DATA_DIR, ["restore", "--input", str(archives[0]), "--yes"])
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertIn("恢复完成", restored.stdout)
        self.assertIn("pre-restore", restored.stdout)

    def test_cli_verify_fails_clearly_on_tampered_archive(self):
        archive_helper.tamper_file(self.archive / "events" / "event_2.db")
        result = run_cli(config.DATA_DIR, ["verify", "--input", str(self.archive)])
        self.assertEqual(result.returncode, 1)
        self.assertIn("校验失败", result.stderr)
        self.assertIn("events/event_2.db", result.stderr)

    def test_cli_backup_allowed_while_service_running_with_hint(self):
        with ServiceProcess(config.DATA_DIR) as server:
            server.wait_ready()
            result = run_cli(config.DATA_DIR, ["backup"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("检测到运行中的服务实例", result.stdout)
        self.assertIn(f"端口 {server.port}", result.stdout)

    def test_cli_restore_refused_while_service_running(self):
        with ServiceProcess(config.DATA_DIR) as server:
            server.wait_ready()
            result = run_cli(config.DATA_DIR,
                             ["restore", "--input", str(self.archive), "--yes"])
        self.assertEqual(result.returncode, 1)
        self.assertIn("恢复被拒绝", result.stderr)
        self.assertIn(str(server.port), result.stderr)
        self.assertIn("PID", result.stderr)


if __name__ == "__main__":
    unittest.main()
