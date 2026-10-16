"""Actual HTTP and database evidence for preview, atomic save and existing data."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
from concurrent.futures import ThreadPoolExecutor

import test_api
import test_schedule_api
from app import config, db
from app.api import auto_schedule
from app.domain import auto_schedule as model


class AutoScheduleApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task=Path(tempfile.mkdtemp(prefix='stss_auto_api_'))
        config.DATA_DIR,config.DB_PATH,config.EVENTS_DIR=task,task/'registry.db',task/'events'
        test_api.ApiTest.setUpClass.__func__(cls)
    tearDownClass=classmethod(test_api.ApiTest.tearDownClass.__func__)
    request=test_api.ApiTest.request
    ok=test_api.ApiTest.ok
    def err(self, method, path, body=None, *, status=400, code=None, token=None):
        return test_api.ApiTest.err(self,method,path,body,token=token,expect=status,code=code)
    login=test_api.ApiTest.login
    make_user=test_api.ApiTest.make_user
    build_event=test_api.ApiTest.build_event
    events_for=test_api.ApiTest.events_for
    play=test_api.ApiTest.play
    lineup_for=test_api.ApiTest.lineup_for
    packet=test_schedule_api.ScheduleApiTest.packet
    draft=test_schedule_api.ScheduleApiTest.draft
    preview=test_schedule_api.ScheduleApiTest.preview
    confirm=test_schedule_api.ScheduleApiTest.confirm
    plan=test_schedule_api.ScheduleApiTest.plan
    setup_groups=test_schedule_api.ScheduleApiTest.setup_groups
    finish_groups=test_schedule_api.ScheduleApiTest.finish_groups

    def setUp(self):
        test_api.ApiTest.setUp(self);self.use_event_database=True

    def prepare(self, count=2, size=4, knockout=True):
        self.setup_groups(count,size)
        if knockout:
            self.confirm(self.draft({'purpose':'knockout','name':'淘汰赛','pool_ids':[p['id'] for p in self.pools]})['stage_id'])
        self.cid=self.fx['team_cat'];self.path=f'/api/categories/{self.cid}/auto-schedule'
        venue=self.ok('POST',f"/api/events/{self.fx['event_id']}/venues",{'name':'自动编排专用场地'})['venue_id']
        self.cfg={'stage_ids':[s['id'] for s in self.plan()['stages']], 'duration_minutes':30,'rest_minutes':30,
            'mode':'fill','windows':[{'venue_id':venue,'start':'2026-10-18 09:00','end':'2026-10-20 20:00'}]}

    def generate(self,cfg=None):
        return self.ok('POST',self.path+'/preview',{'settings':cfg or self.cfg})

    def save(self,preview):
        return self.ok('POST',self.path+'/confirm',self.packet(preview_id=preview['preview_id']))

    def snapshot(self):
        c=db.connect(db.event_db_path(self.fx['event_id']))
        try:
            return {r['name']: [tuple(x) for x in c.execute('SELECT * FROM "'+r['name']+'" ORDER BY rowid')]
                for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")}
        finally:c.close()

    def test_preview_no_writes_save_all_and_retry_after_expiry(self):
        self.prepare();before=self.snapshot();p=self.generate()
        self.assertTrue(p['complete']);self.assertEqual(p['new'],12)
        self.assertEqual(len(p['schedule']),16);self.assertEqual(self.snapshot(),before)
        packet=self.packet(preview_id=p['preview_id'])
        saved=self.ok('POST',self.path+'/confirm',packet)
        self.assertEqual(saved['new'],12);self.assertEqual(len(saved['match_ids']),16)
        auto_schedule.PREVIEWS.clear()
        replay=self.ok('POST',self.path+'/confirm',packet);self.assertTrue(replay['replayed'])
        self.assertEqual(replay['match_ids'],saved['match_ids'])
        after=self.snapshot();self.assertEqual(len(after['match_schedule_meta']),16)
        self.assertEqual(len(after['schedule_policies']),1)
        c=db.connect(db.event_db_path(self.fx['event_id']))
        from app.auto_schedule_store import live_rows
        rows,pools=live_rows(c);c.close()
        self.assertEqual(model.violations(rows,pools),[])
        again=self.generate();self.assertEqual(again['new'],0);self.assertEqual(again['changed'],0)

    def test_unplaced_and_cancel_are_non_destructive(self):
        self.prepare();cfg=copy.deepcopy(self.cfg)
        cfg['windows'][0]['end']='2026-10-18 09:30'
        before=self.snapshot();p=self.generate(cfg)
        self.assertFalse(p['complete']);self.assertTrue(p['unplaced'])
        self.err('POST',self.path+'/confirm',self.packet(preview_id=p['preview_id']),status=400)
        self.assertEqual(self.snapshot(),before)

    def test_preview_changes_tamper_identity_and_expiry(self):
        self.prepare();p=self.generate()
        self.ok('POST',f"/api/events/{self.fx['event_id']}/venues",{'name':'新增占用依据'})
        self.err('POST',self.path+'/confirm',self.packet(preview_id=p['preview_id']),status=409,code='preview_changed')
        p=self.generate();bad=self.packet(preview_id=p['preview_id']);bad['event_identity']={**bad['event_identity'],'event_uuid':'wrong'}
        self.err('POST',self.path+'/confirm',bad,status=409)
        with auto_schedule.LOCK:auto_schedule.PREVIEWS[p['preview_id']]['expires']=time.monotonic()-1
        self.err('POST',self.path+'/confirm',self.packet(preview_id=p['preview_id']),status=409,code='preview_expired')

    def test_saved_rules_guard_manual_changes_and_existing_ids(self):
        self.prepare(knockout=False);p=self.generate();saved=self.save(p)
        mids=saved['match_ids'];first=self.ok('GET',f'/api/matches/{mids[0]}')['match']
        self.err('PUT',f'/api/matches/{mids[1]}',{'venue_id':first['venue_id'],'scheduled_at':first['scheduled_at']},status=409)
        self.err('PUT',f'/api/matches/{mids[0]}',{'scheduled_at':'2026-10-25 09:00'},status=409,code='schedule_window_conflict')
        cfg=copy.deepcopy(self.cfg);cfg['mode']='replan';cfg['windows'][0].update(start='2026-10-19 09:00',end='2026-10-19 20:00')
        newer=self.generate(cfg);self.assertEqual(newer['new'],0);self.save(newer)
        self.assertEqual({m['id'] for m in self.plan()['stages'][0]['matches']},set(mids))

    def test_rollback_and_single_winner_from_two_previews(self):
        self.prepare();p=self.generate();p2=self.generate();before=self.snapshot()
        original=db.insert;counter=[0]
        def broken(conn,table,fields):
            if table=='matches':
                counter[0]+=1
                if counter[0]==2:raise RuntimeError('injected insert failure')
            return original(conn,table,fields)
        with patch('app.db.insert',side_effect=broken):
            self.err('POST',self.path+'/confirm',self.packet(preview_id=p['preview_id']),status=500)
        self.assertEqual(self.snapshot(),before)
        self.save(p)
        self.err('POST',self.path+'/confirm',self.packet(preview_id=p2['preview_id']),status=409,code='preview_changed')

    def test_claimed_match_kept_and_claim_invalidates_preview(self):
        self.prepare(knockout=False);self.save(self.generate())
        match=self.plan()['stages'][0]['matches'][0];mid=match['id']
        cfg=copy.deepcopy(self.cfg);cfg['mode']='replan'
        p=self.generate(cfg)
        self.ok('POST',f'/api/recording/match/{mid}/claim',{})
        self.err('POST',self.path+'/confirm',self.packet(preview_id=p['preview_id']),status=409,code='preview_changed')
        p=self.generate(cfg);kept=next(m for m in p['schedule'] if m['id']==mid)
        self.assertTrue(kept['protected']);self.assertEqual(kept['action'],'保留')
        self.save(p);self.assertEqual(self.ok('GET',f'/api/matches/{mid}')['match']['scheduled_at'],match['scheduled_at'])

    def test_duplicate_pair_rejected_and_odd_groups_supported(self):
        self.prepare(size=3,knockout=False);p=self.generate();self.assertEqual(p['new'],6)
        self.save(p);m=self.plan()['stages'][0]['matches'][0]
        self.ok('POST','/api/matches',{'category_id':self.cid,'stage_id':m['stage_id'],'pool_id':m['pool_id'],
            'home_participation':m['home']['participation_id'],'away_participation':m['away']['participation_id']})
        self.err('POST',self.path+'/preview',{'settings':self.cfg},status=409)

    def test_repeat_schema_upgrade_preserves_every_existing_row(self):
        self.prepare(knockout=False);self.save(self.generate());before=self.snapshot()
        db.init_db(db.event_db_path(self.fx['event_id']));db.init_db(db.event_db_path(self.fx['event_id']))
        self.assertEqual(self.snapshot(),before)

    def test_roles_and_cross_user_preview_are_checked_by_server(self):
        self.prepare(knockout=False);p=self.generate()
        organizer=self.make_user('organizer')
        self.ok('POST',self.path+'/preview',{'settings':self.cfg},token=organizer)
        self.err('POST',self.path+'/confirm',self.packet(preview_id=p['preview_id']),status=409,code='preview_expired',token=organizer)
        for role in ('recorder','viewer'):
            token=self.make_user(role)
            self.err('POST',self.path+'/preview',{'settings':self.cfg},status=403,token=token)
            self.err('POST',self.path+'/confirm',self.packet(preview_id=p['preview_id']),status=403,token=token)

    def test_four_groups_and_complete_custom_placement_graphs_preserved(self):
        self.prepare(count=4)
        ids=[p['id'] for p in self.pools]
        for rank,start in ((3,9),(4,13)):
            self.confirm(self.draft({'purpose':'placement','name':f'第{start}至{start+3}名',
                'pool_ids':ids,'source_rank':rank,'rank_from':start,'rank_to':start+3})['stage_id'])
        self.cfg['stage_ids']=[s['id'] for s in self.plan()['stages']]
        self.cfg['windows'][0]['end']='2026-10-24 20:00'
        before=[(m['id'],m['home']['source_label'],m['away']['source_label'],m['winner_rank'],m['loser_rank'])
            for s in self.plan()['stages'] if s['kind']!='round_robin' for m in s['matches']]
        p=self.generate();self.assertTrue(p['complete']);self.assertEqual(p['new'],24)
        self.save(p)
        after=[(m['id'],m['home']['source_label'],m['away']['source_label'],m['winner_rank'],m['loser_rank'])
            for s in self.plan()['stages'] if s['kind']!='round_robin' for m in s['matches']]
        self.assertEqual(after,before)

    def test_real_concurrent_confirm_only_one_preview_writes(self):
        self.prepare();p=self.generate();q=self.generate()
        packets=[self.packet(preview_id=x['preview_id']) for x in (p,q)]
        with ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(lambda body:self.request('POST',self.path+'/confirm',body),packets))
        self.assertEqual(sum(bool(r.get('ok')) for r in results),1)
        self.assertEqual([r['code'] for r in results if not r.get('ok')],['preview_changed'])
        self.assertEqual(len(self.snapshot()['match_schedule_meta']),16)

    def test_missing_group_sources_and_stricter_fixed_rest_cannot_be_ignored(self):
        self.prepare();cfg=copy.deepcopy(self.cfg);cfg['stage_ids']=cfg['stage_ids'][1:]
        self.err('POST',self.path+'/preview',{'settings':cfg},status=409)
        self.save(self.generate());cfg=copy.deepcopy(self.cfg);cfg['rest_minutes']=120
        self.err('POST',self.path+'/preview',{'settings':cfg},status=400)
        cfg['mode']='replan';self.assertTrue(self.generate(cfg)['complete'])

    def test_legacy_schema_adds_empty_tables_without_changing_old_rows(self):
        self.prepare(knockout=False)
        c=db.connect(db.event_db_path(self.fx['event_id']))
        c.execute('DROP TABLE match_schedule_meta');c.execute('DROP TABLE schedule_policies');c.close()
        before=self.snapshot();db.init_db(db.event_db_path(self.fx['event_id']));db.init_db(db.event_db_path(self.fx['event_id']))
        after=self.snapshot()
        self.assertEqual({k:after[k] for k in before},before)
        self.assertEqual(after['schedule_policies'],[]);self.assertEqual(after['match_schedule_meta'],[])

    def test_preview_size_and_invalid_token_are_non_destructive(self):
        self.prepare();before=self.snapshot()
        with patch.object(auto_schedule,'MAX_PREVIEW_BYTES',1):
            self.err('POST',self.path+'/preview',{'settings':self.cfg},status=400)
        for invalid in (None,[],{},'x'*101):
            self.err('POST',self.path+'/confirm',self.packet(preview_id=invalid),status=400)
        self.assertEqual(self.snapshot(),before)

    def test_later_stage_rules_do_not_replace_earlier_match_rules(self):
        self.prepare();self.save(self.generate())
        stages=self.plan()['stages'];group=next(s for s in stages if s['kind']=='round_robin')
        knockout=next(s for s in stages if s['kind']!='round_robin')
        cfg=copy.deepcopy(self.cfg);cfg.update(stage_ids=[knockout['id']],rest_minutes=60,mode='replan')
        cfg['windows'][0].update(start='2026-10-22 09:00',end='2026-10-23 20:00')
        self.save(self.generate(cfg))
        mid=group['matches'][0]['id']
        self.ok('PUT',f'/api/matches/{mid}',{'note':'保留小组赛原时段'})
        self.err('PUT',f'/api/matches/{mid}',{'scheduled_at':'2026-10-22 09:00'},status=409,code='schedule_window_conflict')
        c=db.connect(db.event_db_path(self.fx['event_id']))
        try:
            from app.auto_schedule_store import live_rows
            rows,_=live_rows(c)
            self.assertEqual({r['rest_minutes'] for r in rows if r['stage_id']==group['id']},{30})
            self.assertEqual({r['rest_minutes'] for r in rows if r['stage_id']==knockout['id']},{60})
            # Newly entered games inherit their own stage, even after another stage was scheduled.
            from app.auto_schedule_store import match_policy
            inherited=match_policy(c,{'id':-1,'category_id':self.cid,'stage_id':group['id']},{self.cid:cfg})
            self.assertEqual(inherited['windows'],self.cfg['windows'])
        finally:c.close()

    def test_stricter_rest_is_saved_even_when_all_positions_are_kept(self):
        self.prepare(knockout=False)
        venue=self.cfg['windows'][0]['venue_id']
        self.cfg['windows']=[{'venue_id':venue,'start':f'2026-10-{day} {hour:02d}:00',
            'end':f'2026-10-{day} {hour:02d}:30'} for day in (18,19) for hour in (9,11,13,15,17,19)]
        self.save(self.generate());before=self.snapshot()['matches']
        cfg=copy.deepcopy(self.cfg);cfg['rest_minutes']=60
        p=self.generate(cfg);self.assertTrue(p['complete']);self.assertEqual(p['changed'],0)
        self.assertEqual(self.save(p)['rules_updated'],12)
        self.assertEqual(self.snapshot()['matches'],before)
        c=db.connect(db.event_db_path(self.fx['event_id']))
        try:
            from app.auto_schedule_store import live_rows
            rows,_=live_rows(c);self.assertEqual({r['rest_minutes'] for r in rows},{60})
            for row in c.execute('SELECT rest_minutes,policy_json FROM match_schedule_meta'):
                self.assertEqual(row['rest_minutes'],60)
                self.assertEqual(json.loads(row['policy_json'])['rest_minutes'],60)
        finally:c.close()


if __name__=='__main__':unittest.main()
