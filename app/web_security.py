"""浏览器安全响应头与同源 CORS 策略（P2-B）。

默认只允许同源：没有 Origin 的请求（curl、服务间调用、旧测试）不受影响；
浏览器跨源请求必须命中 config.CORS_ORIGINS 白名单，否则返回 403。
四个安全头覆盖所有经 Handler._send / transport._reject 发出的响应。
"""
from __future__ import annotations

from urllib.parse import urlsplit

from . import config

SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Referrer-Policy': 'same-origin',
}

ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS'
ALLOW_HEADERS = ('Content-Type, Authorization, X-Event-ID, X-Event-UUID, '
                 'X-Deployment-ID, X-Client-Protocol, X-Actor-ID, Display')


def _normalise(origin: str | None) -> str:
    return (origin or '').strip().rstrip('/')


def is_same_origin(origin: str | None, host: str | None, public_origin: str | None = None) -> bool:
    """判断 Origin 是否与本次请求同源。

    Host 头由本机服务接收，Origin 的 scheme 可能因反向代理不同；PUBLIC_ORIGIN
    可显式声明公网同源地址。无 Origin 视为非浏览器跨源请求（放行）。
    """
    value = _normalise(origin)
    if not value:
        return True
    if public_origin and value == _normalise(public_origin):
        return True
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    if not parts.scheme or not parts.netloc:
        return False
    return parts.netloc.lower() == _normalise(host).lower()


def origin_allowed(origin: str | None, host: str | None, public_origin: str | None = None) -> bool:
    if not _normalise(origin):
        return True
    if is_same_origin(origin, host, public_origin):
        return True
    return _normalise(origin) in {_normalise(item) for item in config.CORS_ORIGINS}


def is_cross_origin(origin: str | None, host: str | None, public_origin: str | None = None) -> bool:
    return bool(_normalise(origin)) and not is_same_origin(origin, host, public_origin)


def cors_headers(origin: str | None, host: str | None, public_origin: str | None = None) -> dict:
    """浏览器跨源且命中白名单时返回 CORS 响应头；同源/无 Origin 返回空。"""
    if not is_cross_origin(origin, host, public_origin):
        return {}
    if not origin_allowed(origin, host, public_origin):
        return {}
    return {
        'Access-Control-Allow-Origin': _normalise(origin),
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Expose-Headers': 'Retry-After, Content-Disposition',
        'Access-Control-Max-Age': '600',
    }


def security_headers() -> dict:
    return dict(SECURITY_HEADERS)


def forbidden_response_body() -> bytes:
    return ('{"ok":false,"code":"cors_forbidden",'
            '"message":"跨源请求未被允许，请使用同源页面或配置 STSS_CORS_ORIGINS",'
            '"outcome":"not_committed"}').encode('utf-8')
