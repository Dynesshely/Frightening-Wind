# -*- coding: utf-8 -*-
"""系统层模型：CPU 预算、视野约束、寻路代价（MECHANICS M21 / M22 / M23）。

这三条都不产生直接产能，但每一条都能让前面的经济模型失效：
- CPU bucket 是唯一可存储的算力，长期不用就是浪费；
- 无视野房间会让"目标产能"变成未知量；
- PathFinder 默认代价只有 moveTo 的一半，用它估时会把路程算短。
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S

CPU_LIMIT = P.SERVER["cpu_limit"]          # 110（私服实测）
BUCKET_MAX = P.SERVER["cpu_bucket"]        # 10000
TICK_LIMIT_MAX = P.SERVER["cpu_tick_limit"]  # 500
PIXEL_COST = getattr(P, "PIXEL_CPU_COST", 10000)
MS_PER_TICK = P.SERVER["ms_per_tick"]


# ---------------------------------------------------------------- CPU
def bucket_trajectory(used: float, ticks: int, start: float = 0.0):
    """bucket 随时间的变化：每 tick 结余 limit - used 进入 bucket（上限 10000）。"""
    b = start
    out = []
    for _ in range(ticks):
        b = min(BUCKET_MAX, b + max(0.0, CPU_LIMIT - used))
        out.append(b)
    return np.array(out)


def pixels_per_hour(cpu_surplus: float) -> float:
    """每墙钟小时能兑换多少 pixel（10000 CPU 结余 = 1 pixel）。"""
    cpu_per_second = cpu_surplus / (MS_PER_TICK / 1000.0)
    return cpu_per_second * 3600.0 / PIXEL_COST


# ---------------------------------------------------------------- 寻路
PATH_DEFAULTS = {"plain": 1, "swamp": 5}     # PathFinder.search 默认值
MOVE_COSTS = {"plain": P.TERRAIN_FATIGUE["plain"], "swamp": P.TERRAIN_FATIGUE["swamp"]}


def path_cost(steps_plain: int, steps_swamp: int, costs: dict) -> float:
    return steps_plain * costs["plain"] + steps_swamp * costs["swamp"]


# ---------------------------------------------------------------- 视野
def visibility_penalty(unknown_room_ratio: float) -> float:
    """无视野房间比例 → 需要预留的缓冲（按最坏情况留 25%）。"""
    return 1.0 + 0.25 * np.clip(unknown_room_ratio, 0.0, 1.0)


# ---------------------------------------------------------------- 图表
def fig_cpu_bucket():
    """fig93：不同用量下 bucket 的积累曲线（含兑换 pixel 的时机）。"""
    ticks = np.arange(0, 1200)
    fig, ax = S.figure(7.8, 4.3)
    for i, used in enumerate([2.0, 20.0, 60.0, 110.0]):
        ys = bucket_trajectory(used, len(ticks))
        ax.plot(ticks, ys, color=S.SEQ[i], linewidth=2.0, label="用量 %.0f CPU/tick" % used)
    ax.axhline(BUCKET_MAX, color=S.MORANDI["rose"], linewidth=1.2, linestyle=(0, (4, 3)))
    ax.annotate("bucket 上限 10,000", (10, BUCKET_MAX * 0.94), fontsize=8, color=S.MORANDI["rose"])
    ax.set_xlabel("tick")
    ax.set_ylabel("bucket（可存储算力）")
    ax.set_title("M21：limit 110 而实际只用 2 CPU，bucket 几分钟就满了")
    ax.legend(loc="lower right")
    ax.set_ylim(0, BUCKET_MAX * 1.15)
    return S.save(fig, "fig93_cpu_bucket",
                  "每 tick 结余 = limit − used；满了之后继续闲置就是纯浪费")


def fig_pixel_economics():
    """fig94：结余算力换成 pixel 的长期收益。"""
    surplus = np.linspace(0, 110, 111)
    per_hour = [pixels_per_hour(s) for s in surplus]
    fig, ax = S.figure(7.8, 4.2)
    ax.plot(surplus, per_hour, color=S.MORANDI["olive"], linewidth=2.4)
    ax.fill_between(surplus, per_hour, color=S.MORANDI["olive"], alpha=0.15)
    cur = CPU_LIMIT - 2.0
    ax.plot([cur], [pixels_per_hour(cur)], marker="o", markersize=9, color=S.BAD)
    ax.annotate("当前结余 %.0f CPU/tick\n→ %.2f pixel/小时" % (cur, pixels_per_hour(cur)),
                (cur, pixels_per_hour(cur)), textcoords="offset points", xytext=(-14, 16),
                fontsize=8.5, color=S.BAD, ha="right")
    ax.set_xlabel("每 tick 的 CPU 结余")
    ax.set_ylabel("可兑换 pixel / 墙钟小时")
    ax.set_title("M21：PIXEL_CPU_COST = 10,000，结余是该变现的")
    return S.save(fig, "fig94_pixel_economics",
                  "pixel 是官方市场的硬通货；bucket 满了不换就是白扔")


def fig_path_cost():
    """fig95：PathFinder 默认代价 vs moveTo 真实代价。"""
    swamp_ratio = np.linspace(0, 1, 51)
    steps = 24
    pf = [path_cost(steps * (1 - r), steps * r, PATH_DEFAULTS) for r in swamp_ratio]
    mv = [path_cost(steps * (1 - r), steps * r, MOVE_COSTS) for r in swamp_ratio]
    fig, ax = S.figure(7.8, 4.2)
    ax.plot(swamp_ratio * 100, pf, color=S.MORANDI["sand"], linewidth=2.2, label="PathFinder 默认（1/5）")
    ax.plot(swamp_ratio * 100, mv, color=S.MORANDI["clay"], linewidth=2.2, label="moveTo 实际（2/10）")
    ax.fill_between(swamp_ratio * 100, pf, mv, color=S.MORANDI["rose"], alpha=0.15)
    ax.set_xlabel("路径中沼泽占比（%）")
    ax.set_ylabel("24 步路径的总代价")
    ax.set_title("M23：默认参数把路径代价低估了整整一倍")
    ax.legend(loc="upper left")
    ax.annotate("差的这一块就是\n估时偏乐观的来源", (55, (pf[27] + mv[27]) / 2),
                fontsize=8.5, color=S.MORANDI["rose"], ha="center")
    return S.save(fig, "fig95_path_cost",
                  "估时/估耗必须显式传 plainCost:2 / swampCost:10")


def main():
    S.setup()
    print("== 系统层模型 ==")
    print("  CPU limit %.0f，bucket 上限 %.0f，tickLimit 上限 %.0f"
          % (CPU_LIMIT, BUCKET_MAX, TICK_LIMIT_MAX))
    for used in (2, 20, 60):
        print("  用量 %3.0f CPU/tick → bucket 需要 %.0f tick 充满；结余可换 %.2f pixel/小时"
              % (used, BUCKET_MAX / max(1e-9, CPU_LIMIT - used), pixels_per_hour(CPU_LIMIT - used)))
    print("  PathFinder 默认 plain=1/swamp=5，moveTo 实际 plain=2/swamp=10（低估 2 倍）")
    paths = [fig_cpu_bucket(), fig_pixel_economics(), fig_path_cost()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
