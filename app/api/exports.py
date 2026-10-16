"""报表导出：赛程、成绩、学校总分 CSV 与打印记录表（设计大纲 8、12.1）。

打印记录表按各场保存的比赛规则生成局列和说明。
"""
from __future__ import annotations

import csv
import html
import io

from .. import config, db
from ..domain import advancement
from ..http_server import Response, route
from .common import (GENDER_NAMES, category_context, get_or_404, match_full_context,
                     participation_display_map)

# 以这些字符开头的单元格在 Excel/WPS 中会被当作公式执行，导出前加单引号转义
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _category_label(name: str, gender: str = "") -> str:
    gender_text = GENDER_NAMES.get(gender, "")
    return name if not gender_text or gender_text in name else f"{gender_text} · {name}"


def _safe_cell(value) -> str:
    text = "" if value is None else str(value)
    return f"'{text}" if text[:1] in _FORMULA_PREFIXES else text


def _csv_response(rows: list[list], filename: str) -> Response:
    buf = io.StringIO()
    writer = csv.writer(buf)
    for row in rows:
        writer.writerow([_safe_cell(cell) for cell in row])
    data = "\ufeff" + buf.getvalue()          # BOM 便于 Excel 打开中文
    return Response(data.encode("utf-8"), 200, "text/csv; charset=utf-8",
                    {"Content-Disposition": f'attachment; filename="{filename}"'})


@route("GET", r"/api/exports/schedule.csv")
def export_schedule(ctx):
    args: list = []
    where = ["1=1"]
    if ctx.arg("event_id"):
        where.append("g.event_id = ?")
        args.append(int(ctx.arg("event_id")))
    if ctx.arg("group_id"):
        where.append("g.id = ?")
        args.append(int(ctx.arg("group_id")))
    if ctx.arg("category_id"):
        where.append("c.id = ?")
        args.append(int(ctx.arg("category_id")))
    rows = db.q(ctx.conn,
                f"""SELECT m.*, g.name AS group_name, c.name AS category_name, c.gender AS category_gender,
                           st.name AS stage_name,
                           p.name AS pool_name, v.name AS venue_name
                      FROM matches m
                      JOIN categories c ON c.id = m.category_id
                      JOIN groups g ON g.id = c.group_id
                      LEFT JOIN stages st ON st.id = m.stage_id
                      LEFT JOIN pools p ON p.id = m.pool_id
                      LEFT JOIN venues v ON v.id = m.venue_id
                     WHERE {' AND '.join(where)}
                     ORDER BY g.seq, c.seq, NULLIF(TRIM(m.scheduled_at), '') IS NULL,
                              NULLIF(TRIM(m.scheduled_at), ''), st.seq, m.round_no, m.seq, m.id""",
                args)
    ids = [r["home_actual"] for r in rows if r["home_actual"]] + \
          [r["away_actual"] for r in rows if r["away_actual"]]
    labels = participation_display_map(ctx.conn, list(set(ids)))
    pool_names = {p['id']: p['name'] for p in db.q(ctx.conn, 'SELECT id,name FROM pools')}
    out = [["大组别", "项目", "阶段", "小组", "轮次", "场次序号", "状态", "结果状态",
            "主队/选手", "客队/选手", "场地", "计划时间", "备注", "比赛编号"]]
    for r in rows:
        out.append([
            r["group_name"], _category_label(r["category_name"], r["category_gender"]),
            r["stage_name"] or "", r["pool_name"] or "",
            r["round_label"], r["seq"], r["status"], r["result_status"] or "",
            labels.get(r["home_actual"], _source_text(r, "home", pool_names)),
            labels.get(r["away_actual"], _source_text(r, "away", pool_names)),
            r["venue_name"] or "", r["scheduled_at"] or "", advancement.display_note(ctx.conn, r),
            f"M{r['id']:03d}",
        ])
    return _csv_response(out, "schedule.csv")


def _source_text(row, side: str, pool_names=None) -> str:
    stype = row[f"{side}_source_type"]
    if stype == "bye":
        return "轮空"
    if stype == "pool_rank":
        return f"{(pool_names or {}).get(row[f'{side}_source_pool'], '小组')}第{row[f'{side}_source_rank']}名（待定）"
    if stype in ("match_winner", "match_loser"):
        ref = row[f'{side}_source_match']
        source = f'M{ref:03d}' if ref else '前场'
        return source + ('胜者（待定）' if stype == 'match_winner' else '负者（待定）')
    return "待定"


@route("GET", r"/api/exports/results.csv")
def export_results(ctx):
    category_id = int(ctx.arg("category_id") or 0)
    cat = category_context(ctx.conn, category_id)
    if cat["kind"] == "individual":
        data = _individual_rows(ctx.conn, category_id)
        out = [["大组别", "项目", "学校", "运动员", "有效次数", "失误次数", "违规次数", "结果状态", "名次", "积分"]]
        for row in data:
            out.append([cat["group_name"], _category_label(cat["name"], cat["gender"]),
                        row["school_name"], row["athlete_name"], row["result_value"],
                        row["error_count"], row["violation_count"], _individual_status(row),
                        _confirmed_rank(row), row["points"] if _has_rank(row) else ""])
        return _csv_response(out, f"individual_results_{category_id}.csv")
    rows = db.q(ctx.conn,
                """SELECT m.id, m.round_label, m.status, m.result_status, m.home_actual, m.away_actual
                     FROM matches m WHERE m.category_id = ?
                     ORDER BY m.round_no, m.seq""", (category_id,))
    out = [["组别", "项目", "轮次", "主队/选手", "客队/选手", "各局比分", "胜方", "结果状态"]]
    for r in rows:
        sets = db.q(ctx.conn, "SELECT * FROM match_sets WHERE match_id = ? ORDER BY set_no", (r["id"],))
        labels = participation_display_map(ctx.conn, [x for x in (r["home_actual"], r["away_actual"]) if x])
        set_text = " ".join(f"{s['home_points']}:{s['away_points']}" for s in sets)
        out.append([cat["group_name"], _category_label(cat["name"], cat["gender"]), r["round_label"],
                    labels.get(r["home_actual"], ""), labels.get(r["away_actual"], ""),
                    set_text, _winner_text(r["result_status"], sets), r["result_status"] or ""])
    return _csv_response(out, f"results_{category_id}.csv")


def _winner_text(result_status, sets) -> str:
    if result_status == "home_forfeit":
        return "客队胜（主队弃权）"
    if result_status == "away_forfeit":
        return "主队胜（客队弃权）"
    if result_status != "normal":
        return ""
    home = sum(1 for s in sets if s["winner_side"] == "home")
    away = sum(1 for s in sets if s["winner_side"] == "away")
    if home == away:
        return ""
    return "主队" if home > away else "客队"


@route("GET", r"/api/exports/standings.csv")
def export_standings(ctx):
    from .standings import pool_standings_payload
    pool_ids = [int(x) for x in (ctx.arg("pool_ids") or "").split(",") if x.strip()]
    out = [["小组", "名次", "参赛主体", "积分", "胜", "负", "弃权", "胜局", "负局",
            "C值", "得分", "失分", "Z值", "说明"]]
    for pool_id in pool_ids:
        pool = get_or_404(ctx.conn, "pools", pool_id, "比赛小组")
        data = pool_standings_payload(ctx.conn, pool)
        for row in data["rows"]:
            out.append([pool["name"], row.get("project_rank") or "待确认", row["label"],
                        row["points"], row["wins"], row["losses"], row["forfeits"],
                        row["sets_won"], row["sets_lost"], row["c_text"],
                        row["points_won"], row["points_lost"], row["z_text"],
                        row["ratio_note"] or ("抽签" if row.get("by_lot") else "")])
    return _csv_response(out, "standings.csv")


@route("GET", r"/api/exports/school-totals.csv")
def export_school_totals(ctx):
    group_id = int(ctx.arg("group_id") or 0)
    group = get_or_404(ctx.conn, "groups", group_id, "大组别")
    schools = db.q(ctx.conn,
                   """SELECT s.id AS school_id, s.name, s.short_name FROM school_entries se
                        JOIN schools s ON s.id = se.school_id WHERE se.group_id = ?""", (group_id,))
    from ..domain import points as points_domain
    rows = db.q(ctx.conn,
                """SELECT sp.*, c.name AS category_name, c.gender AS category_gender, c.kind,
                          COALESCE(t.name, a.name) AS participation_label
                     FROM school_points sp JOIN categories c ON c.id = sp.category_id
                     JOIN participations p ON p.id = sp.participation_id
                     LEFT JOIN teams t ON t.id = p.team_id
                     LEFT JOIN athletes a ON a.id = p.athlete_id
                    WHERE sp.group_id = ?""", (group_id,))
    tiebreaks = {r["school_id"]: r["manual_order"]
                 for r in db.q(ctx.conn, "SELECT * FROM school_tiebreaks WHERE group_id = ?", (group_id,))}
    result = points_domain.compute_school_totals(db.rows_to_dicts(schools),
                                                db.rows_to_dicts(rows), [], tiebreaks)
    out = [["名次", "学校", "团体总分", "第一名数", "第二名数", "第三名数", "分项目明细"]]
    for row in result["rows"]:
        detail = "；".join(f"{_category_label(d['category_name'], d.get('category_gender', ''))}"
                           f"{d['participation_label']}第{d['rank_no']}名"
                           f"（{d['base_points']}×{d['multiplier']}={d['points']}）"
                           for d in row["details"])
        out.append([row.get("rank") or "待确认", row["name"], row["total"],
                    row["rank_counts"].get(1, 0), row["rank_counts"].get(2, 0),
                    row["rank_counts"].get(3, 0), detail])
    return _csv_response(out, "school_totals.csv")


PAGE_HEAD = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>藤球比赛记录表</title>
<style>
 body{font-family:"Microsoft YaHei",sans-serif;margin:24px;color:#111}
 h1{font-size:20px;margin:0 0 4px}
 .meta{display:flex;flex-wrap:wrap;gap:16px;font-size:14px;margin:12px 0}
 .meta div{border-bottom:1px solid #444;min-width:180px;padding:2px 6px}
 table{border-collapse:collapse;width:100%;margin-top:12px;font-size:14px}
 th,td{border:1px solid #333;padding:6px 8px;text-align:center;height:28px}
 th{background:#f2f2f2}
 .setrow td{height:34px;font-weight:bold}
 .foot{margin-top:16px;font-size:13px;line-height:2}
 .box{display:inline-block;width:16px;height:16px;border:1px solid #333;vertical-align:-3px;margin:0 4px}
 @media print{ .noprint{display:none} body{margin:10mm} }
</style>__RULE_PAGE_STYLE__</head><body>
<div class="noprint"><button onclick="window.print()">打印记录表</button>
 <span style="margin-left:12px;font-size:13px">场次 __ID__ · 规则见下方</span></div>"""


@route("GET", r"/api/exports/record-sheet.html")
def export_record_sheet(ctx):
    """打印用记录表采用本场固定规则，较长局制使用横向页面。

    所有来自数据库的文本（队名、姓名、组别名等）都做 HTML 转义，
    避免录入内容里的标签在打印页中被执行。
    """
    match_id = int(ctx.arg("match_id") or 0)
    info = match_full_context(ctx.conn, match_id)
    esc = lambda value: html.escape(str(value if value is not None else ""))  # noqa: E731
    home_name = esc(info["home"]["label"] or info["home"]["type_name"])
    away_name = esc(info["away"]["label"] or info["away"]["type_name"])
    players_home = _team_line(ctx.conn, info["home"]["participation_id"])
    players_away = _team_line(ctx.conn, info["away"]["participation_id"])
    maximum = info['rules']['max_sets']
    team_width = 20 if maximum >= 5 else 28
    players_width = 25 if maximum >= 5 else 30
    set_cols = "".join(f"<th>第{i}局</th>" for i in range(1, maximum + 1))
    blanks = "".join("<td></td>" for _ in range(maximum)) + "<td></td>"
    body = f"""<h1>藤球比赛记录表</h1>
<div class="meta">
  <div>大组别：{esc(info.get('group_name'))}</div>
  <div>项目：{esc(_category_label(info.get('category_name', ''), info.get('category_gender', '')))}</div>
  <div>阶段：{esc(info.get('stage_name'))}</div>
  <div>小组：{esc(info.get('pool_name'))}</div>
  <div>轮次：{esc(info['round_label'])}</div>
  <div>场地：{esc(info.get('venue_name'))}</div>
  <div>日期：____________</div>
</div>
<table>
  <tr><th style="width:{team_width}%">队伍</th><th style="width:{players_width}%">上场队员</th>{set_cols}<th>局分</th></tr>
  <tr class="setrow"><td>{home_name}（主）</td><td style="text-align:left">{players_home}</td>{blanks}</tr>
  <tr class="setrow"><td>{away_name}（客）</td><td style="text-align:left">{players_away}</td>{blanks}</tr>
</table>
<p style="font-size:13px">比赛规则：{esc(info['rules_summary'])}</p>
<table>
  <tr><th>结果</th><td>正常完成 <span class="box"></span></td><td>主队弃权 <span class="box"></span></td>
      <td>客队弃权 <span class="box"></span></td><td>未完成 <span class="box"></span></td>
      <td>取消 <span class="box"></span></td></tr>
</table>
<div class="foot">
  记录员：____________ 裁判员：____________ 核对：____________<br>
  得分过程见系统提交记录；本表与系统提交内容不一致时以核对后的系统记录为准。
</div>"""
    extra_style = '<style>@page{size:A4 landscape}table{table-layout:fixed}th,td{overflow-wrap:anywhere}</style>' if maximum >= 5 else ''
    page = PAGE_HEAD.replace("__ID__", f'M{match_id:03d}').replace('__RULE_PAGE_STYLE__', extra_style) + body + "</body></html>"
    return Response(page.encode("utf-8"), 200, "text/html; charset=utf-8")


def _team_line(conn, participation_id) -> str:
    if not participation_id:
        return ""
    from .common import side_players
    players = side_players(conn, participation_id)
    if not players:
        return ""
    return "　".join(html.escape(f"{p['jersey_no'] + ' ' if p['jersey_no'] else ''}{p['name']}"
                                 + ("（队长）" if p["is_captain"] else "")) for p in players)


@route("GET", r"/api/exports/record-sheet.csv")
def export_record_sheet_csv(ctx):
    match_id = int(ctx.arg("match_id") or 0)
    info = match_full_context(ctx.conn, match_id)
    out = [["藤球比赛记录表"], ["大组别", info.get("group_name", ""), "项目",
            _category_label(info.get("category_name", ""), info.get("category_gender", ""))],
           ["轮次", info["round_label"], "场地", info.get("venue_name", "")],
           ["主队", info["home"]["label"], "客队", info["away"]["label"]],
           ["局次", "主队得分", "客队得分", "胜方"]]
    for s in info.get("sets", []):
        out.append([f"第{s['set_no']}局", s["home_points"], s["away_points"], s["winner_side"]])
    if not info.get("sets"):
        for i in range(1, info['rules']['max_sets'] + 1):
            out.append([f"第{i}局", "", "", ""])
    out.append(["结果状态", info["result_status_name"], "制表口径", info['rules_summary']])
    return _csv_response(out, f"record_{match_id}.csv")


def _has_rank(row):
    return row["placement_status"] == "confirmed" and row["rank_no"] is not None


def _confirmed_rank(row):
    return row["rank_no"] if _has_rank(row) else "待确认"


def _individual_status(row):
    names = {"normal": "正常完成", "dnf": "未完成", "dns": "未参加", "dsq": "取消成绩", "pending": "待核对"}
    if row["result_id"] is None:
        return "未录入" if row["participation_status"] == "active" else "已退出报名"
    return names.get(row["result_status"], "待核对")


def _individual_rows(conn, category_id):
    return db.q(conn, """SELECT p.status AS participation_status, a.name AS athlete_name,
                s.name AS school_name, ir.id AS result_id, ir.result_value, ir.error_count,
                ir.violation_count, ir.result_status, pl.rank_no, pl.status AS placement_status,
                COALESCE(sp.points, 0) AS points
            FROM participations p JOIN athletes a ON a.id = p.athlete_id
            JOIN schools s ON s.id = a.school_id
            LEFT JOIN individual_results ir ON ir.participation_id = p.id AND ir.category_id = p.category_id
            LEFT JOIN placements pl ON pl.participation_id = p.id AND pl.category_id = p.category_id
            LEFT JOIN school_points sp ON sp.placement_id = pl.id
            WHERE p.category_id = ? AND (p.status = 'active' OR ir.id IS NOT NULL)
            ORDER BY pl.status <> 'confirmed' OR pl.status IS NULL, pl.rank_no IS NULL,
                     pl.rank_no, s.name, a.name, p.id""", (category_id,))


def _print_response(ctx, title, event, scope, headers, rows, note):
    from ..domain.printouts import render_sheet
    page = render_sheet(title=title, event=event, scope=scope, headers=headers, rows=rows,
                        generated_at=db.now(ctx.conn), prepared_by=ctx.user.get("display_name", ""), note=note)
    return Response(page.encode("utf-8"), 200, "text/html; charset=utf-8", {"Cache-Control": "no-store"})


@route("GET", r"/api/exports/category-notice.html")
def export_category_notice(ctx):
    category_id = int(ctx.arg("category_id") or 0)
    cat = category_context(ctx.conn, category_id)
    scope = f"{cat['group_name']} · {_category_label(cat['name'], cat['gender'])}"
    if cat["kind"] == "individual":
        data = _individual_rows(ctx.conn, category_id)
        headers = ["名次", "学校", "运动员", "有效次数", "失误次数", "违规次数", "结果状态", "积分"]
        rows = [[_confirmed_rank(r), r["school_name"], r["athlete_name"], r["result_value"],
                 r["error_count"], r["violation_count"], _individual_status(r),
                 r["points"] if _has_rank(r) else "—"] for r in data]
        pending = sum(r["participation_status"] == "active" and r["result_status"] not in ("dns", "dnf", "dsq")
                      and not _has_rank(r) for r in data)
        title = "个人赛成绩单"
        note = f"按有效次数降序、失误次数升序核对；仅展示已经确认的名次。待确认 {pending} 人。"
    else:
        data = db.q(ctx.conn, """SELECT p.id, s.name AS school_name, pl.rank_no,
                        pl.status AS placement_status, pl.source, COALESCE(sp.points, 0) AS points
                    FROM participations p JOIN teams t ON t.id = p.team_id
                    JOIN schools s ON s.id = t.school_id
                    LEFT JOIN placements pl ON pl.participation_id = p.id AND pl.category_id = p.category_id
                    LEFT JOIN school_points sp ON sp.placement_id = pl.id
                    WHERE p.category_id = ? AND (p.status = 'active' OR pl.status = 'confirmed')
                    ORDER BY pl.status <> 'confirmed' OR pl.status IS NULL, pl.rank_no IS NULL,
                             pl.rank_no, s.name, p.id""", (category_id,))
        sources = {"auto": "比赛推导", "standings": "小组排名", "manual": "现场确认"}
        headers = ["名次", "参赛学校", "名次来源", "积分", "核对状态"]
        rows = [[_confirmed_rank(r), r["school_name"], sources.get(r["source"], "—"),
                 r["points"] if _has_rank(r) else "—", "名次已确认" if _has_rank(r) else "名次待确认"] for r in data]
        pending = sum(not _has_rank(r) for r in data)
        title = "三人赛项目名次表"
        from .. import team_rules_store
        current_rules = team_rules_store.project(ctx.conn, category_id)
        rules_label = '赛事统一规则' if current_rules['rules_scope'] == 'event' else '尚未统一，此项目原规则'
        note = f"{rules_label}：{current_rules['rules_summary']}；历史场次按各场记录规则。集体项目积分双倍计入。待确认 {pending} 所学校。"
    return _print_response(ctx, title, cat["event_name"], scope, headers, rows,
                           note + " 请经核对、签字后公示；成绩更正后请重新打印。")


@route("GET", r"/api/exports/school-notice.html")
def export_school_notice(ctx):
    from .standings import school_totals
    group_id = int(ctx.arg("group_id") or 0)
    # 复用成绩页面的完整汇总，包含未确认名次与学校总分并列状态。
    from ..http_server import Context
    nested = Context(ctx.conn, ctx.user, {}, {}, {"group_id": str(group_id)}, ctx.headers, "GET", ctx.path)
    data = school_totals(nested)
    event = get_or_404(ctx.conn, "events", data["group"]["event_id"], "赛事")
    headers = ["名次", "学校", "总分", "第一名数", "第二名数", "第三名数", "待确认项目"]
    rows = [[r.get("rank") if r["status"] != "tie_pending" else "待确认", r["name"], r["total"],
             r["rank_counts"].get(1, 0), r["rank_counts"].get(2, 0), r["rank_counts"].get(3, 0),
             len(r["pending"])] for r in data["rows"]]
    pending = sum(len(r["pending"]) for r in data["rows"])
    note = f"单项前八名积分 9、7、6、5、4、3、2、1，三人赛双倍。尚有 {pending} 项名次未确认，未计入总分。"
    note += f" 有 {len(data['unresolved'])} 组学校总分并列待确认。请经核对、签字后公示；成绩更正后请重新打印。"
    return _print_response(ctx, "学校团体总分表", event["name"], data["group"]["name"], headers, rows, note)
