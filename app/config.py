"""系统配置。数据库路径、服务端口等都可以用环境变量覆盖。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"
DATA_DIR = Path(os.environ.get("STSS_DATA_DIR", BASE_DIR / "data"))

# 默认 SQLite；如需迁移到 PostgreSQL，替换 app/db.py 的连接实现即可，
# 领域层和接口层不直接依赖数据库类型。
# 全局库只承担账号、令牌与赛事索引；每届赛事的业务数据存放在 EVENTS_DIR。
DB_PATH = Path(os.environ.get("STSS_DB", DATA_DIR / "registry.db"))
EVENTS_DIR = Path(os.environ.get("STSS_EVENTS_DIR", DATA_DIR / "events"))
# 升级前自动快照独立存放，绝不放进 events/，避免被启动扫描当成赛事库再次迁移。
# 默认跟随当前数据库所在目录，便于隔离测试；可用 STSS_BACKUPS_DIR 显式覆盖。
def backups_dir() -> Path:
    override = os.environ.get("STSS_BACKUPS_DIR")
    if override:
        return Path(override)
    return DB_PATH.parent / "backups"


def logs_dir() -> Path:
    override = os.environ.get("STSS_LOG_DIR")
    if override:
        return Path(override)
    return DATA_DIR / "logs"


def service_lock_path() -> Path:
    """同一数据目录只允许一个服务进程；锁文件不放进 events/ 以免被赛事扫描匹配。"""
    override = os.environ.get("STSS_LOCK_FILE")
    if override:
        return Path(override)
    return DATA_DIR / "stss.instance.lock"


HOST = os.environ.get("STSS_HOST", "0.0.0.0")
PORT = int(os.environ.get("STSS_PORT", "8000"))

# CORS：默认同源（不使用 *）；需要跨源部署时用逗号白名单显式放行。
CORS_ORIGINS = [item.strip().rstrip("/") for item in
                os.environ.get("STSS_CORS_ORIGINS", "").split(",") if item.strip()]
# 反向代理（https）部署时可填公网 Origin，用于识别同源请求。
PUBLIC_ORIGIN = os.environ.get("STSS_PUBLIC_ORIGIN", "").rstrip("/")

# /api/events 计数缓存秒数（0 表示不缓存；行数据始终实时查询）
EVENT_STATS_TTL = float(os.environ.get("STSS_EVENT_STATS_TTL", "3"))

# 维护任务保留期（天）；维护任务默认 dry-run 且需停服 apply。
RETENTION_DAYS = int(os.environ.get("STSS_RETENTION_DAYS", "30"))

# 日志落盘：data/logs/server.log，按大小轮转。
LOG_LEVEL = os.environ.get("STSS_LOG_LEVEL", "INFO").upper()
LOG_MAX_BYTES = int(os.environ.get("STSS_LOG_MAX_BYTES", str(5 * 1024 * 1024)))
LOG_BACKUP_COUNT = int(os.environ.get("STSS_LOG_BACKUP_COUNT", "5"))

# 令牌有效期（小时）
TOKEN_TTL_HOURS = int(os.environ.get("STSS_TOKEN_TTL", "24"))

# 登录失败限流：同一 IP+用户名/同一 IP 在窗口内失败过多时短时锁定。
LOGIN_MAX_FAILS = int(os.environ.get("STSS_LOGIN_MAX_FAILS", "5"))
LOGIN_IP_MAX_FAILS = int(os.environ.get("STSS_LOGIN_IP_MAX_FAILS", "30"))
LOGIN_WINDOW_SECONDS = int(os.environ.get("STSS_LOGIN_WINDOW_SECONDS", "60"))
LOGIN_LOCK_SECONDS = int(os.environ.get("STSS_LOGIN_LOCK_SECONDS", "60"))

# 接入上限和期限可以按隔离压测结果调节；各期限均为秒。
HTTP_WORKERS = int(os.environ.get("STSS_HTTP_WORKERS", "32"))
HTTP_PENDING = int(os.environ.get("STSS_HTTP_PENDING", "128"))
# Windows 的 listen 队列在突发连接下会直接 RST 未 accept 的连接；256 档在
# 300/500 并发冲击时大量客户端收不到 503。提高到 1024 让接入层先 accept、
# 再按 pending 上限返回规范 503（拒绝语义仍由 pending/worker 上限保证）。
HTTP_BACKLOG = int(os.environ.get("STSS_HTTP_BACKLOG", "1024"))
HTTP_QUEUE_TIMEOUT = float(os.environ.get("STSS_HTTP_QUEUE_TIMEOUT", "5"))
HTTP_HEADER_TIMEOUT = float(os.environ.get("STSS_HTTP_HEADER_TIMEOUT", "3"))
HTTP_BODY_TIMEOUT = float(os.environ.get("STSS_HTTP_BODY_TIMEOUT", "15"))
HTTP_IDLE_TIMEOUT = float(os.environ.get("STSS_HTTP_IDLE_TIMEOUT", "3"))
HTTP_WRITE_TIMEOUT = float(os.environ.get("STSS_HTTP_WRITE_TIMEOUT", "5"))
HTTP_DOWNLOAD_TIMEOUT = float(os.environ.get("STSS_HTTP_DOWNLOAD_TIMEOUT", "30"))
HTTP_MAX_HEADERS = int(os.environ.get("STSS_HTTP_MAX_HEADERS", "32768"))
DB_BUSY_MS = int(os.environ.get("STSS_DB_BUSY_MS", "1000"))
SYNC_BUSY_MS = int(os.environ.get("STSS_SYNC_BUSY_MS", "200"))

# 三人赛每局分数上限（15 分制，含第三局）
TEAM_SET_POINT_CAP = 15
TEAM_SETS_TO_WIN = 2
TEAM_MAX_SETS = 3

# 学校团体总分：单项前八名 9、7、6、5、4、3、2、1，集体项目双倍
PLACEMENT_POINTS = [9, 7, 6, 5, 4, 3, 2, 1]
TEAM_CATEGORY_MULTIPLIER = 2
