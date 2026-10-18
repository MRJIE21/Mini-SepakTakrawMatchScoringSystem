"""成绩导出口径/格式与 XLSX 的真实 HTTP 隔离测试。"""
from __future__ import annotations

import csv
import io
import tempfile
import unittest
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import openpyxl

import test_api
from app import config

STANDARD = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'


class ExportFormatTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        task_tmp = Path(tempfile.mkdtemp(prefix='stss_export_format_'))
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
    match_list = test_api.ApiTest.match_list
    fixture_schedule = test_api.ApiTest.fixture_schedule
    lineup_for = test_api.ApiTest.lineup_for

    def setUp(self):
        test_api.ApiTest.setUp(self)
        self.use_event_database = True

    # ------------------------------------------------------------ helpers
    def text(self, path, expect=200):
        status, raw = self.request('GET', path, raw=True, expect=expect)
        return raw.decode('utf-8-sig')

    def workbook(self, path):
        status, raw = self.request('GET', path, raw=True, expect=200)
        self.assertEqual(status, 200)
        self.assertTrue(raw.startswith(b'PK'), 'xlsx 必须是 zip 容器')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = set(archive.namelist())
            self.assertTrue({'[Content_Types].xml', 'xl/workbook.xml',
                             'xl/worksheets/sheet1.xml', 'xl/styles.xml'} <= names, names)
            for name in names:
                if name.endswith('.xml') or name.endswith('.rels'):
                    ET.fromstring(archive.read(name))
        return openpyxl.load_workbook(io.BytesIO(raw), data_only=True)

    def sheet_rows(self, path):
        book = self.workbook(path)
        sheet = book.active
        return [list(row) for row in sheet.iter_rows(values_only=True)]

    def submit_individual(self, participation_id, value=None, status='normal', errors=0, violations=0):
        return self.ok('POST', '/api/scoring/individual', {
            'submission_uid': str(uuid.uuid4()), 'participation_id': participation_id,
            'base_version': 0, 'result_status': status, 'result_value': value,
            'error_count': errors, 'violation_count': violations,
            'device': '导出格式测试', 'event_identity': dict(self.event_identity),
        })

    # ------------------------------------------------------------ REQ-001/002/004
    def test_pending_semantics_notice_and_numeric_format(self):
        fx = self.build_event(team_count=0, individual_count=6)
        cat = fx['indiv_cat']
        parts = fx['indiv_parts']
        group_id = fx['groups']['甲']['id']

        # 真正缺成绩时仍显示待确认，而不是被当成非正常完成。
        notice = self.text(f'/api/exports/category-notice.html?category_id={cat}')
        self.assertIn('待确认 6 人', notice)
        rows = list(csv.DictReader(io.StringIO(self.text(f'/api/exports/results.csv?category_id={cat}'))))
        self.assertEqual({row['名次'] for row in rows}, {'待确认'})
        totals = self.ok('GET', f'/api/groups/{group_id}/school-totals')
        self.assertEqual(sum(len(row['pending']) for row in totals['rows']), 6)

        for part, value in zip(parts[:4], (21, 19, 15, 12)):
            self.submit_individual(part, value)
        self.submit_individual(parts[4], None, status='dnf')
        self.submit_individual(parts[5], None, status='dns')
        self.ok('POST', f'/api/categories/{cat}/individual-rankings/confirm', {})

        notice = self.text(f'/api/exports/category-notice.html?category_id={cat}')
        self.assertIn('待确认 0 人', notice)
        self.assertIn('—', notice)
        self.assertIn('<td>21</td>', notice)
        self.assertNotIn('21.0', notice)
        self.assertNotIn('<td>待确认</td>', notice)

        rows = list(csv.DictReader(io.StringIO(self.text(f'/api/exports/results.csv?category_id={cat}'))))
        self.assertEqual(len(rows), 6)
        self.assertEqual([row['名次'] for row in rows[:4]], ['1', '2', '3', '4'])
        self.assertEqual([row['名次'] for row in rows[4:]], ['—', '—'])
        self.assertEqual([row['有效次数'] for row in rows[:4]], ['21', '19', '15', '12'])
        self.assertEqual([row['有效次数'] for row in rows[4:]], ['', ''])
        self.assertEqual([row['结果状态'] for row in rows[4:]], ['未完成', '未参加'])

        totals = self.ok('GET', f'/api/groups/{group_id}/school-totals')
        self.assertEqual(sum(len(row['pending']) for row in totals['rows']), 0)
        total_rows = list(csv.DictReader(io.StringIO(
            self.text(f'/api/exports/school-totals.csv?group_id={group_id}'))))
        self.assertIn('待确认项目', total_rows[0])
        self.assertEqual({row['待确认项目'] for row in total_rows}, {'0'})
        school_notice = self.text(f'/api/exports/school-notice.html?group_id={group_id}')
        self.assertIn('尚有 0 项名次未确认', school_notice)

    # ------------------------------------------------------------ REQ-003/005
    def test_csv_localization_and_record_sheet(self):
        fx = self.build_event(team_count=6, individual_count=0)
        cat = fx['team_cat']
        plan = self.build_plan(fx)
        group_stage = self.ok('GET', f'/api/plans/{plan[0]}')['plan']['stages'][0]
        matches = self.match_list(stage_id=group_stage['id'])
        self.play(matches[0]['id'], [(15, 8), (15, 10)])

        schedule = self.text(f"/api/exports/schedule.csv?event_id={fx['event_id']}")
        self.assertIn('已确认', schedule)
        self.assertIn('正常完成', schedule)
        for token in ('finished', 'normal', 'home_forfeit', 'away_forfeit'):
            self.assertNotIn(token, schedule)
        results = self.text(f'/api/exports/results.csv?category_id={cat}')
        self.assertIn('正常完成', results)
        self.assertIn('主队', results)
        self.assertNotIn('normal', results)

        record_csv = self.text(f"/api/exports/record-sheet.csv?match_id={matches[0]['id']}")
        self.assertIn('第1局', record_csv)
        self.assertIn('主队', record_csv)
        self.assertIn('正常完成', record_csv)
        self.assertNotIn('home', record_csv)

        sheet = self.text(f"/api/exports/record-sheet.html?match_id={matches[0]['id']}")
        self.assertIn('本表已填入系统记录的局分与结果', sheet)
        self.assertIn('<td>15</td>', sheet)
        self.assertIn('<td>8</td>', sheet)
        self.assertIn('☑', sheet)
        self.assertNotIn('空白记录表', sheet)

        pending = self.ok('POST', '/api/matches', {
            'category_id': cat, 'home_participation': fx['team_parts'][0],
            'away_participation': fx['team_parts'][1], 'round_label': '未开始测试'})
        empty_sheet = self.text(f"/api/exports/record-sheet.html?match_id={pending['match_id']}")
        self.assertIn('本表为空白记录表', empty_sheet)
        self.assertNotIn('<td>15</td>', empty_sheet)

    # ------------------------------------------------------------ REQ-005 无局分最终状态
    def test_record_sheet_note_matches_final_status_without_sets(self):
        fx = self.build_event(team_count=2, individual_count=0)
        cat = fx['team_cat']

        def new_match(label):
            created = self.ok('POST', '/api/matches', {
                'category_id': cat, 'home_participation': fx['team_parts'][0],
                'away_participation': fx['team_parts'][1], 'round_label': label})
            detail = self.ok('GET', f"/api/matches/{created['match_id']}")['match']
            return created['match_id'], detail

        for status, label in (('home_forfeit', '主队弃权'), ('away_forfeit', '客队弃权'),
                              ('unfinished', '未完成'), ('cancelled', '已取消')):
            match_id, detail = new_match(f'{label}场')
            self.ok('POST', '/api/scoring/submit', {
                'submission_uid': str(uuid.uuid4()), 'match_id': match_id, 'base_version': 0,
                'result_status': status, 'sets': [], 'events': [], 'device': '脚注测试',
                'plan_version': detail['plan_version'],
                'home_participation': detail['home']['participation_id'],
                'away_participation': detail['away']['participation_id'],
                'event_identity': dict(self.event_identity)})
            sheet = self.text(f'/api/exports/record-sheet.html?match_id={match_id}')
            if status in ('unfinished', 'cancelled'):
                self.assertIn('本场已取消/未完成，原局分作废；结果以系统记录为准。', sheet)
                self.assertNotIn('本表已填入系统记录的局分与结果', sheet)
            else:
                self.assertIn('本场无逐局比分（弃权/未完成/取消），结果以系统记录为准。', sheet)
            self.assertNotIn('本表为空白记录表', sheet)
            self.assertIn(f'结果状态：{label}', sheet)
            self.assertIn('☑', sheet)
            record_csv = self.text(f'/api/exports/record-sheet.csv?match_id={match_id}')
            self.assertIn(f'结果状态,{label}', record_csv)

        unstarted_id, _ = new_match('未开始场')
        unstarted = self.text(f'/api/exports/record-sheet.html?match_id={unstarted_id}')
        self.assertIn('本表为空白记录表', unstarted)
        self.assertNotIn('本场无逐局比分', unstarted)

        normal_id, _ = new_match('正常场')
        self.play(normal_id, [(15, 8), (15, 10)])
        normal = self.text(f'/api/exports/record-sheet.html?match_id={normal_id}')
        self.assertIn('本表已填入系统记录的局分与结果', normal)
        self.assertNotIn('本场无逐局比分', normal)
        self.assertNotIn('本表为空白记录表', normal)

    # ------------------------------------------------------------ REQ-007
    def test_xlsx_reports_are_real_and_match_csv(self):
        fx = self.build_event(team_count=6, individual_count=6)
        cat = fx['indiv_cat']
        participations = self.ok('GET', f'/api/categories/{cat}/participations')['participations']
        target = next(item for item in participations if item.get('athlete_id'))
        self.ok('PUT', f"/api/athletes/{target['athlete_id']}", {'name': '=1+1'})
        self.ok('PUT', f"/api/schools/{target['school_id']}", {'name': '=SUM(A1:A2)'})
        for part, value in zip(fx['indiv_parts'], (21, 19, 15, 12, 9, 7)):
            self.submit_individual(part, value)
        self.ok('POST', f'/api/categories/{cat}/individual-rankings/confirm', {})
        group_id = fx['groups']['甲']['id']
        plan = self.build_plan(fx)
        pools = self.ok('GET', f'/api/plans/{plan[0]}')['plan']['stages'][0]['pools']
        pool_ids = ','.join(str(pool['id']) for pool in pools)

        for path, book in (
            (f'/api/exports/results.xlsx?category_id={cat}', '项目成绩'),
            (f'/api/exports/standings.xlsx?pool_ids={pool_ids}', '小组排名'),
            (f'/api/exports/school-totals.xlsx?group_id={group_id}', '学校总分'),
        ):
            status, raw = self.request('GET', path, raw=True, expect=200)
            self.assertEqual(status, 200)
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                self.assertIn('xl/workbook.xml', archive.namelist())
                ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
            workbook = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
            self.assertEqual(workbook.sheetnames, [book])
            rows = [list(row) for row in workbook.active.iter_rows(values_only=True)]
            self.assertGreaterEqual(len(rows), 1)

        results = self.sheet_rows(f'/api/exports/results.xlsx?category_id={cat}')
        csv_rows = list(csv.DictReader(io.StringIO(self.text(f'/api/exports/results.csv?category_id={cat}'))))
        self.assertEqual(list(results[0]), ['大组别', '项目', '学校', '运动员', '有效次数',
                                            '失误次数', '违规次数', '结果状态', '名次', '积分'])
        self.assertEqual(len(results) - 1, len(csv_rows))
        self.assertEqual(results[1][4], 21)
        self.assertIsInstance(results[1][8], int)
        self.assertEqual(str(results[1][8]), csv_rows[0]['名次'])

        totals = self.sheet_rows(f'/api/exports/school-totals.xlsx?group_id={group_id}')
        self.assertEqual(totals[0][-1], '待确认项目')
        self.assertTrue(all(isinstance(row[2], int) for row in totals[1:]))

        # 空数据仍返回只有表头的合法文件。
        empty_cat = next(c['id'] for c in fx['groups']['丙']['categories'] if c['kind'] == 'individual')
        empty_results = self.sheet_rows(f'/api/exports/results.xlsx?category_id={empty_cat}')
        self.assertEqual(len(empty_results), 1)
        empty_totals = self.sheet_rows(f"/api/exports/school-totals.xlsx?group_id={fx['groups']['丙']['id']}")
        self.assertEqual(len(empty_totals), 1)

        # 文本单元格不会被写成公式。
        book = openpyxl.load_workbook(io.BytesIO(
            self.request('GET', f'/api/exports/results.xlsx?category_id={cat}', raw=True)[1]), data_only=True)
        values = [cell for row in book.active.iter_rows() for cell in row]
        self.assertTrue(any(cell.value == '=SUM(A1:A2)' and cell.data_type == 's' for cell in values))
        self.assertTrue(any(cell.value == '=1+1' and cell.data_type == 's' for cell in values))


if __name__ == '__main__':
    unittest.main()
