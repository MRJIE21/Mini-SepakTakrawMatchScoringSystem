from helpers.reviewed_result import reviewed_result
from helpers.historical_schedule import fixture_schedule
"""Real HTTP tests of school projections, concurrency, rollback and replay."""
from copy import deepcopy
import unittest
import uuid
import test_imports_exports as fixtures


class SchoolRegistrationTest(unittest.TestCase):
    fixture_schedule = fixture_schedule
    setUpClass = classmethod(fixtures.ImportExportsTest.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.ImportExportsTest.tearDownClass.__func__)
    req = fixtures.ImportExportsTest.req
    login = fixtures.ImportExportsTest.login
    count = fixtures.ImportExportsTest.count

    def setUp(self):
        fixtures.ImportExportsTest.setUp(self)
        self.sid = self.req('POST', f"/api/events/{self.event['event_id']}/schools", {'name': '测试大学', 'group_id': self.group['id']})['school_id']
        self.a = self.person('甲')
        self.b = self.person('乙')
        self.path = f'/api/schools/{self.sid}/registration-'

    def person(self, name, **fields):
        return self.req('POST', f'/api/schools/{self.sid}/athletes', dict(name=name, gender='male', **fields))['athlete_id']

    def snapshot(self):
        return self.req('GET', self.path + 'workspace')

    def payload(self, **fields):
        snap = self.snapshot()
        return dict(event_identity=snap['event_identity'], base_hash=snap['base_hash'], people=[], projects=[], **fields)

    def project(self, kind, **fields):
        return dict(category_id=self.cat[kind]['id'], choice='participate', **fields)

    def save(self, payload, expected=200, uid=None):
        preview = self.req('POST', self.path + 'preview', payload, expected=expected)
        if expected != 200:
            return preview
        body = dict(payload, preview_hash=preview['preview_hash'], request_uid=uid or str(uuid.uuid4()))
        return self.req('POST', self.path + 'commit', body), body

    def test_preview_no_writes_commit_replay_and_changed_uid(self):
        payload = self.payload()
        payload['people'] = [{'key': 'new:c', 'name': '丙', 'gender': 'male', 'jersey_no': '8', 'note': ''}]
        payload['projects'] = [self.project('team', members=[{'athlete_key': 'new:c', 'jersey_no': '9'}], captain_key='new:c')]
        counts = {t: self.count(t) for t in ('athletes', 'teams', 'participations', 'school_registration_choices', 'audit_logs')}
        preview = self.req('POST', self.path+'preview', payload)
        self.assertEqual(preview['summary']['participating'], 1)
        self.assertTrue(preview['warnings'])
        self.assertEqual(counts, {t: self.count(t) for t in counts})
        body = dict(payload, preview_hash=preview['preview_hash'], request_uid=str(uuid.uuid4()))
        saved = self.req('POST', self.path+'commit', body)
        replay = self.req('POST', self.path+'commit', body)
        self.assertTrue(replay['replayed'])
        self.assertEqual(saved['people_ids'], replay['people_ids'])
        self.assertEqual(self.count('athletes'), counts['athletes']+1)
        changed = deepcopy(body); changed['people'][0]['note'] = '更改'
        self.assertEqual(self.req('POST', self.path+'commit', changed, expected=409)['code'], 'request_uid_reused')
        snap = self.snapshot()
        self.assertEqual(snap['people'][-1]['jersey_no'], '8')
        self.assertEqual(snap['projects'][0]['members'][0]['jersey_no'], '9')

    def test_cross_project_move_and_reuse_existing_participation_id(self):
        initial = self.payload(); initial['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}'}])]
        self.save(initial)
        old_team = next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['team']['id'])['participation_id']
        move = self.payload(); move['projects'] = [self.project('individual', athlete_key=f'a:{self.a}'), self.project('team', members=[{'athlete_key': f'a:{self.b}'}])]
        self.save(move)
        snap = self.snapshot()
        self.assertEqual(next(p for p in snap['projects'] if p['category_id'] == self.cat['team']['id'])['participation_id'], old_team)
        ind_id = next(p for p in snap['projects'] if p['category_id'] == self.cat['individual']['id'])['participation_id']
        back = self.payload(); back['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}'}]), dict(category_id=self.cat['individual']['id'], choice='withdrawn')]
        self.save(back)
        again = self.payload(); again['projects'] = move['projects']; self.save(again)
        self.assertEqual(next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['individual']['id'])['participation_id'], ind_id)

    def test_invalid_projection_rolls_back_new_people_and_entries(self):
        payload = self.payload(); payload['people'] = [{'key': 'new:x', 'name': '新同学', 'gender': 'male'}]
        payload['projects'] = [self.project('individual', athlete_key='new:x'), self.project('team', members=[{'athlete_key': 'new:x'}])]
        counts = {t: self.count(t) for t in ('athletes', 'teams', 'participations', 'school_registration_choices')}
        response = self.req('POST', self.path+'preview', payload, expected=409)
        self.assertEqual(response['code'], 'athlete_already_entered')
        from app import idempotency
        signed = dict(payload, school_id=self.sid, group_id=self.group['id'], user_id=self.req('GET', '/api/me')['user']['id'])
        # Forge a correctly hashed preview to ensure commit repeats validation and rolls back.
        body = dict(payload, preview_hash=idempotency.content_hash(signed), request_uid=str(uuid.uuid4()))
        self.req('POST', self.path+'commit', body, expected=409)
        self.assertEqual(counts, {t: self.count(t) for t in counts})

    def test_concurrent_project_edit_rejects_stale_preview(self):
        payload = self.payload(); payload['projects'] = [self.project('individual', athlete_key=f'a:{self.a}')]
        preview = self.req('POST', self.path+'preview', payload)
        self.req('POST', f"/api/categories/{self.cat['team']['id']}/enrollments", {'school_id': self.sid, 'members': [{'athlete_id': self.a}]})
        body = dict(payload, preview_hash=preview['preview_hash'], request_uid=str(uuid.uuid4()))
        stale = self.req('POST', self.path+'commit', body, expected=409)
        self.assertEqual(stale['code'], 'registration_stale')
        self.assertTrue(stale['detail']['latest']['projects'])
        self.assertEqual(self.count('participations'), 1)

    def test_same_name_review_includes_occupied_people(self):
        payload = self.payload(); payload['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}'}])]; self.save(payload)
        base = self.snapshot(); p = next(p for p in base['people'] if p['id'] == self.a)
        payload = self.payload(); payload['people'] = [{'key': 'new:same', 'name': '甲', 'gender': 'male', 'note': '二班'}]
        self.req('POST', self.path+'preview', payload, expected=400)
        payload['people'][0].update(same_name_candidates=[{'id': self.a, 'rev': p['rev']}], confirm_distinct_person=True)
        payload['projects'] = [self.project('individual', athlete_key='new:same')]; self.save(payload)
        self.assertEqual(sum(p['name'] == '甲' for p in self.snapshot()['people']), 2)

    def test_omitted_projects_unchanged_explicit_no_and_old_restore(self):
        payload = self.payload(); payload['projects'] = [self.project('individual', athlete_key=f'a:{self.a}')]; self.save(payload)
        before = next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['individual']['id'])
        payload = self.payload(); payload['projects'] = [dict(category_id=self.cat['team']['id'], choice='not_participating')]; self.save(payload)
        self.assertEqual(next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['individual']['id']), before)
        self.req('PUT', f"/api/participations/{before['participation_id']}", {'status': 'withdrawn'})
        self.req('POST', f"/api/categories/{self.cat['team']['id']}/enrollments", {'school_id': self.sid, 'members': [{'athlete_id': self.a}]})
        self.assertEqual(self.req('PUT', f"/api/participations/{before['participation_id']}", {'status': 'active'}, expected=409)['code'], 'athlete_already_entered')

    def test_gender_profile_edit_and_restoration_school_limit(self):
        payload = self.payload(); payload['projects'] = [self.project('individual', athlete_key=f'a:{self.a}')]; self.save(payload)
        part = next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['individual']['id'])
        self.req('PUT', f'/api/athletes/{self.a}', {'gender': 'female'}, expected=400)
        self.req('PUT', f"/api/participations/{part['participation_id']}", {'status': 'withdrawn'})
        self.req('POST', f"/api/categories/{self.cat['individual']['id']}/participations", {'athlete_id': self.b})
        self.assertEqual(self.req('PUT', f"/api/participations/{part['participation_id']}", {'status': 'active'}, expected=409)['code'], 'school_individual_limit')

    def test_preview_mandatory_and_roles(self):
        payload = self.payload(); payload['projects'] = [self.project('individual', athlete_key=f'a:{self.a}')]
        self.req('POST', self.path+'commit', dict(payload, request_uid=str(uuid.uuid4())), expected=409)
        self.req('POST', self.path+'commit', payload, expected=400)
        self.req('GET', self.path+'workspace', token=self.login('iteration_recorder'), expected=403)
        self.req('GET', self.path+'workspace', token=self.login('iteration_viewer'), expected=403)
        self.req('GET', self.path+'workspace', token=self.login('iteration_organizer'))

    def test_locked_schedule_protects_school_and_old_entry_points(self):
        self.req('POST', f"/api/categories/{self.cat['team']['id']}/enrollments", {'school_id': self.sid, 'members': [{'athlete_id': self.a}]})
        self.req('POST', f"/api/categories/{self.cat['team']['id']}/enrollments", {'school': {'name': '另一大学'}, 'members': [{'name': '对手', 'gender': 'male'}]})
        plan = self.fixture_schedule('POST', f"/api/categories/{self.cat['team']['id']}/plan", {'stages': [{'kind': 'round_robin', 'name': '循环', 'params': {}}]})['plan_id']
        self.fixture_schedule('POST', f'/api/plans/{plan}/generate')
        self.fixture_schedule('POST', f'/api/plans/{plan}/lock')
        payload = self.payload(); payload['projects'] = [dict(category_id=self.cat['team']['id'], choice='withdrawn')]
        self.assertEqual(self.req('POST', self.path+'preview', payload, expected=409)['code'], 'plan_locked')
        team = next(t for t in self.req('GET', f"/api/categories/{self.cat['team']['id']}/teams")['teams'] if t['school_id'] == self.sid)
        self.req('PUT', f"/api/teams/{team['id']}", {'member_ids': [self.a, self.b], 'captain_id': self.a})
        p = next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['team']['id'])
        self.req('PUT', f"/api/participations/{p['participation_id']}", {'status': 'withdrawn'}, expected=409)
        self.assertTrue(next(c for c in self.snapshot()['categories'] if c['id'] == self.cat['team']['id'])['locked_reason'])
        self.assertFalse(next(c for c in self.snapshot()['categories'] if c['id'] == self.cat['team']['id'])['roster_locked_reason'])
        # Updating non-identity profile information remains possible after locking.
        self.req('PUT', f'/api/athletes/{self.a}', {'name': '甲', 'gender': 'male', 'note': '一班'})

    def lock_team_schedule(self, with_draw=False):
        initial = self.payload()
        initial['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}', 'jersey_no': '1'}], captain_key=f'a:{self.a}')]
        self.save(initial)
        self.req('POST', f"/api/categories/{self.cat['team']['id']}/enrollments", {
            'school': {'name': '对手学校'}, 'members': [{'name': '对手', 'gender': 'male'}]})
        params = {'pool_count': 1}
        if with_draw:
            path = f"/api/categories/{self.cat['team']['id']}/group-draw"
            draw = self.req('POST', path, {'method': 'random', 'capacities': [2],
                'roster_hash': self.req('GET', path)['roster_hash'], 'request_uid': str(uuid.uuid4())})['draw']
            for action in ('complete', 'confirm'):
                draw = self.req('POST', path+'/'+action, {'draw_id': draw['id'], 'base_rev': draw['rev'], 'request_uid': str(uuid.uuid4())})['draw']
            params['draw_id'] = draw['id']
        plan = self.fixture_schedule('POST', f"/api/categories/{self.cat['team']['id']}/plan", {
            'stages': [{'kind': 'round_robin', 'name': '循环', 'params': params}]})['plan_id']
        self.fixture_schedule('POST', f'/api/plans/{plan}/generate')
        self.fixture_schedule('POST', f'/api/plans/{plan}/lock')
        self.team = next(t for t in self.req('GET', f"/api/categories/{self.cat['team']['id']}/teams")['teams'] if t['school_id'] == self.sid)
        self.match = self.req('GET', f"/api/matches?category_id={self.cat['team']['id']}")['matches'][0]
        return plan

    def stored(self, *tables):
        from app import db
        conn = db.connect(db.event_db_path(self.event['event_id']))
        try:
            return {t: [dict(r) for r in db.q(conn, f'SELECT * FROM {t} ORDER BY id')] for t in tables}
        finally:
            conn.close()

    def test_locked_roster_add_preserves_confirmed_draw_schedule_and_entry(self):
        self.lock_team_schedule(with_draw=True)
        before = self.stored('plans', 'stages', 'matches', 'pools', 'pool_members', 'group_draws', 'participations', 'school_registration_choices')
        payload = self.payload()
        payload['people'] = [{'key': 'new:substitute', 'name': '新增替补', 'gender': 'male', 'jersey_no': '4'}]
        payload['projects'] = [dict(next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['team']['id']))]
        payload['projects'][0]['members'].append({'athlete_key': 'new:substitute', 'jersey_no': '4'})
        counts = self.count('athletes'), self.count('team_members')
        preview = self.req('POST', self.path+'preview', payload)
        self.assertEqual(counts, (self.count('athletes'), self.count('team_members')))
        body = dict(payload, preview_hash=preview['preview_hash'], request_uid=str(uuid.uuid4()))
        saved = self.req('POST', self.path+'commit', body)
        replay = self.req('POST', self.path+'commit', body)
        self.assertTrue(replay['replayed'])
        self.assertEqual(saved['people_ids'], replay['people_ids'])
        self.assertEqual(before, self.stored(*before))
        self.assertEqual(counts[0]+1, self.count('athletes'))
        self.assertEqual(counts[1]+1, self.count('team_members'))
        draw = self.req('GET', f"/api/categories/{self.cat['team']['id']}/group-draw")['draw']
        self.assertEqual(draw['status'], 'confirmed')
        self.assertFalse(draw['stale'])
        players = self.req('GET', f"/api/scoring/match/{self.match['id']}")['match']['players']
        self.assertIn('新增替补', [a['name'] for side in players.values() for a in side])

    def test_locked_seed_entry_change_rejects_and_rolls_back_people(self):
        self.lock_team_schedule()
        before = self.stored('athletes', 'teams', 'participations', 'team_members', 'matches')
        for choice, seed in (('withdrawn', None), ('not_participating', None), ('participate', 9)):
            payload = self.payload()
            payload['people'] = [{'key': 'new:x', 'name': '不应保存', 'gender': 'male'}]
            payload['projects'] = [dict(self.project('team', seed_no=seed), choice=choice)]
            self.assertEqual(self.req('POST', self.path+'preview', payload, expected=409)['code'], 'plan_locked')
            self.assertEqual(before, self.stored(*before))
        self.req('POST', f"/api/categories/{self.cat['team']['id']}/enrollments", {
            'school': {'name': '不能追加的学校'}, 'members': [{'name': '不能追加', 'gender': 'male'}]}, expected=409)
        self.assertEqual(before, self.stored(*before))

    def test_claim_freezes_roster_but_allows_new_school_people_and_notes(self):
        self.lock_team_schedule()
        self.req('POST', f"/api/recording/match/{self.match['id']}/claim", {})
        before = self.stored('team_members', 'teams', 'matches')
        cat = next(c for c in self.snapshot()['categories'] if c['id'] == self.cat['team']['id'])
        self.assertIn('已领取记录', cat['roster_locked_reason'])
        payload = self.payload()
        payload['people'] = [{'key': 'new:blocked', 'name': '不能加入冻结名单', 'gender': 'male'}]
        payload['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.b}'}, {'athlete_key': 'new:blocked'}])]
        self.assertEqual(self.req('POST', self.path+'preview', payload, expected=409)['code'], 'roster_in_use')
        from app import idempotency
        signed = dict(payload, school_id=self.sid, group_id=self.group['id'], user_id=self.req('GET', '/api/me')['user']['id'])
        forged = dict(payload, preview_hash=idempotency.content_hash(signed), request_uid=str(uuid.uuid4()))
        self.assertEqual(self.req('POST', self.path+'commit', forged, expected=409)['code'], 'roster_in_use')
        self.assertEqual(len(self.snapshot()['people']), 2, 'rejected commits must roll back new profiles too')
        self.assertEqual(self.req('PUT', f"/api/teams/{self.team['id']}", {'member_ids': [self.b]}, expected=409)['code'], 'roster_in_use')
        self.assertEqual(self.req('PUT', f'/api/athletes/{self.a}', {'name': '不得改名'}, expected=409)['code'], 'roster_in_use')
        payload = self.payload()
        payload['people'] = [{'key': 'new:profile', 'name': '新建学校人员', 'gender': 'male'}]
        project = dict(next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['team']['id']))
        project['note'] = '管理员补充备注'
        payload['projects'] = [project]
        self.save(payload)
        self.assertEqual(before, self.stored(*before))
        self.assertEqual(len(self.snapshot()['people']), 3)

    def test_recording_claim_between_preview_and_commit_rejects_stale_request(self):
        self.lock_team_schedule()
        payload = self.payload()
        payload['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}'}, {'athlete_key': f'a:{self.b}'}])]
        preview = self.req('POST', self.path+'preview', payload)
        roster_before = self.stored('team_members', 'teams')
        self.req('POST', f"/api/recording/match/{self.match['id']}/claim", {})
        # Claim legitimately freezes the match rules. A rejected registration must
        # preserve both the original roster and the post-claim match snapshot.
        before = self.stored('team_members', 'teams', 'matches')
        body = dict(payload, preview_hash=preview['preview_hash'], request_uid=str(uuid.uuid4()))
        response = self.req('POST', self.path+'commit', body, expected=409)
        self.assertEqual(response['code'], 'registration_stale')
        self.assertTrue(next(c for c in response['detail']['latest']['categories'] if c['id'] == self.cat['team']['id'])['roster_locked_reason'])
        self.assertEqual(before, self.stored(*before))
        self.assertEqual(roster_before, self.stored(*roster_before))

    def test_finished_match_freezes_roster_even_without_recording_claim(self):
        self.lock_team_schedule()
        reviewed_result(self, 'POST', f"/api/matches/{self.match['id']}/cancel", {
            'request_uid': str(uuid.uuid4()), 'base_version': self.match['result_version'],
            'event_identity': dict(self.event), 'result_status': 'cancelled', 'reason': '测试终止'}, expected=200)
        self.assertEqual(self.req('PUT', f"/api/teams/{self.team['id']}", {'members': [{'athlete_id': self.b}]}, expected=409)['code'], 'roster_in_use')
        self.req('POST', f'/api/schools/{self.sid}/athletes', {'name': '赛后新人员', 'gender': 'female'})

    def test_locked_roster_still_checks_gender_limit_and_double_entry(self):
        self.lock_team_schedule()
        self.req('POST', f"/api/categories/{self.cat['individual']['id']}/participations", {'athlete_id': self.b})
        payload = self.payload()
        payload['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}'}, {'athlete_key': f'a:{self.b}'}])]
        self.assertEqual(self.req('POST', self.path+'preview', payload, expected=409)['code'], 'athlete_already_entered')
        payload = self.payload()
        payload['people'] = [{'key': 'new:wrong', 'name': '性别不符', 'gender': 'female'}]
        payload['projects'] = [self.project('team', members=[{'athlete_key': 'new:wrong'}])]
        self.req('POST', self.path+'preview', payload, expected=400)
        payload = self.payload()
        payload['people'] = [{'key': f'new:{i}', 'name': f'替补{i}', 'gender': 'male'} for i in range(7)]
        payload['projects'] = [self.project('team', members=[{'athlete_key': f'new:{i}'} for i in range(7)])]
        self.req('POST', self.path+'preview', payload, expected=400)
        self.assertEqual(self.count('athletes'), 3)

    def test_old_delete_does_not_leave_a_phantom_school_decision(self):
        payload = self.payload(); payload['projects'] = [self.project('individual', athlete_key=f'a:{self.a}')]; self.save(payload)
        p = next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['individual']['id'])
        self.req('DELETE', f"/api/participations/{p['participation_id']}")
        self.assertEqual(next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['individual']['id'])['choice'], 'unresolved')

    def test_old_team_inline_creation_also_checks_same_name(self):
        self.req('POST', f"/api/categories/{self.cat['individual']['id']}/participations", {'athlete_id': self.a})
        path = f"/api/categories/{self.cat['team']['id']}/enrollments"
        body = {'school_id': self.sid, 'members': [{'name': '甲', 'gender': 'male'}]}
        self.req('POST', path, body, expected=400)
        body['members'][0].update(note='另一位二班', confirm_distinct_person=True, same_name_candidates=[{'id': self.a, 'rev': 1}])
        self.req('POST', path, body)
        self.assertEqual(sum(p['name'] == '甲' for p in self.snapshot()['people']), 2)


if __name__ == '__main__':
    unittest.main()
