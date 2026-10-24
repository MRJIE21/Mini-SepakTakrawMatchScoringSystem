"""有界标准库 HTTP 接入和不能被滴流重置的读取期限。"""
from __future__ import annotations

import json
import os
import socket
import threading
import time
from collections import deque
from http.server import HTTPServer

from . import config, db
from .errors import ApiError


def default_limits():
    return dict(workers=config.HTTP_WORKERS, pending=config.HTTP_PENDING,
                backlog=config.HTTP_BACKLOG, queue_timeout=config.HTTP_QUEUE_TIMEOUT,
                header_timeout=config.HTTP_HEADER_TIMEOUT, body_timeout=config.HTTP_BODY_TIMEOUT,
                idle_timeout=config.HTTP_IDLE_TIMEOUT, write_timeout=config.HTTP_WRITE_TIMEOUT,
                download_timeout=config.HTTP_DOWNLOAD_TIMEOUT, max_headers=config.HTTP_MAX_HEADERS)


class DeadlineReader:
    """每次单次 raw read 前检查绝对期限，保留 BufferedReader 多读出的字节。"""
    def __init__(self, source, sock, idle_timeout):
        self.source, self.sock = source, sock
        self.idle_timeout = idle_timeout
        self.buffer = bytearray()
        self.set_phase(3)

    def set_phase(self, seconds, max_bytes=None):
        now = time.monotonic()
        self.deadline = now + seconds
        self.progress_at = now
        self.max_bytes, self.delivered = max_bytes, 0

    def _check(self):
        now = time.monotonic()
        remaining = min(self.deadline - now, self.idle_timeout - (now - self.progress_at))
        if remaining <= 0:
            raise TimeoutError("request read deadline exceeded")
        self.sock.settimeout(remaining)

    def _fill(self, amount=16384):
        self._check()
        data = self.source.read1(amount)
        if data:
            self.progress_at = time.monotonic()
            self.buffer.extend(data)
        return bool(data)

    def _take(self, n):
        result = bytes(self.buffer[:n])
        del self.buffer[:n]
        self.delivered += n
        if self.max_bytes is not None and self.delivered > self.max_bytes:
            raise ApiError(431, "headers_too_large", "请求头过大")
        return result

    def readline(self, size=-1):
        while True:
            self._check()
            index = self.buffer.find(b"\n")
            n = index + 1 if index >= 0 else len(self.buffer)
            if size >= 0:
                n = min(n, size)
            if index >= 0 or (size >= 0 and len(self.buffer) >= size):
                return self._take(n)
            if not self._fill():
                return self._take(n)

    def read(self, size=-1):
        if size < 0:
            raise ValueError("HTTP reads must have a bounded size")
        while len(self.buffer) < size:
            self._check()
            if not self._fill(min(16384, size - len(self.buffer))):
                break
        self._check()
        return self._take(min(size, len(self.buffer)))

    def close(self):
        self.source.close()


class BoundedHTTPServer(HTTPServer):
    """固定 worker、独立队列过期回收；一个连接只由一个拥有者处理。"""
    # Windows 的 SO_REUSEADDR 语义与 POSIX 不同：允许两个进程绑定同一地址端口，
    # 会让“端口被占用”静默成功。P2-B 在 Windows 关闭复用，保证第二个实例绑定失败。
    allow_reuse_address = os.name != 'nt'

    def __init__(self, address, handler_cls, *, limits=None, background_sync=True):
        from .write_admission import WriteAdmission
        self.write_admission = WriteAdmission()
        self.limits = default_limits()
        self.limits.update(limits or {})
        for key, value in self.limits.items():
            if value <= 0:
                raise ValueError(f"{key} must be positive")
        self.request_queue_size = int(self.limits["backlog"])
        self._condition = threading.Condition()
        self._pending = deque()
        # 已发出 503 的连接：先 shutdown(SHUT_WR) 发 FIN，再由回收线程继续有界读取
        # 客户端剩余请求数据，等对方读完响应主动关闭后 finally close（避免未读数据
        # 触发 Windows RST，让客户端收不到规范 503）。
        self._reject_lock = threading.Lock()
        self._dying = []
        self._reaper = None
        self._closing = False
        self._started = False
        self._workers = []
        self._expiry_thread = None
        self._sync = None
        self._background_sync = background_sync
        self._registry_path = config.DB_PATH
        self._events_dir = config.EVENTS_DIR
        self._stats = dict(active=0, peak_active=0, pending=0, peak_pending=0,
                           completed=0, rejected=0, expired=0,
                           reject_503=0, reject_aborted=0)
        super().__init__(address, handler_cls)

    def _start_workers(self):
        with self._condition:
            if self._started:
                return
            self._started = True
            for index in range(int(self.limits["workers"])):
                thread = threading.Thread(target=self._work, name=f"stss-http-{index}", daemon=True)
                self._workers.append(thread)
                thread.start()
            self._expiry_thread = threading.Thread(target=self._expire, name="stss-http-expiry", daemon=True)
            self._expiry_thread.start()
            self._reaper = threading.Thread(target=self._reap_rejected, name="stss-http-reap", daemon=True)
            self._reaper.start()
        if self._background_sync:
            from .user_sync import SnapshotWorker
            self._sync = SnapshotWorker(self._registry_path, self._events_dir)
            self._sync.start()

    def serve_forever(self, poll_interval=0.1):
        self._start_workers()
        return super().serve_forever(poll_interval=poll_interval)

    def resource_stats(self):
        with self._condition:
            return dict(self._stats)

    def process_request(self, request, client_address):
        with self._condition:
            rejected = self._closing or len(self._pending) >= int(self.limits["pending"])
            if not rejected:
                self._pending.append((time.monotonic() + self.limits["queue_timeout"], request, client_address))
                self._stats["pending"] = len(self._pending)
                self._stats["peak_pending"] = max(self._stats["peak_pending"], len(self._pending))
                self._condition.notify_all()
            else:
                self._stats["rejected"] += 1
        if rejected:
            self._reject(request)

    def _reject(self, request):
        body = json.dumps(dict(ok=False, code="server_busy", message="服务器繁忙，请稍后重试",
                               outcome="not_admitted"), ensure_ascii=False).encode("utf-8")
        from . import web_security
        header_lines = [b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n",
                        b"Content-Type: application/json; charset=utf-8\r\n",
                        b"Content-Length: " + str(len(body)).encode() + b"\r\n"]
        for key, value in web_security.security_headers().items():
            header_lines.append(f"{key}: {value}\r\n".encode("utf-8"))
        reply = b"".join(header_lines) + b"\r\n" + body
        sent = False
        deferred = False
        try:
            request.setblocking(False)
            # 先有界读掉已到达的请求数据：带未读数据关闭连接时 Windows 会发 RST，
            # 客户端就收不到规范 503，只能显示“网络错误”（P2-05 的根因之一）。
            for _ in range(32):
                try:
                    if not request.recv(65536):
                        break
                except (BlockingIOError, InterruptedError):
                    break
                except OSError:
                    break
            try:
                request.settimeout(0.2)
                request.sendall(reply)
                sent = True
            except OSError:
                pass
            if sent:
                # 先发 FIN 让客户端先读到 503；随后交给回收线程等待对方关闭。
                try:
                    request.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                with self._reject_lock:
                    reaper = self._reaper
                    if reaper is not None and reaper.is_alive():
                        self._dying.append((request, time.monotonic() + 0.3))
                        deferred = True
        except OSError:
            pass
        finally:
            with self._condition:
                if sent:
                    self._stats["reject_503"] += 1
                else:
                    self._stats["reject_aborted"] += 1
            if not deferred:
                self.shutdown_request(request)

    def _reap_rejected(self):
        """回收已发 503 的连接：继续非阻塞读取直到对端关闭或 0.3s 到期。"""
        while True:
            with self._reject_lock:
                dying, self._dying = self._dying, []
                closing = self._closing
            if closing:
                for sock, _deadline in dying:
                    self._close_socket(sock)
                return
            if not dying:
                time.sleep(0.02)
                continue
            now = time.monotonic()
            keep = []
            for sock, deadline in dying:
                if deadline <= now:
                    self._close_socket(sock)
                    continue
                try:
                    sock.setblocking(False)
                    data = sock.recv(65536)
                except (BlockingIOError, InterruptedError):
                    keep.append((sock, deadline))
                    continue
                except OSError:
                    self._close_socket(sock)
                    continue
                if data:
                    keep.append((sock, deadline))
                else:
                    self._close_socket(sock)   # 对端已读完并关闭
            if keep:
                with self._reject_lock:
                    self._dying.extend(keep)
                time.sleep(0.002)

    @staticmethod
    def _close_socket(sock):
        try:
            sock.close()
        except OSError:
            pass

    def _expire(self):
        while True:
            expired = []
            with self._condition:
                if self._closing:
                    return
                now = time.monotonic()
                while self._pending and self._pending[0][0] <= now:
                    expired.append(self._pending.popleft()[1])
                self._stats["pending"] = len(self._pending)
                self._stats["expired"] += len(expired)
                if not expired:
                    wait = max(0.001, self._pending[0][0] - now) if self._pending else 0.5
                    self._condition.wait(timeout=wait)
                    continue
            for request in expired:
                self._reject(request)

    def _work(self):
        while True:
            with self._condition:
                while not self._pending and not self._closing:
                    self._condition.wait()
                if self._closing:
                    return
                deadline, request, address = self._pending.popleft()
                self._stats["pending"] = len(self._pending)
                expired = deadline <= time.monotonic()
                if expired:
                    self._stats["expired"] += 1
                else:
                    self._stats["active"] += 1
                    self._stats["peak_active"] = max(self._stats["peak_active"], self._stats["active"])
            if expired:
                self._reject(request)
                continue
            try:
                self.finish_request(request, address)
            except OSError:
                pass  # 断连是正常通讯失败，不重复输出长 traceback。
            except Exception:
                self.handle_error(request, address)
            finally:
                db.close_thread_connections()
                self.shutdown_request(request)
                with self._condition:
                    self._stats["active"] -= 1
                    self._stats["completed"] += 1

    def server_close(self):
        with self._condition:
            self._closing = True
            pending = list(self._pending)
            self._pending.clear()
            self._stats["pending"] = 0
            self._condition.notify_all()
        super().server_close()
        for _, request, _ in pending:
            self._reject(request)
        for thread in self._workers:
            thread.join()  # 当前业务事务完成后再停止同步，不从主线程关闭 SQLite。
        if self._expiry_thread:
            self._expiry_thread.join()
        if self._reaper:
            self._reaper.join()
        with self._reject_lock:
            leftover = list(self._dying)
            self._dying.clear()
        for sock, _deadline in leftover:
            self._close_socket(sock)
        if self._sync:
            self._sync.stop()
