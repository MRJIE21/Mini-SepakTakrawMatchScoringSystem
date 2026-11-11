"""标准库 HTTP 服务：路由、鉴权、JSON 处理、静态文件。

说明：设计大纲 9.1 建议 FastAPI + PostgreSQL。本工作环境无法联网安装依赖，
因此这一版用 Python 标准库实现 HTTP 与 SQLite，接口层很薄、领域层完全独立，
迁移到 FastAPI 时只需替换本文件与 app/api/* 的适配代码。
"""
from __future__ import annotations

import json
import errno
import logging
import mimetypes
import os
import re
import sqlite3
import sys
import time
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse

from . import config, db, security, web_security
from .errors import ApiError
from .transport import BoundedHTTPServer, DeadlineReader, default_limits

ROUTES: list[tuple[str, str, object, tuple]] = []

logger = logging.getLogger('stss.http')

MAX_BODY = 4 * 1024 * 1024


class Response:
    def __init__(self, body: bytes, status: int = 200, content_type: str = "application/octet-stream",
                 headers: dict | None = None):
        self.body = body
        self.status = status
        self.content_type = content_type
        self.headers = headers or {}


def route(method: str, pattern: str, roles: tuple | None = (), public: bool = False,
          scope: str = "event", transaction: bool = True):
    """注册路由。roles=None 表示任意登录用户；public=True 表示无需登录。"""
    compiled = re.compile("^" + pattern + "$")

    def deco(func):
        func.http_transaction = transaction
        ROUTES.append((method.upper(), compiled, func, roles, public, scope))
        return func

    return deco


def json_response(data, status: int = 200) -> Response:
    body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
    return Response(body, status, "application/json; charset=utf-8")


class Headers(dict):
    """大小写不敏感的请求头视图（P2-B REQ-005）。

    Context.headers 统一使用它，避免代理/HTTP2 小写化后
    ``ctx.headers.get("X-Event-ID")`` 之类读取失效。测试仍可传普通 dict。
    """

    def __init__(self, values=None):
        data = {}
        if isinstance(values, Headers):
            data = dict(values)
        elif values:
            try:
                items = values.items()
            except AttributeError:
                items = []
            for key, value in items:
                data[str(key).lower()] = value
        super().__init__(data)

    def get(self, key, default=None):
        return super().get(str(key).lower(), default)

    def __contains__(self, key):
        return super().__contains__(str(key).lower())

    def __getitem__(self, key):
        return super().__getitem__(str(key).lower())


class Context:
    def __init__(self, conn, user, body, query, params, headers, method, path, remote_addr=""):
        self.conn = conn
        self.user = user
        self.body = body
        self.query = query
        self.params = params
        self.headers = headers if isinstance(headers, Headers) else Headers(headers)
        self.method = method
        self.path = path
        self.remote_addr = remote_addr or ""
        self.token = None
        self.token_hash = None

    def arg(self, name, default=None):
        vals = self.query.get(name)
        if not vals:
            return default
        return vals[0]

    def need(self, name):
        if name not in (self.body or {}):
            raise ApiError(400, "bad_request", f"缺少参数 {name}")
        return self.body[name]


class Handler(BaseHTTPRequestHandler):
    server_version = "SepakTakrawScoring/1.1"
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.limits = getattr(self.server, "limits", default_limits())
        self.rfile = DeadlineReader(self.rfile, self.connection, self.limits["idle_timeout"])
        self.rfile.set_phase(self.limits["header_timeout"], self.limits["max_headers"])
        self.business_outcome = "not_committed"
        self._sending = False

    def handle(self):
        # 固定工作线程不能被 idle keep-alive 长占；每连接只处理一包。
        self.handle_one_request()
        self.close_connection = True

    def handle_one_request(self):
        self.request_version, self.command, self.requestline = "HTTP/1.1", None, ""
        try:
            self.raw_requestline = self.rfile.readline(65537)
            if len(self.raw_requestline) > 65536:
                raise ApiError(414, "uri_too_long", "请求路径过长")
            if not self.raw_requestline:
                return
            if not self.parse_request():
                return
            handler = getattr(self, "do_" + self.command, None)
            if handler is None:
                self.send_error(501, "Unsupported method")
                return
            handler()
        except TimeoutError:
            if not self._sending:
                self._send(json_response({"ok": False, "code": "request_timeout", "message": "请求读取超时",
                                          "outcome": "not_committed"}, 408))
        except ApiError as exc:
            self._send(json_response(exc.to_dict(), exc.status))
        finally:
            self.close_connection = True

    def end_headers(self):
        # 包括 BaseHTTPRequestHandler 的错误回复和 100 Continue，均设写出期限。
        self.close_connection = True
        if not hasattr(self, "_write_deadline"):
            self._write_deadline = time.monotonic() + self.limits["write_timeout"]
        self.connection.settimeout(max(0.001, self._write_deadline - time.monotonic()))
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        # 解析层错误也使用同一个总写期限，避免标准库绕过 _send。
        self._send(json_response({"ok": False, "code": "http_error",
                                  "message": str(message or "HTTP 请求格式错误")[:300],
                                  "outcome": "not_committed"}, code))

    def handle_expect_100(self):
        self._body_length()
        self.send_response_only(100)
        self.end_headers()
        return True

    def finish(self):
        try:
            super().finish()
        finally:
            db.close_thread_connections()

    # ---------------------------------------------------------------- 入口
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self._send(Response(b"", 204))

    def _request_header(self, name):
        headers = getattr(self, "headers", None)
        return headers.get(name) if headers is not None else None

    def _cors(self):
        for key, value in web_security.cors_headers(
                self._request_header("Origin"), self._request_header("Host"),
                config.PUBLIC_ORIGIN).items():
            self.send_header(key, value)

    def _reject_cross_origin(self, response: Response) -> Response:
        # 解析层错误（如慢头 408）发生在 self.headers 赋值之前，必须保持可发送。
        origin = self._request_header("Origin")
        host = self._request_header("Host")
        if not web_security.is_cross_origin(origin, host, config.PUBLIC_ORIGIN):
            return response
        if web_security.origin_allowed(origin, host, config.PUBLIC_ORIGIN):
            return response
        body = web_security.forbidden_response_body()
        return Response(body, 403, "application/json; charset=utf-8")

    def log_message(self, fmt, *args):
        # 访问日志走 logging（已配置时落盘轮转；未配置时由 logging 回退 stderr）。
        try:
            logger.info("%s - %s", self.address_string(), fmt % args)
        except Exception:
            if sys.stderr is not None:
                sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # ---------------------------------------------------------------- 分发
    def _dispatch(self, method: str):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path.startswith("/api/"):
                response = self._handle_api(method, path, parsed)
            else:
                response = self._serve_static(path)
        except ApiError as e:
            payload = e.to_dict()
            payload["outcome"] = self.business_outcome
            response = json_response(payload, e.status)
            # 鉴权可能在读取请求体前拒绝；关闭连接，避免残留 JSON 被当作下一次请求。
            self.close_connection = True
            response.headers['Connection'] = 'close'
        except TimeoutError:
            response = json_response({"ok": False, "code": "request_timeout", "message": "请求读取超时",
                                      "outcome": self.business_outcome}, 408)
        except sqlite3.OperationalError as exc:
            if db.is_busy(exc):
                response = json_response({"ok": False, "code": "database_busy", "message": "数据库繁忙，请稍后重试",
                                          "outcome": self.business_outcome}, 503)
                response.headers["Retry-After"] = "1"
            else:
                traceback.print_exc()
                response = json_response({"ok": False, "code": "server_error", "message": "服务器内部错误",
                                          "outcome": self.business_outcome}, 500)
        except Exception:                              # noqa: BLE001
            traceback.print_exc()
            response = json_response({"ok": False, "code": "server_error",
                                      "message": "服务器内部错误，请查看服务端日志",
                                      "outcome": self.business_outcome}, 500)
        finally:
            db.close_thread_connections()
        self._send(response)

    def _body_length(self):
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(400, "unsupported_transfer_encoding", "请使用 Content-Length 提交 JSON")
        values = self.headers.get_all("Content-Length", [])
        if len(values) > 1:
            raise ApiError(400, "bad_content_length", "Content-Length 不能重复")
        raw_length = values[0] if values else "0"
        if not re.fullmatch(r"\d+", raw_length):
            raise ApiError(400, "bad_content_length", "Content-Length 格式错误")
        length = int(raw_length)
        if length > MAX_BODY:
            raise ApiError(413, "too_large", "提交内容过大")
        return length

    def _read_body(self) -> dict:
        length = self._body_length()
        if length <= 0:
            return {}
        self.rfile.set_phase(self.limits["body_timeout"])
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ApiError(400, "incomplete_body", "请求体未完整接收")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ApiError(400, "bad_encoding",
                           "请求体必须是 UTF-8 编码的 JSON（当前内容不是 UTF-8）") from exc
        try:
            body = json.loads(text)
            if not isinstance(body, dict):
                raise ApiError(400, "bad_json_type", "请求体必须是 JSON 对象")
            return body
        except json.JSONDecodeError as exc:
            raise ApiError(400, "bad_json", f"请求体不是合法 JSON：{exc}") from exc

    def _handle_api(self, method: str, path: str, parsed) -> Response:
        if method == "POST" and (path in ("/api/scoring/submit", "/api/scoring/individual") or
                                 re.fullmatch(r"/api/matches/\d+/(correction|correct|cancel|reset-review)", path)) \
                and self.headers.get("X-Client-Protocol") != "2":
            raise ApiError(426, "client_upgrade_required", "请保存或导出记录后升级记录页面再提交")
        registry_conn = db.get_conn()
        query = parse_qs(parsed.query)
        token = None
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        # Display devices use a separate read-only credential; they must never
        # reach normal business routes.
        display_token = auth[8:].strip() if auth.lower().startswith("display ") else ""
        display_screen = None
        if display_token:
            from . import display_store
            display_screen = display_store.screen_for_token(registry_conn, display_token)
            if display_screen is None:
                raise ApiError(401, "display_unauthorized", "大屏凭据无效或已撤销")
            if method == "GET" and path == "/api/display/state":
                from . import display_state
                try:
                    event_conn = db.get_event_conn(int(display_screen["event_id"]))
                except (FileNotFoundError, ValueError):
                    raise ApiError(404, "event_database_not_found", "赛事数据库不存在") from None
                with db.read_tx(event_conn):
                    state = display_state.build_state(event_conn, display_screen)
                return json_response({"ok": True, **state})
            raise ApiError(403, "display_forbidden", "大屏凭据只能读取展示状态")
        # 不接受 URL 查询串里的令牌：避免被浏览器历史、日志与 Referer 泄露
        user = security.user_for_token(registry_conn, token)

        for m, pattern, func, roles, public, scope in ROUTES:
            if m != method:
                continue
            match = pattern.match(path)
            if not match:
                continue
            if not public:
                if user is None:
                    raise ApiError(401, "unauthorized", "请先登录")
                expected_actor = self.headers.get("X-Actor-ID")
                if expected_actor is not None and expected_actor != str(user["id"]):
                    raise ApiError(409, "account_changed", "账号已切换，请使用原账号核实原提交")
                if roles is not None and user["role"] not in roles and roles != ():
                    raise ApiError(403, "forbidden", "当前角色没有该操作权限")
            conn = registry_conn
            raw_event_id = ""
            if scope == "event":
                raw_event_id = self.headers.get("X-Event-ID") or ""
                if raw_event_id:
                    try:
                        conn = db.get_event_conn(int(raw_event_id))
                    except (ValueError, FileNotFoundError) as exc:
                        raise ApiError(404, "event_database_not_found", "当前赛事数据库不存在") from exc
                    event = db.q1(conn, "SELECT id, uuid FROM events WHERE id = ?", (int(raw_event_id),))
                    if event is None:
                        raise ApiError(409, "event_identity_mismatch", "请求赛事与目标数据库不一致")
                    event_uuid = self.headers.get("X-Event-UUID") or ""
                    if event_uuid and event_uuid != event["uuid"]:
                        raise ApiError(409, "event_identity_mismatch", "请求携带的赛事身份与目标数据库不一致")
                    deployment_id = self.headers.get("X-Deployment-ID") or ""
                    local_deployment = db.q1(conn, "SELECT v FROM settings WHERE k = 'deployment_id'")
                    if deployment_id and (local_deployment is None or deployment_id != local_deployment["v"]):
                        raise ApiError(409, "deployment_identity_mismatch", "请求来自其他部署或数据集，不能直接提交")
            body = self._read_body() if method in ("POST", "PUT", "DELETE") else {}
            frozen_submission = path.startswith("/api/scoring/") or bool(
                re.fullmatch(r"/api/matches/\d+/(correction|correct|cancel|reset-review)", path))
            if scope == "event" and method == "POST" and frozen_submission \
                    and self.headers.get("X-Event-UUID") and not body.get("event_identity"):
                raise ApiError(400, "missing_event_identity", "提交包缺少冻结的赛事身份")
            if scope == "event" and raw_event_id and isinstance(body, dict) and body.get("event_identity"):
                identity = body["event_identity"]
                if not isinstance(identity, dict):
                    raise ApiError(400, "bad_event_identity", "赛事身份必须是 JSON 对象")
                if str(identity.get("event_id") or "") != str(raw_event_id) or \
                        identity.get("event_uuid") != event["uuid"]:
                    raise ApiError(409, "event_identity_mismatch", "提交包赛事身份与当前赛事不一致")
                if identity.get("deployment_id"):
                    target_deployment = db.q1(conn, "SELECT v FROM settings WHERE k='deployment_id'")
                    if not target_deployment or identity["deployment_id"] != target_deployment['v']:
                        raise ApiError(409, "deployment_identity_mismatch", "提交包部署身份与当前部署不一致")
            ctx = Context(conn, user, body, query, match.groupdict(),
                          self.headers, method, path,
                          self.client_address[0] if self.client_address else "")
            if token:
                ctx.token = token
                ctx.token_hash = security.token_hash(token)
            from . import access
            if not public:
                access.authorize(ctx, scope)
            def materialize():
                from . import event_settings
                event_settings.guard(ctx)
                result = func(ctx)
                if not public:
                    result = access.filter_result(ctx, result)
                if isinstance(result, Response):
                    return result
                if isinstance(result, dict):
                    return json_response({"ok": True, **result})
                return json_response({"ok": True, "data": result})

            if method in ("POST", "PUT", "DELETE") and getattr(func, "http_transaction", True):
                # 赛事创建/元数据更新原来会写第二个库，不能仅凭索引库回滚断言无提交。
                cross_database = scope == "registry" and path.startswith("/api/events")
                try:
                    from . import event_settings
                    with event_settings.write_guard(ctx), db.tx(conn):
                        self.business_outcome = "unknown"
                        if user and conn is not registry_conn:
                            db.ensure_user_snapshot(conn, user)
                        response = materialize()
                except BaseException as exc:
                    if not cross_database and getattr(exc, "transaction_rolled_back", False):
                        self.business_outcome = "not_committed"
                    raise
                self.business_outcome = "committed"
                self._invalidate_event_stats(raw_event_id)
                return response
            if method == "GET" and path != "/api/admin/backup":
                with db.read_tx(conn):
                    return materialize()
            if method != "GET":
                self.business_outcome = "unknown"
            from . import event_settings
            with event_settings.write_guard(ctx):
                response = materialize()
            if method != "GET":
                self.business_outcome = "committed"
                self._invalidate_event_stats(raw_event_id)
            return response
        raise ApiError(404, "not_found", f"接口不存在：{method} {path}")

    def _invalidate_event_stats(self, raw_event_id):
        """赛事库写操作提交后失效 /api/events 计数缓存（P2-B REQ-004）。"""
        try:
            from .api import catalog
            invalidate = getattr(catalog, "invalidate_event_stats", None)
            if invalidate is not None:
                invalidate(int(raw_event_id) if raw_event_id else None)
        except Exception:
            pass

    def _serve_static(self, path: str) -> Response:
        if path in ("/", ""):
            path = "/index.html"
        target = (config.WEB_DIR / path.lstrip("/")).resolve()
        web_root = config.WEB_DIR.resolve()
        if web_root not in target.parents or not target.is_file():
            return Response(b"not found", 404, "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        elif target.suffix in (".html", ".css"):
            ctype = f"{ctype.split(';')[0]}; charset=utf-8"
        body = target.read_bytes()
        headers = {"Cache-Control": "no-cache"}
        if target.name == "sw.js":
            headers["Service-Worker-Allowed"] = "/"
        return Response(body, 200, ctype, headers)

    def _send(self, response: Response):
        response = self._reject_cross_origin(response)
        self._sending = True
        self.close_connection = True
        seconds = self.limits["download_timeout"] if response.headers.get("Content-Disposition") else self.limits["write_timeout"]
        self._write_deadline = time.monotonic() + seconds
        self.connection.settimeout(seconds)
        self.send_response(response.status)
        self.send_header("Content-Type", response.content_type)
        self.send_header("Content-Length", str(len(response.body)))
        self.send_header("Connection", "close")
        for key, value in web_security.security_headers().items():
            self.send_header(key, value)
        self._cors()
        for k, v in response.headers.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            for offset in range(0, len(response.body), 65536):
                remaining = self._write_deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("response write deadline exceeded")
                self.connection.settimeout(min(remaining, self.limits["idle_timeout"]))
                self.wfile.write(response.body[offset:offset + 65536])


def create_server(address=None, handler_cls=Handler, *, limits=None, background_sync=True):
    """生产、回归与浏览器夹具共同使用的接入工厂（调用前初始化隔离数据库）。"""
    return BoundedHTTPServer(address or (config.HOST, config.PORT), handler_cls,
                             limits=limits, background_sync=background_sync)


def _local_ip() -> str:
    """获取本机局域网 IPv4 地址（UDP connect 不会真的发包）。"""
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
        finally:
            sock.close()
    except OSError:
        return ""


def _local_ips() -> list[str]:
    """列出网卡 IPv4，避免默认路由只显示手机无法访问的有线地址。"""
    import ipaddress
    import socket

    candidates = [_local_ip()]
    try:
        candidates.extend(record[4][0] for record in socket.getaddrinfo(
            socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM))
    except OSError:
        pass
    addresses = []
    for candidate in candidates:
        try:
            address = ipaddress.IPv4Address(candidate)
        except ipaddress.AddressValueError:
            continue
        if address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast:
            continue
        value = str(address)
        if value not in addresses:
            addresses.append(value)
    return addresses


def _listen(host: str, port: int | None = None):
    """只监听目标端口；占用/禁止监听时明确报错，不再静默回退到其它端口。

    P2-B：同一数据目录由实例锁保证单实例；端口被占用应由运维结束占用进程或
    显式指定 --port，避免“双击两次出现两个实例/两个数据目录打架”。
    """
    requested = config.PORT if port is None else port
    try:
        return create_server((host, requested))
    except OSError as exc:
        unavailable = exc.errno in (errno.EACCES, errno.EADDRINUSE) or getattr(exc, 'winerror', None) in (10013, 10048)
        if unavailable:
            raise OSError(
                f"端口 {requested} 已被占用或禁止监听；请结束占用进程后重试，"
                f"或用 --port 指定其它端口（Windows: netstat -ano | findstr :{requested}）。"
            ) from exc
        raise


EVENT_DB_NAME = re.compile(r'event_\d+\.db')


def init_event_databases() -> list:
    """只初始化真正的赛事库；备份/临时文件不得进入迁移流程。

    旧版本把升级前备份命名为 ``event_N.db.before-*.db`` 放在同一目录，
    启动 glob ``event_*.db`` 会把它当成赛事库反复迁移。现在严格匹配
    ``event_<数字>.db``，其它文件只告警并跳过。
    """
    if not config.EVENTS_DIR.is_dir():
        return []
    canonical, stray = [], []
    for path in sorted(config.EVENTS_DIR.iterdir()):
        if not path.is_file():
            continue
        if EVENT_DB_NAME.fullmatch(path.name):
            canonical.append(path)
        else:
            stray.append(path)
    if stray:
        print(f"提示：赛事目录中有 {len(stray)} 个非赛事库文件（备份/临时文件），已跳过、不会被迁移：")
        for path in stray[:5]:
            print(f"  - {path.name}")
        if len(stray) > 5:
            print(f"  … 其余 {len(stray) - 5} 个同类文件")
        print(f"  确认无用后可人工移出 {config.EVENTS_DIR} 或删除；升级前备份现在保存在 {config.backups_dir()}。")
    for event_path in canonical:
        try:
            db.init_db(event_path)
        except sqlite3.DatabaseError as exc:
            raise RuntimeError(
                f"赛事数据库损坏：{event_path}；请从 {config.backups_dir()} 恢复备份，"
                f"或移出该文件后重启服务。") from exc
    return canonical


def serve(host: str | None = None, port: int | None = None):
    db.init_db()
    init_event_databases()
    conn = db.connect()
    try:
        security.ensure_default_users(conn)
    finally:
        conn.close()
    bind_host = host or config.HOST
    httpd = _listen(bind_host, port)
    bind_port = httpd.server_port
    print("藤球比赛计分系统已启动")
    # 0.0.0.0 只是“监听全部网卡”的绑定地址，浏览器不能直接访问它
    if bind_host in ("0.0.0.0", "::", ""):
        print(f"  本机访问：http://127.0.0.1:{bind_port}/")
        addresses = _local_ips()
        if addresses:
            for address in addresses:
                print(f"  局域网候选：http://{address}:{bind_port}/")
            print("  手机请使用手机所在网络可达的网卡地址；电脑同时连接有线和 Wi-Fi 时，可分别尝试上方地址。")
        else:
            print("  局域网访问：用 ipconfig 查看本机 IPv4 地址后访问 http://该地址:端口/")
    else:
        print(f"  访问地址：http://{bind_host}:{bind_port}/")
    print(f"  全局索引库：{config.DB_PATH}")
    print(f"  赛事数据库目录：{config.EVENTS_DIR}")
    print("  管理员账号：admin（使用已配置的登录密码）")
    print("  忘记密码时用 python run.py --set-admin-password 新密码 重设。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


def load_routes():
    """导入所有接口模块以注册路由。"""
    from .api import registration_history, auth, catalog, scheduling, schedule, auto_schedule, individual_draw, matches, scoring, standings, exports, admin, imports, school_registration, school_import, group_draw, display, result_import  # noqa: F401
