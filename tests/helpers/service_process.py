"""子进程测试设施：隔离数据目录启动/停止真实 ``run.py`` 服务。

P2-B 单实例锁、日志、备份/恢复 CLI 都需要真实进程验证：

* :func:`isolated_env` 把 STSS_* 环境变量全部指向临时目录，绝不接触真实 ``data/``。
* :class:`ServiceProcess` 用显式随机端口启动 ``python run.py``，等到端口可连接
  才算就绪；stdout/stderr 落文件，失败时可在断言消息里直接读取。
* :func:`run_cli` 执行一次性命令（--init-db/backup/verify/restore/maintenance）。
* :func:`free_port` 绑定 0 端口后释放，避免与开发机现有服务冲突。
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

PRODUCT = Path(__file__).resolve().parents[2]


def free_port() -> int:
    """取一个当前空闲的本地端口（用于显式 --port 启动真实服务）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def isolated_env(data_dir: Path | str, extra: dict | None = None) -> dict:
    """隔离环境变量：数据/日志/锁/备份全部落在 ``data_dir`` 下。"""
    root = Path(data_dir)
    env = {
        "STSS_DATA_DIR": str(root),
        "STSS_DB": str(root / "registry.db"),
        "STSS_EVENTS_DIR": str(root / "events"),
        "STSS_LOG_DIR": str(root / "logs"),
        "STSS_LOCK_FILE": str(root / "stss.instance.lock"),
        "STSS_BACKUPS_DIR": str(root / "backups"),
        "STSS_LAUNCHER": "1",  # 启动失败时不要等待回车
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if extra:
        env.update({key: str(value) for key, value in extra.items()})
    return env


def _tail(path: Path, limit: int = 4000) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-limit:]


def run_cli(data_dir: Path | str, args: list[str], *, timeout: float = 120,
            extra_env: dict | None = None, cwd: Path | str | None = None) -> subprocess.CompletedProcess:
    """在隔离环境中执行一次性 CLI 命令，返回 CompletedProcess（UTF-8 文本）。"""
    env = {**os.environ, **isolated_env(data_dir, extra_env)}
    return subprocess.run(
        [sys.executable, "-B", str(PRODUCT / "run.py"), *args],
        cwd=str(cwd or PRODUCT), env=env, stdin=subprocess.DEVNULL,
        capture_output=True, encoding="utf-8", errors="replace", timeout=timeout)


class ServiceProcess:
    """真实 ``run.py`` 服务进程；用端口就绪等待，退出时优先 terminate。"""

    def __init__(self, data_dir: Path | str, *, port: int | None = None,
                 host: str = "127.0.0.1", extra_env: dict | None = None,
                 args: list[str] | None = None, cwd: Path | str | None = None):
        self.data_dir = Path(data_dir)
        self.port = int(port if port is not None else free_port())
        self.host = host
        self.extra_env = dict(extra_env or {})
        self.args = list(args or [])
        self.cwd = Path(cwd) if cwd else PRODUCT
        self.log_dir = self.data_dir / "_process"
        self.stdout_path = self.log_dir / "stdout.log"
        self.stderr_path = self.log_dir / "stderr.log"
        self.process: subprocess.Popen | None = None
        self._stdout_file = None
        self._stderr_file = None

    # -- lifecycle -----------------------------------------------------
    def start(self) -> "ServiceProcess":
        self.log_dir.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, **isolated_env(self.data_dir, self.extra_env)}
        self._stdout_file = open(self.stdout_path, "ab")
        self._stderr_file = open(self.stderr_path, "ab")
        self.process = subprocess.Popen(
            [sys.executable, "-B", str(self.cwd / "run.py"),
             "--host", self.host, "--port", str(self.port), *self.args],
            cwd=str(self.cwd), env=env, stdin=subprocess.DEVNULL,
            stdout=self._stdout_file, stderr=self._stderr_file)
        return self

    def output(self) -> str:
        return "STDOUT:\n" + _tail(self.stdout_path) + "\nSTDERR:\n" + _tail(self.stderr_path)

    def wait_ready(self, timeout: float = 30) -> "ServiceProcess":
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process is None:
                raise RuntimeError("service not started")
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"服务进程提前退出（code={self.process.returncode}）：\n{self.output()}")
            try:
                with socket.create_connection((self.host or "127.0.0.1", self.port), timeout=0.5):
                    return self
            except OSError:
                time.sleep(0.1)
        raise TimeoutError(f"服务在 {timeout}s 内未在端口 {self.port} 就绪：\n{self.output()}")

    def stop(self, timeout: float = 15) -> int:
        process = self.process
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=timeout)
            code = process.returncode or 0
            self.process = None
        else:
            code = 0
        for handle in (self._stdout_file, self._stderr_file):
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass
        self._stdout_file = self._stderr_file = None
        return code

    def kill(self) -> None:
        """模拟崩溃：直接强杀，用于验证 OS 自动释放实例锁。"""
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=15)
        for handle in (self._stdout_file, self._stderr_file):
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass
        self._stdout_file = self._stderr_file = None

    def __enter__(self) -> "ServiceProcess":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()

    # -- convenience ---------------------------------------------------
    def server_log(self) -> str:
        path = self.data_dir / "logs" / "server.log"
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""


def wait_for(predicate, timeout: float = 30, interval: float = 0.05):
    """轮询等待条件成立；超时抛 TimeoutError。返回 predicate 的最终值。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise TimeoutError("等待条件超时")
