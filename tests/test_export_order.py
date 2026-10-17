"""成绩类导出正序/倒序的真实 HTTP 隔离测试。"""
from __future__ import annotations

import csv
import io
import re
import tempfile
import unittest
import uuid
from pathlib import Path

import openpyxl

import test_api
from app import config


class ExportOrderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task_tmp = Path(tempfile.mkdtemp(prefix='stss_export_order_'))
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = task_tmp, task_tmp / 'registry.db', task_tmp / 'events'
        test_api.ApiTest.setUpClass.__func__(cls)

    tearDownClass = classmethod(test_api.ApiTest.tearDownClass.__func__)
    request = test_api.ApiTest.request
    ok = test_api.ApiTest.ok
    err = test_api.ApiTest.err
    login = test_api.ApiTest.login
    make_user = test_api.ApiTest.make_user
    build_event = test_api.ApiTest.build_event
    build_plan = test_api.ApiTest.build_plan
    play = test_api.ApiTest.play
    events_for = test_api.ApiTest.events_for
    lineup_for = test_api.ApiTest.lineup_for
    fixture_schedule = test_api.ApiTest.fixture_schedule
    match_list = test_api.ApiTest.match_list

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True

    # ---------------------------------------------------------------- helpers
    def raw(self, path, expect=200):
        status, body = self.request('GET', path, raw=True, expect=expect)
        return status, body

    def text(self, path, expect=200):
        return self.raw(path, expect)[1].decode('utf-8-sig')

    def csv_rows(self, path):
        return list(csv.reader(io.StringIO(self.text(path))))

    def xlsx_rows(self, path):
        status, body = self.raw(path)
        self.assertEqual(status, 200)
        book = openpyxl.load_workbook(io.BytesIO(body), data_only=True)
        return [list(row) for row in book.active.iter_rows(values_only=True)]

    def html_cells(self, path):
        """把打印页第一个表格的每行单元格文本提取为行列表（含表头），忽略样式/工具栏。"""
        page = self.text(path)
        table_html = page.split('<table', 1)[-1]
        rows = []
        for row_html in re.findall(r'<tr>(.*?)</tr>', table_html, flags=re.S):
            cells = [re.sub(r'<[^>]+>', '', cell).strip()
                     for cell in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row_html, flags=re.S)]
            if cells:
                rows.append(cells)
        return rows

    def prepare(self, team_count=6, individual_count=3):
        self.fx = self.build_event(team_count, individual_count)
        self.team_cat = self.fx['team_cat']
        self.indiv_cat = self.fx['indiv_cat']
        plan = self.build_plan(self.fx)
        stages = self.ok('GET', f'/api/plans/{plan[0]}')['plan']['stages']
        self.pools = stages[0]['pools']
        group_stage = stages[0]
        matches = self.match_list(stage_id=group_stage['id'])
        for match in matches[:3]:
            self.play(match['id'], [(15, 9), (15, 11)])
        for index, pid in enumerate(self.fx['team_parts'], start=1):
            self.ok('POST', f'/api/categories/{self.team_cat}/placements',
                    {'participation_id': pid, 'rank_no': index, 'confirm': True})
        for part, value in zip(self.fx['indiv_parts'], (20, 18, 16)):
            self.ok('POST', '/api/scoring/individual', {
                'submission_uid': str(uuid.uuid4()), 'participation_id': part, 'base_version': 0,
                'result_status': 'normal', 'result_value': value, 'error_count': 0,
                'violation_count': 0, 'device': '排序测试', 'event_identity': dict(self.event_identity),
            })
        self.ok('POST', f'/api/categories/{self.indiv_cat}/individual-rankings/confirm', {})
        self.group_id = self.fx['groups']['甲']['id']
        self.pool_ids = ','.join(str(p['id']) for p in self.pools)

    def assert_reverse(self, asc, desc, label):
        self.assertEqual(desc[0], asc[0], f'{label} 表头应一致')
        self.assertEqual(desc[1:], list(reversed(asc[1:])), f'{label} 倒序应等于正序整体反转')

    # ---------------------------------------------------------------- 接口矩阵
    def test_results_and_notice_asc_desc(self):
        self.prepare()
        for path, kind in ((f'/api/exports/results.csv?category_id={self.team_cat}', 'csv'),
                           (f'/api/exports/results.csv?category_id={self.indiv_cat}', 'csv')):
            asc = self.csv_rows(path)
            self.assertGreater(len(asc), 2, path)
            default = self.csv_rows(path)
            self.assertEqual(default, asc, f'{path} 缺省应等于 asc')
            desc = self.csv_rows(path + '&order=desc')
            self.assert_reverse(asc, desc, path)
            self.assertEqual(self.csv_rows(path + '&order=asc'), asc, path)
        for path in (f'/api/exports/results.xlsx?category_id={self.team_cat}',
                     f'/api/exports/results.xlsx?category_id={self.indiv_cat}'):
            asc = self.xlsx_rows(path)
            desc = self.xlsx_rows(path + '&order=desc')
            self.assert_reverse(asc, desc, path)
            self.assertEqual(len(asc), len(desc))
        for cat in (self.team_cat, self.indiv_cat):
            asc = self.html_cells(f'/api/exports/category-notice.html?category_id={cat}')
            desc = self.html_cells(f'/api/exports/category-notice.html?category_id={cat}&order=desc')
            self.assertGreater(len(asc), 1)
            self.assert_reverse(asc, desc, f'category-notice {cat}')
            self.assertIn('共', self.text(f'/api/exports/category-notice.html?category_id={cat}&order=desc'))

    def test_standings_and_school_totals_asc_desc(self):
        self.prepare()
        paths = (f'/api/exports/standings.csv?pool_ids={self.pool_ids}',
                 f'/api/exports/school-totals.csv?group_id={self.group_id}')
        for path in paths:
            asc = self.csv_rows(path)
            self.assertGreater(len(asc), 2, path)
            self.assertEqual(self.csv_rows(path), asc)
            self.assert_reverse(asc, self.csv_rows(path + '&order=desc'), path)
        for path in (f'/api/exports/standings.xlsx?pool_ids={self.pool_ids}',
                     f'/api/exports/school-totals.xlsx?group_id={self.group_id}'):
            asc = self.xlsx_rows(path)
            self.assert_reverse(asc, self.xlsx_rows(path + '&order=desc'), path)
        school_asc = self.html_cells(f'/api/exports/school-notice.html?group_id={self.group_id}')
        school_desc = self.html_cells(f'/api/exports/school-notice.html?group_id={self.group_id}&order=desc')
        self.assert_reverse(school_asc, school_desc, 'school-notice')

    def test_invalid_order_is_rejected_without_file(self):
        self.prepare()
        paths = [
            f'/api/exports/results.csv?category_id={self.team_cat}&order=descx',
            f'/api/exports/results.xlsx?category_id={self.team_cat}&order=desc_extra',
            f'/api/exports/category-notice.html?category_id={self.team_cat}&order=up',
            f'/api/exports/standings.csv?pool_ids={self.pool_ids}&order=down',
            f'/api/exports/standings.xlsx?pool_ids={self.pool_ids}&order=1',
            f'/api/exports/school-totals.csv?group_id={self.group_id}&order=reverse',
            f'/api/exports/school-totals.xlsx?group_id={self.group_id}&order=true',
            f'/api/exports/school-notice.html?group_id={self.group_id}&order=top',
        ]
        for path in paths:
            status, body = self.raw(path, expect=400)
            self.assertEqual(status, 400, path)
            self.assertIn('invalid_order', body.decode('utf-8'), path)

    def test_other_exports_ignore_order_and_empty_data_stays_valid(self):
        self.prepare()
        schedule = f"/api/exports/schedule.csv?event_id={self.fx['event_id']}"
        self.assertEqual(self.text(schedule), self.text(schedule + '&order=desc'))
        first_match = self.ok('GET', f'/api/categories/{self.team_cat}/plan')['plan']['stages'][0]['matches'][0]
        record = f"/api/exports/record-sheet.csv?match_id={first_match['id']}"
        self.assertEqual(self.text(record), self.text(record + '&order=desc'))

        empty_cat = next(c['id'] for c in self.fx['groups']['乙']['categories'] if c['kind'] == 'team')
        empty = f'/api/exports/results.csv?category_id={empty_cat}'
        self.assertEqual(self.csv_rows(empty), self.csv_rows(empty + '&order=desc'))
        empty_xlsx = self.xlsx_rows(f'/api/exports/results.xlsx?category_id={empty_cat}&order=desc')
        self.assertEqual(len(empty_xlsx), 1, '空数据仍应只有表头')
        empty_totals = self.xlsx_rows(f"/api/exports/school-totals.xlsx?group_id={self.fx['groups']['乙']['id']}&order=desc")
        self.assertGreaterEqual(len(empty_totals), 1)


if __name__ == '__main__':
    unittest.main()
