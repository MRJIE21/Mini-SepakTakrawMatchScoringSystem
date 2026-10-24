"""Isolated two-event migration: semantic equality, atomic failure and restart."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import config,db,result_candidates,security
from helpers import backup_archive


class ReviewMigrationTest(unittest.TestCase):
    def setUp(self):
        db.close_thread_connections()
        self.saved=config.DATA_DIR,config.DB_PATH,config.EVENTS_DIR
        self.tmp=tempfile.TemporaryDirectory(prefix='review-migration-')
        self.root=Path(self.tmp.name)
        config.DATA_DIR=self.root;config.DB_PATH=self.root/'registry.db';config.EVENTS_DIR=self.root/'events'
        with patch.object(result_candidates,'initialize'):
            self.dataset=backup_archive.init_dataset(self.root)
        self.paths=[config.DB_PATH,*self.dataset['event_paths'].values()]
        for eid,path in self.dataset['event_paths'].items():
            c=db.connect(path)
            try:
                cid=eid*100;group=eid*10;school=eid*1000
                c.execute("INSERT INTO plans(id,category_id,status) VALUES(1,?,'locked')",(cid,))
                for pid in (11,12):
                    team_school=school+pid
                    c.execute('INSERT INTO schools(id,event_id,name) VALUES(?,?,?)',(team_school,eid,f'参赛学校{pid}'))
                    c.execute('INSERT INTO teams(id,category_id,school_id,name) VALUES(?,?,?,?)',(pid,cid,team_school,f'队伍{pid}'))
                    c.execute('INSERT INTO participations(id,category_id,team_id) VALUES(?,?,?)',(pid,cid,pid))
                c.execute("INSERT INTO categories(id,group_id,gender,kind,name) VALUES(?,?,'male','individual','个人赛')",(cid+1,group))
                for i,status in enumerate(('normal','dns','dnf','dsq','pending'),1):
                    c.execute('INSERT INTO athletes(id,group_id,school_id,name) VALUES(?,?,?,?)',(i,group,school,f'选手{i}'))
                    c.execute('INSERT INTO participations(id,category_id,athlete_id) VALUES(?,?,?)',(i,cid+1,i))
                    c.execute('INSERT INTO individual_results(id,category_id,participation_id,result_status,result_value,confirmed,version) VALUES(?,?,?,?,?,?,1)',
                              (i,cid+1,i,status,0 if status=='normal' else None,int(status!='pending')))
                for i,status in enumerate(('normal','home_forfeit','away_forfeit','cancelled','unfinished'),1):
                    c.execute("INSERT INTO matches(id,category_id,plan_id,home_source_type,away_source_type,home_actual,away_actual,status,result_status,result_version,reset_state) VALUES(?,?,1,'participation','participation',11,12,'finished',?,1,?)",
                              (i,cid,status,'review' if i==5 else 'none'))
                    if i==1:
                        c.execute("INSERT INTO match_sets(match_id,set_no,home_points,away_points,winner_side) VALUES(1,1,15,8,'home')")
                        c.execute("INSERT INTO score_events(match_id,seq,kind,set_no,side,home_after,away_after) VALUES(1,1,'score',1,'home',1,0)")
                c.execute("INSERT INTO settings(k,v) VALUES('review-migration-fixture','legacy_mixed / reset history')")
                c.execute("INSERT INTO submissions(uid,kind,match_id,payload_hash,status) VALUES('old-uid','match',1,'old-hash','confirmed')")
            finally:c.close()

    def tearDown(self):
        db.close_thread_connections()
        config.DATA_DIR,config.DB_PATH,config.EVENTS_DIR=self.saved
        self.tmp.cleanup()

    def semantic(self,path):
        c=db.connect(path)
        try:
            tables=('matches','match_sets','score_events','individual_results','placements','pool_rank_snapshots',
                    'school_points','submissions','request_log','display_screens','display_pair_codes','categories')
            return {t:[tuple(r) for r in c.execute(f'SELECT * FROM {t} ORDER BY rowid')] for t in tables}
        finally:c.close()

    def test_all_databases_keep_legacy_semantics_and_no_fabricated_reviewer(self):
        before={p:self.semantic(p) for p in self.paths}
        for path in self.paths:
            c=db.connect(path)
            try:
                result_candidates.initialize(c)
                count=c.execute('SELECT COUNT(*) FROM official_versions').fetchone()[0]
                result_candidates.initialize(c)
                self.assertEqual(c.execute('SELECT COUNT(*) FROM official_versions').fetchone()[0],count)
                self.assertEqual(c.execute('SELECT COUNT(*) FROM review_grants').fetchone()[0],0)
                self.assertEqual(c.execute('SELECT COUNT(*) FROM official_versions WHERE reviewer_id IS NOT NULL OR candidate_id IS NOT NULL OR legacy<>1').fetchone()[0],0)
                self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
            finally:c.close()
            self.assertEqual(self.semantic(path),before[path])
            # Real initialization on restart must preserve every old business row.
            db.init_db(path)
            self.assertEqual(self.semantic(path),before[path])
        self.assertTrue(list(config.backups_dir().glob('*before-independent-review*')))

    def test_schema_history_and_marker_roll_back_together(self):
        path=self.dataset['event_paths'][1];before=self.semantic(path);c=db.connect(path)
        try:
            with patch.object(result_candidates,'save_official_history',side_effect=RuntimeError('migration interrupted')):
                with self.assertRaisesRegex(RuntimeError,'interrupted'):result_candidates.initialize(c)
            self.assertIsNone(c.execute("SELECT name FROM sqlite_master WHERE name='result_candidates'").fetchone())
            self.assertIsNone(c.execute("SELECT v FROM settings WHERE k='result_review_schema'").fetchone())
            self.assertEqual(self.semantic(path),before)
            result_candidates.initialize(c)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM official_versions').fetchone()[0],10)
        finally:c.close()

    def test_unknown_schema_refuses_before_any_new_structure(self):
        c=db.connect(self.dataset['event_paths'][1])
        try:
            c.execute("INSERT INTO settings(k,v) VALUES('result_review_schema','999')")
            with self.assertRaisesRegex(RuntimeError,'版本'):result_candidates.initialize(c)
            self.assertIsNone(c.execute("SELECT name FROM sqlite_master WHERE name='result_candidates'").fetchone())
        finally:c.close()


if __name__=='__main__':unittest.main()
