"""旧库 group_draws 只允许 random/seeded；新增循环落位需要无损重建表。"""
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import db


def build_legacy_database(path: Path):
    """用当前 schema 但把 group_draws 的 CHECK 还原成旧的两种方式。"""
    schema = (Path(db.__file__).resolve().parent / 'schema.sql').read_text(encoding='utf-8')
    legacy = re.sub(r"CHECK \(method IN \('random','seeded','cycle'\)\)",
                    "CHECK (method IN ('random','seeded'))", schema)
    if legacy == schema:
        raise AssertionError('未找到 group_draws 的 method CHECK，测试需要同步更新')
    conn = sqlite3.connect(path)
    try:
        conn.executescript(legacy)
        conn.execute("INSERT INTO events(id,uuid,name,status,created_at) "
                     "VALUES(1,'u','e','draft',datetime('now'))")
        conn.execute("INSERT INTO groups(id,event_id,code,name) VALUES(1,1,'A','甲组')")
        conn.execute("INSERT INTO categories(id,group_id,name,gender,kind) "
                     "VALUES(1,1,'男子三人赛','male','team')")
        conn.execute("INSERT INTO users(id,username,password_hash,salt,display_name,role,active,created_at) "
                     "VALUES(1,'admin','x','y','Admin','admin',1,datetime('now'))")
        for draw_id, method, status in ((1, 'random', 'confirmed'), (2, 'seeded', 'cancelled')):
            conn.execute("INSERT INTO group_draws(id,category_id,method,status,capacities_json,"
                         "roster_json,steps_json,created_by) VALUES(?,?,?,?,'[2]','[]','[]',1)",
                         (draw_id, 1, method, status))
        conn.commit()
    finally:
        conn.close()


class GroupDrawCycleMigrationTest(unittest.TestCase):
    def test_legacy_check_is_rebuilt_and_rows_preserved(self):
        work = Path(tempfile.mkdtemp(prefix='group-cycle-migration-'))
        path = work / 'event_9.db'
        build_legacy_database(path)
        legacy = sqlite3.connect(path)
        legacy_sql = legacy.execute("SELECT sql FROM sqlite_master WHERE name='group_draws'").fetchone()[0]
        before_rows = legacy.execute("SELECT id,method,status FROM group_draws ORDER BY id").fetchall()
        legacy.close()
        self.assertNotIn("'cycle'", legacy_sql)

        db.init_db(path)

        conn = sqlite3.connect(path)
        try:
            sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='group_draws'").fetchone()[0]
            self.assertIn("'cycle'", sql)
            self.assertEqual(conn.execute("SELECT id,method,status FROM group_draws ORDER BY id").fetchall(),
                             before_rows)
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(), [])
            indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            self.assertIn('idx_group_draws_category', indexes)
            # 迁移后可写入循环落位
            conn.execute("INSERT INTO group_draws(category_id,method,capacities_json,roster_json,steps_json) "
                         "VALUES(1,'cycle','[2]','[]','[]')")
            conn.commit()
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) FROM group_draws WHERE method='cycle'").fetchone()[0], 1)
        finally:
            conn.close()
        snapshot = Path(str(path) + '.before-group-cycle-v1.sqlite')
        self.assertTrue(snapshot.is_file(), '升级前应留快照')
        saved = sqlite3.connect(snapshot)
        try:
            self.assertNotIn("'cycle'", saved.execute(
                "SELECT sql FROM sqlite_master WHERE name='group_draws'").fetchone()[0])
            self.assertEqual(saved.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        finally:
            saved.close()
        # 幂等：再跑一次不重复重建也不丢数据
        db.init_db(path)
        again = sqlite3.connect(path)
        try:
            self.assertEqual(again.execute('SELECT COUNT(*) FROM group_draws').fetchone()[0], 3)
            self.assertEqual(again.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        finally:
            again.close()


if __name__ == '__main__':
    unittest.main()
