"""REQ-009 单实例锁 / 日志落盘 / 端口占用提示的真实测试（TEST-P2B-009）。

覆盖：锁 JSON 内容、同进程/跨进程冲突（含 PID/端口）、崩溃自动释放、锁文件
不进入赛事扫描；日志文件生成、UTC 格式、按大小轮转、重复 configure 幂等、
日志目录不可写回退 stderr；run.py entrypoint 端口占用提示与锁释放。
"""
import contextlib
import errno
import io
import json
import logging
import os
import re
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run
from app import config, db, instance_lock, logging_setup
from app.http_server import init_event_databases
from helpers.service_process import ServiceProcess, run_cli


class InstanceLockUnitTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-lock-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        self.addCleanup(self._restore_config)
        config.DATA_DIR = self.root / "data"
        config.DB_PATH = config.DATA_DIR / "registry.db"
        config.EVENTS_DIR = config.DATA_DIR / "events"
        instance_lock.reset_for_tests()
        self.addCleanup(instance_lock.reset_for_tests)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    def test_acquire_writes_json_and_probe_reports_holder(self):
        lock = instance_lock.acquire(config.DATA_DIR, port=8010)
        self.addCleanup(lock.release)
        path = Path(config.service_lock_path())
        self.assertTrue(path.is_file())
        info = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(info["pid"], os.getpid())
        self.assertEqual(info["port"], 8010)
        self.assertTrue(info["started_at_utc"].endswith("Z"))
        self.assertEqual(Path(info["data_dir"]), config.DATA_DIR.resolve())
        status = instance_lock.probe()
        self.assertTrue(status["locked"])
        self.assertEqual(status["pid"], os.getpid())
        self.assertEqual(status["port"], 8010)
        message = instance_lock.describe_status()
        self.assertIn(f"PID {os.getpid()}", message)
        self.assertIn("端口 8010", message)

    def test_second_acquire_in_same_process_fails_with_pid_and_port(self):
        lock = instance_lock.acquire(config.DATA_DIR, port=8011)
        self.addCleanup(lock.release)
        with self.assertRaises(instance_lock.InstanceLockError) as caught:
            instance_lock.acquire(config.DATA_DIR, port=8012)
        message = str(caught.exception)
        self.assertIn(str(os.getpid()), message)
        self.assertIn("8011", message)
        self.assertEqual(caught.exception.port, 8011)

    def test_release_allows_reacquire_and_context_manager_releases(self):
        with instance_lock.acquire(config.DATA_DIR, port=8013) as lock:
            self.assertTrue(instance_lock.is_locked())
            self.assertEqual(lock.port, 8013)
        self.assertFalse(instance_lock.is_locked())
        again = instance_lock.acquire(config.DATA_DIR, port=8014)
        again.release()
        again.release()  # 幂等：重复 release 不抛错
        self.assertFalse(instance_lock.is_locked())

    def test_corrupt_stale_lock_file_does_not_block_startup(self):
        path = Path(config.service_lock_path())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"not a json lock file")
        lock = instance_lock.acquire(config.DATA_DIR, port=8015)
        try:
            info = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(info["pid"], os.getpid())
            self.assertEqual(info["port"], 8015)
        finally:
            lock.release()

    def test_lock_file_lives_in_data_dir_not_events_dir(self):
        path = Path(config.service_lock_path())
        self.assertEqual(path.parent, config.DATA_DIR)
        self.assertNotEqual(path.parent, config.EVENTS_DIR)
        self.assertIsNone(re.fullmatch(r"event_\d+\.db", path.name))


class ServiceLockProcessTest(unittest.TestCase):
    """真实 run.py 服务进程：二次启动、崩溃释放、日志生成。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-lock-proc-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        self.saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        self.addCleanup(self._restore_config)
        config.DATA_DIR = self.data
        config.DB_PATH = self.data / "registry.db"
        config.EVENTS_DIR = self.data / "events"
        instance_lock.reset_for_tests()
        self.addCleanup(instance_lock.reset_for_tests)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    def _server(self) -> ServiceProcess:
        server = ServiceProcess(self.data, extra_env={"STSS_ADMIN_PASSWORD": "admin123"})
        self.addCleanup(server.stop)
        return server.start()

    def test_second_instance_same_data_dir_exits_with_pid_and_port(self):
        server = self._server()
        server.wait_ready()
        result = run_cli(self.data, ["--init-db"])
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn("PID", combined)
        self.assertIn(str(server.process.pid), combined)
        self.assertIn(str(server.port), combined)
        self.assertIn("netstat -ano | findstr", combined)
        # 第二个 serve 进程同样被锁拒绝，而不是换端口起第二实例。
        second = run_cli(self.data, ["--host", "127.0.0.1", "--port", str(server.port + 1)])
        self.assertEqual(second.returncode, 1, second.stdout + second.stderr)
        self.assertIn(str(server.process.pid), second.stderr + second.stdout)

    def test_crashed_instance_lock_is_released_automatically(self):
        server = self._server()
        server.wait_ready()
        server.kill()  # 模拟崩溃：OS 自动释放锁，锁文件残留
        self.assertTrue(Path(config.service_lock_path()).is_file())
        self.assertFalse(instance_lock.is_locked())
        result = run_cli(self.data, ["--init-db"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(Path(config.DB_PATH).is_file())
        info = json.loads(Path(config.service_lock_path()).read_text(encoding="utf-8"))
        self.assertIn("pid", info)

    def test_reset_db_refused_while_running_keeps_database(self):
        server = self._server()
        server.wait_ready()
        self.assertTrue(Path(config.DB_PATH).is_file())
        result = run_cli(self.data, ["--reset-db"])
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn(str(server.process.pid), combined)
        # 锁在删除数据库之前获取，失败时不得删除任何数据。
        self.assertTrue(Path(config.DB_PATH).is_file())

    def test_set_admin_password_cli_holds_lock_and_exits(self):
        from app import security
        result = run_cli(self.data, ["--set-admin-password", "newpass123"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(Path(config.DB_PATH).is_file())
        import sqlite3
        conn = sqlite3.connect(str(config.DB_PATH))
        try:
            row = conn.execute(
                "SELECT password_hash, salt FROM users WHERE username='admin'").fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        self.assertTrue(security.verify_password("newpass123", row[0], row[1]))
        self.assertFalse(instance_lock.is_locked())

    def test_startup_writes_log_file_with_lock_line(self):
        server = self._server()
        server.wait_ready()
        log_path = self.data / "logs" / "server.log"
        self.assertTrue(log_path.is_file(), server.output())
        text = log_path.read_text(encoding="utf-8")
        self.assertIn("已获取实例锁", text)
        self.assertRegex(text, r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z INFO \[stss\]")

    def test_lock_file_is_not_migrated_as_event_database(self):
        config.EVENTS_DIR.mkdir(parents=True, exist_ok=True)
        stray = config.EVENTS_DIR / "stss.instance.lock"
        stray.write_text("{}", encoding="utf-8")
        db.init_db(config.EVENTS_DIR / "event_1.db")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            canonical = init_event_databases()
        self.assertEqual([path.name for path in canonical], ["event_1.db"])
        self.assertIn("非赛事库文件", output.getvalue())
        self.assertTrue(stray.is_file())


class PortOccupancyProcessTest(unittest.TestCase):
    """真实占用端口：显式端口被占用时非零退出并给出 netstat 提示，不回退。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-port-occ-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        self.addCleanup(self._restore_config)
        config.DATA_DIR = self.root / "data"
        config.DB_PATH = config.DATA_DIR / "registry.db"
        config.EVENTS_DIR = config.DATA_DIR / "events"
        instance_lock.reset_for_tests()
        self.addCleanup(instance_lock.reset_for_tests)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = self.saved

    @unittest.skipUnless(hasattr(socket, "SO_EXCLUSIVEADDRUSE"),
                         "需要 Windows SO_EXCLUSIVEADDRUSE 才能可靠模拟端口被占用")
    def test_occupied_port_reports_netstat_hint_without_fallback(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(5)
        port = listener.getsockname()[1]
        result = run_cli(config.DATA_DIR,
                         ["--host", "127.0.0.1", "--port", str(port)],
                         timeout=90)
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn(f"端口 {port} 已被占用或禁止监听", combined)
        self.assertIn(f"netstat -ano | findstr :{port}", combined)
        # 失败路径必须释放锁，重启不会被自己卡住。
        self.assertFalse(instance_lock.is_locked())


class LoggingSetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-log-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        logging_setup.reset()
        self.addCleanup(logging_setup.reset)

    def test_log_file_created_and_rotated_with_utc_format(self):
        stream = io.StringIO()
        state = logging_setup.configure(log_dir=self.root / "logs", level="INFO",
                                        max_bytes=1024, backup_count=2, stream=stream)
        self.assertTrue(state["file"])
        self.assertFalse(state["fallback"])
        log = logging_setup.get_logger("stss.test")
        for index in range(300):
            log.info("line %03d %s", index, "x" * 60)
        for handler in logging.getLogger().handlers:
            handler.flush()
        log_dir = self.root / "logs"
        self.assertTrue((log_dir / "server.log").is_file())
        self.assertTrue((log_dir / "server.log.1").is_file(), list(log_dir.iterdir()))
        content = (log_dir / "server.log").read_text(encoding="utf-8")
        self.assertRegex(content, r"(?m)^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z INFO \[stss\.test\] line ")
        self.assertIn("line", stream.getvalue())

    def test_configure_is_idempotent_and_keeps_foreign_handlers(self):
        own = logging.NullHandler()
        logging.getLogger().addHandler(own)
        self.addCleanup(logging.getLogger().removeHandler, own)
        stream = io.StringIO()
        logging_setup.configure(log_dir=self.root / "logs", stream=stream,
                                max_bytes=4096, backup_count=1)
        marked = [handler for handler in logging.getLogger().handlers
                  if getattr(handler, "_stss_handler", False)]
        self.assertEqual(len(marked), 2)  # 文件 + 控制台
        logging_setup.configure(log_dir=self.root / "logs", stream=stream,
                                max_bytes=4096, backup_count=1)
        marked_after = [handler for handler in logging.getLogger().handlers
                        if getattr(handler, "_stss_handler", False)]
        self.assertEqual(len(marked_after), 2)
        self.assertIn(own, logging.getLogger().handlers)
        logging_setup.get_logger("stss").info("unique-marker")
        for handler in logging.getLogger().handlers:
            handler.flush()
        self.assertEqual(stream.getvalue().count("unique-marker"), 1)

    def test_unwritable_log_dir_falls_back_to_stream(self):
        blocked = self.root / "logs-blocked"
        blocked.write_text("not a directory", encoding="utf-8")
        stream = io.StringIO()
        state = logging_setup.configure(log_dir=blocked, stream=stream)
        self.assertTrue(state["fallback"])
        self.assertIsNone(state["file"])
        logging_setup.get_logger("stss").warning("fallback-marker")
        self.assertIn("fallback-marker", stream.getvalue())

    def test_missing_stderr_uses_file_only(self):
        log_dir = self.root / "logs-nostderr"
        with patch.object(sys, "stderr", None):
            state = logging_setup.configure(log_dir=log_dir, stream=logging_setup._UNSET)
        self.assertTrue(state["file"])
        handlers = [handler for handler in logging.getLogger().handlers
                    if getattr(handler, "_stss_handler", False)]
        self.assertEqual(len(handlers), 1)
        logging_setup.get_logger("stss").info("file-only-marker")
        handlers[0].flush()
        self.assertIn("file-only-marker", (log_dir / "server.log").read_text(encoding="utf-8"))


class EntrypointPortHintTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="stss-p2b-port-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.saved = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR, config.PORT)
        self.addCleanup(self._restore_config)
        config.DATA_DIR = self.root / "data"
        config.DB_PATH = config.DATA_DIR / "registry.db"
        config.EVENTS_DIR = config.DATA_DIR / "events"
        config.PORT = 8123
        instance_lock.reset_for_tests()
        self.addCleanup(instance_lock.reset_for_tests)
        logging_setup.reset()
        self.addCleanup(logging_setup.reset)

    def _restore_config(self):
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR, config.PORT = self.saved

    def test_port_in_use_prints_netstat_hint_and_releases_lock(self):
        def busy(address, handler=None, **kwargs):
            raise OSError(errno.EADDRINUSE, "address already in use")

        stderr = io.StringIO()
        stdout = io.StringIO()
        env = {"STSS_PORT": "8123", "STSS_LAUNCHER": "1",
               "STSS_DATA_DIR": str(config.DATA_DIR),
               "STSS_DB": str(config.DB_PATH),
               "STSS_EVENTS_DIR": str(config.EVENTS_DIR),
               "STSS_LOCK_FILE": str(Path(config.DATA_DIR) / "stss.instance.lock"),
               "STSS_LOG_DIR": str(Path(config.DATA_DIR) / "logs")}
        with patch.dict(os.environ, env), \
                patch.object(sys, "argv", ["run.py"]), \
                patch("app.http_server.create_server", side_effect=busy), \
                contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(stdout):
            code = run.entrypoint()
        text = stderr.getvalue()
        self.assertEqual(code, 1, text)
        self.assertIn("启动失败", text)
        self.assertIn("netstat -ano | findstr :8123", text)
        self.assertIn("--port", text)
        # 启动失败后锁必须释放，下一次启动不会被自己卡住。
        self.assertFalse(instance_lock.is_locked())


if __name__ == "__main__":
    unittest.main()
