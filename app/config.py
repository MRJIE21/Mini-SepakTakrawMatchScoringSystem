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

HOST = os.environ.get("STSS_HOST", "0.0.0.0")
PORT = int(os.environ.get("STSS_PORT", "8000"))

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
HTTP_BACKLOG = int(os.environ.get("STSS_HTTP_BACKLOG", "256"))
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
