"""Bounded pages, authorized counts, revision changes and batched relations."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, list_revision, result_candidates
from app.api.common import serialize_match, serialize_matches
from app.api.scheduling import plan_detail
from app.errors import ApiError
from app.http_server import Context
from app.match_listing import list_page
from app.domain.schedule import validate_schedule


class PaginationSafetyTest(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(':memory:')
        self.conn.executescript((Path(__file__).resolve().parents[1] / 'app/schema.sql').read_text(encoding='utf-8'))
        db._migrate(self.conn)
        result_candidates.initialize(self.conn)
        c = self.conn
        with db.tx(c):
            self.user = {'id': db.insert(c, 'users', {'username': 'page-audit', 'password_hash': 'x', 'salt': 'x', 'role': 'admin'}), 'role': 'admin'}
            self.event = db.insert(c, 'events', {'name': 'Memory event', 'uuid': 'memory'})
            group = db.insert(c, 'groups', {'event_id': self.event, 'code': 'A', 'name': 'Group'})
            self.cat = db.insert(c, 'categories', {'group_id': group, 'gender': 'male', 'kind': 'team', 'name': 'Team'})
            self.plan = db.insert(c, 'plans', {'category_id': self.cat, 'status': 'locked'})
            self.stage = db.insert(c, 'stages', {'plan_id': self.plan, 'seq': 1, 'kind': 'custom', 'name': 'Manual'})
            parts = []
            for n in (1, 2):
                sid = db.insert(c, 'schools', {'event_id': self.event, 'name': f'学校{n}', 'short_name': f'校{n}'})
                tid = db.insert(c, 'teams', {'category_id': self.cat, 'school_id': sid, 'name': f'Team{n}'})
                parts.append(db.insert(c, 'participations', {'category_id': self.cat, 'team_id': tid}))
            self.ids = []
            for n in range(601):
                self.ids.append(db.insert(c, 'matches', {'category_id': self.cat, 'plan_id': self.plan,
                    'stage_id': self.stage, 'seq': n + 1, 'round_no': 1, 'round_label': f'场次{n + 1}',
                    'status': 'ready' if n < 600 else 'pending', 'home_actual': parts[0], 'away_actual': parts[1],
                    'home_source_type': 'participation', 'home_participation': parts[0],
                    'away_source_type': 'participation', 'away_participation': parts[1]}))
            db.run(c, 'INSERT INTO settings(k,v) VALUES(?,?)',
                   (f'recording:match:{self.ids[0]}', json.dumps({'user_id': self.user['id']})))

    def tearDown(self):
        self.conn.close()

    def context(self, role='admin', **query):
        return Context(self.conn, {**self.user, 'role': role}, {},
                       {k: [str(v)] for k, v in query.items()}, {}, {}, 'GET', '/api/matches')

    def test_pages_are_bounded_and_legacy_never_silently_truncates(self):
        first = list_page(self.context(offset=0, limit=100))
        second = list_page(self.context(offset=100, limit=100, list_revision=first['list_revision']))
        self.assertEqual(first['total'], 601)
        self.assertTrue(first['has_more'])
        self.assertEqual(len(first['matches']), 100)
        self.assertFalse({m['id'] for m in first['matches']} & {m['id'] for m in second['matches']})
        with self.assertRaises(ApiError) as err:
            list_page(self.context())
        self.assertEqual(err.exception.code, 'pagination_required')
        page = list_page(self.context(offset=0, limit=100, q='场次601'))
        self.assertEqual([m['id'] for m in page['matches']], [self.ids[-1]])

    def test_authorization_precedes_count_and_pagination(self):
        viewer = list_page(self.context('viewer', offset=0, limit=100))
        self.assertEqual(viewer['total'], 600)
        db.run(self.conn, "UPDATE plans SET status='draft' WHERE id=?", (self.plan,))
        viewer = list_page(self.context('viewer', offset=0, limit=100))
        self.assertEqual(viewer['total'], 0)
        self.assertEqual(viewer['matches'], [])

    def test_membership_revision_detects_changes_not_pure_scores(self):
        first = list_page(self.context(offset=0, limit=100))
        db.run(self.conn, 'UPDATE matches SET result_version=result_version+1 WHERE id=?', (self.ids[0],))
        self.assertEqual(list_revision.value(self.conn), first['list_revision'])
        list_page(self.context(offset=100, limit=100, list_revision=first['list_revision']))
        db.run(self.conn, 'UPDATE schools SET short_name=? WHERE id=(SELECT MIN(id) FROM schools)', ('改名',))
        with self.assertRaises(ApiError) as err:
            list_page(self.context(offset=100, limit=100, list_revision=first['list_revision']))
        self.assertEqual(err.exception.code, 'list_changed')

    def test_bulk_serializer_matches_single_and_has_bounded_queries(self):
        rows = db.q(self.conn, 'SELECT * FROM matches ORDER BY id LIMIT 100')
        expected = [serialize_match(self.conn, r, with_sets=False) for r in rows]
        calls = []
        self.conn.set_trace_callback(calls.append)
        actual = serialize_matches(self.conn, rows, with_sets=False)
        self.conn.set_trace_callback(None)
        self.assertEqual(actual, expected)
        self.assertLessEqual(sum(s.lstrip().upper().startswith('SELECT') for s in calls), 20)

    def test_summary_plan_never_reads_full_matches(self):
        plan = db.q1(self.conn, 'SELECT * FROM plans WHERE id=?', (self.plan,))
        calls = []
        self.conn.set_trace_callback(calls.append)
        summary = plan_detail(self.conn, plan, include_matches=False)
        self.conn.set_trace_callback(None)
        self.assertEqual(summary['stages'][0]['matches'], [])
        self.assertEqual(summary['stages'][0]['match_count'], 601)
        self.assertEqual(len(calls), 2)

    def test_retired_resets_do_not_block_schedule_or_dependencies(self):
        first, second = self.ids[:2]
        self.conn.execute('UPDATE matches SET reset_state=?, scheduled_at=? WHERE id=?',
                          ('inactive', '2026-10-07 09:00', first))
        change = dict(db.q1(self.conn, 'SELECT * FROM matches WHERE id=?', (second,)))
        change.update(scheduled_at='2026-10-07 09:00', home_source_type='match_winner',
                      home_source_match=first)
        validate_schedule(self.conn, {second: change})
        self.conn.execute("UPDATE matches SET reset_state='review' WHERE id=?", (first,))
        validate_schedule(self.conn, {second: change})
        self.conn.execute("UPDATE matches SET reset_state='active' WHERE id=?", (first,))
        with self.assertRaises(ApiError) as error:
            validate_schedule(self.conn, {second: change})
        self.assertEqual(error.exception.code, 'schedule_conflict')


if __name__ == '__main__':
    unittest.main()
