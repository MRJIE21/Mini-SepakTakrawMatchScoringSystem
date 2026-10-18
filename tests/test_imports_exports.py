"""1.1 迭代验收：真实 HTTP 导入事务、赛事身份、幂等与打印成绩完整性。"""
from __future__ import annotations
from helpers.historical_schedule import fixture_schedule

import csv
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from app import config, db, security
from app.http_server import Handler, load_routes, create_server


class QuietHandler(Handler):
    def log_message(self, fmt, *args):
        pass


class ImportExportsTest(unittest.TestCase):
    fixture_schedule = fixture_schedule
    @classmethod
    def setUpClass(cls):
        cls.old_config = config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR
        cls.tmp = tempfile.TemporaryDirectory(prefix="stss_iteration_")
        config.DATA_DIR = Path(cls.tmp.name)
        config.DB_PATH = config.DATA_DIR / "registry.db"
        config.EVENTS_DIR = config.DATA_DIR / "events"
        db.init_db()
        conn = db.connect()
        try:
            security.create_user(conn, "iteration_admin", "Iteration123", "admin", "测试制表员")
            security.create_user(conn, "iteration_recorder", "Iteration123", "recorder", "记录员")
            security.create_user(conn, "iteration_viewer", "Iteration123", "viewer", "查看者")
            security.create_user(conn, "iteration_organizer", "Iteration123", "organizer", "编排员")
        finally:
            conn.close()
        load_routes()
        cls.server = create_server(("127.0.0.1", 0), QuietHandler)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        config.DATA_DIR, config.DB_PATH, config.EVENTS_DIR = cls.old_config
        cls.tmp.cleanup()

    def req(self, method, path, body=None, expected=200, token=None, raw=False, headers=None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Client-Protocol", "2")
        chosen = self.token if token is None else token
        if chosen:
            req.add_header("Authorization", f"Bearer {chosen}")
        for key, value in (self.headers if headers is None else headers).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as exc:
            try:
                status, payload = exc.code, exc.read()
            finally:
                exc.close()
        self.assertEqual(status, expected, payload.decode("utf-8", errors="replace"))
        return payload.decode("utf-8-sig") if raw else json.loads(payload)

    def login(self, name):
        return self.req("POST", "/api/login", {"username": name, "password": "Iteration123"}, token="")["token"]

    def setUp(self):
        self.token = ""
        self.headers = {}
        self.token = self.login("iteration_admin")
        self.event = self.req("POST", "/api/events", {"name": "批量导入与成绩单验证赛"})
        self.event['deployment_id'] = self.req('GET', '/api/events')['deployment_id']
        for user in self.req('GET', '/api/users')['users']:
            if user['role'] != 'admin':
                self.req('PUT', f"/api/users/{user['id']}", {'event_ids': [self.event['event_id']]})
        self.headers = {"X-Event-ID": str(self.event["event_id"]), "X-Event-UUID": self.event["event_uuid"]}
        self.req("POST", f"/api/events/{self.event['event_id']}/bootstrap", {})
        structure = self.req("GET", f"/api/events/{self.event['event_id']}/structure")
        self.group = structure["groups"][0]
        self.cat = {c["kind"]: c for c in self.group["categories"] if c["gender"] == "male"}

    def path(self, kind="team", action="import-preview"):
        return f"/api/categories/{self.cat[kind]['id']}/enrollments/{action}"

    def text(self, rows, delimiter=","):
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter=delimiter)
        writer.writerow(["学校", "运动员", "性别", "号码", "队长", "种子序号", "运动员ID"])
        writer.writerows(rows)
        return buf.getvalue()

    def team_text(self, school="第一大学", count=3):
        return self.text([[school, f"选手{i}", "男", str(i + 1), "是" if i == 0 else "", "", ""]
                          for i in range(count)])

    def preview(self, text, kind="team"):
        return self.req("POST", self.path(kind), {"csv_text": text})

    def commit(self, text, preview, kind="team", uid=None, expected=200):
        return self.req("POST", self.path(kind, "import"), {
            "csv_text": text, "preview_hash": preview["preview_hash"], "request_uid": uid or str(uuid.uuid4()),
        }, expected=expected)

    def count(self, table):
        conn = db.connect(db.event_db_path(self.event["event_id"]))
        try:
            return db.q1(conn, f"SELECT COUNT(*) AS n FROM {table}")["n"]
        finally:
            conn.close()

    def test_preview_rolls_back_then_commit_and_retry_are_idempotent(self):
        text = self.team_text()
        preview = self.preview(text)
        self.assertEqual(preview["summary"], {"ready": 1, "skipped": 0, "error": 0})
        for table in ("schools", "athletes", "teams", "participations", "audit_logs"):
            if table != "audit_logs":
                self.assertEqual(self.count(table), 0)
        audit_count = self.count("audit_logs")
        self.preview(text)
        self.assertEqual(self.count("audit_logs"), audit_count)
        uid = str(uuid.uuid4())
        saved = self.commit(text, preview, uid=uid)
        replay = self.commit(text, preview, uid=uid)
        self.assertEqual(saved["summary"]["imported"], 1)
        self.assertTrue(replay["replayed"])
        self.assertEqual(self.count("athletes"), 3)
        self.assertEqual(self.count("participations"), 1)

    def test_same_file_is_skipped_and_roster_changes_require_manual_review(self):
        text = self.team_text()
        self.commit(text, self.preview(text))
        duplicate = self.preview(text)
        self.assertEqual(duplicate["summary"]["skipped"], 1)
        self.commit(text, duplicate)
        changed = self.preview(text.replace("选手1", "替补选手"))
        self.assertEqual(changed["summary"]["error"], 1)
        self.assertEqual(self.count("athletes"), 3)

    def test_invalid_batch_commits_nothing_including_schools_and_members(self):
        text = self.team_text() + self.team_text("第二大学").split("\r\n", 1)[1].replace(
            "第二大学,选手1,男,2", "第二大学,选手1,男,21")
        preview = self.preview(text)
        self.assertEqual(preview["summary"]["ready"], 1)
        self.assertEqual(preview["summary"]["error"], 1)
        result = self.commit(text, preview, expected=409)
        self.assertEqual(result["code"], "import_invalid")
        for table in ("schools", "athletes", "teams", "participations", "request_log"):
            self.assertEqual(self.count(table), 0)

    def test_preview_becomes_stale_after_other_enrollment(self):
        text = self.team_text()
        preview = self.preview(text)
        other = self.team_text("其他大学")
        self.commit(other, self.preview(other))
        failed = self.commit(text, preview, expected=409)
        self.assertEqual(failed["code"], "import_preview_stale")
        self.assertEqual(self.count("schools"), 1)

    def test_changed_file_cannot_use_previous_preview(self):
        text = self.team_text()
        failed = self.commit(text.replace("第一大学", "另一大学"), self.preview(text), expected=409)
        self.assertEqual(failed["code"], "import_preview_stale")

    def test_bom_tabs_and_quoted_school_names(self):
        school = '某大学,体育学院"一部"'
        text = "\ufeff" + self.text([[school, "张三", "男子", "1", "是", "", ""]], delimiter="\t")
        preview = self.preview(text)
        self.assertEqual(preview["summary"]["ready"], 1)
        self.commit(text, preview)
        rows = self.req("GET", f"/api/categories/{self.cat['team']['id']}/participations")["participations"]
        self.assertEqual(rows[0]["school_name"], school)

    def test_team_member_limit_and_captain_validation(self):
        self.assertEqual(self.preview(self.team_text(count=7))["summary"]["error"], 1)
        two_captains = self.team_text().replace("选手1,男,2,,", "选手1,男,2,是,")
        self.assertEqual(self.preview(two_captains)["summary"]["error"], 1)
        duplicate_member = self.team_text().replace("选手1", "选手0")
        self.assertEqual(self.preview(duplicate_member)["summary"]["error"], 1)
        self.assertEqual(self.count("athletes"), 0)

    def test_individual_school_limit_and_cross_event_type_validation(self):
        text = self.text([["第一大学", "张三", "男", "", "", "", ""],
                          ["第一大学", "李四", "男", "", "", "", ""]])
        self.assertEqual(self.preview(text, "individual")["summary"]["error"], 1)
        team = self.team_text()
        self.commit(team, self.preview(team))
        cross_entry = self.text([["第一大学", "选手0", "男", "", "", "", ""]])
        result = self.preview(cross_entry, "individual")
        self.assertEqual(result["items"][0]["code"], "athlete_already_entered")
        self.assertEqual(self.count("athletes"), 3)

    def test_same_name_is_ambiguous_and_explicit_id_must_match_school(self):
        first = self.req("POST", f"/api/events/{self.event['event_id']}/schools",
                         {"name": "同名学校", "group_id": self.group["id"]})["school_id"]
        ids = [self.req("POST", f"/api/schools/{first}/athletes", {"name": "同名人", "gender": "male"})["athlete_id"]
               for _ in range(2)]
        text = self.text([["同名学校", "同名人", "男", "", "", "", ""]])
        self.assertEqual(self.preview(text, "individual")["summary"]["error"], 1)
        explicit = self.text([["同名学校", "同名人", "男", "", "", "", str(ids[0])]])
        self.assertEqual(self.preview(explicit, "individual")["summary"]["ready"], 1)
        wrong = explicit.replace("同名学校", "另一学校")
        self.assertEqual(self.preview(wrong, "individual")["summary"]["error"], 1)

    def test_permissions_template_and_event_identity(self):
        for username in ("iteration_recorder", "iteration_viewer"):
            token = self.login(username)
            self.req("POST", self.path(), {"csv_text": self.team_text()}, token=token, expected=403)
            self.req("GET", self.path(action="import-template.csv"), token=token, expected=403)
        organizer = self.login("iteration_organizer")
        template = self.req("GET", self.path(action="import-template.csv"), token=organizer, raw=True)
        self.assertEqual(list(csv.reader(io.StringIO(template)))[0][0], "学校")
        headers = {**self.headers, "X-Event-UUID": "wrong-event"}
        self.req("POST", self.path(), {"csv_text": self.team_text()}, headers=headers, expected=409)
        self.req("POST", self.path(), {"csv_text": self.team_text()}, headers={}, expected=400)

    def test_csv_shape_and_sex_errors_do_not_write(self):
        self.req("POST", self.path(), {"csv_text": "学校,运动员,运动员\n学校,甲,乙"}, expected=400)
        self.req("POST", self.path(), {"csv_text": "学校,运动员\n学校,甲,多余"}, expected=400)
        self.req("POST", self.path(), {"csv_text": "学校,运动员\n"}, expected=400)
        self.assertEqual(self.preview(self.team_text().replace(",男,", ",女,"))["summary"]["error"], 1)
        self.assertEqual(self.count("schools"), 0)

    def test_personal_csv_and_print_include_pending_zero_and_confirmed_scores(self):
        text = self.text([["第一大学", "零分选手", "男", "", "", "", ""],
                          ["第二大学", "高分选手", "男", "", "", "", ""]])
        self.commit(text, self.preview(text, "individual"), "individual")
        cat_id = self.cat["individual"]["id"]
        parts = self.req("GET", f"/api/categories/{cat_id}/participations")["participations"]
        notice = self.req("GET", f"/api/exports/category-notice.html?category_id={cat_id}", raw=True)
        self.assertIn("未录入", notice)
        self.assertIn("待确认 2 人", notice)
        for part, value in zip(parts, (0, 5)):
            self.req("POST", "/api/scoring/individual", {
                "category_id": cat_id, "participation_id": part["id"], "result_value": value,
                "error_count": 0, "violation_count": 0, "result_status": "normal", "base_version": 0,
                "submission_uid": str(uuid.uuid4()), "event_identity": dict(self.event),
            })
        self.req("POST", f"/api/categories/{cat_id}/individual-rankings/confirm", {})
        csv_text = self.req("GET", f"/api/exports/results.csv?category_id={cat_id}", raw=True)
        data = list(csv.DictReader(io.StringIO(csv_text)))
        self.assertEqual(len(data), 2)
        self.assertEqual({r["有效次数"] for r in data}, {"0", "5"})
        self.assertEqual({r["名次"] for r in data}, {"1", "2"})
        notice = self.req("GET", f"/api/exports/category-notice.html?category_id={cat_id}", raw=True)
        self.assertIn("个人赛成绩单", notice)
        self.assertIn("待确认 0 人", notice)
        self.assertIn("测试制表员", notice)

    def test_prints_escape_input_and_paginate_complete_rosters(self):
        text = self.text([[f"学校{i:02}", f"选手{i:02}", "男", "", "", "", ""] for i in range(19)])
        text += self.text([["<script>坏学校</script>", "特殊选手", "男", "", "", "", ""]]).split("\r\n", 1)[1]
        self.commit(text, self.preview(text, "individual"), "individual")
        notice = self.req("GET", f"/api/exports/category-notice.html?category_id={self.cat['individual']['id']}", raw=True)
        self.assertEqual(notice.count('<section class="sheet">'), 2)
        self.assertIn("共 20 条", notice)
        self.assertIn("选手18", notice)
        self.assertIn("&lt;script&gt;坏学校&lt;/script&gt;", notice)
        self.assertNotIn("<script>坏学校", notice)
        school = self.req("GET", f"/api/exports/school-notice.html?group_id={self.group['id']}", raw=True)
        # REQ-008：仅报名、无任何已开赛场次的组别不产生名次，公告按“未开赛/无成绩”口径输出。
        self.assertIn("本组别尚未开赛/无成绩，名次不计入", school)
        self.assertNotIn("尚有", school)
        self.assertIn("第 2 / 2 页", school)

    def test_team_print_uses_confirmed_placement_and_school_points(self):
        text = self.team_text()
        saved = self.commit(text, self.preview(text))
        cat_id = self.cat["team"]["id"]
        pid = saved["items"][0]["participation_id"]
        pending = self.req("GET", f"/api/exports/category-notice.html?category_id={cat_id}", raw=True)
        self.assertIn("名次待确认", pending)
        self.req("POST", f"/api/categories/{cat_id}/placements", {"participation_id": pid, "rank_no": 1, "confirm": True})
        notice = self.req("GET", f"/api/exports/category-notice.html?category_id={cat_id}", raw=True)
        self.assertIn("三人赛项目名次表", notice)
        self.assertIn("<td>18</td>", notice)
        school = self.req("GET", f"/api/exports/school-notice.html?group_id={self.group['id']}", raw=True)
        self.assertIn("<td>18</td>", school)
        self.assertIn("尚有 0 项名次未确认", school)

    def test_locked_schedule_blocks_new_import_and_existing_team_can_be_enrolled(self):
        cat_id = self.cat["team"]["id"]
        school = self.req("POST", f"/api/events/{self.event['event_id']}/schools",
                          {"name": "已有名单学校", "group_id": self.group["id"]})["school_id"]
        athlete = self.req("POST", f"/api/schools/{school}/athletes",
                           {"name": "已有选手", "gender": "male"})["athlete_id"]
        self.req("POST", f"/api/categories/{cat_id}/teams", {
            "school_id": school, "name": "已有队", "members": [{"athlete_id": athlete, "jersey_no": "1"}],
            "captain_id": athlete,
        })
        text = self.text([["已有名单学校", "已有选手", "男", "1", "是", "", ""]])
        self.commit(text, self.preview(text))
        other = self.team_text("第二大学")
        self.commit(other, self.preview(other))
        plan = self.fixture_schedule("POST", f"/api/categories/{cat_id}/plan", {"stages": [
            {"kind": "round_robin", "name": "小组赛", "params": {"pool_count": 1}}]})
        self.fixture_schedule("POST", f"/api/plans/{plan['plan_id']}/generate", {})
        self.fixture_schedule("POST", f"/api/plans/{plan['plan_id']}/lock", {})
        blocked = self.preview(self.team_text("锁定后新学校"))
        self.assertEqual(blocked["items"][0]["code"], "plan_locked")
        self.assertEqual(self.count("schools"), 2)

    def test_uid_cannot_be_reused_for_changed_payload(self):
        text = self.team_text()
        preview = self.preview(text)
        uid = str(uuid.uuid4())
        self.commit(text, preview, uid=uid)
        other = self.team_text("另一大学")
        failed = self.commit(other, self.preview(other), uid=uid, expected=409)
        self.assertEqual(failed["code"], "request_uid_reused")
        self.assertEqual(self.count("schools"), 1)

    def test_import_does_not_restore_withdrawn_enrollments(self):
        text = self.team_text()
        saved = self.commit(text, self.preview(text))
        pid = saved["items"][0]["participation_id"]
        self.req("PUT", f"/api/participations/{pid}", {"status": "withdrawn"})
        preview = self.preview(text)
        self.assertEqual(preview["summary"]["error"], 1)
        self.assertIn("显式恢复", preview["items"][0]["message"])

    def test_legacy_combined_enrollment_enforces_shared_member_validation(self):
        cat_id = self.cat["team"]["id"]
        body = {"school": {"name": "直接报名学校"},
                "members": [{"name": f"队员{i}", "gender": "male", "jersey_no": str(i + 1)} for i in range(7)]}
        self.req("POST", f"/api/categories/{cat_id}/enrollments", body, expected=400)
        self.assertEqual(self.count("schools"), 0)
        body["members"] = [{"name": "队员", "gender": "male", "jersey_no": "21"}]
        self.req("POST", f"/api/categories/{cat_id}/enrollments", body, expected=400)
        self.assertEqual(self.count("athletes"), 0)

    def test_school_ties_are_printed_as_pending(self):
        cat_id = self.cat["team"]["id"]
        first = self.team_text()
        saved = self.commit(first, self.preview(first))
        first_pid = saved["items"][0]["participation_id"]
        second = self.team_text("第二大学")
        saved = self.commit(second, self.preview(second))
        second_pid = saved["items"][0]["participation_id"]
        conn = db.connect(db.event_db_path(self.event["event_id"]))
        try:
            # 只为打印验证构造一个完整并列的汇总；不依赖名次录入接口是否允许并列。
            for pid in (first_pid, second_pid):
                school_id = db.q1(conn, "SELECT t.school_id FROM participations p JOIN teams t ON t.id = p.team_id WHERE p.id = ?",
                                  (pid,))["school_id"]
                plid = db.insert(conn, "placements", {"category_id": cat_id, "participation_id": pid,
                                                       "rank_no": 1, "status": "confirmed"})
                db.insert(conn, "school_points", {"event_id": self.event["event_id"], "group_id": self.group["id"],
                    "school_id": school_id, "category_id": cat_id, "participation_id": pid,
                    "placement_id": plid, "rank_no": 1, "base_points": 9, "multiplier": 2, "points": 18})
        finally:
            conn.close()
        sheet = self.req("GET", f"/api/exports/school-notice.html?group_id={self.group['id']}", raw=True)
        self.assertIn("有 1 组学校总分并列待确认", sheet)
        self.assertEqual(sheet.count("<td>待确认</td>"), 2)

    def test_blank_import_numbers_keep_existing_team_numbers(self):
        school = self.req("POST", f"/api/events/{self.event['event_id']}/schools",
                          {"name": "号码沿用学校", "group_id": self.group["id"]})["school_id"]
        self.req("POST", f"/api/schools/{school}/athletes", {"name": "张三", "gender": "male", "jersey_no": "7"})
        text = self.text([["号码沿用学校", "张三", "男", "", "是", "", ""]])
        saved = self.commit(text, self.preview(text))
        self.assertNotIn("号码待补充", saved["items"][0]["message"])
        self.assertEqual(self.preview(text)["summary"]["skipped"], 1)
        conn = db.connect(db.event_db_path(self.event["event_id"]))
        try:
            self.assertEqual(db.q1(conn, "SELECT jersey_no FROM team_members")["jersey_no"], "7")
        finally:
            conn.close()

    def test_import_limit_rejects_oversized_roster_before_writing(self):
        text = self.text([[f"学校{i}", f"选手{i}", "男", "", "", "", ""] for i in range(1001)])
        result = self.req("POST", self.path("individual"), {"csv_text": text}, expected=400)
        self.assertIn("1000", result["message"])
        self.assertEqual(self.count("schools"), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
