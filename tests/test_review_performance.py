"""Opt-in synthetic real-HTTP workload; never reads a deployed data directory."""
import copy
import json
import math
import os
import platform
import random
import sqlite3
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app import config, db, result_candidates
import test_independent_review as fixtures


@unittest.skipUnless(os.environ.get('STSS_PERFORMANCE') == '1', 'Explicit isolated performance run')
class ReviewPerformanceTest(unittest.TestCase):
    def test_synthetic_task_reads_and_independent_confirmations(self):
        case=os.environ.get('STSS_PERF_CASE','1')
        self.assertIn(case,('1','4','8','mixed'))
        workers=8 if case=='mixed' else int(case)
        fixture=fixtures.IndependentReviewTest();fixture.setUp()
        samples=[];mutex=threading.Lock();completed=0
        report={'case':case,'workers':workers,'environment':{
            'platform':platform.platform(),'processor':platform.processor(),'logical_cpus':os.cpu_count(),
            'python':sys.version,'sqlite':sqlite3.sqlite_version,'disk_type':'UNKNOWN'},
            'dataset_per_event':{'matches':1000,'team_enrollments':2000,'pending_candidates':200},
            'warmup_task_cycles':20,'task_cycles':1000,'confirmation_operations':200,
            'task_cycle_http_requests':2,'confirmation_replay_per_operation':1,'sla':'Not specified; measured values only'}
        output=Path(os.environ['STSS_BROWSER_ARTIFACTS'])/f'review-performance-{case}.json'
        identities={1:fixture.ident}
        def request(eid,method,path,body=None,user='author'):
            req=urllib.request.Request(fixture.base+path,method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={'Content-Type':'application/json','Authorization':'Bearer '+fixture.tokens[user],
                    'X-Client-Protocol':'3','X-Event-ID':str(eid),'X-Event-UUID':identities[eid]['event_uuid']})
            try:
                with urllib.request.urlopen(req,timeout=60) as response:return response.status,json.loads(response.read())
            except urllib.error.HTTPError as error:
                try:return error.code,json.loads(error.read())
                finally:error.close()
        def save():
            report['samples']=list(samples)
            output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        try:
            self.assertIn('stss-independent-review-',str(config.DATA_DIR))
            event_ids=[1,2] if case=='mixed' else [1]
            if case=='mixed':
                registry=db.connect()
                try:
                    registry.execute("INSERT INTO events(id,uuid,name) VALUES(2,'performance-event-two','Synthetic second event')")
                    for uid in fixture.ids.values():registry.execute('UPDATE settings SET v=? WHERE k=?',('[1,2]',f'access:user:{uid}'))
                    db.create_event_database(2,dict(db.q1(registry,'SELECT * FROM events WHERE id=2')),registry)
                finally:registry.close()
            candidates={}
            for eid in event_ids:
                conn=fixture.conn if eid==1 else db.connect(config.EVENTS_DIR/'event_2.db')
                try:
                    with db.tx(conn):
                        if eid==1:
                            for table in ('matches','participations','teams','athletes','schools'):conn.execute(f'DELETE FROM {table}')
                        else:
                            conn.execute("INSERT INTO groups(id,event_id,code,name) VALUES(1,2,'A','Synthetic')")
                            conn.execute("INSERT INTO categories(id,group_id,gender,kind,name) VALUES(1,1,'male','team','Synthetic team')")
                            conn.execute("INSERT INTO plans(id,category_id,status) VALUES(1,1,'locked')")
                        conn.executemany('INSERT INTO schools(id,event_id,name) VALUES(?,?,?)',
                            ((i,eid,f'Synthetic school {i}') for i in range(1,2001)))
                        conn.executemany('INSERT INTO school_entries(event_id,group_id,school_id) VALUES(?,1,?)',
                            ((eid,i) for i in range(1,2001)))
                        conn.executemany('INSERT INTO teams(id,category_id,school_id,name) VALUES(?,1,?,?)',
                            ((i,i,f'Synthetic team {i}') for i in range(1,2001)))
                        conn.executemany('INSERT INTO participations(id,category_id,team_id) VALUES(?,1,?)',
                            ((i,i) for i in range(1,2001)))
                        conn.executemany("""INSERT INTO matches(id,category_id,plan_id,home_source_type,away_source_type,
                            home_participation,away_participation,home_actual,away_actual,status)
                            VALUES(?,1,1,'participation','participation',?,?,?,?,'ready')""",
                            ((i,2*i-1,2*i,2*i-1,2*i) for i in range(1,1001)))
                    identities[eid]=result_candidates.identity(conn,1)
                finally:
                    if eid!=1:conn.close()
                status,_=request(eid,'POST',f'/api/events/{eid}/review-grants',{
                    'user_id':fixture.ids['reviewer'],'active':True,'base_version':0,'reason':'Isolated synthetic benchmark'},user='admin')
                self.assertEqual(status,200)
                candidates[eid]=[]
                for mid in range(1,201):
                    packet=copy.deepcopy(fixture.packet());packet['subject_id']=mid
                    packet['submission_uid']=f'performance-{case}-{mid}'
                    packet['payload'].update(event_identity=identities[eid],home_participation=2*mid-1,away_participation=2*mid)
                    status,received=request(eid,'POST','/api/result-candidates',packet)
                    self.assertEqual(status,200,received)
                    candidates[eid].append(received)
            for i in range(20):
                eid=event_ids[i%len(event_ids)]
                for route in ('/api/categories/1/workspace','/api/result-candidates?category_id=1&limit=100'):
                    status,data=request(eid,'GET',route);self.assertEqual(status,200,data)
            print(f'PERFORMANCE warmup complete: case={case}, events={event_ids}',flush=True)
            first=candidates[1][0];denied=fixture.decision(first)
            self.assertEqual(request(1,'POST',f"/api/result-candidates/{first['candidate_id']}/decision",denied)[0],403)
            operations=[('read',event_ids[i%len(event_ids)],i) for i in range(1000)]
            operations += [('confirm',event_ids[i%len(event_ids)],i//len(event_ids)) for i in range(200)]
            random.Random(20261022).shuffle(operations)
            def operation(task):
                nonlocal completed
                kind,eid,index=task;start=time.perf_counter();failures=[]
                try:
                    if kind=='read':
                        for route in ('/api/categories/1/workspace','/api/result-candidates?category_id=1&limit=100'):
                            status,data=request(eid,'GET',route)
                            if status!=200:failures.append({'status':status,'code':data.get('code')})
                            if route.startswith('/api/categories') and data.get('counts',{}).get('enrolled')!=2000:
                                failures.append({'code':'wrong_event_or_enrollment_count'})
                    else:
                        received=candidates[eid][index];body=fixture.decision(received)
                        route=f"/api/result-candidates/{received['candidate_id']}/decision"
                        status,data=request(eid,'POST',route,body,'reviewer')
                        if status!=200 or data.get('receipt',{}).get('applied_version')!=1:
                            failures.append({'status':status,'code':data.get('code','wrong_version')})
                        first_status=status
                        status,replayed=request(eid,'POST',route,body,'reviewer')
                        if status!=200:failures.append({'status':status,'code':replayed.get('code','replay_failed')})
                        elif first_status==200 and replayed!=data:failures.append({'status':status,'code':'replay_mismatch'})
                except Exception as error:failures.append({'code':type(error).__name__})
                sample={'operation':kind,'event_id':eid,'ms':round((time.perf_counter()-start)*1000,3),'failures':failures}
                with mutex:
                    samples.append(sample);completed+=1
                    if completed%100==0:
                        save();print(f'PERFORMANCE case={case}: {completed}/1200 operations',flush=True)
            started=time.perf_counter()
            with ThreadPoolExecutor(workers) as executor:list(executor.map(operation,operations))
            report['seconds']=round(time.perf_counter()-started,3)
            report['summary']={}
            for kind in ('read','confirm'):
                subset=[s for s in samples if s['operation']==kind];values=sorted(s['ms'] for s in subset)
                report['summary'][kind]={'count':len(values),'p50_ms':values[math.ceil(len(values)*.5)-1],
                    'p95_ms':values[math.ceil(len(values)*.95)-1],'failure_operations':sum(bool(s['failures']) for s in subset),
                    'failure_rate':sum(bool(s['failures']) for s in subset)/len(subset),
                    'lock_timeouts':sum('busy' in str(s['failures']).lower() or 'locked' in str(s['failures']).lower() for s in subset)}
            report['correctness']={}
            for eid in event_ids:
                conn=db.connect(config.EVENTS_DIR/f'event_{eid}.db')
                try:
                    expected=100 if case=='mixed' else 200
                    counts={table:conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                        for table in ('review_decisions','submissions','official_versions')}
                    report['correctness'][eid]=counts
                    # Each initial approval retains both its empty base (v0)
                    # and the independently confirmed v1 snapshot.
                    self.assertEqual(counts,{'review_decisions':expected,'submissions':expected,'official_versions':2*expected})
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM official_versions WHERE legacy=0').fetchone()[0],expected)
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM matches WHERE result_version=1').fetchone()[0],expected)
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM matches WHERE result_version NOT IN (0,1)').fetchone()[0],0)
                    self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                    self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(),[])
                    report['correctness'][eid]=counts
                finally:conn.close()
            save();print(json.dumps({k:v for k,v in report.items() if k!='samples'},ensure_ascii=False),flush=True)
            self.assertEqual(len(samples),1200)
            self.assertFalse([s for s in samples if s['failures']],f'Failures are retained in {output}')
        finally:
            save();fixture.tearDown()


if __name__=='__main__':unittest.main()
