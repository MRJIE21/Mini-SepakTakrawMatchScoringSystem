"""账号快照持久 outbox；两个库的事务从不重叠。"""
from __future__ import annotations

import random
import threading
import time
from pathlib import Path

from . import config, db


class SnapshotWorker:
    def __init__(self, registry_path, events_dir):
        self.registry_path, self.events_dir = Path(registry_path), Path(events_dir)
        self._stop = threading.Event()
        self._thread = None
        self.last_error = ""

    def start(self):
        self._thread = threading.Thread(target=self._run, name="stss-user-snapshots", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join()

    def reconcile(self):
        """每次启动核对可恢复的旧快照；提升版本可修复过去的同版本半提交。"""
        conn = db.connect(self.registry_path, busy_ms=config.SYNC_BUSY_MS, existing=True)
        try:
            with db.tx(conn):
                conn.execute("UPDATE users SET snapshot_revision=snapshot_revision+1")
                for user in db.q(conn, "SELECT id FROM users"):
                    db.enqueue_user_snapshot(conn, user["id"])
        finally:
            conn.close()

    def _read_jobs(self, limit):
        conn = db.connect(self.registry_path, busy_ms=config.SYNC_BUSY_MS, existing=True)
        try:
            with db.read_tx(conn):
                jobs = []
                for row in db.q(conn, """SELECT * FROM user_snapshot_outbox
                    WHERE next_attempt_at <= ? ORDER BY next_attempt_at,event_id,user_id LIMIT ?""", (time.time(), limit)):
                    user = db.q1(conn, "SELECT * FROM users WHERE id=?", (row["user_id"],))
                    if user:
                        jobs.append((dict(row), dict(user)))
                return jobs
        finally:
            conn.close()

    def _apply(self, job, user):
        path = self.events_dir / f"event_{int(job['event_id'])}.db"
        if not path.is_file():
            raise FileNotFoundError(f"赛事数据库不存在：{path.name}")
        conn = db.connect(path, busy_ms=config.SYNC_BUSY_MS, existing=True)
        try:
            with db.tx(conn):
                event = db.q1(conn, "SELECT uuid FROM events WHERE id=?", (job["event_id"],))
                deployment = db.q1(conn, "SELECT v FROM settings WHERE k='deployment_id'")
                if not event or event["uuid"] != job["event_uuid"] or not deployment or deployment["v"] != job["deployment_id"]:
                    raise ValueError("赛事/部署身份不符，未写入快照")
                db.ensure_user_snapshot(conn, user)
        finally:
            conn.close()

    def _ack(self, job, user, error=None):
        conn = db.connect(self.registry_path, busy_ms=config.SYNC_BUSY_MS, existing=True)
        try:
            with db.tx(conn):
                identity = (job["event_id"], job["user_id"], job["event_uuid"], job["deployment_id"])
                if error is None:
                    conn.execute("""DELETE FROM user_snapshot_outbox
                        WHERE event_id=? AND user_id=? AND event_uuid=? AND deployment_id=?
                        AND target_revision <= ?""", (*identity, user["snapshot_revision"]))
                else:
                    delay = min(60, 2 ** min(job["attempts"], 6)) * random.uniform(0.9, 1.1)
                    conn.execute("""UPDATE user_snapshot_outbox SET attempts=attempts+1,
                        next_attempt_at=?,last_error=? WHERE event_id=? AND user_id=?
                        AND event_uuid=? AND deployment_id=? AND target_revision=?""",
                        (time.time() + delay, str(error)[:500], *identity, job["target_revision"]))
        finally:
            conn.close()

    def run_once(self, limit=32):
        jobs = self._read_jobs(limit)
        for job, user in jobs:
            if self._stop.is_set():
                break
            error = None
            try:
                self._apply(job, user)
            except Exception as exc:
                error = exc
            self._ack(job, user, error)
        return len(jobs)

    def _run(self):
        reconciled = False
        while not self._stop.is_set():
            try:
                if not reconciled:
                    self.reconcile()
                    reconciled = True
                count = self.run_once()
                self.last_error = ""
            except Exception as exc:
                self.last_error = str(exc)
                count = 0
            self._stop.wait(0.05 if count else 0.5)
