"""Isolated server fixture for the live-display browser checks."""
import json
import os
import sys
import threading
from pathlib import Path

PRODUCT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PRODUCT))
data = Path(os.environ["STSS_DISPLAY_DATA"])
os.environ["STSS_DATA_DIR"] = str(data)
os.environ["STSS_DB"] = str(data / "registry.db")
os.environ["STSS_EVENTS_DIR"] = str(data / "events")
os.environ["STSS_ADMIN_PASSWORD"] = "admin123"

from app import access, config, db, display_store, security  # noqa: E402

config.DATA_DIR = data
config.DB_PATH = data / "registry.db"
config.EVENTS_DIR = data / "events"
config.EVENTS_DIR.mkdir(parents=True, exist_ok=True)
db.init_db()
event_path = config.EVENTS_DIR / "event_1.db"
db.init_db(event_path)


def fixture(conn):
    conn.execute("INSERT INTO events(id, uuid, name) VALUES(1, ?, ?)",
                 ("event-uuid-browser", "体育馆大屏测试赛事"))
    conn.execute("INSERT INTO groups(id, event_id, code, name, seq) VALUES(1, 1, 'A', '甲组', 1)")
    conn.execute("INSERT INTO categories(id, group_id, gender, kind, name, seq) "
                 "VALUES(1, 1, 'male', 'team', '男子三人赛', 1)")
    conn.execute("INSERT INTO schools(id, event_id, name, short_name) VALUES(1, 1, '机械学院', '机械')")
    conn.execute("INSERT INTO schools(id, event_id, name, short_name) VALUES(2, 1, '电气学院', '电气')")
    conn.execute("INSERT INTO teams(id, category_id, school_id, name) VALUES(1, 1, 1, '机械学院')")
    conn.execute("INSERT INTO teams(id, category_id, school_id, name) VALUES(2, 1, 2, '电气学院')")
    conn.execute("INSERT INTO participations(id, category_id, team_id) VALUES(1, 1, 1)")
    conn.execute("INSERT INTO participations(id, category_id, team_id) VALUES(2, 1, 2)")
    conn.execute("INSERT INTO plans(id, category_id, name, status, version) VALUES(1, 1, '默认方案', 'locked', 1)")
    conn.execute(
        "INSERT INTO matches(id, category_id, plan_id, plan_version, seq, round_no, round_label, "
        "home_source_type, home_participation, away_source_type, away_participation, "
        "home_actual, away_actual, status) "
        "VALUES(1, 1, 1, 1, 1, 1, '决赛', 'participation', 1, 'participation', 2, 1, 2, 'ready')")
    conn.execute(
        "INSERT INTO matches(id, category_id, plan_id, plan_version, seq, round_no, round_label, "
        "home_source_type, home_participation, away_source_type, away_participation, "
        "home_actual, away_actual, status) "
        "VALUES(2, 1, 1, 1, 2, 1, '小组赛', 'participation', 1, 'participation', 2, 1, 2, 'ready')")
    conn.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('recording:match:1', ?)",
                 (json.dumps({"user_id": 2}),))
    conn.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('recording:match:2', ?)",
                 (json.dumps({"user_id": 2}),))


registry = db.connect()
event = db.connect(event_path)
try:
    deployment = registry.execute("SELECT v FROM settings WHERE k='deployment_id'").fetchone()
    if deployment:
        event.execute("INSERT OR REPLACE INTO settings(k, v) VALUES('deployment_id', ?)", (deployment["v"],))
    fixture(registry)
    fixture(event)
    security.create_user(registry, "admin", "admin123", "admin", "管理员")
    security.create_user(event, "admin", "admin123", "admin", "管理员")
    security.create_user(registry, "recorder", "recorder123", "recorder", "记录员")
    security.create_user(event, "recorder", "recorder123", "recorder", "记录员")
    security.create_user(registry, "screenop", "screen123", "display_operator", "大屏操作员")
    security.create_user(event, "screenop", "screen123", "display_operator", "大屏操作员")
    access.set_events(registry, 2, [1])
    access.set_events(registry, 3, [1])
    admin_token = security.login(registry, "admin", "admin123")
    recorder_token = security.login(registry, "recorder", "recorder123")
    operator_token = security.login(registry, "screenop", "screen123")
    display_store.create_screen(registry, 1, "1 号屏", "display-token-test")
finally:
    registry.close()
    event.close()

from app.http_server import Handler, create_server, load_routes  # noqa: E402

load_routes()
server = create_server(("127.0.0.1", 0), Handler, background_sync=False)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps({"port": server.server_address[1], "admin_token": admin_token,
                  "recorder_token": recorder_token, "operator_token": operator_token,
                  "display_token": "display-token-test"}), flush=True)
threading.Event().wait()
