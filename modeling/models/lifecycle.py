# -*- coding: utf-8 -*-
"""人口生命周期模型：孵化 / 续命 / 回收（MECHANICS M04 / M05 / M06 / M07）。

三条路径的经济性完全不同，旧模型只算了"重造"一条：

    重造   ：花 cost(body) 能量，占 spawn 3·N tick，得到 TTL 1500 的新兵
    续命   ：花 ceil(cost/2.5/N) 能量，占 spawn 2.5·N tick，TTL 只加 floor(600/N)
    回收   ：返还 min(cost, 125·N) 能量，立即腾出人口名额

关键结论：续命的单位 TTL 成本与重造几乎相同，但它只占 spawn 一小半时间；
回收在"早期换兵"时能拿回大半造价。
"""
from __future__ import annotations

import math

import numpy as np

from mw import params as P
from mw import style as S

LIFE = P.CREEP_LIFE_TIME          # 1500


# ---------------------------------------------------------------- 孵化
def spawn_ticks(parts) -> int:
    """孵化耗时 = 3 tick / 部件。"""
    return P.CREEP_SPAWN_TIME * P.body_size(parts)


def spawn_capacity_loss(parts) -> float:
    """孵化期间 spawn 被占用，按"本可以产出的采集量"计的间接成本（e）。"""
    return spawn_ticks(parts) * P.HARVEST_POWER      # 以 1 个 WORK 的机会成本计价


# ---------------------------------------------------------------- 续命
def renew_gain(parts) -> int:
    """一次 renewCreep 增加的 TTL。"""
    n = P.body_size(parts)
    return int(math.floor(600.0 / n)) if n else 0


def renew_cost(parts) -> int:
    """一次 renewCreep 的能量。"""
    n = P.body_size(parts)
    return int(math.ceil(P.body_cost(parts) / 2.5 / n)) if n else 0


def renew_cost_per_ttl(parts) -> float:
    gain = renew_gain(parts)
    return renew_cost(parts) / gain if gain else float("inf")


# ---------------------------------------------------------------- 回收
def recycle_refund(parts) -> int:
    """回收返还：造价，但不超过 125 能量/部件。"""
    return min(P.body_cost(parts), P.CREEP_PART_MAX_ENERGY * P.body_size(parts))


def rebuild_cost_per_ttl(parts) -> float:
    return P.body_cost(parts) / LIFE


# ---------------------------------------------------------------- 图表
def fig_spawn_time():
    """fig80：典型 body 的孵化耗时与机会成本。"""
    bodies = ["1W1C1M", "2C1M", "4C2M", "5W1C1M", "10C5M", "20C10M"]
    ticks, opps, labels = [], [], []
    for b in bodies:
        parts = P.parse_body(b)
        t = spawn_ticks(parts)
        labels.append("%s\nN=%d" % (b, P.body_size(parts)))
        ticks.append(t)
        # 机会成本：这段时间 spawn 本可以孵化的采集体量（按 1 个 WORK 的机会成本估）
        opps.append(t * P.HARVEST_POWER)
    fig, ax = S.figure(8.0, 4.3)
    x = np.arange(len(labels))
    ax.bar(x, ticks, 0.55, color=S.MORANDI["dust"], label="孵化耗时（tick）")
    for i, t in enumerate(ticks):
        ax.annotate("%d tick\n%.0f 秒" % (t, t * P.SERVER["ms_per_tick"] / 1000),
                    (i, t), textcoords="offset points", xytext=(0, 3),
                    ha="center", fontsize=7.5, color=S.TEXT)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("孵化耗时（tick）")
    ax.set_ylim(0, max(ticks) * 1.3)
    ax.set_title("M04：3 tick/部件 —— 身体越大，spawn 被占用越久")
    ax2 = ax.twinx()
    ax2.plot(x, opps, color=S.MORANDI["clay"], marker="o", linewidth=1.6,
             label="机会成本（这段时间的理论采集量）")
    ax2.set_ylabel("机会成本（能量）", color=S.MORANDI["clay"])
    ax2.tick_params(axis="y", colors=S.MORANDI["clay"])
    for side in ("top", "right", "left", "bottom"):
        ax2.spines[side].set_visible(False)
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="upper left")
    return S.save(fig, "fig80_spawn_time",
                  "孵化期间 spawn 不能做别的事，这是看不见的机会成本")

def fig_renew_vs_rebuild():
    """fig81：续命 / 重造 / 回收 三条曲线。"""
    samples = ["1W1C1M", "2C1M", "4C2M", "5W1C1M", "10C5M"]
    labels, renew_p, rebuild_p, refund = [], [], [], []
    for b in samples:
        parts = P.parse_body(b)
        labels.append(b)
        renew_p.append(renew_cost_per_ttl(parts))
        rebuild_p.append(rebuild_cost_per_ttl(parts))
        refund.append(recycle_refund(parts) / P.body_cost(parts) * 100)

    fig, (ax1, ax2) = S.plt.subplots(1, 2, figsize=(11.8, 4.3))
    fig.patch.set_facecolor(S.BG)
    for ax in (ax1, ax2):
        ax.set_facecolor(S.BG)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.grid(axis="y", color=S.GRID, linewidth=0.8)
        ax.set_axisbelow(True)

    x = np.arange(len(labels))
    w = 0.36
    ax1.bar(x - w / 2, rebuild_p, w, color=S.MORANDI["sand"], label="重造（cost/1500）")
    ax1.bar(x + w / 2, renew_p, w, color=S.MORANDI["clay"], label="续命（renew）")
    for i, v in enumerate(renew_p):
        ax1.annotate("%.3f" % v, (i + w / 2, v), textcoords="offset points", xytext=(0, 3),
                     ha="center", fontsize=7, color=S.TEXT)
    ax1.set_xticks(x)
    ax1.set_xticklabels(labels, fontsize=8)
    ax1.set_ylabel("每 TTL 的能量成本")
    ax1.set_title("M06：续命与重造的单位 TTL 成本几乎相同")
    ax1.legend(loc="upper left")

    ax2.bar(x, refund, 0.55, color=S.MORANDI["olive"])
    for i, v in enumerate(refund):
        ax2.annotate("%.0f%%" % v, (i, v), textcoords="offset points", xytext=(0, 3),
                     ha="center", fontsize=8, color=S.TEXT)
    ax2.set_xticks(x)
    ax2.set_xticklabels(labels, fontsize=8)
    ax2.set_ylabel("回收能拿回造价的比例（%）")
    ax2.set_title("M07：小身体能全额回收，大身体被 125/部件 卡住")
    ax2.set_ylim(0, 115)
    return S.save(fig, "fig81_renew_vs_rebuild",
                  "renew 还会清空 boost，这一点在 boost 期必须考虑")


def fig_recycle_limit():
    """fig82：125 能量/部件 的上限从哪个 body 开始生效。"""
    ns = np.arange(1, 51)
    refunds = [min(n * 125, n * 125) for n in ns]          # 上限本身
    # 对比：同样部件数下"重装 WORK 兵"的造价
    costs = [P.body_cost({"WORK": int(n), "MOVE": int(math.ceil(n / 2.0))}) for n in ns]
    fig, ax = S.figure(7.8, 4.2)
    ax.plot(ns, refunds, color=S.MORANDI["sage"], linewidth=2.4, label="回收上限 125/部件")
    ax.plot(ns, costs, color=S.MORANDI["clay"], linewidth=2.0, label="纯 WORK 兵造价")
    ax.set_xlabel("body 部件数")
    ax.set_ylabel("能量")
    ax.set_title("M07：重甲/纯 WORK 兵会撞上 125/部件 的回收天花板")
    ax.legend(loc="upper left")
    return S.save(fig, "fig82_recycle_limit",
                  "回收适合提前换兵，但别指望把昂贵 body 的成本全额拿回")


def decision(parts, ttl: int, need_immediately: bool) -> str:
    """决策建议：renew / recycle / rebuild。

    - 立刻需要这个岗位的产能 → 续命（只占 2.5N tick，比重造快一倍）
    - 有余量、且身体便宜 → 重造更省（不占 spawn 太久）
    - 要腾人口名额 → 回收
    """
    n = P.body_size(parts)
    if need_immediately and ttl < 300:
        return "renew（占 spawn %d tick）" % int(2.5 * n)
    if ttl < 100:
        return "recycle（返还 %d 能量）" % recycle_refund(parts)
    return "rebuild（占 spawn %d tick）" % spawn_ticks(parts)


def main():
    S.setup()
    print("== 生命周期模型 ==")
    for b in ["1W1C1M", "2C1M", "5W1C1M", "10C5M"]:
        p = P.parse_body(b)
        print("  %-8s N=%-2d 孵化 %2d tick · renew +%2d TTL/花 %2d 能量 · 重造 %.3f/TTL · renew %.3f/TTL · 回收 %d/%d"
              % (b, P.body_size(p), spawn_ticks(p), renew_gain(p), renew_cost(p),
                 rebuild_cost_per_ttl(p), renew_cost_per_ttl(p),
                 recycle_refund(p), P.body_cost(p)))
    p = P.parse_body("2C1M")
    for ttl, need in [(200, True), (200, False), (80, False)]:
        print("  TTL=%d need=%s → %s" % (ttl, need, decision(p, ttl, need)))
    paths = [fig_spawn_time(), fig_renew_vs_rebuild(), fig_recycle_limit()]
    for x in paths:
        print("  图:", x)
    return paths


if __name__ == "__main__":
    main()
