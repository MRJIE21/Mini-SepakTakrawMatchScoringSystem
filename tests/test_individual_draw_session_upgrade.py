"""升级前旧库安装新表：只新增空过程表，不改写既有业务数据。"""
import json
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import config, db, security


def build_legacy_event_database(path: Path):
    """用旧版结构（无 individual_draw_sessions）建一个含业务数据的赛事库。"""
    schema = (Path(db.__file__).resolve().parent / 'schema.sql').read_text(encoding='utf-8')
    # 去掉新表与新索引的整条语句，模拟尚未升级的旧库。
    legacy = re.sub(r'CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS individual_draw_sessions[\s\S]*?;',
                    '', schema, flags=re.IGNORECASE)
    legacy = re.sub(r'CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_individual_draw_sessions[\s\S]*?;',
                    '', legacy, flags=re.IGNORECASE)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('PRAGMA foreign_keys = ON')
        conn.executescript(legacy)
        conn.execute("INSERT INTO events(id,uuid,name,status,created_at) "
                     "VALUES(1,'legacy-uuid','legacy','draft',datetime('now'))")
        conn.execute("INSERT INTO groups(id,event_id,code,name) VALUES(1,1,'A','grp')")
        conn.execute("INSERT INTO categories(id,group_id,name,gender,kind) "
                     "VALUES(1,1,'legacy-individual','male','individual')")
        conn.execute("INSERT INTO schools(id,event_id,name) VALUES(1,1,'legacy-school')")
        conn.execute("INSERT INTO users(id,username,password_hash,salt,display_name,role,active,created_at) "
                     "VALUES(1,'legacy-admin','x','y','legacy','admin',1,datetime('now'))")
        conn.execute("INSERT INTO athletes(id,group_id,school_id,name,gender) VALUES(1,1,1,'a','male')")
        conn.execute("INSERT INTO participations(id,category_id,athlete_id,status) VALUES(1,1,1,'active')")
        conn.execute("INSERT INTO individual_draws(category_id,revision,roster_json,order_json,"
                     "confirmed_by,request_uid) VALUES(1,1,'[]','[]',1,'legacy-uid')")
        conn.commit()
    finally:
        conn.close()


class SessionUpgradeTest(unittest.TestCase):
    def test_old_event_database_gains_empty_session_table_without_backfill(self):
        task = Path(tempfile.mkdtemp(prefix='individual-draw-upgrade-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        config.EVENTS_DIR.mkdir(parents=True, exist_ok=True)
        event_path = config.EVENTS_DIR / 'event_1.db'
        build_legacy_event_database(event_path)

        before = sqlite3.connect(event_path)
        before_draw = [tuple(row) for row in before.execute('SELECT * FROM individual_draws').fetchall()]
        before_tables = {r[0] for r in before.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        before.close()
        self.assertNotIn('individual_draw_sessions', before_tables)

        db.init_db(event_path)

        after = sqlite3.connect(event_path)
        after.row_factory = sqlite3.Row
        try:
            tables = {r[0] for r in after.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn('individual_draw_sessions', tables)
            columns = {r['name'] for r in after.execute('PRAGMA table_info(individual_draw_sessions)')}
            self.assertEqual(columns, {'id', 'category_id', 'roster_json', 'order_json', 'roster_hash',
                                       'base_revision', 'revision', 'status', 'created_by', 'picked_by',
                                       'created_at', 'updated_at', 'confirmed_at'})
            self.assertEqual(after.execute('SELECT COUNT(*) FROM individual_draw_sessions').fetchone()[0], 0)
            # 正式签表和既有业务数据逐行不变。
            self.assertEqual([tuple(r) for r in after.execute('SELECT * FROM individual_draws')], before_draw)
            self.assertEqual(after.execute('SELECT COUNT(*) FROM participations').fetchone()[0], 1)
            indexes = {r[0] for r in after.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            self.assertIn('idx_individual_draw_sessions_active', indexes)
            self.assertIn('idx_individual_draw_sessions_category', indexes)
            # 唯一索引确实只约束进行中/待确认状态。
            after.execute("INSERT INTO individual_draw_sessions"
                          "(category_id,roster_json,order_json,roster_hash,status) "
                          "VALUES(1,'[{\"id\":1}]','[]','h','drawing')")
            after.execute("UPDATE individual_draw_sessions SET status='cancelled' WHERE id=1")
            after.execute("INSERT INTO individual_draw_sessions"
                          "(category_id,roster_json,order_json,roster_hash,status) "
                          "VALUES(1,'[{\"id\":1}]','[]','h','confirmed')")
            after.commit()
        finally:
            after.close()

        # 重复升级幂等。
        db.init_db(event_path)
        again = sqlite3.connect(event_path)
        try:
            self.assertEqual(again.execute('SELECT COUNT(*) FROM individual_draw_sessions').fetchone()[0], 2)
            self.assertEqual([tuple(r) for r in again.execute('SELECT * FROM individual_draws')], before_draw)
        finally:
            again.close()

    def test_backup_snapshot_created_once_and_stays_valid(self):
        task = Path(tempfile.mkdtemp(prefix='individual-draw-upgrade-backup-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        config.EVENTS_DIR.mkdir(parents=True, exist_ok=True)
        event_path = config.EVENTS_DIR / 'event_2.db'
        build_legacy_event_database(event_path)
        db.init_db(event_path)
        snapshot = Path(str(event_path) + '.before-individual-draw-session-v1.sqlite')
        self.assertTrue(snapshot.is_file())
        stamp = snapshot.stat().st_mtime_ns
        saved = sqlite3.connect(snapshot)
        try:
            self.assertEqual(saved.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertNotIn('individual_draw_sessions',
                             {r[0] for r in saved.execute("SELECT name FROM sqlite_master WHERE type='table'")})
        finally:
            saved.close()
        db.init_db(event_path)
        self.assertEqual(snapshot.stat().st_mtime_ns, stamp)


if __name__ == '__main__':
    unittest.main()
