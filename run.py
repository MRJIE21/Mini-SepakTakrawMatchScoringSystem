#!/usr/bin/env python3
"""藤球比赛计分系统 启动入口。

用法：
  python run.py                 启动服务（默认 0.0.0.0:8000）
  python run.py --port 8080     指定端口
  python run.py --init-db       仅初始化空的全局索引库后退出
  python run.py --reset-db      删除全局索引库和全部赛事库后重建（危险）
  python run.py --db 路径       指定数据库文件
  python run.py --set-admin-password 新密码   忘记 admin 密码时重设

Windows 推荐双击 start.cmd。未指定端口时，8000 无法监听会尝试备用端口，
请按启动窗口打印的实际地址访问。

首次启动只创建管理员账号 admin：密码取自环境变量 STSS_ADMIN_PASSWORD，
未设置时使用固定初始密码 Admin123456。其他角色账号由管理员在页面中创建。

后端只使用 Python 标准库，无需安装任何依赖，Python 3.10+ 即可运行。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

def reset_admin_password(password: str) -> int:
    """忘记 admin 密码时的离线恢复入口：直接改库并使旧令牌失效。"""
    from app import config, db, security
    if len(password) < 6:
        print("密码至少 6 位")
        return 2
    conn = db.connect()
    try:
        with db.tx(conn):
            admin = db.q1(conn, "SELECT id FROM users WHERE username = 'admin'")
            if admin is None:
                uid = security.create_user(conn, "admin", password, "admin", "赛事管理员")
                print("已创建管理员账号 admin")
            else:
                uid = admin['id']
                security.set_password(conn, uid, password)
                db.run(conn, "DELETE FROM tokens WHERE user_id = ?", (uid,))
                print("admin 密码已重设，该账号原有登录状态已失效")
            db.sync_user_to_event_databases(conn, uid)
    finally:
        conn.close()
    return 0


def main() -> int:
    from app import config, db
    from app.http_server import load_routes, serve

    parser = argparse.ArgumentParser(description="藤球比赛计分系统")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--init-db", action="store_true", help="初始化空数据库后退出")
    parser.add_argument("--reset-db", action="store_true", help="删除索引库和全部赛事库后重建")
    parser.add_argument("--set-admin-password", default=None, metavar="新密码",
                        help="重设 admin 密码（忘记初始密码时使用），完成后退出")
    parser.add_argument("--db", default=None, help="数据库文件路径")
    args = parser.parse_args()

    if args.db:
        config.DB_PATH = Path(args.db)

    if args.reset_db and config.DB_PATH.exists():
        print(f"删除全局索引库：{config.DB_PATH}")
        config.DB_PATH.unlink()
    if args.reset_db and config.EVENTS_DIR.exists():
        events_dir = config.EVENTS_DIR.resolve()
        data_dir = config.DATA_DIR.resolve()
        if events_dir == data_dir or data_dir not in events_dir.parents:
            raise RuntimeError(f"拒绝删除数据目录外的赛事库目录：{events_dir}")
        print(f"删除赛事数据库目录：{events_dir}")
        shutil.rmtree(events_dir)

    db.init_db()

    if args.set_admin_password:
        return reset_admin_password(args.set_admin_password)

    if args.init_db:
        print(f"空的全局索引库已就绪：{config.DB_PATH}")
        return 0

    load_routes()
    serve(args.host, args.port)
    return 0


def entrypoint() -> int:
    """双击启动失败时显示诊断；命令行/重定向执行不等待输入。"""
    try:
        return main()
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        traceback.print_exc()
        print(f"\n启动失败：{exc}", file=sys.stderr)
        if isinstance(exc, OSError) and getattr(exc, 'winerror', None) in (10013, 10048):
            print("当前端口无法监听，可运行 start.cmd --port 8080 指定其他端口。", file=sys.stderr)
        print("请保留上方错误信息以便排查。", file=sys.stderr)
        if os.name == 'nt' and sys.stdin is not None and sys.stdin.isatty() and not os.environ.get('STSS_LAUNCHER'):
            try:
                input("按回车键关闭窗口……")
            except (EOFError, KeyboardInterrupt):
                pass
        return 1


if __name__ == "__main__":
    raise SystemExit(entrypoint())
