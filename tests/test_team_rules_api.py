from helpers.reviewed_result import reviewed_result
import copy
import json
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
import threading
import test_api as fixtures
from helpers.historical_schedule import fixture_schedule
from helpers.backups import find_backup
from app import db, config, team_rules_store
from app.domain import team_rules
from test_team_rules import events_for_scores


class TeamRulesApiTest(fixtures.ApiTest):
    @classmethod
    def setUpClass(cls):
        cls.saved_config = (config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR)
        db.close_thread_connections()
        root = Path(tempfile.mkdtemp(prefix='team-rules-api-class-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = root, root / 'registry.db', root / 'events'
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        db.close_thread_connections()
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = cls.saved_config

    def setUp(self):
        super().setUp()
        self.use_event_database = True
        self.fx = self.build_event(team_count=2, individual_count=0)
        self.cat = self.fx['team_cat']
        self.path = f"/api/events/{self.fx['event_id']}/team-rules"

    def new_match(self):
        return self.ok('POST', '/api/matches', {'category_id': self.cat,
                       'home_participation': self.fx['team_parts'][0],
                       'away_participation': self.fx['team_parts'][1]})['match_id']

    def changed_rules(self):
        value = team_rules.normalize()
        value['max_sets'] = 5
        value['regular'] = {'mode': 'fixed_deuce', 'target_points': 15, 'deuce_points': 17}
        return value

    def save_rules(self, value, before=None, expect=200):
        before = before or self.ok('GET', self.path)
        return self.request('PUT', self.path, {'rules': value, 'expected_revision': before['rules_revision'],
                            'impact_token': before['impact_token']}, expect=expect)

    def test_event_rules_save_noop_and_shared_projects(self):
        before = self.ok('GET', self.path)
        self.assertEqual(before['rules'], team_rules.normalize())
        mid = self.new_match()
        changed = self.save_rules(self.changed_rules())
        self.assertEqual(changed['rules_revision'], 2)
        self.assertEqual(self.save_rules(self.changed_rules())['rules_revision'], 2)
        self.assertEqual(self.ok('GET', f'/api/matches/{mid}')['match']['rules'], self.changed_rules())
        structure = self.ok('GET', f"/api/events/{self.fx['event_id']}/structure")
        other = next(c for g in structure['groups'] for c in g['categories'] if c['kind']=='team' and c['id'] != self.cat)
        self.assertEqual(other['rules'], self.changed_rules())
        saved = next(c for g in structure['groups'] for c in g['categories'] if c['id'] == self.cat)
        self.assertEqual(saved['rules'], self.changed_rules())
        self.request('GET', f"/api/categories/{self.fx['indiv_cat']}/team-rules", expect=400)

    def test_permissions_invalid_parameters_and_stale_revision(self):
        before = self.ok('GET', self.path)
        body = {'rules': self.changed_rules(), 'expected_revision': 1, 'impact_token': before['impact_token']}
        for role in ('organizer', 'recorder', 'viewer'):
            token = self.make_user(role)
            self.request('GET', self.path, token=token, expect=200)
            self.request('PUT', self.path, body, token=token, expect=403)
        self.save_rules(self.changed_rules())
        self.save_rules(team_rules.normalize(), before, expect=409)
        for value in (None, {'schema_version': 99}, {**team_rules.normalize(), 'max_sets': 4}):
            fresh = self.ok('GET', self.path)
            self.request('PUT', self.path, {**body, 'rules': value, 'expected_revision': fresh['rules_revision'],
                         'impact_token': fresh['impact_token']}, expect=400)

    def test_empty_event_configuration_new_projects_and_other_event_isolation(self):
        original = (self.event_headers, self.event_identity)
        self.save_rules(self.changed_rules())
        event = self.ok('POST', '/api/events', {'name': '独立空赛事'})
        self.event_headers = {'X-Event-ID': str(event['event_id']), 'X-Event-UUID': event['event_uuid']}
        empty_path = f"/api/events/{event['event_id']}/team-rules"
        empty = self.ok('GET', empty_path)
        self.assertEqual((empty['team_projects'], empty['rules']), (0, team_rules.normalize()))
        desired = team_rules.normalize(); desired['max_sets'] = 7
        self.ok('PUT', empty_path, {'rules': desired, 'expected_revision': empty['rules_revision'], 'impact_token': empty['impact_token']})
        group = self.ok('POST', f"/api/events/{event['event_id']}/groups", {'name': '新组', 'code': '新'})['group_id']
        for gender in ('male', 'female'):
            cat = self.ok('POST', f'/api/groups/{group}/categories', {'name': gender, 'gender': gender, 'kind': 'team'})['category_id']
            self.assertEqual(self.ok('GET', f'/api/categories/{cat}/team-rules')['rules'], desired)
        self.event_headers, self.event_identity = original
        self.assertEqual(self.ok('GET', self.path)['rules'], self.changed_rules())
        # URL 中的赛事与所选赛事不一致时必须被拒绝，不能借所选事件库读到另一赛事。
        mismatch = self.request('GET', empty_path, expect=409)
        self.assertEqual(mismatch['code'], 'event_identity_mismatch')

    def test_legacy_project_write_rejected_without_widening_effect(self):
        before = self.ok('GET', self.path)
        result = self.request('PUT', f'/api/categories/{self.cat}/team-rules',
                              {'rules': self.changed_rules(), 'expected_revision': before['rules_revision'],
                               'impact_token': before['impact_token']}, expect=409)
        self.assertEqual(result['code'], 'event_rules_required')
        self.assertEqual(self.ok('GET', self.path), before)

    def test_project_structure_change_invalidates_full_event_impact(self):
        before = self.ok('GET', self.path)
        group = self.ok('POST', f"/api/events/{self.fx['event_id']}/groups", {'code': '丁', 'name': '丁组'})['group_id']
        self.save_rules(self.changed_rules(), before, expect=409)
        before = self.ok('GET', self.path)
        cat = self.ok('POST', f'/api/groups/{group}/categories', {'kind': 'team', 'gender': 'female', 'name': '女子三人赛'})['category_id']
        result = self.save_rules(self.changed_rules(), before, expect=409)
        self.assertEqual(result['code'], 'rules_impact_changed')
        self.save_rules(self.changed_rules())
        self.assertEqual(self.ok('GET', f'/api/categories/{cat}/team-rules')['rules'], self.changed_rules())

    def test_two_administrators_same_revision_exactly_one_write(self):
        before = self.ok('GET', self.path)
        second = self.make_user('admin')
        start = threading.Barrier(2)
        def change(value, token):
            start.wait(timeout=5)
            status, raw = self.request('PUT', self.path, {'rules': value,
                'expected_revision': before['rules_revision'], 'impact_token': before['impact_token']}, token=token, raw=True)
            return status, json.loads(raw)
        other = team_rules.normalize(); other['max_sets'] = 7
        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(change, self.changed_rules(), self.token)
            b = pool.submit(change, other, second)
            results = [a.result(timeout=15), b.result(timeout=15)]
        self.assertEqual(sorted(r[0] for r in results), [200, 409])
        saved = next(r[1]['rules'] for r in results if r[0] == 200)
        self.assertEqual(self.ok('GET', self.path)['rules'], saved)
        self.assertEqual(self.ok('GET', self.path)['rules_revision'], before['rules_revision'] + 1)

    def test_event_rule_change_invalidates_list_and_batch_matches_use_event_rules(self):
        mid = self.new_match()
        before = self.ok('GET', f'/api/matches?category_id={self.cat}&limit=1')
        self.save_rules(self.changed_rules())
        after = self.ok('GET', f'/api/matches?category_id={self.cat}&limit=1')
        self.assertGreater(after['list_revision'], before['list_revision'])
        self.assertEqual(after['matches'][0]['rules'], self.changed_rules())
        self.assertEqual(self.ok('GET', f'/api/matches/{mid}')['match']['rules_hash'], after['matches'][0]['rules_hash'])

    def test_mixed_unification_preserves_all_started_evidence_and_rolls_back_failure(self):
        conn = db.connect(db.event_db_path(self.fx['event_id']))
        try:
            db.update(conn, 'categories', self.cat, {'team_rules_json': team_rules.canonical(self.changed_rules()), 'rules_revision': 4})
            conn.execute('DELETE FROM settings WHERE k=?', (team_rules_store.EVENT_MARKER,))
        finally: conn.close()
        db.init_db(db.event_db_path(self.fx['event_id']))
        mids = [self.new_match() for _ in range(6)]
        # Pre-existing snapshot plus four kinds of legacy started evidence lacking snapshots.
        self.ok('POST', f'/api/recording/match/{mids[0]}/claim', {})
        conn = db.connect(db.event_db_path(self.fx['event_id']))
        try:
            db.insert(conn, 'match_sets', {'match_id': mids[1], 'set_no': 1, 'home_points': 8, 'away_points': 5, 'winner_side': ''})
            db.insert(conn, 'score_events', {'match_id': mids[2], 'seq': 1, 'kind': 'score', 'set_no': 1, 'side': 'home', 'home_after': 1, 'away_after': 0})
            db.insert(conn, 'submissions', {'uid': 'event-rule-history', 'kind': 'match', 'match_id': mids[3], 'status': 'confirmed'})
            db.update(conn, 'matches', mids[4], {'status': 'finished', 'result_status': 'unfinished', 'result_version': 1})
            archived_plan = db.insert(conn, 'plans', {'category_id': self.cat, 'name': '旧归档方案', 'status': 'archived'})
            archived = db.insert(conn, 'matches', {'category_id': self.cat, 'plan_id': archived_plan,
                'home_source_type': 'participation', 'away_source_type': 'participation',
                'home_participation': self.fx['team_parts'][0], 'away_participation': self.fx['team_parts'][1],
                'status': 'finished', 'result_status': 'unfinished', 'result_version': 1})
            # A rejected event update must also roll back the preceding snapshot freezes.
            conn.execute("CREATE TRIGGER reject_event_rule BEFORE UPDATE OF team_rules_json ON events BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
            before = self.ok('GET', self.path)
            self.assertEqual(before['rules_state'], 'legacy_mixed')
            self.assertEqual(self.match_list(category_id=self.cat)[-1]['rules'], self.changed_rules())
            body = {'rules': team_rules.normalize(), 'expected_revision': before['rules_revision'],
                    'impact_token': before['impact_token'], 'acknowledge_legacy_unification': True}
            with self.assertRaises(Exception):
                with db.tx(conn): team_rules_store.save_event(conn, self.fx['event_id'], team_rules.normalize(), body)
            self.assertEqual(db.q1(conn, 'SELECT rules_snapshot_json FROM matches WHERE id=?', (mids[1],))[0], None)
            self.assertEqual(team_rules_store.event(conn, self.fx['event_id'])['rules_state'], 'legacy_mixed')
            conn.execute('DROP TRIGGER reject_event_rule')
        finally: conn.close()
        self.save_rules(team_rules.normalize(), expect=409)  # No implicit unification of a default draft.
        self.ok('PUT', self.path, body)
        for mid in mids[:5] + [archived]:
            match = self.ok('GET', f'/api/matches/{mid}')['match']
            self.assertEqual((match['rules_state'], match['rules']), ('frozen', self.changed_rules()))
        self.assertEqual(self.ok('GET', f'/api/matches/{mids[5]}')['match']['rules'], team_rules.normalize())
        self.assertEqual(self.ok('GET', self.path)['rules_state'], 'unified')

    def test_claim_freezes_and_same_owner_returns_snapshot(self):
        mid = self.new_match()
        before = self.ok('GET', self.path)
        frozen = self.ok('POST', f'/api/recording/match/{mid}/claim', {})
        self.assertEqual(frozen['rules_state'], 'frozen')
        self.save_rules(self.changed_rules(), before, expect=409)
        changed = self.save_rules(self.changed_rules())
        self.assertEqual(changed['frozen_matches'], 1)
        repeated = self.ok('POST', f'/api/recording/match/{mid}/claim', {})
        self.assertEqual(repeated['rules_hash'], frozen['rules_hash'])
        self.assertEqual(repeated['rules'], team_rules.normalize())
        later = self.new_match()
        new_claim = self.ok('POST', f'/api/recording/match/{later}/claim', {})
        self.assertEqual(new_claim['rules'], self.changed_rules())

    def test_broken_rule_data_and_hash_never_use_default(self):
        path = db.event_db_path(self.fx['event_id'])
        conn = db.connect(path)
        try:
            db.update(conn, 'events', self.fx['event_id'], {'team_rules_json': '{broken'})
            self.request('GET', self.path, expect=409)
            db.update(conn, 'events', self.fx['event_id'], {'team_rules_json': 'null'})
            self.request('GET', self.path, expect=409)
            db.update(conn, 'events', self.fx['event_id'], {'team_rules_json': json.dumps({**team_rules.normalize(), 'schema_version': 9})})
            self.request('GET', self.path, expect=409)
            db.update(conn, 'events', self.fx['event_id'], {'team_rules_json': None})
            mid = self.new_match()
            self.ok('POST', f'/api/recording/match/{mid}/claim', {})
            db.update(conn, 'matches', mid, {'rules_hash': 'wrong'})
            self.request('GET', f'/api/matches/{mid}', expect=409)
        finally: conn.close()

    def test_legacy_migration_backup_repeated_preserves_ids(self):
        mid = self.new_match()
        historical = [self.new_match() for _ in range(4)]
        source = db.connect(db.event_db_path(self.fx['event_id']))
        fixture_path = Path(tempfile.mkdtemp(prefix='legacy-rules-')) / 'old.db'
        target = db.connect(fixture_path)
        try:
            source.backup(target)
            # The legacy schema predates the rule-aware list triggers as well as its columns.
            for trigger in ('list_rev_matches_update', 'list_rev_categories_update'):
                target.execute(f'DROP TRIGGER {trigger}')
            target.execute('DELETE FROM settings WHERE k=?', (team_rules_store.MARKER,))
            target.execute('DELETE FROM settings WHERE k=?', (team_rules_store.EVENT_MARKER,))
            target.execute('INSERT INTO settings(k,v) VALUES(?,?)', (f'recording:match:{mid}', '{"user_id":1}'))
            db.update(target, 'matches', historical[0], {'status': 'finished', 'result_status': 'unfinished', 'result_version': 1})
            db.insert(target, 'match_sets', {'match_id': historical[1], 'set_no': 1, 'home_points': 8, 'away_points': 5, 'winner_side': ''})
            db.insert(target, 'score_events', {'match_id': historical[2], 'seq': 1, 'kind': 'score', 'set_no': 1, 'side': 'home', 'home_after': 1, 'away_after': 0})
            db.insert(target, 'submissions', {'uid': 'old-submit', 'kind': 'match', 'match_id': historical[3], 'status': 'confirmed'})
            for field in ('rules_snapshot_json', 'rules_revision', 'rules_hash'):
                target.execute(f'ALTER TABLE matches DROP COLUMN {field}')
            for field in ('team_rules_json', 'rules_revision'):
                target.execute(f'ALTER TABLE categories DROP COLUMN {field}')
        finally:
            target.close(); source.close()
        db.init_db(fixture_path)
        conn = db.connect(fixture_path)
        try:
            snap = team_rules_store.match_rules(conn, db.q1(conn, 'SELECT * FROM matches WHERE id=?', (mid,)))
            self.assertEqual(snap['rules'], team_rules.normalize())
            self.assertEqual(snap['rules_state'], 'frozen')
            for old_id in historical:
                self.assertEqual(team_rules_store.match_rules(conn, db.q1(conn, 'SELECT * FROM matches WHERE id=?', (old_id,)))['rules_state'], 'frozen')
            self.assertEqual(db.q1(conn, 'SELECT home_points FROM match_sets WHERE match_id=?', (historical[1],))[0], 8)
            all_ids = [r['id'] for r in db.q(conn, 'SELECT id FROM matches')]
        finally: conn.close()
        backup = find_backup(fixture_path, 'before-team-rules-v1')
        self.assertIsNotNone(backup)
        self.assertTrue(backup.is_file())
        original_backup = backup.read_bytes()
        db.init_db(fixture_path)
        self.assertEqual(backup.read_bytes(), original_backup)
        conn = db.connect(fixture_path)
        try:
            self.assertEqual([r['id'] for r in db.q(conn, 'SELECT id FROM matches')], all_ids)
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        finally: conn.close()

    def packet(self, mid, scoreline, uid=None):
        match = self.ok('GET', f'/api/scoring/match/{mid}')['match']
        sets = [{'set_no': i, 'home_points': h, 'away_points': a,
                 'winner_side': team_rules.winner(h, a, team_rules.for_set(match['rules'], i)) or ''}
                for i, (h, a) in enumerate(scoreline, 1)]
        return {'submission_uid': uid or f'rules-{mid}', 'match_id': mid, 'event_identity': self.event_identity,
                'base_version': match['base_version'], 'plan_version': match['plan_version'],
                'rules_hash': match['rules_hash'], 'result_status': 'normal', 'sets': sets,
                'home_participation': match['home']['participation_id'],
                'away_participation': match['away']['participation_id'], 'events': events_for_scores(scoreline)}

    def test_submit_five_sets_winner_hash_and_correction(self):
        self.save_rules(self.changed_rules())
        mid = self.new_match()
        incomplete = self.packet(mid, [(15, 0), (15, 0)])
        reviewed_result(self, 'POST', '/api/scoring/submit', incomplete, expected=422)
        packet = self.packet(mid, [(17, 16), (15, 0), (17, 14)])
        missing = copy.deepcopy(packet); missing.pop('rules_hash')
        reviewed_result(self, 'POST', '/api/scoring/submit', missing, expected=409)
        result = reviewed_result(self, 'POST', '/api/scoring/submit', packet, expected=200)
        self.assertEqual(result['match']['winner_side'], 'home')
        self.assertEqual(result['match']['rules_state'], 'frozen')
        self.assertTrue(reviewed_result(self, 'POST', '/api/scoring/submit', packet, expected=200)['duplicate'])
        self.save_rules(team_rules.normalize())
        match = self.ok('GET', f'/api/matches/{mid}')['match']
        self.assertEqual(match['rules'], self.changed_rules())
        correction = {'reason': '核对比分', 'rules_hash': match['rules_hash'], 'result_status': 'normal',
                      'sets': packet['sets'], 'events': []}
        reviewed_result(self, 'POST', f'/api/matches/{mid}/correction', correction, expected=200)
        correction['sets'] = copy.deepcopy(packet['sets']); correction['sets'][0]['away_points'] = 13
        reviewed_result(self, 'POST', f'/api/matches/{mid}/correction', {**correction, 'base_version': 2,
                     'request_uid': 'invalid-correction', 'event_identity': self.event_identity}, expected=422)
        for path in (f'/api/exports/record-sheet.html?match_id={mid}', f'/api/exports/record-sheet.csv?match_id={mid}'):
            status, raw = self.request('GET', path, raw=True)
            self.assertEqual(status, 200)
            self.assertIn('5局3胜', raw.decode('utf-8-sig'))

    def test_one_set_deciding_and_actual_advancement(self):
        r = team_rules.normalize(); r['max_sets'] = 1
        r['deciding'] = {'mode': 'fixed_deuce', 'target_points': 11, 'deuce_points': 13}
        self.save_rules(r)
        mid = self.new_match()
        result = reviewed_result(self, 'POST', '/api/scoring/submit', self.packet(mid, [(13, 11)]), expected=200)
        self.assertEqual(result['match']['winner_side'], 'home')
        conn = db.connect(db.event_db_path(self.fx['event_id']))
        try:
            from app.domain import advancement
            self.assertEqual(advancement.result_winner_side(conn, db.q1(conn, 'SELECT * FROM matches WHERE id=?', (mid,))), 'home')
        finally: conn.close()

    def test_legacy_packet_and_rollback_of_illegal_extra_point(self):
        mid = self.new_match()
        packet = self.packet(mid, [(15, 0), (15, 0)])
        packet.pop('rules_hash')
        bad = copy.deepcopy(packet)
        bad['events'].append({'seq': len(bad['events']) + 1, 'kind': 'score', 'set_no': 2, 'side': 'away'})
        reviewed_result(self, 'POST', '/api/scoring/submit', bad, expected=422)
        self.assertEqual(self.ok('GET', f'/api/matches/{mid}')['match']['rules_state'], 'inherited')
        reviewed_result(self, 'POST', '/api/scoring/submit', packet, expected=200)
        self.assertTrue(reviewed_result(self, 'POST', '/api/scoring/submit', packet, expected=200)['duplicate'])

    def test_actual_concurrent_claim_and_change_atomic_order(self):
        for i in range(3):
            mid = self.new_match()
            before = self.ok('GET', self.path)
            desired = self.changed_rules() if before['rules']['max_sets'] == 3 else team_rules.normalize()
            body = {'rules': desired, 'expected_revision': before['rules_revision'], 'impact_token': before['impact_token']}
            start = threading.Barrier(2)
            def change():
                start.wait(timeout=5)
                status, raw = self.request('PUT', self.path, body, raw=True)
                return status, json.loads(raw)
            def claim():
                start.wait(timeout=5)
                return self.request('POST', f'/api/recording/match/{mid}/claim', {}, expect=200)
            with ThreadPoolExecutor(max_workers=2) as executor:
                change_future = executor.submit(change); claim_future = executor.submit(claim)
                status, response = change_future.result(timeout=15); frozen = claim_future.result(timeout=15)
            self.assertIn(status, (200, 409), response)
            self.assertEqual(frozen['rules'], desired if status == 200 else before['rules'])
            self.assertEqual(self.ok('GET', f'/api/matches/{mid}')['match']['rules_hash'], frozen['rules_hash'])

    def test_round_robin_standings_and_double_elim_reset_nondefault(self):
        r = team_rules.normalize(); r['max_sets'] = 1
        self.save_rules(r)
        plan = self.fixture_schedule('POST', f'/api/categories/{self.cat}/plan', {'stages': [
            {'kind': 'round_robin', 'name': '循环赛', 'params': {}}]})['plan_id']
        self.fixture_schedule('POST', f'/api/plans/{plan}/generate'); self.fixture_schedule('POST', f'/api/plans/{plan}/lock')
        match = self.match_list(category_id=self.cat)[0]
        reviewed_result(self, 'POST', '/api/scoring/submit', self.packet(match['id'], [(15, 9)]), expected=200)
        pool = self.ok('GET', f'/api/categories/{self.cat}/plan')['plan']['stages'][0]['pools'][0]
        standings = self.ok('GET', f"/api/pools/{pool['id']}/standings")
        winner_row = next(row for row in standings['rows'] if row['wins'])
        self.assertEqual((winner_row['sets_won'], winner_row['points']), (1, 2))
        # A new isolated project/event exercises actual grand-final-reset generation.
        self.fx = self.build_event(team_count=4, individual_count=0)
        self.cat = self.fx['team_cat']; self.path = f"/api/events/{self.fx['event_id']}/team-rules"
        self.save_rules(r)
        plan = self.fixture_schedule('POST', f'/api/categories/{self.cat}/plan', {'stages': [
            {'kind': 'double_elim', 'name': '双淘汰', 'params': {'grand_final_reset': True}}]})['plan_id']
        self.fixture_schedule('POST', f'/api/plans/{plan}/generate'); self.fixture_schedule('POST', f'/api/plans/{plan}/lock')
        for _ in range(20):
            ready = self.match_list(category_id=self.cat, status='ready')
            finals = [m for m in ready if m['round_no'] == 200]
            if finals: break
            self.assertTrue(ready)
            for m in ready: reviewed_result(self, 'POST', '/api/scoring/submit', self.packet(m['id'], [(15, 8)]), expected=200)
        self.assertEqual(len(finals), 1)
        reviewed_result(self, 'POST', '/api/scoring/submit', self.packet(finals[0]['id'], [(9, 15)]), expected=200)
        resets = [m for m in self.match_list(category_id=self.cat) if m['round_no'] == 201]
        self.assertEqual(len(resets), 1); self.assertEqual(resets[0]['status'], 'ready')
        reviewed_result(self, 'POST', '/api/scoring/submit', self.packet(resets[0]['id'], [(15, 5)]), expected=200)
        result = self.ok('POST', f'/api/categories/{self.cat}/placements/auto', {})
        self.assertEqual(sorted(p['rank_no'] for p in result['placements']), [1, 2])

    def test_nine_set_csv_columns_and_frozen_transfer(self):
        r = team_rules.normalize(); r['max_sets'] = 9
        self.save_rules(r)
        mid = self.new_match()
        claim = self.ok('POST', f'/api/recording/match/{mid}/claim', {})
        token = self.make_user('recorder')
        uid = self.ok('GET', '/api/me', token=token)['user']['id']
        transfer = self.ok('POST', f'/api/recording/match/{mid}/transfer', {'user_id': uid, 'reason': '换班核对'})
        self.assertEqual(claim['rules_hash'], transfer['rules_hash'])
        status, raw = self.request('GET', f'/api/exports/record-sheet.csv?match_id={mid}', raw=True)
        self.assertEqual(status, 200); self.assertIn('第9局', raw.decode('utf-8-sig'))
        status, raw = self.request('GET', f'/api/exports/record-sheet.html?match_id={mid}', raw=True)
        self.assertEqual(status, 200); self.assertIn('<th>第9局</th>', raw.decode('utf-8'))

    def test_unclaimed_administrative_result_freezes_rules(self):
        self.save_rules(self.changed_rules())
        for result_status in ('cancelled', 'unfinished'):
            mid = self.new_match()
            result = reviewed_result(self, 'POST', f'/api/matches/{mid}/cancel', {'result_status': result_status, 'reason': '现场确认'}, expected=200)
            self.assertEqual(result['match']['rules_state'], 'frozen')
            frozen = result['match']['rules_hash']
            self.save_rules(team_rules.normalize())
            current = self.ok('GET', f'/api/matches/{mid}')['match']
            self.assertEqual(current['rules_hash'], frozen)
            self.assertEqual(current['rules'], self.changed_rules())
            self.save_rules(self.changed_rules())


# Reuse the fixture helpers without inheriting the unrelated API suite as duplicate tests.
for _name in dir(fixtures.ApiTest):
    if _name.startswith('test_') and _name not in TeamRulesApiTest.__dict__:
        setattr(TeamRulesApiTest, _name, None)
