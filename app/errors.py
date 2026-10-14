"""接口错误与统一返回结构。"""
from __future__ import annotations


class ApiError(Exception):
    """业务错误：返回给前端的可读提示。"""

    def __init__(self, status: int, code: str, message: str, detail=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail

    def to_dict(self) -> dict:
        out = {"ok": False, "code": self.code, "message": self.message}
        if self.detail is not None:
            out["detail"] = self.detail
        return out


def bad_request(message: str, code: str = "bad_request", detail=None) -> ApiError:
    return ApiError(400, code, message, detail)


def unauthorized(message: str = "请先登录") -> ApiError:
    return ApiError(401, "unauthorized", message)


def forbidden(message: str = "当前角色没有该操作权限") -> ApiError:
    return ApiError(403, "forbidden", message)


def not_found(message: str = "对象不存在") -> ApiError:
    return ApiError(404, "not_found", message)


def conflict(message: str, code: str = "conflict", detail=None) -> ApiError:
    return ApiError(409, code, message, detail)


def invalid_fields(message: str, fields: dict, code: str = "invalid_field") -> ApiError:
    """带字段定位的校验错误。

    fields 形如 ``{"school_id": "请选择学校"}``，前端据此把提示挂到具体控件上
    （改进方案 §9.1），而不是只弹一条整体 toast。
    """
    return ApiError(400, code, message, {"fields": fields})


def stale_revision(message: str, current=None) -> ApiError:
    """修订号不一致：别人已经改过这条记录（改进方案 §4.3）。"""
    detail = {"current": current} if current is not None else None
    return ApiError(409, "stale_revision", message, detail)
