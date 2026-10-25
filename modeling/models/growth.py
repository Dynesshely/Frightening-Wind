# -*- coding: utf-8 -*-
"""增长模型：RCL 曲线、升级时间、GCL。

    CONTROLLER_LEVELS[L] = 处于 RCL L 时升到 L+1 所需的能量（progressTotal）
    到达 RCL L 的累计能量 = Σ_{k=1}^{L-1} CONTROLLER_LEVELS[k]
    升级速率        ṗ = min(n_WORK·η, 15, 能量供给)
    剩余时间        T = (progressTotal − progress) / ṗ

注意：**RCL 每级 progress 归零**，所以"累计"必须逐级累加，
不能拿两级 progressTotal 相减。
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S


def cumulative_to(level: int) -> int:
    """到达 RCL level 需要的累计升级能量。"""
    return sum(P.CONTROLLER_LEVELS[l] for l in range(1, level))


def ticks_to_next(level: int, progress: int, rate: float) -> float:
    """从当前进度到下一级所需的 tick 数。"""
    need = P.CONTROLLER_LEVELS.get(level, 0) - progress
    if need <= 0 or rate <= 0:
        return 0.0
    return need / rate


def hours(ticks: float) -> float:
    """tick → 墙钟小时（私服 333.7 ms/tick）。"""
    return ticks * P.SERVER["ms_per_tick"] / 1000.0 / 3600.0


def gcl_of(total_energy: float) -> float:
    """GCL 的连续近似：(E/1e6)^(1/2.4)。"""
    return (total_energy / P.GCL_MULTIPLY) ** (1.0 / P.GCL_POW)


def energy_for_gcl(level: int) -> float:
    """达到某 GCL 需要的累计升级能量。"""
    return P.GCL_MULTIPLY * (level ** P.GCL_POW)


# ---------------------------------------------------------------- 图表
def fig_rcl_curve():
    """fig40：每级 progressTotal 与累计能量（对数）。"""
    levels = list(range(1, 8))
    totals = [P.CONTROLLER_LEVELS[l] for l in levels]
    cums = [cumulative_to(l) for l in levels]

    fig, ax = S.figure(8.0, 4.3)
    ax.bar(levels, totals, 0.6, color=S.MORANDI["dust"], label="本级 progressTotal")
    for x, y in zip(levels, totals):
        ax.annotate("%.0f" % y, (x, y * 1.15), ha="center", fontsize=7.5, color=S.TEXT)
    ax.set_yscale("log")
    ax.set_xticks(levels)
    ax.set_xlabel("RCL")
    ax.set_ylabel("能量（对数轴）")
    ax.set_title("升级成本：RCL 4 是一道坎，RCL 7 是另一道")

    ax2 = ax.twinx()
    ax2.plot(levels, cums, color=S.MORANDI["rose"], marker="o", linewidth=1.8,
             label="到达该级累计能量")
    ax2.set_yscale("log")
    ax2.set_ylabel("累计能量（对数轴）", color=S.MORANDI["rose"])
    ax2.tick_params(axis="y", colors=S.MORANDI["rose"])
    for side in ("top", "right", "left", "bottom"):
        ax2.spines[side].set_visible(False)

    ax.axvspan(3.5, 4.5, color=S.MORANDI["sand"], alpha=0.35, zorder=0)
    ax.annotate("当前 RCL 4", (4, totals[3]), textcoords="offset points",
                xytext=(0, 40), ha="center", fontsize=8.5, color=S.TEXT)
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="upper left")
    return S.save(fig, "fig40_rcl_curve",
                  "累计 = Σ 前几级 progressTotal；每级 progress 归零，不能直接相减")


def fig_time_to_rcl5():
    """fig41：升级速率 → 到 RCL5 的时间。"""
    need = P.CONTROLLER_LEVELS[4] - P.ROOM["progress"]
    rates = np.logspace(np.log10(0.5), np.log10(20), 200)
    ts = need / rates
    hs = np.array([hours(t) for t in ts])

    fig, ax = S.figure(7.8, 4.3)
    ax.plot(rates, hs, color=S.MORANDI["sage"], linewidth=2.2)
    ax.fill_between(rates, hs, color=S.MORANDI["sage"], alpha=0.16)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("升级速率（progress / tick）")
    ax.set_ylabel("到 RCL5 的墙钟时间（小时，对数轴）")
    ax.set_title("还差 %d 点：速率翻倍，时间减半" % need)

    marks = [
        (P.ROOM["measured_upgrade_rate"], "当前实测 1.13", S.BAD),
        (6.67, "两个 source 满配 6.67", S.MORANDI["clay"]),
        (13.3, "双 source 极限 13.3", S.MORANDI["dust"]),
    ]
    for r, label, c in marks:
        h = hours(need / r)
        ax.plot([r], [h], marker="o", color=c, markersize=8, zorder=5)
        ax.annotate("%s → %.1f 小时" % (label, h), (r, h), textcoords="offset points",
                    xytext=(8, 10), fontsize=8, color=c)
    S.hline(ax, 24, "24 小时", S.MUTED)
    ax.set_ylim(0.5, 600)
    return S.save(fig, "fig41_time_to_rcl5",
                  "T = (405000 − progress) / 速率；换算用私服 333.7 ms/tick")


def fig_income_vs_rcl():
    """fig42：收入提升 → 各 RCL 的时间（假设全部能量用于升级）。"""
    scenarios = [
        ("当前 1.13", P.ROOM["measured_income"], S.BAD),
        ("补矿工 5.0", 5.0, S.MORANDI["clay"]),
        ("满配 6.67", 6.67, S.MORANDI["olive"]),
        ("双源 13.3", 13.3, S.MORANDI["sage"]),
    ]
    fig, ax = S.figure(8.0, 4.3)
    targets = ["RCL5", "RCL6", "RCL7"]
    x = np.arange(len(targets))
    w = 0.2
    for i, (label, rate, c) in enumerate(scenarios):
        vals = []
        for lv in (4, 5, 6):
            need = sum(P.CONTROLLER_LEVELS[l] for l in range(lv, lv + 1))
            if lv == 4:
                need = P.CONTROLLER_LEVELS[4] - P.ROOM["progress"]
            vals.append(hours(need / rate))
        ax.bar(x + (i - 1.5) * w, vals, w, color=c, label=label)
    ax.set_yscale("log")
    ax.set_xticks(x)
    ax.set_xticklabels(targets)
    ax.set_ylabel("墙钟时间（小时，对数轴）")
    ax.set_title("加速升级是唯一变量：同一条曲线，四种收入")
    ax.legend(ncol=2, loc="upper left")
    return S.save(fig, "fig42_income_vs_rcl",
                  "只算 controller 本级所需能量，不含 creep 与建造开销")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 增长模型 ==")
    for lv in range(1, 8):
        print("  RCL %d：本级 %9d，到达该级累计 %10d，GCL 里程碑 %10.0f"
              % (lv, P.CONTROLLER_LEVELS[lv], cumulative_to(lv), energy_for_gcl(lv)))
    need = P.CONTROLLER_LEVELS[4] - P.ROOM["progress"]
    rate = P.ROOM["measured_upgrade_rate"]
    t = need / rate
    print("  当前 RCL4 %d/%d：还差 %d 点，按 %.2f/tick 需要 %.0f tick = %.1f 小时"
          % (P.ROOM["progress"], P.CONTROLLER_LEVELS[4], need, rate, t, hours(t)))
    for r in (5.0, 6.67, 13.3):
        print("    若速率提到 %.2f → %.1f 小时" % (r, hours(need / r)))
    paths = [fig_rcl_curve(), fig_time_to_rcl5(), fig_income_vs_rcl()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
