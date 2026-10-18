-- 藤球比赛计分系统 数据库结构（SQLite）
-- 对应设计大纲第 11 节数据模型大纲。
-- 业务层级：赛事 → 大组别（甲乙丙） → 项目（个人/三人 × 男/女）
--           → 编排方案 → 阶段 → 小组/签位 → 场次 → 单局 → 得分事件

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- 用户与权限
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin','organizer','recorder','viewer','display_operator')),
  active        INTEGER NOT NULL DEFAULT 1,
  snapshot_revision INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);

-- 全局账号提交与同步任务原子保存；赛事库中的空表不参与业务。
CREATE TABLE IF NOT EXISTS user_snapshot_outbox (
  event_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_uuid TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  target_revision INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at REAL NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(event_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_due ON user_snapshot_outbox(next_attempt_at);

-- ---------------------------------------------------------------- 赛事与层级
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date   TEXT NOT NULL DEFAULT '',
  location   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','finished')),
  team_rules_json TEXT,
  team_rules_revision INTEGER NOT NULL DEFAULT 1,
  team_rules_state TEXT NOT NULL DEFAULT 'unified',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 参赛大组别：甲组/乙组/丙组。三者独立比赛、独立排名、独立学校总分。
CREATE TABLE IF NOT EXISTS groups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code     TEXT NOT NULL,
  name     TEXT NOT NULL,
  seq      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, code)
);

-- 项目：大组别内 4 个（男/女 × 三人赛/个人赛）
CREATE TABLE IF NOT EXISTS categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  gender   TEXT NOT NULL CHECK (gender IN ('male','female')),
  kind     TEXT NOT NULL CHECK (kind IN ('team','individual')),
  name     TEXT NOT NULL,
  seq      INTEGER NOT NULL DEFAULT 0,
  team_rules_json TEXT,
  rules_revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (group_id, gender, kind)
);

CREATE TABLE IF NOT EXISTS schools (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  -- 档案修订号：并发编辑时用于检测覆盖（改进方案 §4.3、§15.4）
  rev        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (event_id, name)
);

-- 学校在本届赛事所属大组别
CREATE TABLE IF NOT EXISTS school_entries (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  note      TEXT NOT NULL DEFAULT '',
  UNIQUE (group_id, school_id)
);

CREATE TABLE IF NOT EXISTS athletes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  gender    TEXT NOT NULL DEFAULT '' CHECK (gender IN ('male','female','')),
  -- 运动员常用号码；某支队伍的报名号码另存于 team_members.jersey_no
  jersey_no TEXT NOT NULL DEFAULT '',
  note      TEXT NOT NULL DEFAULT '',
  rev       INTEGER NOT NULL DEFAULT 1
);

-- 学校明确的项目选择；空缺仍表示尚未决定。
CREATE TABLE IF NOT EXISTS school_registration_choices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  choice TEXT NOT NULL CHECK (choice IN ('participate','not_participating','withdrawn')),
  rev INTEGER NOT NULL DEFAULT 1,
  UNIQUE (school_id, category_id)
);

-- 旧版共享草稿历史表；现有数据库保留记录，当前流程不再读写。
CREATE TABLE IF NOT EXISTS school_registration_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  rev INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (school_id, group_id)
);

-- 三人赛代表队
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  school_id   INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  rev         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (category_id, school_id)
);

-- 队长由接口显式接受的 captain_id 决定，写为 is_captain=1 的那一行；
-- 不再由成员顺序隐式推导（改进方案 §6.5、Q12）。
CREATE TABLE IF NOT EXISTS team_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  jersey_no  TEXT NOT NULL DEFAULT '',
  is_captain INTEGER NOT NULL DEFAULT 0,
  UNIQUE (team_id, athlete_id)
);

-- 参赛记录（参赛主体）：三人赛=队伍，个人赛=运动员
CREATE TABLE IF NOT EXISTS participations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  team_id     INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  athlete_id  INTEGER REFERENCES athletes(id) ON DELETE CASCADE,
  seed_no     INTEGER,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  note        TEXT NOT NULL DEFAULT '',
  rev         INTEGER NOT NULL DEFAULT 1,
  CHECK ((team_id IS NULL) <> (athlete_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_part_team  ON participations(category_id, team_id)  WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_part_athl  ON participations(category_id, athlete_id) WHERE athlete_id IS NOT NULL;

-- 组合提交幂等记录：同一 request_uid + 相同内容重放返回原结果，
-- 相同 uid 但内容不同视为冲突（改进方案 §9.2、§15.3）。
CREATE TABLE IF NOT EXISTS request_log (
  uid          TEXT PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT '',
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payload_hash TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('succeeded','conflict')),
  result_json  TEXT NOT NULL DEFAULT '{}',
  message      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------- 编排
-- 编排方案：锁定范围为某个大组别下的具体项目
CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '默认方案',
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','previewed','locked','running','archived')),
  version     INTEGER NOT NULL DEFAULT 1,
  params_json TEXT NOT NULL DEFAULT '{}',
  locked_by   INTEGER REFERENCES users(id),
  locked_at   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_plans_cat ON plans(category_id, status);

-- 学校小组抽签：固定签位及揭晓进度，撤销后保留记录。
CREATE TABLE IF NOT EXISTS group_draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('random','seeded','cycle')),
  status TEXT NOT NULL DEFAULT 'drawing' CHECK (status IN ('drawing','complete','confirmed','cancelled')),
  rev INTEGER NOT NULL DEFAULT 1,
  revealed INTEGER NOT NULL DEFAULT 0,
  capacities_json TEXT NOT NULL,
  roster_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  cancel_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_group_draws_category ON group_draws(category_id, id);

-- 方案版本归档（解锁调整时保留原版）
CREATE TABLE IF NOT EXISTS plan_archive (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  archived_by INTEGER REFERENCES users(id),
  archived_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN
              ('round_robin','single_elim','double_elim','swiss','gauntlet','placement','custom')),
  name        TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  note        TEXT NOT NULL DEFAULT '',
  UNIQUE (plan_id, seq)
);

-- 比赛小组 / 签位组
CREATE TABLE IF NOT EXISTS pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id    INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'group' CHECK (kind IN ('group','bracket')),
  seq         INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','running','finished','confirmed')),
  rank_from   INTEGER,
  rank_to     INTEGER,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  confirmation_basis TEXT NOT NULL DEFAULT '',
  confirmation_resolutions TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS pool_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  participation_id INTEGER NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  seed_no         INTEGER,
  UNIQUE (pool_id, participation_id)
);

-- 抽签结果（积分、C 值、Z 值均相同后使用）
CREATE TABLE IF NOT EXISTS draw_lots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  participation_id INTEGER NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  lot_value       INTEGER NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  recorded_by     INTEGER REFERENCES users(id),
  recorded_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (pool_id, participation_id)
);

-- 小组名次确认快照：小组排名确认后冻结，供“小组第 N 名”签位解析使用
CREATE TABLE IF NOT EXISTS pool_rank_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id         INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  rank_no         INTEGER NOT NULL,
  participation_id INTEGER NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','pending')),
  note            TEXT NOT NULL DEFAULT '',
  confirmed_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (pool_id, rank_no)
);

-- 场地
CREATE TABLE IF NOT EXISTS venues (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  seq      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, name)
);

-- 场次。参赛位置支持：指定队伍 / 小组第 N 名 / 某场胜者 / 某场负者 / 轮空
CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  plan_version  INTEGER NOT NULL DEFAULT 1,
  stage_id      INTEGER REFERENCES stages(id) ON DELETE CASCADE,
  pool_id       INTEGER REFERENCES pools(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL DEFAULT 0,
  round_no      INTEGER NOT NULL DEFAULT 0,
  round_label   TEXT NOT NULL DEFAULT '',
  schedule_role TEXT NOT NULL DEFAULT '',
  schedule_revision INTEGER NOT NULL DEFAULT 1,
  winner_rank   INTEGER,
  loser_rank    INTEGER,
  venue_id      INTEGER REFERENCES venues(id),
  scheduled_at  TEXT NOT NULL DEFAULT '',
  home_source_type   TEXT NOT NULL CHECK (home_source_type IN
                     ('participation','pool_rank','match_winner','match_loser','bye')),
  home_source_pool   INTEGER REFERENCES pools(id),
  home_source_rank   INTEGER,
  home_source_match  INTEGER REFERENCES matches(id),
  home_participation INTEGER REFERENCES participations(id),
  away_source_type   TEXT NOT NULL CHECK (away_source_type IN
                     ('participation','pool_rank','match_winner','match_loser','bye')),
  away_source_pool   INTEGER REFERENCES pools(id),
  away_source_rank   INTEGER,
  away_source_match  INTEGER REFERENCES matches(id),
  away_participation INTEGER REFERENCES participations(id),
  home_actual   INTEGER REFERENCES participations(id),
  away_actual   INTEGER REFERENCES participations(id),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','ready','finished','void')),
  result_status TEXT CHECK (result_status IN
                ('normal','home_forfeit','away_forfeit','unfinished','cancelled')),
  result_version INTEGER NOT NULL DEFAULT 0,
  reset_parent_id INTEGER REFERENCES matches(id),
  reset_state TEXT NOT NULL DEFAULT 'none' CHECK (reset_state IN ('none','active','inactive','review')),
  reset_parent_version INTEGER,
  rules_snapshot_json TEXT,
  rules_revision INTEGER,
  rules_hash TEXT,
  note          TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_matches_cat  ON matches(category_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_pool ON matches(pool_id, seq);

CREATE TABLE IF NOT EXISTS match_sets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  set_no      INTEGER NOT NULL,
  home_points INTEGER NOT NULL DEFAULT 0,
  away_points INTEGER NOT NULL DEFAULT 0,
  winner_side TEXT CHECK (winner_side IN ('home','away','')),
  UNIQUE (match_id, set_no)
);

-- 逐次得分事件（三人赛）。kind=undo 时反向引用被撤回的事件。
CREATE TABLE IF NOT EXISTS score_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('score','undo')),
  set_no      INTEGER NOT NULL,
  side        TEXT CHECK (side IN ('home','away','')),
  home_after  INTEGER,
  away_after  INTEGER,
  ref_seq     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (match_id, seq)
);

-- ---------------------------------------------------------------- 个人赛成绩
CREATE TABLE IF NOT EXISTS individual_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  participation_id INTEGER NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  result_value    REAL,
  error_count     INTEGER,
  violation_count INTEGER,
  result_text     TEXT NOT NULL DEFAULT '',
  rank_no         INTEGER,
  result_status   TEXT NOT NULL DEFAULT 'normal'
                  CHECK (result_status IN ('normal','dnf','dns','dsq','pending')),
  confirmed       INTEGER NOT NULL DEFAULT 0,
  note            TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (category_id, participation_id)
);

-- 提交记录（幂等、版本冲突判定）
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('match','individual')),
  match_id      INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  individual_result_id INTEGER REFERENCES individual_results(id) ON DELETE CASCADE,
  device        TEXT NOT NULL DEFAULT '',
  base_version  INTEGER NOT NULL DEFAULT 0,
  plan_version  INTEGER NOT NULL DEFAULT 0,
  payload_hash  TEXT NOT NULL DEFAULT '',
  home_participation INTEGER,
  away_participation INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('received','confirmed','rejected','conflict')),
  message       TEXT NOT NULL DEFAULT '',
  user_id       INTEGER REFERENCES users(id),
  received_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ---------------------------------------------------------------- 名次与积分
CREATE TABLE IF NOT EXISTS placements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  participation_id INTEGER NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  rank_no         INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('confirmed','pending')),
  source          TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('auto','standings','manual','individual')),
  note            TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  confirmed_by    INTEGER REFERENCES users(id),
  confirmed_at    TEXT,
  UNIQUE (category_id, participation_id)
);

CREATE TABLE IF NOT EXISTS school_points (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  group_id        INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  participation_id INTEGER NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  placement_id    INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  rank_no         INTEGER NOT NULL,
  base_points     INTEGER NOT NULL,
  multiplier      INTEGER NOT NULL DEFAULT 1,
  points          INTEGER NOT NULL,
  placement_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (placement_id)
);

-- 学校总分同分时，录入现场确认结果
CREATE TABLE IF NOT EXISTS school_tiebreaks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  manual_order INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id),
  recorded_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (group_id, school_id)
);

-- ---------------------------------------------------------------- 审计
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 预计时间与休息独立于计分规则，旧比赛保持原数据。
CREATE TABLE IF NOT EXISTS schedule_policies (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 出场抽签与种子、成绩名次分别保存；名单快照不随删除报名丢失。
CREATE TABLE IF NOT EXISTS individual_draws (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  roster_json TEXT NOT NULL,
  order_json TEXT NOT NULL,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  request_uid TEXT NOT NULL
);
-- 逐人抽取过程：名单快照与已揭晓顺序独立于正式签表，确认后才写入 individual_draws。
-- 每项目至多一份进行中/已完成待确认会话，由部分唯一索引强制。
CREATE TABLE IF NOT EXISTS individual_draw_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  roster_json TEXT NOT NULL,
  order_json TEXT NOT NULL DEFAULT '[]',
  -- roster_hash 绑定开始时的完整活动名单与正式签表修订；任何变化使本轮失效。
  roster_hash TEXT NOT NULL,
  base_revision INTEGER NOT NULL DEFAULT 0 CHECK(base_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  status TEXT NOT NULL DEFAULT 'drawing'
    CHECK(status IN ('drawing','complete','confirmed','cancelled')),
  created_by INTEGER REFERENCES users(id),
  picked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  confirmed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_individual_draw_sessions_active
  ON individual_draw_sessions(category_id) WHERE status IN ('drawing','complete');
CREATE INDEX IF NOT EXISTS idx_individual_draw_sessions_category
  ON individual_draw_sessions(category_id, id);
CREATE TABLE IF NOT EXISTS match_schedule_meta (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
  rest_minutes INTEGER NOT NULL CHECK(rest_minutes > 0),
  policy_json TEXT NOT NULL,
  batch_uid TEXT NOT NULL
);

-- 体育馆大屏：设备凭据与一次性配对码（注册库使用；赛事库中同样建表但不由赛事接口使用）。
CREATE TABLE IF NOT EXISTS display_screens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_seen_at TEXT NOT NULL DEFAULT '',
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_display_screens_event ON display_screens(event_id, id);
CREATE TABLE IF NOT EXISTS display_pair_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash   TEXT NOT NULL UNIQUE,
  device_hash TEXT NOT NULL,
  screen_id   INTEGER REFERENCES display_screens(id) ON DELETE CASCADE,
  event_id    INTEGER REFERENCES events(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at  TEXT NOT NULL,
  claimed_at  TEXT,
  token_once  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_display_pair_codes_expiry ON display_pair_codes(expires_at);

-- 体育馆大屏：当前已推送配置（每赛事一行）。
CREATE TABLE IF NOT EXISTS display_config (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  layout             INTEGER NOT NULL DEFAULT 8,
  mode               TEXT NOT NULL DEFAULT 'score' CHECK (mode IN ('score','announce','standby')),
  slots_json         TEXT NOT NULL DEFAULT '[]',
  visible_slots_json TEXT NOT NULL DEFAULT '[]',
  announcement_title TEXT NOT NULL DEFAULT '',
  announcement_body  TEXT NOT NULL DEFAULT '',
  poll_ms            INTEGER NOT NULL DEFAULT 500 CHECK (poll_ms BETWEEN 100 AND 1000),
  revision           INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at         TEXT NOT NULL DEFAULT '',
  updated_by         INTEGER REFERENCES users(id)
);

-- 体育馆大屏：计分端实时快照（仅展示，不是正式成绩）。
CREATE TABLE IF NOT EXISTS display_live (
  match_id      INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  event_seq     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'live',
  current_set   INTEGER,
  home_points   INTEGER NOT NULL DEFAULT 0,
  away_points   INTEGER NOT NULL DEFAULT 0,
  home_sets     INTEGER NOT NULL DEFAULT 0,
  away_sets     INTEGER NOT NULL DEFAULT 0,
  sets_json     TEXT NOT NULL DEFAULT '[]',
  lineup_hash   TEXT NOT NULL DEFAULT '',
  recorder_id   INTEGER REFERENCES users(id),
  draft_uid     TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT '',
  expires_at    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_display_live_expiry ON display_live(expires_at);

