# -*- coding: utf-8 -*-
"""运输模型：hauler 吞吐、所需人口、修路与 link 的收益。

    T_空  = L · ceil(0 / (2·n_MOVE)) = L          （空 CARRY 不计疲劳）
    T_满  = L · ceil(n_CARRY·c / (2·n_MOVE))
    往返  = T_空 + T_满 + 2                        （装卸各 1 tick）
    Thr   = 50·n_CARRY / 往返                     [energy/tick]
    n_hauler = ceil( 采集速率 / Thr )
"""
from __future__ import annotations

import math

import numpy as np

from mw import params as P
from mw import style as S
from .mining import steady_yield
from .movement import trip_ticks

#: 满配目标：每个 source 分到 10 个 WORK（稳态 6.67 e/tick，非理论极限 10）
TARGET_RATE = steady_yield(10)


def throughput(parts, steps: int, terrain: str = "plain") -> float:
    """单个 hauler 的吞吐（energy/tick）。"""
    cap = P.CARRY_CAPACITY * parts.get("CARRY", 0)
    if cap <= 0:
        return 0.0
    t = trip_ticks(parts, steps, terrain, round_trip=True)["total"] + 2
    return cap / t


def haulers_needed(rate: float, parts, steps: int, terrain: str = "plain") -> int:
    """喂满 rate 需要几个 hauler（向上取整，最少 1）。"""
    t = throughput(parts, steps, terrain)
    return max(1, math.ceil(rate / t)) if t > 0 else 10 ** 6


def road_cost(steps: int, swamp_ratio: float = 0.0) -> int:
    """修 steps 段路的能量成本（平原 300 / 沼泽 1500）。"""
    per = (1 - swamp_ratio) * P.CONSTRUCTION_COST["road"] + \
          swamp_ratio * P.CONSTRUCTION_COST["road"] * P.CONSTRUCTION_COST_ROAD_SWAMP_RATIO
    return int(round(steps * per))


# ---------------------------------------------------------------- 图表
def fig_throughput_curve():
    """fig30：距离 → 单 hauler 吞吐（有路/无路 × 载重）。"""
    dists = np.arange(1, 41)
    cases = [("2C1M", "plain", "2C1M 无路"), ("2C1M", "road", "2C1M 有路"),
             ("4C2M", "plain", "4C2M 无路"), ("4C2M", "road", "4C2M 有路")]
    fig, ax = S.figure(7.8, 4.3)
    for i, (b, terr, label) in enumerate(cases):
        parts = P.parse_body(b)
        ys = [throughput(parts, int(d), terr) for d in dists]
        ax.plot(dists, ys, color=S.SEQ[i], label=label,
                linestyle="-" if terr == "road" else (0, (5, 2)))
    ax.set_ylim(0, 13)
    for src, nm in zip(P.ROOM["sources"], ["A", "B"]):
        x = src["spawn_steps"]
        ax.axvline(x, color=S.MUTED, linewidth=1, linestyle=":")
        ax.annotate("source %s（%d 步）" % (nm, x), (x, 11.8),
                    rotation=90, fontsize=7.5, color=S.MUTED, va="top", ha="right")
    ax.set_xlabel("单程距离（格）")
    ax.set_ylabel("单 hauler 吞吐（energy/tick）")
    ax.set_title("距离是运输的唯一敌人：吞吐按 1/距离 衰减")
    ax.legend(ncol=2, loc="upper right", fontsize=7.5)
    return S.save(fig, "fig30_hauler_throughput",
                  "实线 = 有路，虚线 = 无路；空车返程不计 CARRY 疲劳")


def fig_haulers_needed():
    """fig31：距离 → 喂满 10 e/tick 需要的 hauler 数。"""
    dists = np.arange(1, 41)
    rate = TARGET_RATE
    cases = [("2C1M", "plain", "2C1M 无路"), ("4C2M", "plain", "4C2M 无路"),
             ("4C2M", "road", "4C2M 有路")]
    fig, ax = S.figure(7.8, 4.3)
    for i, (b, terr, label) in enumerate(cases):
        parts = P.parse_body(b)
        ys = [haulers_needed(rate, parts, int(d), terr) for d in dists]
        ax.step(dists, ys, where="mid", color=S.SEQ[i], label=label)
    for src, nm in zip(P.ROOM["sources"], ["A", "B"]):
        x = src["spawn_steps"]
        parts = P.parse_body("2C1M")
        y = haulers_needed(rate, parts, x, "plain")
        ax.plot([x], [y], marker="o", color=S.BAD, markersize=7, zorder=5)
        ax.annotate("source %s：%d 个" % (nm, y), (x, y),
                    textcoords="offset points", xytext=(8, -12), fontsize=8, color=S.BAD)
    ax.set_xlabel("单程距离（格）")
    ax.set_ylabel("需要的 hauler 数量")
    ax.set_title("喂满 %.1f e/tick（10 个 WORK）需要多少 hauler" % rate)
    ax.legend(loc="upper left")
    return S.save(fig, "fig31_haulers_needed",
                  "本房间：source A 24 步 → 需 8 个；source B 6 步 → 需 2 个")


def fig_road_payback():
    """fig32：修路回本时间（按省下的 hauler 摊销折算）。"""
    dists = np.arange(2, 41)
    parts = P.parse_body("2C1M")
    rate = TARGET_RATE
    payback = []
    for d in dists:
        n_no = haulers_needed(rate, parts, int(d), "plain")
        n_road = haulers_needed(rate, parts, int(d), "road")
        saved = (n_no - n_road) * P.body_cost(parts) / P.CREEP_LIFE_TIME
        cost = road_cost(int(d))
        payback.append(cost / saved if saved > 0 else np.nan)
    fig, ax = S.figure(7.8, 4.3)
    ax.plot(dists, payback, color=S.MORANDI["sage"], marker="o", markersize=4)
    ax.fill_between(dists, payback, color=S.MORANDI["sage"], alpha=0.18)
    ax.set_yscale("log")
    ax.set_xlabel("单程距离（格）")
    ax.set_ylabel("回本时间（tick，对数轴）")
    ax.set_title("修路的回本时间：距离越长越值得")
    ax.axhline(1500, color=S.MORANDI["rose"], linewidth=1.2, linestyle=(0, (4, 3)))
    ax.annotate("一代 creep 的寿命 1500 tick", (3, 1600), fontsize=8,
                color=S.MORANDI["rose"])
    for src, nm in zip(P.ROOM["sources"], ["A", "B"]):
        x = src["spawn_steps"]
        n_no = haulers_needed(rate, parts, x, "plain")
        n_road = haulers_needed(rate, parts, x, "road")
        saved = (n_no - n_road) * P.body_cost(parts) / P.CREEP_LIFE_TIME
        if saved > 0:
            ax.plot([x], [road_cost(x) / saved], marker="D", color=S.BAD, markersize=7)
            ax.annotate("source %s" % nm, (x, road_cost(x) / saved),
                        textcoords="offset points", xytext=(6, 8), fontsize=8, color=S.BAD)
    return S.save(fig, "fig32_road_payback",
                  "回本 = 修路成本 / 省下的 hauler 摊销；低于 1500 tick 即「一代兵内就能回本」")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 运输模型 ==")
    parts = P.parse_body("2C1M")
    for src, nm in zip(P.ROOM["sources"], ["A", "B"]):
        d = src["spawn_steps"]
        thr_n = throughput(parts, d, "plain")
        thr_r = throughput(parts, d, "road")
        print("  source %s（%d 步）：2C1M 无路 %.2f → 有路 %.2f e/tick；喂满 %.2f 需要 %d / %d 个"
              % (nm, d, thr_n, thr_r, TARGET_RATE,
                 haulers_needed(TARGET_RATE, parts, d, "plain"),
                 haulers_needed(TARGET_RATE, parts, d, "road")))
    print("  修路成本：source A 24 段 = %d 能量" % road_cost(24))
    paths = [fig_throughput_curve(), fig_haulers_needed(), fig_road_payback()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
