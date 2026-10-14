"""每个赛事必须拥有独立 SQLite 文件，业务行不可跨赛事可见。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app import config, db, security


class EventDatabaseIsolationTest(unittest.TestCase):
    def test_business_rows_are_physically_isolated(self):
        old_dir = config.EVENTS_DIR
        with tempfile.TemporaryDirectory(prefix="stss_event_db_") as tmp:
            root = Path(tmp)
            config.EVENTS_DIR = root / "events"
            registry = root / "registry.db"
            db.init_db(registry)
            registry_conn = db.connect(registry)
            try:
                security.create_user(registry_conn, "admin", "Admin123456", "admin", "赛事管理员")
                for event_id, name in ((1, "第一届"), (2, "第二届")):
                    registry_conn.execute(
                        "INSERT INTO events(id,name,start_date,end_date,location) VALUES(?,?,?,?,?)",
                        (event_id, name, "", "", ""),
                    )
                    event = dict(db.q1(registry_conn, "SELECT * FROM events WHERE id = ?", (event_id,)))
                    db.create_event_database(event_id, event, registry_conn)

                first = db.connect(db.event_db_path(1))
                second = db.connect(db.event_db_path(2))
                try:
                    first.execute("INSERT INTO groups(event_id,code,name,seq) VALUES(1,'A','第一组',1)")
                    self.assertEqual(db.q1(first, "SELECT COUNT(*) AS n FROM groups")["n"], 1)
                    self.assertEqual(db.q1(second, "SELECT COUNT(*) AS n FROM groups")["n"], 0)
                    self.assertNotEqual(db.event_db_path(1), db.event_db_path(2))
                finally:
                    first.close()
                    second.close()
            finally:
                registry_conn.close()
                config.EVENTS_DIR = old_dir


if __name__ == "__main__":
    unittest.main()
