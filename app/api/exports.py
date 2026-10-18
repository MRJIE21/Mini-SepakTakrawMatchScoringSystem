"""报表导出：赛程、成绩、学校总分 CSV 与打印记录表（设计大纲 8、12.1）。

打印记录表按各场保存的比赛规则生成局列和说明。
"""
from __future__ import annotations

import csv
import html
import io

from .. import config, db
from ..domain import advancement
from ..errors import bad_request
from ..http_server import Response, route
from .common import (GENDER_NAMES, MATCH_STATUS_NAMES, RESULT_STATUS_NAMES,
                     category_context, get_or_404, match_full_context,
                     participation_display_map)
from .xlsx import workbook_bytes

# 以这些字符开头的单元格在 Excel/WPS 中会被当作公式执行，导出前加单引号转义
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_WINNER_SIDE_NAMES = {"home": "主队", "away": "客队"}
_FINAL_INDIVIDUAL_STATUSES = ("dns", "dnf", "dsq")
# 有最终结果但可能没有逐局比分的状态：记录表不能再说“空白记录表”。
_NO_SET_FINAL_STATUSES = ("home_forfeit", "away_forfeit", "unfinished", "cancelled")
# 取消/未完成场次的旧局分只作审计留存，任何正式打印/导出都不得呈现为有效比分。
_VOID_RESULT_STATUSES = ("cancelled", "unfinished")
_RECORD_SHEET_FILLED_NOTE = ("本表已填入系统记录的局分与结果，供赛后留档；"
                             "与系统提交内容不一致时以核对后的系统记录为准。")
_RECORD_SHEET_NO_SET_NOTE = "本场无逐局比分（弃权/未完成/取消），结果以系统记录为准。"
_RECORD_SHEET_VOID_NOTE = "本场已取消/未完成，原局分作废；结果以系统记录为准。"
_RECORD_SHEET_BLANK_NOTE = "本表为空白记录表，供现场手工记录；录入后请以系统核对结果为准。"


def _is_void_result(result_status) -> bool:
    return str(result_status or "") in _VOID_RESULT_STATUSES


def _record_sheet_note(has_sets: bool, result_status: str) -> str:
    """记录表页脚只说明本场实际记录情况，避免“已勾选结果却称空白表”。"""
    if _is_void_result(result_status):
        return _RECORD_SHEET_VOID_NOTE
    if has_sets:
        return _RECORD_SHEET_FILLED_NOTE
    if result_status in _NO_SET_FINAL_STATUSES:
        return _RECORD_SHEET_NO_SET_NOTE
    return _RECORD_SHEET_BLANK_NOTE


def _match_status_text(value) -> str:
    return MATCH_STATUS_NAMES.get(value, f"未知状态（{value}）" if value else "")


def _result_status_text(value) -> str:
    return RESULT_STATUS_NAMES.get(value, f"未知结果（{value}）" if value else "")


def _winner_side_text(value) -> str:
    return _WINNER_SIDE_NAMES.get(value, "未分出胜方" if not value else f"未知方（{value}）")


def _number(value):
    """报表数值统一为整数/浮点；整数值的浮点转 int，空值保持空。"""
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    return value


def _order_arg(ctx) -> str:
    """成绩类导出的行顺序：缺省正序，只接受 asc/desc，未知值明确拒绝。"""
    value = (ctx.arg("order") or "asc").strip().lower()
    if value not in ("asc", "desc"):
        raise bad_request("排序只能选择正序（asc）或倒序（desc）", code="invalid_order")
    return value


def _ordered(rows: list, order: str) -> list:
    """倒序只反转默认行顺序，不重新排序、不改行内容。"""
    return list(reversed(rows)) if order == "desc" else rows


def _confirmed_then_pending(rows_with_state: list[tuple[bool, list]], order: str):
    """打印成绩单分组排序：只反转已确认行，待确认行固定追加在最后。

    返回 (行列表, 分组提示行)；没有待确认行时不插入分组提示。
    """
    confirmed = [row for ok, row in rows_with_state if ok]
    pending = [row for ok, row in rows_with_state if not ok]
    ordered = list(reversed(confirmed)) if order == "desc" else confirmed
    separator = ({"text": "待确认名次（不计入）", "before": len(ordered)}
                 if pending else None)
    return ordered + pending, separator


def _xlsx_response(data: bytes, filename: str) -> Response:
    return Response(data, 200, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    {"Content-Disposition": f'attachment; filename="{filename}"'})


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
            r["round_label"], r["seq"], _match_status_text(r["status"]),
            _result_status_text(r["result_status"]),
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


def _results_table(conn, category_id):
    """项目成绩表：CSV 与 XLSX 共用同一行数据。"""
    cat = category_context(conn, category_id)
    if cat["kind"] == "individual":
        data = _individual_rows(conn, category_id)
        headers = ["大组别", "项目", "学校", "运动员", "有效次数", "失误次数", "违规次数",
                   "结果状态", "名次", "积分"]
        rows = [[cat["group_name"], _category_label(cat["name"], cat["gender"]),
                 row["school_name"], row["athlete_name"], _number(row["result_value"]),
                 _number(row["error_count"]), _number(row["violation_count"]),
                 _individual_status(row), _confirmed_rank(row),
                 row["points"] if _has_rank(row) else ""] for row in data]
        return headers, rows, f"individual_results_{category_id}.csv"
    matches = db.q(conn,
                   """SELECT m.id, m.round_label, m.status, m.result_status, m.home_actual, m.away_actual
                        FROM matches m WHERE m.category_id = ?
                        ORDER BY m.round_no, m.seq""", (category_id,))
    headers = ["组别", "项目", "轮次", "主队/选手", "客队/选手", "各局比分", "胜方", "结果状态"]
    rows = []
    for r in matches:
        sets = db.q(conn, "SELECT * FROM match_sets WHERE match_id = ? ORDER BY set_no", (r["id"],))
        labels = participation_display_map(conn, [x for x in (r["home_actual"], r["away_actual"]) if x])
        set_text = "" if _is_void_result(r["result_status"]) else \
            " ".join(f"{s['home_points']}:{s['away_points']}" for s in sets)
        rows.append([cat["group_name"], _category_label(cat["name"], cat["gender"]), r["round_label"],
                     labels.get(r["home_actual"], ""), labels.get(r["away_actual"], ""),
                     set_text, _winner_text(r["result_status"], sets),
                     _result_status_text(r["result_status"])])
    return headers, rows, f"results_{category_id}.csv"


@route("GET", r"/api/exports/results.csv")
def export_results(ctx):
    headers, rows, filename = _results_table(ctx.conn, int(ctx.arg("category_id") or 0))
    return _csv_response([headers, *_ordered(rows, _order_arg(ctx))], filename)


@route("GET", r"/api/exports/results.xlsx")
def export_results_xlsx(ctx):
    headers, rows, _ = _results_table(ctx.conn, int(ctx.arg("category_id") or 0))
    category_id = int(ctx.arg("category_id") or 0)
    return _xlsx_response(workbook_bytes(headers, _ordered(rows, _order_arg(ctx)), "项目成绩"),
                          f"results_{category_id}.xlsx")


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


def _standings_table(conn, pool_ids):
    from .standings import pool_standings_payload
    headers = ["小组", "名次", "参赛主体", "积分", "胜", "负", "弃权", "胜局", "负局",
               "C值", "得分", "失分", "Z值", "说明"]
    rows = []
    for pool_id in pool_ids:
        pool = get_or_404(conn, "pools", pool_id, "比赛小组")
        data = pool_standings_payload(conn, pool)
        for row in data["rows"]:
            rows.append([pool["name"], row.get("project_rank") or "待确认", row["label"],
                         _number(row["points"]), _number(row["wins"]), _number(row["losses"]),
                         _number(row["forfeits"]), _number(row["sets_won"]), _number(row["sets_lost"]),
                         row["c_text"], _number(row["points_won"]), _number(row["points_lost"]),
                         row["z_text"], row["ratio_note"] or ("抽签" if row.get("by_lot") else "")])
    return headers, rows


def _parse_pool_ids(raw):
    return [int(x) for x in (raw or "").split(",") if x.strip()]


@route("GET", r"/api/exports/standings.csv")
def export_standings(ctx):
    headers, rows = _standings_table(ctx.conn, _parse_pool_ids(ctx.arg("pool_ids")))
    return _csv_response([headers, *_ordered(rows, _order_arg(ctx))], "standings.csv")


@route("GET", r"/api/exports/standings.xlsx")
def export_standings_xlsx(ctx):
    headers, rows = _standings_table(ctx.conn, _parse_pool_ids(ctx.arg("pool_ids")))
    return _xlsx_response(workbook_bytes(headers, _ordered(rows, _order_arg(ctx)), "小组排名"),
                          "standings.xlsx")


def _school_totals_table(conn, group_id):
    from .standings import group_school_totals
    result = group_school_totals(conn, group_id)
    started = bool(result.get("started", True))
    headers = ["名次", "学校", "团体总分", "第一名数", "第二名数", "第三名数", "分项目明细", "待确认项目"]
    rows = []
    for row in result["rows"]:
        detail = "；".join(f"{_category_label(d['category_name'], d.get('category_gender', ''))}"
                           f"{d['participation_label']}第{d['rank_no']}名"
                           f"（{d['base_points']}×{d['multiplier']}={d['points']}）"
                           for d in row["details"])
        # 未开赛组别不产生名次：名次列用“—”，待确认列固定 0，与页面/打印公告同口径。
        rank_cell = (row.get("rank") or "待确认") if started else "—"
        rows.append([rank_cell, row["name"], _number(row["total"]),
                     _number(row["rank_counts"].get(1, 0)), _number(row["rank_counts"].get(2, 0)),
                     _number(row["rank_counts"].get(3, 0)), detail,
                     _number(len(row.get("pending") or [])) if started else 0])
    return result["group"], headers, rows


@route("GET", r"/api/exports/school-totals.csv")
def export_school_totals(ctx):
    group_id = int(ctx.arg("group_id") or 0)
    group, headers, rows = _school_totals_table(ctx.conn, group_id)
    return _csv_response([headers, *_ordered(rows, _order_arg(ctx))], "school_totals.csv")


@route("GET", r"/api/exports/school-totals.xlsx")
def export_school_totals_xlsx(ctx):
    group_id = int(ctx.arg("group_id") or 0)
    group, headers, rows = _school_totals_table(ctx.conn, group_id)
    return _xlsx_response(workbook_bytes(headers, _ordered(rows, _order_arg(ctx)), "学校总分"),
                          "school_totals.xlsx")


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
    played_sets = {} if _is_void_result(info.get("result_status")) else \
        {s['set_no']: s for s in (info.get('sets') or [])}
    has_result = bool(played_sets)

    def score_cells(side):
        cells = "".join(
            f"<td>{esc(played_sets[no][f'{side}_points'])}</td>" if no in played_sets else "<td></td>"
            for no in range(1, maximum + 1))
        sets_won = sum(1 for s in played_sets.values() if s['winner_side'] == side)
        sets_total = f"<td>{sets_won}</td>" if has_result else "<td></td>"
        return cells + sets_total

    status = info.get("result_status") or ""
    marks = {key: ("☑" if status == key else "☐")
             for key in ("normal", "home_forfeit", "away_forfeit", "unfinished", "cancelled")}
    result_line = (f"正常完成 {marks['normal']}　主队弃权 {marks['home_forfeit']}　"
                   f"客队弃权 {marks['away_forfeit']}　未完成 {marks['unfinished']}　取消 {marks['cancelled']}")
    fill_note = _record_sheet_note(has_result, status)
    body = f"""<h1>藤球比赛记录表</h1>
<div class="meta">
  <div>大组别：{esc(info.get('group_name'))}</div>
  <div>项目：{esc(_category_label(info.get('category_name', ''), info.get('category_gender', '')))}</div>
  <div>阶段：{esc(info.get('stage_name'))}</div>
  <div>小组：{esc(info.get('pool_name'))}</div>
  <div>轮次：{esc(info['round_label'])}</div>
  <div>场地：{esc(info.get('venue_name'))}</div>
  <div>日期：{esc((info.get('scheduled_at') or '').split(' ')[0] or '____________')}</div>
</div>
<table>
  <tr><th style="width:{team_width}%">队伍</th><th style="width:{players_width}%">上场队员</th>{set_cols}<th>局分</th></tr>
  <tr class="setrow"><td>{home_name}（主）</td><td style="text-align:left">{players_home}</td>{score_cells('home')}</tr>
  <tr class="setrow"><td>{away_name}（客）</td><td style="text-align:left">{players_away}</td>{score_cells('away')}</tr>
</table>
<p style="font-size:13px">比赛规则：{esc(info['rules_summary'])}</p>
<table>
  <tr><th>结果</th><td colspan="5">{result_line}
    <span style="margin-left:18px">结果状态：{esc(info.get('result_status_name') or _result_status_text(status) or '未记录')}</span></td></tr>
</table>
<div class="foot">
  记录员：____________ 裁判员：____________ 核对：____________<br>
  {esc(fill_note)}
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
    void = _is_void_result(info.get("result_status"))
    sets = [] if void else info.get("sets", [])
    for s in sets:
        out.append([f"第{s['set_no']}局", s["home_points"], s["away_points"],
                    _winner_side_text(s["winner_side"])])
    if not sets:
        for i in range(1, info['rules']['max_sets'] + 1):
            out.append([f"第{i}局", "", "", ""])
    out.append(["结果状态", info.get("result_status_name") or _result_status_text(info.get("result_status")),
                "制表口径", info['rules_summary']])
    if void:
        out.append(["说明", "本场已取消/未完成，原局分作废", "", ""])
    return _csv_response(out, f"record_{match_id}.csv")


def _has_rank(row):
    return row["placement_status"] == "confirmed" and row["rank_no"] is not None


def _row_value(row, key):
    try:
        return row[key]
    except (KeyError, IndexError):
        return None


def _confirmed_rank(row):
    if _has_rank(row):
        return _number(row["rank_no"])
    if _row_value(row, "result_status") in _FINAL_INDIVIDUAL_STATUSES:
        return "—"
    return "待确认"


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


def _print_response(ctx, title, event, scope, headers, rows, note, separator=None):
    from ..domain.printouts import render_sheet
    page = render_sheet(title=title, event=event, scope=scope, headers=headers, rows=rows,
                        generated_at=db.now(ctx.conn), prepared_by=ctx.user.get("display_name", ""),
                        note=note, separator=separator)
    return Response(page.encode("utf-8"), 200, "text/html; charset=utf-8", {"Cache-Control": "no-store"})


@route("GET", r"/api/exports/category-notice.html")
def export_category_notice(ctx):
    category_id = int(ctx.arg("category_id") or 0)
    order = _order_arg(ctx)
    cat = category_context(ctx.conn, category_id)
    scope = f"{cat['group_name']} · {_category_label(cat['name'], cat['gender'])}"
    if cat["kind"] == "individual":
        data = _individual_rows(ctx.conn, category_id)
        headers = ["名次", "学校", "运动员", "有效次数", "失误次数", "违规次数", "结果状态", "积分"]
        paired = [(_has_rank(r), [_confirmed_rank(r), r["school_name"], r["athlete_name"],
                                  _number(r["result_value"]), _number(r["error_count"]),
                                  _number(r["violation_count"]), _individual_status(r),
                                  r["points"] if _has_rank(r) else "—"]) for r in data]
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
        paired = [(_has_rank(r), [_confirmed_rank(r), r["school_name"], sources.get(r["source"], "—"),
                                  r["points"] if _has_rank(r) else "—",
                                  "名次已确认" if _has_rank(r) else "名次待确认"]) for r in data]
        pending = sum(not _has_rank(r) for r in data)
        title = "三人赛项目名次表"
        from .. import team_rules_store
        current_rules = team_rules_store.project(ctx.conn, category_id)
        rules_label = '赛事统一规则' if current_rules['rules_scope'] == 'event' else '尚未统一，此项目原规则'
        note = f"{rules_label}：{current_rules['rules_summary']}；历史场次按各场记录规则。集体项目积分双倍计入。待确认 {pending} 所学校。"
    # 倒序只作用于已确认名次块；待确认名次固定追加在最后并单独分组，避免倒序把待确认排到最前。
    rows, separator = _confirmed_then_pending(paired, order)
    return _print_response(ctx, title, cat["event_name"], scope, headers, rows,
                           note + " 请经核对、签字后公示；成绩更正后请重新打印。", separator)


@route("GET", r"/api/exports/school-notice.html")
def export_school_notice(ctx):
    from .standings import school_totals
    group_id = int(ctx.arg("group_id") or 0)
    order = _order_arg(ctx)
    # 复用成绩页面的完整汇总，包含未确认名次、学校总分并列状态与“已开赛”口径。
    from ..http_server import Context
    nested = Context(ctx.conn, ctx.user, {}, {}, {"group_id": str(group_id)}, ctx.headers, "GET", ctx.path)
    data = school_totals(nested)
    started = bool(data.get("started", True))
    event = get_or_404(ctx.conn, "events", data["group"]["event_id"], "赛事")
    headers = ["名次", "学校", "总分", "第一名数", "第二名数", "第三名数", "待确认项目"]
    if started:
        ranked = [(r["status"] != "tie_pending",
                   [r.get("rank") if r["status"] != "tie_pending" else "待确认", r["name"], r["total"],
                    r["rank_counts"].get(1, 0), r["rank_counts"].get(2, 0), r["rank_counts"].get(3, 0),
                    len(r["pending"])]) for r in data["rows"]]
    else:
        # 未开赛组别不产生名次：名次列“—”，待确认项目固定 0，不显示待确认分组。
        ranked = [(True,
                   ["—", r["name"], r["total"],
                    r["rank_counts"].get(1, 0), r["rank_counts"].get(2, 0), r["rank_counts"].get(3, 0), 0])
                  for r in data["rows"]]
    rows, separator = _confirmed_then_pending(ranked, order)
    pending = sum(len(r["pending"]) for r in data["rows"])
    if started:
        note = f"单项前八名积分 9、7、6、5、4、3、2、1，三人赛双倍。尚有 {pending} 项名次未确认，未计入总分。"
        note += f" 有 {len(data['unresolved'])} 组学校总分并列待确认。"
    else:
        note = "本组别尚未开赛/无成绩，名次不计入。单项前八名积分 9、7、6、5、4、3、2、1，三人赛双倍。"
    note += "请经核对、签字后公示；成绩更正后请重新打印。"
    return _print_response(ctx, "学校团体总分表", event["name"], data["group"]["name"],
                           headers, rows, note, separator)
