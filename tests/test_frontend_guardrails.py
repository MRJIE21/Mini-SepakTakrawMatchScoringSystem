"""前端静态护栏：防止几类“运行时才炸”或“改回去没人发现”的问题。

1. 局部变量遮蔽 window.location 等全局对象（曾导致“创建赛事”后 location.reload 报错）；
2. 新增页面模块忘记登记到 sw.js 的离线缓存清单（断网时该页面打不开）；
3. 业务页面重新引入 window.prompt 或整页刷新（改进方案 Q08、Q11 已明确要移除）。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
SHADOW = re.compile(r"\b(?:const|let|var)\s+(location|history|navigator|document|window)\s*=")
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"//[^\n]*")


def code_only(text: str) -> str:
    """去掉注释，避免把“已不再使用 window.prompt”这类说明文字当成违规代码。"""
    return LINE_COMMENT.sub("", BLOCK_COMMENT.sub("", text))


class FrontendGuardrailTest(unittest.TestCase):
    def js_files(self):
        return sorted(list((WEB / "js").glob("*.js")) + list((WEB / "js" / "views").glob("*.js")))

    def view_files(self):
        return sorted((WEB / "js" / "views").glob("*.js"))

    def test_no_shadowing_of_window_globals(self):
        hits = []
        for path in self.js_files():
            for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if SHADOW.search(line):
                    hits.append(f"{path.relative_to(WEB)}:{lineno}: {line.strip()}")
        self.assertEqual(hits, [], "局部变量遮蔽了浏览器全局对象，运行时会报错")

    def test_service_worker_shell_covers_all_modules(self):
        shell = (WEB / "sw.js").read_text(encoding="utf-8")
        listed = set(re.findall(r"'([^']+)'", shell))
        missing = []
        for path in self.js_files():
            url = "/js/" + path.relative_to(WEB / "js").as_posix()
            if url not in listed:
                missing.append(url)
        self.assertEqual(missing, [], "以下模块未加入 sw.js 离线缓存清单，断网时无法打开")

    def test_views_do_not_use_native_prompts(self):
        """Q11：业务输入改用页内表单，输入内容能在提交前核对。"""
        hits = []
        for path in self.view_files():
            text = code_only(path.read_text(encoding="utf-8"))
            for lineno, line in enumerate(text.splitlines(), 1):
                if "window.prompt(" in line or "window.confirm(" in line or "window.alert(" in line:
                    hits.append(f"{path.relative_to(WEB)}:{lineno}")
        self.assertEqual(hits, [], "页面不应再用原生 prompt/confirm/alert 收集业务输入")

    def test_views_do_not_reload_the_whole_page(self):
        """Q08：正常增删改流程用局部刷新，整页重载会打断录入并丢失状态。

        main.js 的退出登录与 401 重新登录仍允许整页重载，那里本就该清空内存。
        """
        hits = []
        for path in self.view_files():
            text = code_only(path.read_text(encoding="utf-8"))
            for lineno, line in enumerate(text.splitlines(), 1):
                if "location.reload(" in line:
                    hits.append(f"{path.relative_to(WEB)}:{lineno}: {line.strip()}")
        self.assertEqual(hits, [], "业务页面应改用视图内局部刷新，不要 location.reload()")

    def test_direct_match_opens_before_loading_scoring_queue(self):
        """点击开始记录应直接打开单场记录台，不能先被整张队列请求或长列表阻塞。"""
        text = (WEB / "js" / "views" / "scoring.js").read_text(encoding="utf-8")
        direct = text.index("if (params.match)")
        queue = text.index("/api/scoring/queue")
        self.assertLess(direct, queue)

    def test_school_and_people_creation_lives_in_project_registration(self):
        """不再要求先进入独立学校页，项目报名可直接新建学校和人员。"""
        text = (WEB / "js" / "views" / "catalog.js").read_text(encoding="utf-8")
        main = (WEB / "js" / "main.js").read_text(encoding="utf-8")
        self.assertIn("'搜索或新建学校'", text)
        self.assertIn("'搜索或填写运动员姓名'", text)
        self.assertNotIn("items: ['workspace', 'catalog']", main)

    def test_leave_guard_survives_until_the_old_page_is_replaced(self):
        """换页开始时旧页面仍在屏幕上，此时清空守卫会让未提交输入失去离开确认。"""
        main = (WEB / "js" / "main.js").read_text(encoding="utf-8")
        ui = (WEB / "js" / "ui.js").read_text(encoding="utf-8")
        render_route = main[main.index("async function renderRoute"):]
        render_route = render_route[:render_route.index("\n}\n") + 3]
        self.assertIn("markPageLeaveGuardPending()", render_route)
        self.assertIn("finally", render_route, "结束换页必须放在 finally，避免报错或取消后守卫冻结")
        self.assertIn("settlePageLeaveGuard()", render_route)
        self.assertNotIn("setPageLeaveGuard(null)", render_route,
                         "renderRoute 不能在旧页面上直接清空守卫")
        self.assertIn("if (guard === null && pendingNavigation) return;", ui,
                      "ui.js 必须支持换页期间冻结守卫")
        self.assertIn("history.replaceState(null, '', restore)", main,
                      "取消离开后必须把地址还原到真正渲染的那一页")

    def test_school_registration_has_one_entry_inside_the_workspace(self):
        """侧栏不再重复出现学校报名；旧链接与待办统一落到工作台报名名单。"""
        main = (WEB / "js" / "main.js").read_text(encoding="utf-8")
        self.assertNotIn("items: ['schoolRegistration'", main)
        for name in ("views/workspace.js", "views/catalog.js", "views/dashboard.js",
                     "views/schoolRegistration.js"):
            body = (WEB / "js" / name).read_text(encoding="utf-8")
            self.assertNotIn("go('schoolRegistration'", body,
                             f"{name} 不应再把用户送出项目工作台")


if __name__ == "__main__":
    unittest.main(verbosity=2)
