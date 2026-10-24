"""取消/未完成场次的旧局分不得在记录表与成绩导出中呈现为有效比分。"""
from helpers.reviewed_result import reviewed_result
import csv
import io
import tempfile
import unittest
from pathlib import Path

import test_api
from app import config


class CancelArchiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task = Path(tempfile.mkdtemp(prefix='cancel-archive-'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task, task / 'registry.db', task / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)

    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    build_event = test_api.ApiTest.build_event
    play = test_api.ApiTest.play
    lineup_for = test_api.ApiTest.lineup_for
    events_for = test_api.ApiTest.events_for

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.fx = self.build_event(team_count=2, individual_count=0)
        self.match_id = self.ok('POST', '/api/matches', {
            'category_id': self.fx['team_cat'],
            'home_participation': self.fx['team_parts'][0],
            'away_participation': self.fx['team_parts'][1],
            'round_label': '补赛',
        })['match_id']
        self.play(self.match_id, [(15, 10), (15, 12)])
        reviewed_result(self, 'POST', f'/api/matches/{self.match_id}/cancel', {'reason': '现场取消'}, expected=200)

    def raw(self, path):
        status, payload = self.request('GET', path, expect=200, raw=True)
        return payload.decode('utf-8-sig')

    def test_record_sheet_html_marks_void_scores(self):
        text = self.raw(f'/api/exports/record-sheet.html?match_id={self.match_id}')
        self.assertIn('取消 ☑', text)
        self.assertIn('原局分作废', text)
        self.assertNotIn('<td>15</td>', text)
        self.assertNotIn('15:10', text)

    def test_record_sheet_csv_does_not_render_old_sets(self):
        rows = list(csv.reader(io.StringIO(self.raw(
            f'/api/exports/record-sheet.csv?match_id={self.match_id}'))))
        set_rows = [row for row in rows if row and row[0].startswith('第') and row[0].endswith('局')]
        self.assertTrue(set_rows)
        self.assertTrue(all(row[1:] == ['', '', ''] for row in set_rows), set_rows)
        self.assertTrue(any('原局分作废' in ' '.join(row) for row in rows))

    def test_results_csv_and_xlsx_do_not_render_old_sets(self):
        text = self.raw(f"/api/exports/results.csv?category_id={self.fx['team_cat']}")
        rows = list(csv.reader(io.StringIO(text)))
        matches = [row for row in rows if len(row) >= 8 and row[2] == '补赛']
        self.assertEqual(len(matches), 1, rows)
        self.assertEqual(matches[0][5], '', '取消场次的各局比分必须为空')
        self.assertEqual(matches[0][6], '', '取消场次不得给出胜方')
        self.assertIn('已取消', matches[0][7])


if __name__ == '__main__':
    unittest.main()
