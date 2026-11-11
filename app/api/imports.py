"""项目报名表导入：只读预览、整批事务、重试幂等与赛事隔离。"""
from __future__ import annotations

import csv
import io
from collections import OrderedDict

from .. import db, idempotency, security
from ..errors import ApiError, bad_request, conflict
from ..http_server import route
from . import catalog
from .common import category_context
from .exports import _csv_response

ORG = ("admin", "organizer")
HEADERS = ["学校", "学校简称", "运动员", "性别", "号码", "队长", "种子序号", "运动员ID"]
MAX_ROWS = 1000


def _category(ctx):
    event_id = next((value for key, value in ctx.headers.items() if key.lower() == "x-event-id"), None)
    if not event_id:
        raise bad_request("请先选择本届赛事，再进入项目导入", code="missing_event_identity")
    cat = category_context(ctx.conn, int(ctx.params["category_id"]))
    if int(event_id) != cat["event_id"]:
        raise conflict("导入项目不属于当前赛事", code="event_identity_mismatch")
    return cat


@route("GET", r"/api/categories/(?P<category_id>\d+)/enrollments/import-template.csv", roles=ORG)
def import_template(ctx):
    cat = _category(ctx)
    gender = "男" if cat["gender"] == "male" else "女"
    rows = [HEADERS]
    for index in range(3 if cat["kind"] == "team" else 1):
        rows.append(["示例学校（请替换）", "示例", f"示例选手{index + 1}", gender,
                     str(index + 1) if cat["kind"] == "team" else "",
                     "是" if cat["kind"] == "team" and index == 0 else "", "", ""])
    return _csv_response(rows, f"enrollment_template_{cat['id']}.csv")


def _parse(text: str, cat: dict) -> list[dict]:
    if not isinstance(text, str) or not text.strip():
        raise bad_request("请上传 CSV 文件或粘贴含表头的报名表")
    text = text.lstrip("\ufeff")
    delimiter = "\t" if "\t" in text.splitlines()[0] else ","
    try:
        reader = csv.DictReader(io.StringIO(text), delimiter=delimiter, strict=True)
        fields = [s.strip() for s in (reader.fieldnames or [])]
        if len(fields) != len(set(fields)):
            raise bad_request("表头不能重复")
        if not {"学校", "运动员"}.issubset(fields):
            raise bad_request("缺少表头：学校、运动员。请先下载本项目模板")
        unknown = set(fields) - set(HEADERS)
        if unknown:
            raise bad_request(f"无法识别表头：{'、'.join(sorted(unknown))}，请使用本项目模板")
        reader.fieldnames = fields
        result = []
        for row in reader:
            line = reader.line_num
            if None in row or any(value is None for value in row.values()):
                raise bad_request(f"第 {line} 行列数与表头不一致")
            clean = {key: value.strip() for key, value in row.items()}
            if not any(clean.values()):
                continue
            clean["line"] = line
            result.append(clean)
            if len(result) > MAX_ROWS:
                raise bad_request(f"一次最多导入 {MAX_ROWS} 行，请拆分文件")
        if not result:
            raise bad_request("表格只有表头，没有可导入的名单")
        return result
    except csv.Error as exc:
        raise bad_request(f"CSV 格式不正确：{exc}") from exc


def _state_hash(conn, cat: dict, text: str) -> str:
    # 预览与提交期间任何名单、赛程或项目结构变动，都要求重新核对。
    state = {table: db.rows_to_dicts(db.q(conn, f"SELECT * FROM {table} ORDER BY id"))
             for table in ("events", "groups", "categories", "schools", "school_entries",
                           "athletes", "teams", "team_members", "participations", "plans", "matches")}
    return idempotency.content_hash({"category_id": cat["id"], "csv_text": text, "state": state})


def _gender(row: dict, cat: dict) -> str:
    raw = row.get("性别", "")
    options = {"男": "male", "男子": "male", "male": "male",
               "女": "female", "女子": "female", "female": "female"}
    gender = options.get(raw, cat["gender"] if not raw else None)
    if gender != cat["gender"]:
        raise bad_request("运动员性别与本项目不一致")
    return gender


def _athlete(conn, school, row: dict, cat: dict) -> dict:
    name = row.get("运动员", "")
    if not name:
        raise bad_request("缺少运动员姓名")
    gender = _gender(row, cat)
    raw_id = row.get("运动员ID", "")
    if raw_id:
        if not raw_id.isascii() or not raw_id.isdigit() or int(raw_id) < 1:
            raise bad_request("运动员ID必须是正整数，新增运动员时留空")
        athlete = db.q1(conn, "SELECT * FROM athletes WHERE id = ?", (int(raw_id),))
        if athlete is None or athlete["school_id"] != school["id"] or athlete["group_id"] != cat["group_id"]:
            raise bad_request("运动员ID不存在或不属于本学校、大组别")
        if athlete["name"] != name or (athlete["gender"] and athlete["gender"] != gender):
            raise bad_request("运动员ID对应的姓名或性别与本行不一致")
    else:
        matches = db.q(conn, "SELECT * FROM athletes WHERE school_id = ? AND name = ?",
                       (school["id"], name))
        if len(matches) > 1:
            raise bad_request("该学校有同名运动员，请填写运动员ID明确选择")
        athlete = matches[0] if matches else None
        if athlete and athlete["gender"] and athlete["gender"] != gender:
            raise bad_request("已有同名运动员的性别不同，请核对档案或填写运动员ID")
    result = {"athlete_id": athlete["id"]} if athlete else {"name": name, "gender": gender}
    jersey = row.get("号码", "")
    if jersey and (not jersey.isascii() or not jersey.isdigit()
                   or str(int(jersey)) != jersey or not 1 <= int(jersey) <= 20):
        raise bad_request("号码必须是 1—20 的整数，也可留空待补充")
    result["jersey_no"] = jersey
    if cat["kind"] == "individual" and not athlete:
        result["athlete_jersey_no"] = jersey
    return result


def _seed(rows: list[dict]):
    seeds = {str(catalog.parse_seed(row.get("种子序号"))) for row in rows
             if row.get("种子序号")}
    if len(seeds) > 1:
        raise bad_request("同一学校三人赛名单的种子序号不一致")
    return int(next(iter(seeds))) if seeds else None


def _same_seed(existing, seed):
    if seed is not None and existing["seed_no"] != seed:
        raise conflict("该报名已存在，但种子序号不同，请在报名名单中核对修改")


def _enroll_item(conn, user, cat: dict, rows: list[dict]) -> dict:
    school_name = rows[0].get("学校", "")
    if not school_name:
        raise bad_request("缺少学校名称")
    shorts = {row.get("学校简称") for row in rows if row.get("学校简称")}
    if len(shorts) > 1:
        raise bad_request("同一学校的简称不一致")
    seed = _seed(rows)
    body = {"school": {"name": school_name, "short_name": next(iter(shorts), "")}, "seed_no": seed}
    created = {"schools": [], "athletes": [], "teams": []}
    school = catalog._resolve_school(conn, cat, body, created)
    body = {"school_id": school["id"], "seed_no": seed}
    if cat["kind"] == "individual":
        athlete = _athlete(conn, school, rows[0], cat)
        body["athlete"] = athlete
        if athlete.get("athlete_id"):
            existing = db.q1(conn, """SELECT * FROM participations
                WHERE category_id = ? AND athlete_id = ? AND deleted_at IS NULL""",
                             (cat["id"], athlete["athlete_id"]))
            if existing:
                if existing["status"] != "active":
                    raise conflict("该运动员已退出报名，请在报名名单中显式恢复")
                _same_seed(existing, seed)
                return {"status": "skipped", "message": "已报名，跳过", "participation_id": existing["id"]}
        saved = catalog._enroll_individual(conn, user, cat, body)
    else:
        if len(rows) > 6:
            raise bad_request("三人赛每队最多报名 6 人")
        members, captains, names = [], [], set()
        for index, row in enumerate(rows):
            member = _athlete(conn, school, row, cat)
            key = ("id", member["athlete_id"]) if member.get("athlete_id") else ("name", row["运动员"])
            if key in names:
                raise bad_request(f"第 {row['line']} 行运动员在本队重复，请核对同名人员及运动员ID")
            names.add(key)
            members.append(member)
            flag = row.get("队长", "").lower()
            if flag in ("是", "1", "yes", "true", "√"):
                captains.append(index)
            elif flag not in ("", "否", "0", "no", "false"):
                raise bad_request(f"第 {row['line']} 行队长栏请填写“是”或“否”")
        if len(captains) > 1:
            raise bad_request("同一队伍只能指定一位队长")
        body.update({"members": members, "captain_index": captains[0] if captains else None})
        team = db.q1(conn, "SELECT * FROM teams WHERE category_id = ? AND school_id = ?",
                      (cat["id"], school["id"]))
        if team:
            stored = catalog.team_members(conn, team["id"])
            stored_numbers = {m["id"]: m["jersey_no"] for m in stored}
            # 留空的号码不覆盖已有队内号码，与组合报名的沿用规则一致。
            incoming = {(m.get("athlete_id"), m["jersey_no"] or stored_numbers.get(m.get("athlete_id"), ""))
                        for m in members}
            expected = {(m["id"], m["jersey_no"]) for m in stored}
            incoming_captain = members[captains[0]].get("athlete_id") if captains else None
            if incoming != expected or incoming_captain != catalog.team_captain_id(conn, team["id"]):
                raise conflict("该学校已有项目名单，队员、号码或队长不同，请在报名名单中核对修改")
            body["team_id"] = team["id"]
            existing = db.q1(conn, """SELECT * FROM participations
                WHERE category_id = ? AND team_id = ? AND deleted_at IS NULL""",
                             (cat["id"], team["id"]))
            if existing:
                if existing["status"] != "active":
                    raise conflict("该学校已退出报名，请在报名名单中显式恢复")
                _same_seed(existing, seed)
                return {"status": "skipped", "message": "名单一致且已报名，跳过", "participation_id": existing["id"]}
        saved = catalog._enroll_team(conn, user, cat, body)
    warnings = saved.get("profile_gaps", [])
    if cat["kind"] == "team":
        if len(rows) < 3:
            warnings.append("不足 3 位队员，开赛前需补齐")
        if any(not member["jersey_no"] for member in catalog.team_members(conn, saved["team_id"])):
            warnings.append("有队员号码待补充")
    return {"status": "ready", "message": "可导入" + (f"；{'；'.join(warnings)}" if warnings else ""),
            "participation_id": saved["participation_id"]}


def _run(conn, user, cat: dict, rows: list[dict]) -> dict:
    groups = OrderedDict()
    for row in rows:
        key = row.get("学校", "") if cat["kind"] == "team" else row["line"]
        groups.setdefault(key, []).append(row)
    items = []
    for index, group in enumerate(groups.values()):
        entry = {"lines": [row["line"] for row in group], "school": group[0].get("学校", ""),
                 "athletes": "、".join(row.get("运动员", "") for row in group)}
        try:
            with db.savepoint(conn, f"import_item_{index}"):
                entry.update(_enroll_item(conn, user, cat, group))
        except ApiError as exc:
            entry.update({"status": "error", "message": exc.message, "code": exc.code})
        items.append(entry)
    summary = {key: sum(item["status"] == key for item in items) for key in ("ready", "skipped", "error")}
    return {"items": items, "summary": summary, "row_count": len(rows)}


def _preview(conn, user, cat: dict, text: str) -> dict:
    rows = _parse(text, cat)
    digest = _state_hash(conn, cat, text)
    conn.execute("SAVEPOINT import_preview")
    try:
        result = _run(conn, user, cat, rows)
    finally:
        conn.execute("ROLLBACK TO import_preview")
        conn.execute("RELEASE import_preview")
    # 预览生成的 ID 随回滚失效，不提供给客户端当作真实对象引用。
    for item in result["items"]:
        item.pop("participation_id", None)
    return {**result, "preview_hash": digest, "category": cat}


@route("POST", r"/api/categories/(?P<category_id>\d+)/enrollments/import-preview", roles=ORG)
def preview_import(ctx):
    cat = _category(ctx)
    return _preview(ctx.conn, ctx.user, cat, ctx.body.get("csv_text"))


@route("POST", r"/api/categories/(?P<category_id>\d+)/enrollments/import", roles=ORG)
def commit_import(ctx):
    cat = _category(ctx)
    uid = idempotency.extract_uid(ctx.body)
    if not uid or len(uid) > 150:
        raise bad_request("导入需要有效的请求标识")
    text = ctx.body.get("csv_text")
    # 赛事与项目进入幂等哈希，其他项目的同名请求标识不能重放此结果。
    payload = {"category_id": cat["id"], "event_id": cat["event_id"],
               "csv_text": text, "preview_hash": ctx.body.get("preview_hash")}

    def write():
        rows = _parse(text, cat)
        if payload["preview_hash"] != _state_hash(ctx.conn, cat, text):
            raise conflict("报名名单、项目或赛程已变化，请重新预览并核对", code="import_preview_stale")
        result = _run(ctx.conn, ctx.user, cat, rows)
        if result["summary"]["error"]:
            raise conflict("表格中存在错误，整批未导入，请修正后重新预览",
                           code="import_invalid", detail=result)
        for item in result["items"]:
            if item["status"] == "ready":
                item["status"] = "imported"
                item["message"] = item["message"].replace("可导入", "已导入", 1)
        result["summary"]["imported"] = result["summary"].pop("ready")
        security.audit(ctx.conn, ctx.user, "import_enrollments", "category", cat["id"], result["summary"])
        return result

    return idempotency.replay_or_run(ctx.conn, ctx.user, uid, payload, write,
                                     scope=f"import-enroll:{cat['id']}")
