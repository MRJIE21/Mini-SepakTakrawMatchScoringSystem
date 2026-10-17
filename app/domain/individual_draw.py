"""Individual starting order, independent from seeds and result rankings.

一次完整预览曾用 ``generate`` 洗牌生成整份排序；逐人抽取改为每步只调用一次
随机源：``pick_one`` 从「尚未抽到」的候选人中实际选出一人。开始抽取不预排，
不预生成完整顺序，客户端也不能提交候选、种子或排列。
"""
import hashlib
import json
import random


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode('utf-8')).hexdigest()


def _ids(roster):
    ids = [row['id'] for row in roster]
    if (not ids or len(ids) != len(set(ids))
            or any(type(pid) is not int for pid in ids)):
        raise ValueError('抽签名单必须是非空的唯一报名标识列表')
    return ids


def validate_order(order, roster):
    ids = _ids(roster)
    if (not isinstance(order, list) or any(type(pid) is not int for pid in order)
            or len(order) != len(ids) or set(order) != set(ids)):
        raise ValueError('抽签顺序必须完整且不重复地覆盖当前有效报名')
    return order


def validate_progress(order, roster):
    """已抽顺序必须是名单快照的无重复子集（前缀），损坏时拒绝而不是重置。"""
    ids = _ids(roster)
    if not isinstance(order, list) or any(type(pid) is not int for pid in order):
        raise ValueError('已抽顺序必须是整数标识列表')
    if len(order) != len(set(order)) or not set(order).issubset(set(ids)):
        raise ValueError('已抽顺序与名单快照不一致')
    return order


def remaining(roster, order):
    """尚未抽到的候选（保持名单快照顺序），不参与任何随机。"""
    validate_progress(order, roster)
    taken = set(order)
    return [row for row in roster if row['id'] not in taken]


def pick_one(roster, order, chooser=None):
    """从剩余候选中实际抽出一人并返回其报名标识。

    只调用随机源一次，参数恰为剩余候选；已抽人员不进入候选。
    ``chooser`` 可注入受控随机源用于测试，默认使用操作系统随机源。
    """
    candidates = remaining(roster, order)
    if not candidates:
        raise ValueError('全部人员已抽取，没有剩余候选')
    source = chooser if chooser is not None else random.SystemRandom()
    return source.choice(candidates)['id']


def default_pick(roster, order):
    """存储层调用的抽取函数签名 ``(名单快照, 已抽顺序) -> 新报名标识``。

    每次调用只创建一个操作系统随机源并只抽一次，不预排完整顺序。
    """
    return pick_one(roster, order)


def generate(roster, rng=None):
    """旧一次性预览仍在兼容期内保留：整份排列，仅供历史回执核实路径使用。"""
    order = [row['id'] for row in roster]
    validate_order(order, roster)
    (rng if rng is not None else random.SystemRandom()).shuffle(order)
    return validate_order(order, roster)
