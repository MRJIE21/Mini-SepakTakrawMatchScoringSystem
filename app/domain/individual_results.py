"""个人赛计数口径。十进制四舍五入到小数点后两位，再比较和保存。"""
import math
import re
from decimal import Decimal, DecimalException, ROUND_HALF_UP, localcontext


FIELDS = (
    ("result_value", "有效次数"),
    ("error_count", "失误次数"),
    ("violation_count", "犯规次数"),
)
NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
INTEGER = re.compile(r"[0-9]+")


def normalize(value, *, integer_only=False):
    """返回 SQLite/JSON 可往返的数值，拒绝溢出和下溢。"""
    raw = str(value).strip()
    pattern = INTEGER if integer_only else NUMBER
    if not pattern.fullmatch(raw):
        raise ValueError("请填写非负整数" if integer_only else "请输入非负数值")
    try:
        number = Decimal(raw)
        if number < 0:
            raise ValueError("请输入非负数值")
        if not number:
            return 0
        if number.adjusted() > 308:
            raise ValueError("数值超出可保存范围")
        with localcontext() as context:
            context.prec = max(28, number.adjusted() + 3)
            rounded = number.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        stored = float(rounded)
        if math.isfinite(stored) and Decimal(str(stored)) == rounded:
            return int(stored) if stored.is_integer() and stored <= 2**53 else stored
    except DecimalException:
        pass
    raise ValueError("数值超出可保存范围")
