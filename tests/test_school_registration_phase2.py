"""Real HTTP coverage: table projection, retired draft routes, backend concurrency and replay."""
import csv
import io
import unittest
import uuid
import test_school_registration as fixtures


class SchoolPhase2Test(unittest.TestCase):
    setUpClass = classmethod(fixtures.SchoolRegistrationTest.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.SchoolRegistrationTest.tearDownClass.__func__)
    setUp = fixtures.SchoolRegistrationTest.setUp
    req, login, count = fixtures.SchoolRegistrationTest.req, fixtures.SchoolRegistrationTest.login, fixtures.SchoolRegistrationTest.count
    person, snapshot, payload, project, save = fixtures.SchoolRegistrationTest.person, fixtures.SchoolRegistrationTest.snapshot, fixtures.SchoolRegistrationTest.payload, fixtures.SchoolRegistrationTest.project, fixtures.SchoolRegistrationTest.save

    def text(self, rows, delimiter='\t'):
        from app.school_import import HEADERS
        buf = io.StringIO(); writer = csv.DictWriter(buf, fieldnames=HEADERS, delimiter=delimiter)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
        return buf.getvalue()

    def row(self, kind='team', name='甲', **fields):
        return dict(项目=self.cat[kind]['name'], 运动员=name, **fields)

    def imported(self, rows, payload=None):
        return self.req('POST', self.path+'import-preview', dict(payload or self.payload(), csv_text=self.text(rows)))

    def test_multi_project_move_includes_local_input_and_retains_unlisted(self):
        start = self.payload(); start['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}', 'jersey_no': '4'}])]
        self.save(start)
        payload = self.payload(); p = next(p for p in self.snapshot()['people'] if p['id'] == self.b)
        payload['people'] = [dict(key=p['key'], name=p['name'], gender=p['gender'], jersey_no='5', note='二班', base_rev=p['rev'])]
        counts = {t: self.count(t) for t in ('athletes', 'teams', 'participations', 'audit_logs')}
        result = self.imported([self.row('individual', 运动员ID=str(self.a)), self.row(name='乙', 项目号码='7', 队长='是')], payload)
        self.assertEqual(result['errors'], [])
        self.assertEqual(counts, {t: self.count(t) for t in counts})
        self.assertEqual(next(p for p in result['model']['people'] if p['id'] == self.b)['note'], '二班')
        self.assertEqual([p['choice'] for p in result['model']['projects'] if p['category_id'] not in (self.cat['team']['id'], self.cat['individual']['id'])], ['unresolved', 'unresolved'])
        self.save(result['payload'])
        self.assertEqual(next(p for p in self.snapshot()['projects'] if p['category_id'] == self.cat['team']['id'])['members'], [{'athlete_key': f'a:{self.b}', 'jersey_no': '7'}])

    def test_table_errors_and_business_errors_never_write(self):
        before = self.snapshot()
        audits = self.count('audit_logs')
        result = self.imported([self.row(name='新同学', 项目号码='21'), self.row('individual', name='乙', 队长='是')])
        self.assertEqual([e['line'] for e in result['errors']], [2, 3]); self.assertIsNone(result['model'])
        result = self.imported([self.row(name='新同学'), self.row('individual', name='新同学')])
        self.assertEqual(result['errors'][0]['code'], 'athlete_already_entered')
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.count('audit_logs'), audits)

    def test_same_name_requires_id_or_distinct_confirmation(self):
        other = self.person('甲', note='二班')
        result = self.imported([self.row()]); self.assertTrue(result['errors'])
        result = self.imported([self.row(运动员ID=str(other))]); self.assertFalse(result['errors'])
        self.assertEqual(result['model']['projects'][0]['members'][0]['athlete_key'], f'a:{other}')
        result = self.imported([self.row(同名新建确认='是', 区分信息='三班')]); self.assertFalse(result['errors'])
        self.assertEqual(len(result['payload']['people'][0]['same_name_candidates']), 2)
        self.save(result['payload']); self.assertEqual(self.count('athletes'), 4)

    def test_duplicate_roster_and_conflicting_profile_values(self):
        result = self.imported([self.row(), self.row()]); self.assertTrue(result['errors'])
        result = self.imported([self.row(常用号码='2'), self.row('individual', 常用号码='3')]); self.assertTrue(result['errors'])
        result = self.imported([self.row(同名新建确认='是', 区分信息='新班'), self.row(同名新建确认='是', 区分信息='新班')]); self.assertTrue(result['errors'])
        self.assertEqual(self.count('athletes'), 2)

    def test_unlisted_and_explicit_exit_are_distinct(self):
        start = self.payload(); start['projects'] = [self.project('individual', athlete_key=f'a:{self.a}')]; self.save(start)
        result = self.imported([self.row(name='乙')]); self.assertFalse(result['errors'])
        self.assertEqual(len(result['payload']['projects']), 1)
        result = self.imported([self.row('individual', name='', 参赛选择='退出'), self.row()]); self.assertFalse(result['errors'])
        self.save(result['payload']); self.assertEqual(self.count('participations'), 2)

    def test_template_round_trip_and_formula_escaped_known_values(self):
        self.req('PUT', f'/api/athletes/{self.a}', {'name': '=甲', 'note': '@二班'})
        payload = self.payload(); payload['projects'] = [self.project('team', members=[{'athlete_key': f'a:{self.a}', 'jersey_no': '3'}], captain_key=f'a:{self.a}', note='+备注')]; self.save(payload)
        text = self.req('GET', self.path+'import-template.csv', raw=True)
        self.assertIn("'=甲", text)
        result = self.req('POST', self.path+'import-preview', dict(self.payload(), csv_text=text))
        self.assertFalse(result['errors']); self.assertEqual(result['payload']['people'], []); self.assertEqual(result['payload']['projects'], [])

    def test_formula_escaped_name_ambiguity_requires_id(self):
        self.req('PUT', f'/api/athletes/{self.a}', {'name': '=甲'})
        literal = self.person("'=甲")
        before = self.snapshot()
        result = self.imported([self.row(name="'=甲")])
        self.assertTrue(result['errors'])
        self.assertIn('运动员ID', result['errors'][0]['message'])
        self.assertEqual(before, self.snapshot())
        for identity in (self.a, literal):
            result = self.imported([self.row(name="'=甲", 运动员ID=str(identity))])
            self.assertFalse(result['errors'])
            self.assertEqual(result['model']['projects'][0]['members'][0]['athlete_key'], f'a:{identity}')
            self.assertEqual(result['payload']['people'], [])

    def test_unknown_quoted_name_is_not_unescaped(self):
        result = self.imported([self.row(name="'=新人员")])
        self.assertFalse(result['errors'])
        self.assertEqual(result['payload']['people'][0]['name'], "'=新人员")

    def test_empty_team_can_round_trip_template(self):
        payload = self.payload(); payload['projects'] = [self.project('team', members=[])]; self.save(payload)
        text = self.req('GET', self.path+'import-template.csv', raw=True)
        result = self.req('POST', self.path+'import-preview', dict(self.payload(), csv_text=text)); self.assertFalse(result['errors'])

    def test_shared_draft_routes_removed_without_changing_registration(self):
        before = self.snapshot()
        for method in ('GET', 'PUT', 'DELETE'):
            self.req(method, self.path+'draft', {} if method != 'GET' else None, expected=404)
        self.assertEqual(before, self.snapshot())

    def test_legacy_revision_never_blocks_preview_commit_or_original_retry(self):
        payload = self.payload(shared_draft_rev=999)
        payload['projects'] = [self.project('individual', athlete_key=f'a:{self.a}')]
        saved, body = self.save(payload)
        self.assertEqual(self.count('participations'), 1)
        self.assertTrue(self.req('POST', self.path+'commit', body)['replayed'])
        self.assertEqual(self.count('participations'), 1)
        changed = dict(body, shared_draft_rev=0)
        self.assertEqual(self.req('POST', self.path+'commit', changed, expected=409)['code'], 'request_uid_reused')

    def test_direct_submission_keeps_backend_permissions_and_identity_validation(self):
        for user in ('iteration_recorder', 'iteration_viewer'):
            token = self.login(user)
            self.req('POST', self.path+'import-preview', dict(self.payload(), csv_text=self.text([self.row()])), token=token, expected=403)
        payload = self.payload(); payload['event_identity'] = {}
        self.req('POST', self.path+'import-preview', dict(payload, csv_text=self.text([self.row()])), expected=409)

    def test_csv_shape_and_scope_errors(self):
        for text in ('项目,运动员\n三人赛,甲,多一列', '项目,运动员,姓名\nx,甲,甲', '项目,运动员,无效列\nx,甲,y'):
            self.req('POST', self.path+'import-preview', dict(self.payload(), csv_text=text), expected=400)
        result = self.imported([self.row(学校='另一个学校')]); self.assertTrue(result['errors'])
        result = self.imported([self.row(种子序号='9'*5000)]); self.assertTrue(result['errors'])
        payload = self.payload(); payload['projects'] = [dict(category_id=self.cat['team']['id'], members=['broken'])]
        self.req('POST', self.path+'import-preview', dict(payload, csv_text=self.text([self.row()])), expected=400)


if __name__ == '__main__':
    unittest.main()
