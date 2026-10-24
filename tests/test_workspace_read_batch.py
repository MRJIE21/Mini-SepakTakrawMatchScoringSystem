"""Bulk workbench reads preserve single-object rules and fresh authority state."""
import unittest
from app import db, workspace
from app.domain import advancement
from app.api.catalog import team_captain_id,team_profile_gaps
from app.api.common import participation_info, recording_blocker
from app.read_projection import text_integer_rows
import test_independent_review as fixtures


class WorkspaceReadBatchTest(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.IndependentReviewTest();self.fixture.setUp();self.conn=self.fixture.conn
    def tearDown(self):self.fixture.tearDown()

    def test_bulk_matches_keep_profile_rules_and_bounded_queries_without_writes(self):
        self.conn.execute('INSERT INTO team_members(team_id,athlete_id) VALUES(1,1)')
        with db.tx(self.conn):
            self.conn.executemany("""INSERT INTO matches(id,category_id,plan_id,home_source_type,away_source_type,
                home_participation,away_participation,home_actual,away_actual,status)
                VALUES(?,1,1,'participation','participation',1,2,1,2,'ready')""",((i,) for i in range(2,501)))
        received=self.fixture.receive()
        expected=[]
        for part in db.q(self.conn,'SELECT * FROM participations WHERE category_id=1'):
            info=participation_info(self.conn,part['id'])
            expected.append({'participation_id':part['id'],'school_id':info['school_id'],'display':info['display'],
                'gaps':team_profile_gaps(self.conn,part['team_id'],team_captain_id(self.conn,part['team_id']))})
        tables=('matches','match_sets','score_events','audit_logs','review_decisions')
        before={table:[tuple(r) for r in db.q(self.conn,f'SELECT * FROM {table}')] for table in tables}
        queries=[];self.conn.set_trace_callback(queries.append)
        try:snapshot=workspace.category_snapshot(self.conn,1,'organizer')
        finally:self.conn.set_trace_callback(None)
        self.assertEqual(snapshot['reminders'][0]['items'],expected)
        self.assertEqual(snapshot['counts']['matches_scoreable'],499)
        self.assertEqual(snapshot['counts']['candidates_pending'],1)
        self.assertEqual(snapshot['primary_action']['tab'],'review')
        self.assertLess(len(queries),80,f'Workbench made {len(queries)} queries for 500 matches')
        for table,rows in before.items():self.assertEqual([tuple(r) for r in db.q(self.conn,f'SELECT * FROM {table}')],rows)
        self.conn.execute("UPDATE athletes SET gender='male' WHERE id=1")
        self.conn.execute('UPDATE team_members SET is_captain=1 WHERE team_id=1')
        latest=workspace.category_snapshot(self.conn,1,'organizer')
        self.assertEqual(latest['reminders'][0]['items'][0]['gaps'],['队员不足 3 人（当前 1 人）'])
        db.insert(self.conn,'result_disputes',{'id':'bulk-read-dispute','category_id':1,'subject_kind':'match',
            'subject_id':1,'candidate_id':received['candidate_id'],'affected_json':'[]','reason':'Synthetic dispute',
            'status':'open','updated_at':db.now(self.conn)})
        latest=workspace.category_snapshot(self.conn,1,'organizer')
        self.assertEqual(latest['counts']['matches_scoreable'],0)
        self.assertEqual(latest['counts']['disputes_open'],1)

    def test_individual_profiles_use_current_gender_and_empty_does_not_complete(self):
        unknown=workspace.category_snapshot(self.conn,2,'organizer')
        self.assertEqual(unknown['counts']['profiles_incomplete'],1)
        self.conn.execute("UPDATE athletes SET gender='male' WHERE id=1")
        latest=workspace.category_snapshot(self.conn,2,'organizer')
        self.assertEqual(latest['counts']['profiles_incomplete'],0)
        self.conn.execute("UPDATE participations SET status='withdrawn' WHERE id=3")
        empty=workspace.category_snapshot(self.conn,2,'organizer')
        self.assertEqual(empty['primary_action']['tab'],'registration')
        self.assertNotEqual(next(s for s in empty['steps'] if s['tab']=='entry')['state'],'complete')

    def test_projection_preserves_unicode_null_large_ids_and_order(self):
        self.conn.execute('CREATE TEMP TABLE projection_values(id INTEGER, label TEXT, optional TEXT)')
        values=[(2**60,'同名·甲 "引号"\n换行',None),(0,'',''),(-1,'\\路径/表情🏐','null')]
        self.conn.executemany('INSERT INTO projection_values VALUES(?,?,?)',values)
        sql='SELECT id,label,optional FROM projection_values ORDER BY id DESC'
        expected=[dict(row) for row in db.q(self.conn,sql)]
        self.assertEqual(text_integer_rows(self.conn,sql,('id','label','optional')),expected)
        self.assertEqual(text_integer_rows(self.conn,sql+' LIMIT 0',('id','label','optional')),[])
        with self.assertRaises(ValueError):text_integer_rows(self.conn,sql,('id','id'))

    def test_bulk_eligibility_matches_single_stage_rules_and_fresh_changes(self):
        self.conn.execute("INSERT INTO stages(id,plan_id,seq,kind,name) VALUES(1,1,1,'custom','Synthetic custom')")
        self.conn.execute('UPDATE matches SET stage_id=1 WHERE id=1')
        for status in ('draft','previewed','locked','running','archived'):
            for kind in ('custom','round_robin'):
                for metadata in ({},{'schedule_meta':{'state':'draft'}},{'schedule_meta':{'state':'confirmed'}}):
                    with self.subTest(status=status,kind=kind,metadata=metadata):
                        import json
                        self.conn.execute('UPDATE plans SET status=? WHERE id=1',(status,))
                        self.conn.execute('UPDATE stages SET kind=?,params_json=? WHERE id=1',(kind,json.dumps(metadata)))
                        match=db.q1(self.conn,'SELECT * FROM matches WHERE id=1')
                        expected=0 if recording_blocker(self.conn,match) else 1
                        self.assertEqual(workspace.category_snapshot(self.conn,1,'organizer')['counts']['matches_scoreable'],expected)

    def test_refresh_skips_queries_and_writes_for_unchanged_ready_matches(self):
        with db.tx(self.conn):
            self.conn.executemany("""INSERT INTO matches(id,category_id,plan_id,home_source_type,away_source_type,
                home_participation,away_participation,home_actual,away_actual,status)
                VALUES(?,1,1,'participation','participation',1,2,1,2,'ready')""",((i,) for i in range(2,501)))
        before=[tuple(r) for r in db.q(self.conn,'SELECT * FROM matches ORDER BY id')]
        statements=[];self.conn.set_trace_callback(statements.append)
        try:result=advancement.refresh_plan(self.conn,1)
        finally:self.conn.set_trace_callback(None)
        self.assertEqual(result['affected'],[])
        self.assertLess(len(statements),12)
        self.assertFalse([sql for sql in statements if sql.lstrip().upper().startswith('UPDATE')])
        self.assertEqual([tuple(r) for r in db.q(self.conn,'SELECT * FROM matches ORDER BY id')],before)

    def test_refresh_still_protects_claimed_lineup_changes(self):
        self.fixture.request('POST','/api/recording/match/1/claim',{})
        self.conn.execute('UPDATE matches SET home_participation=2,away_participation=1 WHERE id=1')
        result=advancement.refresh_plan(self.conn,1)
        self.assertEqual([r['match_id'] for r in result['affected']],[1])
        self.assertEqual(tuple(db.q1(self.conn,'SELECT home_actual,away_actual FROM matches WHERE id=1')),(1,2))

    def test_refresh_still_protects_returned_candidate_history(self):
        received=self.fixture.receive();self.fixture.grant()
        self.fixture.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",
            self.fixture.decision(received,'return'),user='reviewer')
        self.conn.execute('UPDATE matches SET home_participation=2,away_participation=1 WHERE id=1')
        result=advancement.refresh_plan(self.conn,1)
        self.assertEqual([r['match_id'] for r in result['affected']],[1])
        self.assertEqual(tuple(db.q1(self.conn,'SELECT home_actual,away_actual FROM matches WHERE id=1')),(1,2))


if __name__=='__main__':unittest.main()
