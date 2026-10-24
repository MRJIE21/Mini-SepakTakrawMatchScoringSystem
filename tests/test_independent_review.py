"""Real HTTP + isolated registry/event databases for independent review."""
import copy
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from app import config,db,security,result_candidates
from app.domain import validation
from app.http_server import Handler,create_server,load_routes

load_routes()


class IndependentReviewTest(unittest.TestCase):
    def setUp(self):
        db.close_thread_connections()
        self.saved=(config.DATA_DIR,config.DB_PATH,config.EVENTS_DIR)
        self.tmp=Path(tempfile.mkdtemp(prefix='stss-independent-review-'))
        config.DATA_DIR=self.tmp;config.DB_PATH=self.tmp/'registry.db';config.EVENTS_DIR=self.tmp/'events'
        config.EVENTS_DIR.mkdir()
        db.init_db()
        registry=db.connect()
        self.tokens={};self.ids={}
        for name,role in [('author','organizer'),('reviewer','organizer'),('admin','admin'),('recorder','recorder'),('viewer','viewer'),('display','display_operator')]:
            uid=security.create_user(registry,name,'test-pass-123',role,name)
            self.ids[name]=uid;self.tokens[name]=security.issue_token(registry,uid)
            registry.execute('INSERT INTO settings(k,v) VALUES(?,?)',(f'access:user:{uid}','[1]'))
        registry.execute("INSERT INTO events(id,uuid,name) VALUES(1,'review-event','Review fixture')")
        event=db.q1(registry,'SELECT * FROM events WHERE id=1')
        db.create_event_database(1,dict(event),registry)
        registry.close()
        self.conn=db.connect(config.EVENTS_DIR/'event_1.db')
        c=self.conn
        c.execute("INSERT INTO groups(id,event_id,code,name) VALUES(1,1,'甲','甲组')")
        c.execute("INSERT INTO categories(id,group_id,gender,kind,name) VALUES(1,1,'male','team','男三人'),(2,1,'male','individual','男个人')")
        for i in (1,2):
            c.execute('INSERT INTO schools(id,event_id,name) VALUES(?,1,?)',(i,f'School {i}'))
            c.execute('INSERT INTO teams(id,category_id,school_id,name) VALUES(?,1,?,?)',(i,i,f'Team {i}'))
            c.execute('INSERT INTO participations(id,category_id,team_id) VALUES(?,1,?)',(i,i))
        c.execute("INSERT INTO athletes(id,group_id,school_id,name) VALUES(1,1,1,'Athlete')")
        c.execute('INSERT INTO participations(id,category_id,athlete_id) VALUES(3,2,1)')
        c.execute("INSERT INTO plans(id,category_id,status) VALUES(1,1,'locked')")
        c.execute("""INSERT INTO matches(id,category_id,plan_id,home_source_type,away_source_type,
            home_participation,away_participation,home_actual,away_actual,status)
            VALUES(1,1,1,'participation','participation',1,2,1,2,'ready')""")
        self.ident=result_candidates.identity(c,1)
        self.server=create_server(('127.0.0.1',0),Handler,background_sync=False)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_address[1]}'

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join()
        self.conn.close();db.close_thread_connections()
        config.DATA_DIR,config.DB_PATH,config.EVENTS_DIR=self.saved

    def request(self,method,path,body=None,user='author',expect=200,protocol='3'):
        req=urllib.request.Request(self.base+path,method=method,data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type':'application/json','Authorization':'Bearer '+self.tokens[user],
                     'X-Event-ID':'1','X-Event-UUID':self.ident['event_uuid'],'X-Client-Protocol':protocol})
        try:
            with urllib.request.urlopen(req,timeout=15) as r:status=r.status;data=json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:status=e.code;data=json.loads(e.read())
            finally:e.close()
        if expect is not None:self.assertEqual(status,expect,(path,status,data))
        return data

    def grant(self,user='reviewer',active=True,base_version=0):
        return self.request('POST','/api/events/1/review-grants',{'user_id':self.ids[user],'active':active,
            'base_version':base_version,'reason':'隔离复核测试'},user='admin')

    def packet(self,kind='match',status=None):
        sid=1 if kind=='match' else 3
        payload={'base_version':0,'claim_epoch':0,'event_identity':self.ident,'result_status':status or ('home_forfeit' if kind=='match' else 'normal')}
        if kind=='match':payload.update({'plan_version':1,'home_participation':1,'away_participation':2,'sets':[],'events':[]})
        else:payload.update({'result_value':12,'error_count':2,'violation_count':0})
        return {'payload_schema':3,'subject_kind':kind,'subject_id':sid,'operation':'initial','submission_uid':uuid.uuid4().hex,'payload':payload}

    def receive(self,packet=None):
        return self.request('POST','/api/result-candidates',packet or self.packet())

    def decision(self,received,action='approve'):
        receipt=received['receipt']
        return {'decision_uid':uuid.uuid4().hex,'action':action,'revision':receipt['revision'],
                'candidate_hash':receipt['candidate_hash'],'base_version':0,'reason':'test' if action!='approve' else ''}

    def test_receive_isolated_immutable_idempotent(self):
        packet=self.packet();received=self.receive(packet)
        self.assertEqual(received['receipt']['receipt_kind'],'candidate_received')
        self.assertNotIn('applied_version',received['receipt'])
        self.assertEqual(self.receive(packet),received)
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)
        for table in ('submissions','match_sets','score_events','review_decisions'):
            self.assertEqual(db.q1(self.conn,f'SELECT COUNT(*) FROM {table}')[0],0)
        changed=copy.deepcopy(packet);changed['payload']['result_status']='away_forfeit'
        self.request('POST','/api/result-candidates',changed,expect=409)
        self.request('POST','/api/result-candidates',self.packet(),expect=409)
        with self.assertRaises(sqlite3.IntegrityError):self.conn.execute("UPDATE result_candidates SET payload_json='{}'")
        with self.assertRaises(sqlite3.IntegrityError):self.conn.execute('DELETE FROM result_candidates')

    def test_explicit_grant_and_no_self_review_including_admin(self):
        received=self.receive();path=f"/api/result-candidates/{received['candidate_id']}/decision"
        self.request('POST',path,self.decision(received),user='reviewer',expect=403)
        self.grant('author')
        self.request('POST',path,self.decision(received),expect=403)
        self.grant();body=self.decision(received)
        approved=self.request('POST',path,body,user='reviewer')
        self.assertEqual(approved['receipt']['applied_version'],1)
        self.assertEqual(self.request('POST',path,body,user='reviewer'),approved)
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],1)
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM review_decisions')[0],1)
        self.assertEqual(db.q1(self.conn,'SELECT reviewer_id FROM official_versions WHERE version=1')[0],self.ids['reviewer'])
        # Admin-authored packets cannot be approved even after self-grant.
        self.grant('admin')
        c=self.conn
        c.execute("INSERT INTO matches SELECT 2,category_id,plan_id,plan_version,stage_id,pool_id,seq,round_no,round_label,schedule_role,schedule_revision,winner_rank,loser_rank,venue_id,scheduled_at,home_source_type,home_source_pool,home_source_rank,home_source_match,home_participation,away_source_type,away_source_pool,away_source_rank,away_source_match,away_participation,home_actual,away_actual,'ready',NULL,0,reset_parent_id,reset_state,reset_parent_version,rules_snapshot_json,rules_revision,rules_hash,note,updated_at FROM matches WHERE id=1")
        packet=self.packet();packet['subject_id']=2
        own=self.request('POST','/api/result-candidates',packet,user='admin')
        self.request('POST',f"/api/result-candidates/{own['candidate_id']}/decision",self.decision(own),user='admin',expect=403)

    def test_return_new_revision_keeps_authors(self):
        self.grant();received=self.receive();path=f"/api/result-candidates/{received['candidate_id']}/decision"
        body=self.decision(received,'return');body['reason']=''
        self.request('POST',path,body,user='reviewer',expect=400)
        body['reason']='核对原件';self.request('POST',path,body,user='reviewer')
        packet=self.packet();packet['parent_id']=received['candidate_id']
        revised=self.receive(packet)
        self.assertEqual(revised['revision'],2)
        detail=self.request('GET',f"/api/result-candidates/{revised['candidate_id']}")['candidate']
        self.assertIn(self.ids['author'],detail['authors'])
        self.grant('author')
        self.request('POST',f"/api/result-candidates/{revised['candidate_id']}/decision",self.decision(revised),expect=403)

    def test_individual_pending_not_final_and_ranks_separate(self):
        self.grant();received=self.receive(self.packet('individual','pending'))
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer',expect=422)
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM individual_results')[0],0)
        self.request('POST','/api/categories/2/individual-rankings/confirm',{},expect=409)
        withdraw=self.decision(received,'return')
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",withdraw,user='reviewer')
        received=self.receive(self.packet('individual'))
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer')
        result=db.q1(self.conn,'SELECT * FROM individual_results')
        self.assertIsNone(result['rank_no']);self.assertEqual(result['confirmed'],1)
        self.request('POST','/api/categories/2/individual-rankings/confirm',{})
        self.assertEqual(db.q1(self.conn,'SELECT rank_no FROM individual_results')[0],1)

    def test_concurrent_confirm_return_single_decision(self):
        self.grant();self.grant('admin');received=self.receive()
        path=f"/api/result-candidates/{received['candidate_id']}/decision"
        barrier=threading.Barrier(2)
        def do(user,action):
            barrier.wait();return self.request('POST',path,self.decision(received,action),user=user,expect=None)
        with ThreadPoolExecutor(2) as executor:
            a=executor.submit(do,'reviewer','approve');b=executor.submit(do,'admin','return');results=[a.result(),b.result()]
        self.assertEqual(sum(bool(r.get('receipt')) for r in results),1,results)
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM review_decisions')[0],1)

    def test_failure_rolls_back_official_and_decision(self):
        self.grant();received=self.receive()
        from app.api import scoring
        with patch.object(scoring,'_revalidate_placements',side_effect=RuntimeError('injected after score write')):
            self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer',expect=500)
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM submissions')[0],0)
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM review_decisions')[0],0)
        self.assertEqual(db.q1(self.conn,'SELECT status FROM candidate_heads')[0],'submitted')

    def test_old_writes_and_readonly_roles_cannot_bypass(self):
        for endpoint in ('/api/scoring/submit','/api/scoring/individual','/api/matches/1/correction','/api/matches/1/cancel','/api/matches/1/reset-review'):
            self.request('POST',endpoint,{'event_identity':self.ident},user='admin',expect=426)
        for user in ('viewer','display'):
            self.request('POST','/api/result-candidates',self.packet(),user=user,expect=403)
            self.request('GET','/api/result-candidates',user=user,expect=403)
        old=self.packet()['payload'];old['match_id']=1;old['submission_uid']='legacy-old-uid'
        self.conn.execute('''INSERT INTO submissions(uid,kind,match_id,payload_hash,status,user_id,base_version)
            VALUES(?,'match',1,?,'confirmed',?,0)''',(old['submission_uid'],validation.payload_hash(old),self.ids['author']))
        result=self.request('POST','/api/scoring/submit',old,protocol='2')
        self.assertTrue(result['duplicate']);self.assertEqual(result['receipt']['status'],'confirmed')
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)

    def test_revocation_uses_registry_not_stale_snapshot(self):
        self.grant();received=self.receive();path=f"/api/result-candidates/{received['candidate_id']}/decision"
        # A stale event snapshot cannot grant access after registry suspension.
        reg=db.connect();reg.execute('UPDATE users SET active=0 WHERE id=?',(self.ids['reviewer'],));reg.close()
        self.request('POST',path,self.decision(received),user='reviewer',expect=401)
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)

    def test_old_binary_writes_fail_closed(self):
        old=sqlite3.connect(config.EVENTS_DIR/'event_1.db')
        try:
            with self.assertRaises(sqlite3.OperationalError):old.execute('UPDATE matches SET result_version=9 WHERE id=1')
        finally:old.close()

    def approve_initial(self):
        self.grant();received=self.receive()
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer')
        return received

    def correction(self,actions=None):
        impact=self.request('GET','/api/result-candidates/impact?subject_kind=match&subject_id=1')
        packet=self.packet();packet['operation']='correction'
        packet['payload'].update({'base_version':1,'reason':'比分依据核对','result_status':'away_forfeit',
            'events_mode':'retain','retained_events_hash':validation.payload_hash([])})
        packet.update({'impact_hash':impact['impact_hash'],'impact_actions':actions or []})
        return packet

    def test_correction_preserves_formal_until_independent_approval(self):
        self.approve_initial()
        received=self.receive(self.correction())
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],1)
        self.assertEqual(db.q1(self.conn,'SELECT result_status FROM matches WHERE id=1')[0],'home_forfeit')
        self.request('POST','/api/recording/match/1/claim',{},user='recorder',expect=409)
        body=self.decision(received);body['base_version']=1
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",body,user='reviewer')
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],2)
        self.assertEqual(db.q1(self.conn,'SELECT result_status FROM matches WHERE id=1')[0],'away_forfeit')
        self.assertEqual(db.q1(self.conn,"SELECT COUNT(*) FROM result_disputes WHERE status='open'")[0],0)

    def test_claimed_downstream_requires_explicit_retained_history(self):
        self.approve_initial()
        self.conn.execute("""INSERT INTO matches(id,category_id,plan_id,home_source_type,home_source_match,
            away_source_type,away_participation,home_actual,away_actual,status)
            VALUES(2,1,1,'match_winner',1,'participation',1,2,1,'ready')""")
        self.request('POST','/api/recording/match/2/claim',{},user='recorder')
        received=self.receive(self.correction())
        body=self.decision(received);body['base_version']=1
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",body,user='reviewer',expect=409)
        self.assertEqual(db.q1(self.conn,'SELECT home_actual FROM matches WHERE id=2')[0],2)
        returned=self.decision(received,'return');returned['base_version']=1
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",returned,user='reviewer')
        self.assertEqual(db.q1(self.conn,"SELECT COUNT(*) FROM result_disputes WHERE status='open'")[0],1)
        preserve=self.correction([{'match_id':2,'base_version':0,'action':'preserve','reason':'先核验旧对阵能否保留'}])
        preserve['parent_id']=received['candidate_id'];preserved=self.receive(preserve)
        body=self.decision(preserved);body['base_version']=1
        failure=self.request('POST',f"/api/result-candidates/{preserved['candidate_id']}/decision",body,user='reviewer',expect=409)
        self.assertEqual(failure['code'],'impact_preserve_invalid')
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],1)
        returned=self.decision(preserved,'return');returned['base_version']=1
        self.request('POST',f"/api/result-candidates/{preserved['candidate_id']}/decision",returned,user='reviewer')
        packet=self.correction([{'match_id':2,'base_version':0,'action':'cancel','reason':'外部裁决后保留旧场历史，另行排场','draft_acknowledged':True}])
        packet['parent_id']=preserved['candidate_id']
        revised=self.receive(packet);body=self.decision(revised);body['base_version']=1
        self.request('POST',f"/api/result-candidates/{revised['candidate_id']}/decision",body,user='reviewer')
        downstream=db.q1(self.conn,'SELECT * FROM matches WHERE id=2')
        self.assertEqual((downstream['home_actual'],downstream['away_actual']),(2,1))
        self.assertEqual((downstream['result_status'],downstream['result_version']),('cancelled',1))
        self.assertEqual(db.q1(self.conn,"SELECT COUNT(*) FROM official_versions WHERE subject_id=2 AND version=1")[0],1)

    def test_revocation_and_confirmation_registry_fence_order(self):
        self.grant();received=self.receive();path=f"/api/result-candidates/{received['candidate_id']}/decision"
        seen=threading.Event();original=security.user_for_token
        def observe(conn,token):
            result=original(conn,token)
            if token==self.tokens['reviewer'] and result:seen.set()
            return result
        reg=db.connect()
        try:
            with ThreadPoolExecutor(1) as pool, patch.object(security,'user_for_token',side_effect=observe):
                with db.tx(reg):
                    reg.execute('UPDATE users SET active=0 WHERE id=?',(self.ids['reviewer'],))
                    future=pool.submit(self.request,'POST',path,self.decision(received),'reviewer',401)
                    self.assertTrue(seen.wait(4),'Request must first observe the uncommitted old active snapshot')
                future.result()
        finally:reg.close()
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)

    def test_event_commit_then_registry_failure_retains_original_receipt(self):
        self.grant();received=self.receive();body=self.decision(received)
        path=f"/api/result-candidates/{received['candidate_id']}/decision";original=db.tx
        @contextmanager
        def fail_after_registry_commit(conn=None):
            target=conn or db.get_conn()
            is_registry=target is db.get_conn()
            nested=target.in_transaction
            with original(conn) as value:yield value
            if is_registry and not nested:raise RuntimeError('injected after event and registry commit')
        with patch.object(db,'tx',side_effect=fail_after_registry_commit):
            result=self.request('POST',path,body,user='reviewer',expect=500)
        self.assertNotEqual(result['outcome'],'not_committed')
        receipt=self.request('GET','/api/review-receipts/'+body['decision_uid'],user='reviewer')
        self.assertTrue(receipt['found']);self.assertEqual(receipt['receipt']['applied_version'],1)
        self.request('POST',path,body,user='reviewer')
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM review_decisions')[0],1)

    def test_committed_exact_replay_is_readonly_under_other_writers_and_rechecks_grant(self):
        self.grant();received=self.receive();body=self.decision(received)
        path=f"/api/result-candidates/{received['candidate_id']}/decision"
        original=self.request('POST',path,body,user='reviewer')
        tables=('matches','match_sets','score_events','submissions','review_decisions','review_receipts','audit_logs')
        before={table:[tuple(row) for row in db.q(self.conn,f'SELECT * FROM {table}')] for table in tables}
        registry=db.connect();event=db.connect(config.EVENTS_DIR/'event_1.db')
        try:
            with db.tx(registry),db.tx(event):
                self.assertEqual(self.request('POST',path,body,user='reviewer'),original)
                changed={**body,'reason':'altered replay'}
                self.request('POST',path,changed,user='reviewer',expect=409)
        finally:registry.close();event.close()
        for table,rows in before.items():self.assertEqual([tuple(row) for row in db.q(self.conn,f'SELECT * FROM {table}')],rows)
        self.grant(active=False,base_version=1)
        self.request('POST',path,body,user='reviewer',expect=403)
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM review_decisions')[0],1)

    def test_scope_token_and_role_revocation_win_the_registry_fence(self):
        self.grant();received=self.receive();path=f"/api/result-candidates/{received['candidate_id']}/decision"
        original=security.user_for_token
        for authority,expected in (('scope',403),('token',401),('role',403)):
            with self.subTest(authority=authority):
                seen=threading.Event();reg=db.connect();uid=self.ids['reviewer']
                old_token=dict(db.q1(reg,'SELECT * FROM tokens WHERE user_id=?',(uid,)))
                def observe(conn,token):
                    result=original(conn,token)
                    if token==self.tokens['reviewer'] and result:seen.set()
                    return result
                try:
                    with ThreadPoolExecutor(1) as pool,patch.object(security,'user_for_token',side_effect=observe):
                        with db.tx(reg):
                            if authority=='scope':reg.execute('UPDATE settings SET v=? WHERE k=?',('[]',f'access:user:{uid}'))
                            elif authority=='token':reg.execute('DELETE FROM tokens WHERE user_id=?',(uid,))
                            else:reg.execute("UPDATE users SET role='viewer' WHERE id=?",(uid,))
                            future=pool.submit(self.request,'POST',path,self.decision(received),'reviewer',expected)
                            self.assertTrue(seen.wait(4),'Request first reads the uncommitted old authority snapshot')
                        future.result()
                    self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)
                finally:
                    if authority=='scope':reg.execute('UPDATE settings SET v=? WHERE k=?',('[1]',f'access:user:{uid}'))
                    elif authority=='token':db.insert(reg,'tokens',old_token)
                    else:reg.execute("UPDATE users SET role='organizer' WHERE id=?",(uid,))
                    reg.close()

    def test_approval_commits_before_a_later_registry_revocation(self):
        from app import result_review
        self.grant();received=self.receive();entered=threading.Event();release=threading.Event()
        requested=threading.Event();revoked=threading.Event();original=result_review.materialize
        def hold(*args):
            entered.set()
            if not release.wait(8):raise RuntimeError('test barrier timed out')
            return original(*args)
        def revoke():
            reg=db.connect();requested.set()
            try:
                with db.tx(reg):reg.execute('UPDATE users SET active=0 WHERE id=?',(self.ids['reviewer'],))
                revoked.set()
            finally:reg.close()
        with ThreadPoolExecutor(2) as pool,patch.object(result_review,'materialize',side_effect=hold):
            future=pool.submit(self.request,'POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),'reviewer')
            try:
                self.assertTrue(entered.wait(4));later=pool.submit(revoke)
                self.assertTrue(requested.wait(4));self.assertFalse(revoked.wait(.15))
            finally:release.set()
            self.assertEqual(future.result()['receipt']['applied_version'],1);later.result()
        self.assertTrue(revoked.is_set())
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],1)

    def test_event_grant_revocation_is_checked_after_the_event_lock(self):
        self.grant();received=self.receive();seen=threading.Event();original=security.user_for_token
        def observe(conn,token):
            result=original(conn,token)
            if token==self.tokens['reviewer'] and result:seen.set()
            return result
        with ThreadPoolExecutor(1) as pool,patch.object(security,'user_for_token',side_effect=observe):
            with db.tx(self.conn):
                self.conn.execute('UPDATE review_grants SET active=0 WHERE user_id=?',(self.ids['reviewer'],))
                future=pool.submit(self.request,'POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),'reviewer',403)
                self.assertTrue(seen.wait(4))
            future.result()
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)

    def test_withdraw_keeps_dispute_until_an_independent_resolution(self):
        self.approve_initial();received=self.receive(self.correction())
        body=self.decision(received,'withdraw');body['base_version']=1
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/withdraw",body)
        self.assertEqual(db.q1(self.conn,"SELECT COUNT(*) FROM result_disputes WHERE status='open'")[0],1)
        packet=self.correction();packet['operation']='resolve_dispute'
        packet['payload']['reason']='核对原始记录和外部裁定，维持原正式结果'
        resolution=self.receive(packet);body=self.decision(resolution);body['base_version']=1
        self.grant('author')
        self.request('POST',f"/api/result-candidates/{resolution['candidate_id']}/decision",body,expect=403)
        self.request('POST',f"/api/result-candidates/{resolution['candidate_id']}/decision",body,user='reviewer')
        row=db.q1(self.conn,'SELECT result_version,result_status FROM matches WHERE id=1')
        self.assertEqual(tuple(row),(1,'home_forfeit'))
        self.assertEqual(db.q1(self.conn,"SELECT COUNT(*) FROM result_disputes WHERE status='open'")[0],0)

    def test_individual_correction_only_invalidates_rankings_when_approved(self):
        self.grant();received=self.receive(self.packet('individual'))
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer')
        self.request('POST','/api/categories/2/individual-rankings/confirm',{})
        before={t:[tuple(r) for r in db.q(self.conn,f'SELECT * FROM {t}')] for t in ('individual_results','placements','school_points')}
        impact=self.request('GET','/api/result-candidates/impact?subject_kind=individual&subject_id=3')
        packet=self.packet('individual');packet.update(operation='correction',impact_hash=impact['impact_hash'],impact_actions=[])
        packet['payload'].update(base_version=1,result_value=30,reason='根据原始记录复核次数')
        received=self.receive(packet)
        for table,rows in before.items():self.assertEqual([tuple(r) for r in db.q(self.conn,f'SELECT * FROM {table}')],rows)
        body=self.decision(received);body['base_version']=1
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",body,user='reviewer')
        result=db.q1(self.conn,'SELECT version,result_value,rank_no FROM individual_results')
        self.assertEqual(tuple(result),(2,30,None))
        self.assertTrue(all(r['status']=='pending' for r in db.q(self.conn,'SELECT status FROM placements')))
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM school_points')[0],0)
        self.request('POST','/api/categories/2/individual-rankings/confirm',{})
        self.assertEqual(db.q1(self.conn,'SELECT rank_no FROM individual_results')[0],1)

    def test_historical_reset_deactivation_requires_independent_approval(self):
        self.conn.execute("UPDATE matches SET reset_state='review' WHERE id=1")
        impact=self.request('GET','/api/result-candidates/impact?subject_kind=match&subject_id=1')
        packet=self.packet();packet.update(operation='reset_review',impact_hash=impact['impact_hash'],impact_actions=[])
        packet['payload'].update(action='deactivate',reason='历史父关系无法核实，保留原件后显式停用')
        received=self.receive(packet);self.grant()
        self.assertEqual(tuple(db.q1(self.conn,'SELECT reset_state,result_version FROM matches WHERE id=1')),('review',0))
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer')
        self.assertEqual(tuple(db.q1(self.conn,'SELECT reset_state,result_version FROM matches WHERE id=1')),('inactive',1))

    def test_live_stream_fence_pending_stale_and_formal_projection(self):
        from app import display_state,display_store
        self.request('POST','/api/recording/match/1/claim',{},user='recorder')
        epoch=result_candidates.epoch_info(self.conn,'match',1)['epoch']
        start={'match_id':1,'draft_uid':'first','claim_epoch':epoch,'expected_stream_epoch':0}
        first=self.request('POST','/api/display/live/start',start,user='recorder')
        self.assertEqual(first,self.request('POST','/api/display/live/start',start,user='recorder'))
        live={**start,'stream_epoch':first['stream_epoch'],'event_seq':20,'home_points':5,'away_points':3}
        self.request('POST','/api/display/live',live,user='recorder')
        second=self.request('POST','/api/display/live/start',{**start,'draft_uid':'second','expected_stream_epoch':1},user='recorder')
        self.assertEqual(second['stream_epoch'],2)
        self.request('POST','/api/display/live',live,user='recorder',expect=409)
        self.request('POST','/api/display/live/start',start,user='recorder',expect=409)
        live.update({'draft_uid':'second','stream_epoch':2,'event_seq':1,'home_points':7})
        self.request('POST','/api/display/live',live,user='recorder')
        self.assertEqual(display_state._tile(self.conn,0,{'match_id':1})['status'],'live')
        packet=self.packet();packet['payload']['claim_epoch']=epoch
        received=self.request('POST','/api/result-candidates',packet,user='recorder')
        tile=display_state._tile(self.conn,0,{'match_id':1})
        self.assertEqual((tile['status'],tile['home']['points']),('pending_review',7))
        self.assertNotIn('candidate_id',tile)
        self.assertNotIn('payload',tile)
        self.request('POST','/api/display/live',live,user='recorder',expect=409)
        self.conn.execute('UPDATE display_live SET expires_at_epoch=1 WHERE match_id=1')
        self.assertEqual(display_state._tile(self.conn,0,{'match_id':1})['status'],'pending_review_stale')
        self.grant()
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer')
        self.assertEqual(display_state._tile(self.conn,0,{'match_id':1})['status'],'finished')
        self.assertIsNone(display_store.live_row(self.conn,1))

    def test_pending_without_live_never_invents_zero_scores(self):
        from app import display_state
        self.receive()
        tile=display_state._tile(self.conn,0,{'match_id':1})
        self.assertEqual(tile['status'],'pending_review')
        self.assertIsNone(tile['home']['points'])
        self.assertIsNone(tile['away']['points'])

    def test_cancel_preview_before_rule_freeze_approves_atomically(self):
        from app import display_state
        impact=self.request('GET','/api/result-candidates/impact?subject_kind=match&subject_id=1')
        packet=self.packet();packet.update({'operation':'cancel','impact_hash':impact['impact_hash']})
        packet['payload'].update({'reason':'比赛取消裁决','result_status':'cancelled'})
        received=self.receive(packet);self.grant()
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer')
        self.assertEqual(db.q1(self.conn,'SELECT result_status FROM matches WHERE id=1')[0],'cancelled')
        self.assertEqual(display_state._tile(self.conn,0,{'match_id':1})['status'],'cancelled')

    def test_restore_refuses_lost_increments_and_preserves_reviewed_archive(self):
        from app import backup_restore
        old=self.tmp/'old-archive'
        backup_restore.build_archive(old)
        received=self.approve_initial()
        expected={table:[tuple(r) for r in db.q(self.conn,f'SELECT * FROM {table}')]
            for table in ('result_candidates','review_decisions','review_receipts','official_versions','review_grants','matches')}
        self.server.shutdown();self.thread.join();self.conn.close();db.close_thread_connections()
        latest=self.tmp/'reviewed-archive';backup_restore.build_archive(latest)
        with self.assertRaisesRegex(backup_restore.RestoreError,'复核'):
            backup_restore.restore_archive(old)
        self.assertTrue(list(config.backups_dir().glob('pre-restore-*/manifest.json')))
        restored=backup_restore.restore_archive(latest)
        self.assertTrue(restored['verified'])
        self.conn=db.connect(config.EVENTS_DIR/'event_1.db')
        for table,rows in expected.items():
            self.assertEqual([tuple(r) for r in db.q(self.conn,f'SELECT * FROM {table}')],rows,table)
        self.assertEqual(result_candidates.candidate(self.conn,received['candidate_id'])['status'],'approved')

    def test_restore_cannot_resurrect_registry_authority(self):
        from app import backup_restore,clock
        self.approve_initial()
        self.server.shutdown();self.thread.join();self.conn.close();db.close_thread_connections()
        archive=self.tmp/'authority-archive';backup_restore.build_archive(archive)
        uid=self.ids['reviewer'];reg=db.connect()
        original_user=dict(db.q1(reg,'SELECT * FROM users WHERE id=?',(uid,)))
        token_row=dict(db.q1(reg,'SELECT * FROM tokens WHERE user_id=?',(uid,)))
        scope_key=f'access:user:{uid}'
        mutations=(('active',0),('role','viewer'),('scope','[]'),('token',None),('clock',clock.utc_epoch()+3600))
        reg.close()
        try:
            for name,value in mutations:
                with self.subTest(authority=name):
                    reg=db.connect()
                    old_clock=db.q1(reg,'SELECT v FROM settings WHERE k=?',(clock.HIGH_WATER_KEY,))
                    if name in ('active','role'):reg.execute(f'UPDATE users SET {name}=? WHERE id=?',(value,uid))
                    elif name=='scope':reg.execute('UPDATE settings SET v=? WHERE k=?',(value,scope_key))
                    elif name=='token':reg.execute('DELETE FROM tokens WHERE user_id=?',(uid,))
                    else:reg.execute('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)',(clock.HIGH_WATER_KEY,str(value)))
                    reg.close()
                    with self.assertRaisesRegex(backup_restore.RestoreError,'复核'):
                        backup_restore.restore_archive(archive)
                    reg=db.connect()
                    if name in ('active','role'):
                        self.assertEqual(db.q1(reg,f'SELECT {name} FROM users WHERE id=?',(uid,))[0],value)
                        reg.execute(f'UPDATE users SET {name}=? WHERE id=?',(original_user[name],uid))
                    elif name=='scope':
                        self.assertEqual(db.q1(reg,'SELECT v FROM settings WHERE k=?',(scope_key,))[0],value)
                        reg.execute('UPDATE settings SET v=? WHERE k=?',('[1]',scope_key))
                    elif name=='token':
                        self.assertEqual(db.q1(reg,'SELECT COUNT(*) FROM tokens WHERE user_id=?',(uid,))[0],0)
                        db.insert(reg,'tokens',token_row)
                    elif old_clock:reg.execute('UPDATE settings SET v=? WHERE k=?',(old_clock[0],clock.HIGH_WATER_KEY))
                    else:reg.execute('DELETE FROM settings WHERE k=?',(clock.HIGH_WATER_KEY,))
                    reg.close()
        finally:self.conn=db.connect(config.EVENTS_DIR/'event_1.db')

    def test_unclaimed_candidate_freezes_upstream_roster_and_draw(self):
        from app import registration
        from app.errors import ApiError
        self.receive()
        with self.assertRaises(ApiError):registration.guard_team_roster(self.conn,1)
        self.receive(self.packet('individual','pending'))
        draw=self.request('GET','/api/categories/2/individual-draw')['draw']
        self.assertFalse(draw['can_draw'])
        self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM individual_results')[0],0)

    def test_typed_versions_and_immutable_decision_body(self):
        for field in ('claim_epoch','plan_version','home_participation'):
            packet=self.packet();packet['payload'][field]=True
            self.request('POST','/api/result-candidates',packet,expect=400)
        received=self.receive();self.grant()
        path=f"/api/result-candidates/{received['candidate_id']}/decision"
        for field in ('revision','base_version'):
            body=self.decision(received);body[field]=True
            self.request('POST',path,body,user='reviewer',expect=400)
        body=self.decision(received);body['result_value']=999
        self.request('POST',path,body,user='reviewer',expect=400)
        for value in ('false',1,None):
            body=self.decision(received);body['legacy_authorship_attested']=value
            self.request('POST',path,body,user='reviewer',expect=400)
        body=self.decision(received);body['candidate_hash']='0'*64
        self.request('POST',path,body,user='reviewer',expect=409)
        self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=1')[0],0)

    def test_candidate_history_cannot_be_deleted_after_return(self):
        received=self.receive()
        self.request('DELETE','/api/matches/1',{},expect=409)
        self.grant()
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received,'return'),user='reviewer')
        self.request('DELETE','/api/matches/1',{},expect=409)
        self.assertEqual(result_candidates.candidate(self.conn,received['candidate_id'])['status'],'returned')

    def test_faults_after_each_formal_write_leave_no_partial_decision(self):
        from app import result_review
        self.grant()
        for index,target in enumerate(('match_sets','score_events','matches','official_history','review_decisions','review_receipts','review_audit'),2):
            with self.subTest(target=target):
                self.conn.execute("""INSERT INTO matches(id,category_id,plan_id,home_source_type,away_source_type,
                    home_participation,away_participation,home_actual,away_actual,status)
                    VALUES(?,1,1,'participation','participation',1,2,1,2,'ready')""",(index,))
                packet=self.packet();packet['subject_id']=index
                packet['payload'].update({'result_status':'normal',
                    'sets':[{'set_no':n,'home_points':15,'away_points':0,'winner_side':'home'} for n in (1,2)],
                    'events':[{'seq':n,'kind':'score','set_no':(n-1)//15+1,'side':'home','home_after':(n-1)%15+1,'away_after':0} for n in range(1,31)]})
                received=self.receive(packet)
                original_insert,original_update,original_save,original_audit=db.insert,db.update,result_candidates.save_official_history,security.audit
                def insert(conn,table,data):
                    value=original_insert(conn,table,data)
                    if table==target:raise RuntimeError('injected after '+target)
                    return value
                def update(conn,table,sid,data):
                    value=original_update(conn,table,sid,data)
                    if target=='matches' and table=='matches' and 'result_version' in data:raise RuntimeError('injected after version')
                    return value
                def save(conn,kind,sid,snapshot,*args,**kwargs):
                    value=original_save(conn,kind,sid,snapshot,*args,**kwargs)
                    if target=='official_history' and snapshot['version']>0:raise RuntimeError('injected after official history')
                    return value
                def audit(conn,user,action,*args,**kwargs):
                    value=original_audit(conn,user,action,*args,**kwargs)
                    if target=='review_audit' and action=='review_approve':raise RuntimeError('injected after review audit')
                    return value
                with patch.object(db,'insert',side_effect=insert),patch.object(db,'update',side_effect=update),patch.object(
                        result_candidates,'save_official_history',side_effect=save),patch.object(security,'audit',side_effect=audit):
                    self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='reviewer',expect=500)
                self.assertEqual(db.q1(self.conn,'SELECT result_version FROM matches WHERE id=?',(index,))[0],0)
                self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM match_sets WHERE match_id=?',(index,))[0],0)
                self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM score_events WHERE match_id=?',(index,))[0],0)
                self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM official_versions WHERE subject_id=?',(index,))[0],0)
                self.assertEqual(result_candidates.candidate(self.conn,received['candidate_id'])['status'],'submitted')
                self.assertEqual(db.q1(self.conn,'SELECT COUNT(*) FROM review_decisions')[0],0)
                self.assertEqual(db.q1(self.conn,"SELECT COUNT(*) FROM review_receipts WHERE action<>'receive'")[0],0)

    def test_queue_authorizes_before_count_and_cursor_has_no_200_row_dead_end(self):
        ids=set()
        for mid in range(1,206):
            if mid>1:
                self.conn.execute("""INSERT INTO matches(id,category_id,plan_id,home_source_type,away_source_type,
                    home_participation,away_participation,home_actual,away_actual,status)
                    VALUES(?,1,1,'participation','participation',1,2,1,2,'ready')""",(mid,))
            packet=self.packet();packet['subject_id']=mid
            ids.add(self.receive(packet)['candidate_id'])
        first=self.request('GET','/api/result-candidates?limit=100')
        self.assertEqual((first['total'],len(first['candidates'])),(205,100))
        second=self.request('GET',f"/api/result-candidates?limit=100&cursor={first['next_cursor']}")
        third=self.request('GET',f"/api/result-candidates?limit=100&cursor={second['next_cursor']}")
        combined=[row['id'] for page in (first,second,third) for row in page['candidates']]
        self.assertEqual(len(combined),len(set(combined)))
        self.assertEqual(set(combined),ids)
        self.assertIsNone(third['next_cursor'])
        hidden=self.request('GET','/api/result-candidates?status=all',user='recorder')
        self.assertEqual((hidden['total'],hidden['candidates']),(0,[]))
        self.request('GET','/api/result-candidates?limit=201',expect=400)
        exact=self.request('GET','/api/result-candidates?q='+third['candidates'][0]['id'])
        self.assertEqual(exact['total'],1)

    def test_pending_does_not_leak_into_formal_exports_or_display_hidden_slots(self):
        from app import display_state,display_store
        packet=self.packet();packet['payload']['note']='PRIVATE-CANDIDATE-NOTE'
        self.receive(packet)
        self.receive(self.packet('individual','pending'))
        for role in ('viewer','display'):
            match=self.request('GET','/api/matches/1',user=role)['match']
            self.assertEqual((match['result_version'],match['sets']),(0,[]))
            self.assertNotIn('candidate_id',match)
            self.request('GET','/api/result-candidates',user=role,expect=403)
            # The existing viewer/display whitelist does not expose the
            # individual recording roster; refactoring must not widen it.
            self.request('GET','/api/categories/2/participations',user=role,expect=403)
        for route in ('/api/exports/results.csv?category_id=1','/api/exports/results.xlsx?category_id=1',
                      '/api/exports/record-sheet.html?match_id=1','/api/exports/record-sheet.csv?match_id=1'):
            req=urllib.request.Request(self.base+route,headers={'Authorization':'Bearer '+self.tokens['admin'],
                'X-Event-ID':'1','X-Event-UUID':self.ident['event_uuid']})
            with urllib.request.urlopen(req,timeout=15) as response:raw=response.read()
            self.assertNotIn(b'PRIVATE-CANDIDATE-NOTE',raw)
        display_store.publish_config(self.conn,self.ids['admin'],{'layout':1,'mode':'score',
            'slots':[{'match_id':1}],'visible_slots':[1]})
        device=display_state.build_state(self.conn,{'id':77,'name':'paired fixture','event_id':1})
        self.assertIsNone(device['slots'][0]['match_id'])
        self.assertIsNone(device['slots'][0]['home']['points'])
        preview=display_state.build_state(self.conn,{'id':None,'name':'admin preview','event_id':1})
        self.assertEqual(preview['slots'][0]['status'],'pending_review')

    def test_project_grant_and_recusal_remain_explicit_in_queue_and_decision(self):
        received=self.receive();path=f"/api/result-candidates/{received['candidate_id']}/decision"
        self.request('POST','/api/events/1/review-grants',{'user_id':self.ids['reviewer'],'category_id':2,
            'active':True,'base_version':0,'reason':'仅个人赛复核'},user='admin')
        self.request('POST',path,self.decision(received),user='reviewer',expect=403)
        self.assertFalse(self.request('GET','/api/result-candidates',user='reviewer')['candidates'][0]['can_review'])
        self.request('POST','/api/events/1/review-grants',{'user_id':self.ids['reviewer'],'category_id':1,
            'active':True,'base_version':0,'reason':'三人赛复核'},user='admin')
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/recuse",{'reason':'现场存在回避事项'},user='reviewer')
        self.assertFalse(self.request('GET','/api/result-candidates',user='reviewer')['candidates'][0]['can_review'])
        self.request('POST',path,self.decision(received),user='reviewer',expect=403)
        self.grant('admin')
        self.request('POST',path,self.decision(received),user='admin')

    def test_transfer_retains_every_recording_author(self):
        self.request('POST','/api/recording/match/1/claim',{})
        transfer=self.request('POST','/api/recording/match/1/transfer',{'user_id':self.ids['reviewer'],'reason':'换班保留过程来源'},user='admin')
        packet=self.packet();packet['payload']['claim_epoch']=transfer['claim_epoch']
        received=self.request('POST','/api/result-candidates',packet,user='reviewer')
        detail=self.request('GET',f"/api/result-candidates/{received['candidate_id']}")['candidate']
        self.assertEqual(set(detail['authors']),{self.ids['author'],self.ids['reviewer']})
        self.grant('author');self.grant('reviewer')
        for actor in ('author','reviewer'):
            self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user=actor,expect=403)
        self.grant('admin')
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received),user='admin')

    def test_manual_match_creation_runs_real_advancement_and_serialization(self):
        created=self.request('POST','/api/matches',{'category_id':1,'home_participation':1,
            'away_participation':2,'round_label':'手工新场次'},user='admin')
        match=self.request('GET',f"/api/matches/{created['match_id']}")['match']
        self.assertEqual(match['status'],'ready')
        self.assertEqual((match['home']['participation_id'],match['away']['participation_id']),(1,2))

    def test_fresh_packet_after_return_links_revision_and_new_assigned_author(self):
        self.grant();received=self.receive()
        self.request('POST',f"/api/result-candidates/{received['candidate_id']}/decision",self.decision(received,'return'),user='reviewer')
        self.request('POST','/api/recording/match/1/transfer',{'user_id':self.ids['recorder'],'reason':'新记录员按原件复核后重录'},user='admin')
        packet=self.packet();packet['payload']['claim_epoch']=result_candidates.epoch_info(self.conn,'match',1)['epoch']
        revised=self.request('POST','/api/result-candidates',packet,user='recorder')
        detail=self.request('GET',f"/api/result-candidates/{revised['candidate_id']}",user='recorder')['candidate']
        self.assertEqual((detail['parent_id'],detail['revision']),(received['candidate_id'],2))
        self.assertIn(self.ids['author'],detail['authors']);self.assertIn(self.ids['recorder'],detail['authors'])
        self.request('GET',f"/api/result-candidates/{received['candidate_id']}",user='recorder',expect=403)


if __name__=='__main__':unittest.main()
