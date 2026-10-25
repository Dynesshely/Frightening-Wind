# -*- coding: utf-8 -*-
"""人口经济模型：造价、摊销、净产出。

    cost(body) = Σ n_p · k_p
    T_spawn    = 3 · N            （每部件 3 tick）
    ċ          = cost / 1500      （energy/tick 摊销）
    Ė_net      = 2·n_WORK·η − ċ   （采集兵）

η 是**有效工时占比**（真在干活 / 存活时间）。这是本项目真正的优化目标：
兵的数量不产生收益，**只有 η 才产生收益**。
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S

#: 评估用的代表 body（按用途分组）
SAMPLES = [
    ("1W1C1M", "通用工兵"),
    ("2C1M", "短驳 hauler"),
    ("4C2M", "中程 hauler"),
    ("5W1C1M", "满配矿工"),
    ("2W2C1M", "升级工"),
    ("1W1M1A", "哨兵"),
]


def amortized(parts) -> float:
    """每 tick 摊销成本。"""
    return P.body_cost(parts) / P.CREEP_LIFE_TIME


def spawn_ticks(parts) -> int:
    """生成耗时。"""
    return P.CREEP_SPAWN_TIME * P.body_size(parts)


def net_yield(parts, eta: float) -> float:
    """采集型兵的净产出（energy/tick）。非采集兵返回负值（纯消耗）。"""
    n_work = parts.get("WORK", 0) if isinstance(parts, dict) else P.parse_body(parts).get("WORK", 0)
    gross = P.HARVEST_POWER * n_work * eta
    return gross - amortized(parts)


# ---------------------------------------------------------------- 图表
def fig_body_tradeoff():
    """fig10：左 = 造价与生成时间；右 = 摊销与净产出（同量纲才可比）。"""
    names, costs, spawns_, amorts, nets = [], [], [], [], []
    for b, cn in SAMPLES:
        parts = P.parse_body(b)
        names.append("%s\n%s" % (b, cn))
        costs.append(P.body_cost(parts))
        spawns_.append(spawn_ticks(parts))
        amorts.append(amortized(parts))
        nets.append(net_yield(parts, 1.0))

    fig, (ax1, ax2) = S.plt.subplots(1, 2, figsize=(11.4, 4.3))
    fig.patch.set_facecolor(S.BG)
    for ax in (ax1, ax2):
        ax.set_facecolor(S.BG)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.grid(axis="y", color=S.GRID, linewidth=0.8)
        ax.set_axisbelow(True)

    x = np.arange(len(names))

    ax1.bar(x, costs, 0.55, color=S.MORANDI["dust"], label="造价（能量）")
    for xi, c in zip(x, costs):
        ax1.annotate(str(c), (xi, c), textcoords="offset points", xytext=(0, 3),
                     ha="center", fontsize=7.5, color=S.TEXT)
    ax1.set_xticks(x)
    ax1.set_xticklabels(names, fontsize=7.5)
    ax1.set_ylabel("造价（能量）")
    ax1.set_title("买它要多少：造价 / 生成耗时")
    ax1.set_ylim(0, max(costs) * 1.3)

    ax1b = ax1.twinx()
    ax1b.plot(x, spawns_, color=S.MORANDI["rose"], marker="o", linewidth=1.6,
              label="生成耗时（tick）")
    ax1b.set_ylabel("生成耗时（tick）", color=S.MORANDI["rose"])
    ax1b.tick_params(axis="y", colors=S.MORANDI["rose"])
    for side in ("top", "right", "left", "bottom"):
        ax1b.spines[side].set_visible(False)
    ax1b.grid(False)
    ax1b.legend(loc="upper left")

    w = 0.36
    ax2.bar(x - w / 2, amorts, w, color=S.MORANDI["clay"], label="摊销（e/tick，养它）")
    cols = [S.GOOD if v > 0 else S.BAD for v in nets]
    ax2.bar(x + w / 2, nets, w, color=cols, label="满负荷净产出（e/tick，它挣的）")
    ax2.axhline(0, color=S.NEUTRAL, linewidth=1)
    for xi, v in zip(x, nets):
        ax2.annotate("%+.2f" % v, (xi + w / 2, v), textcoords="offset points",
                     xytext=(0, 4 if v >= 0 else -13), ha="center", fontsize=7,
                     color=S.TEXT)
    ax2.set_xticks(x)
    ax2.set_xticklabels(names, fontsize=7.5)
    ax2.set_ylabel("energy / tick")
    ax2.set_title("养它 vs 它挣的（η = 100% 理想值）")
    ax2.legend(loc="upper left")

    fig.suptitle("一个 creep 的三笔账", fontsize=12, color=S.TEXT, y=1.02)
    return S.save(fig, "fig10_body_tradeoff",
                  "摊销 = 造价 / 1500 tick；净产出 = 2·n_WORK·η − 摊销。hauler 的净产出为负是正常的——它的价值在搬运，不在采集")


def fig_eta_sensitivity():
    """fig11：有效工时占比 η 对净产出的影响。"""
    etas = np.linspace(0, 1, 101)
    bodies = ["1W1C1M", "2C1M", "5W1C1M"]
    fig, ax = S.figure(7.4, 4.2)
    for i, b in enumerate(bodies):
        parts = P.parse_body(b)
        ys = [net_yield(parts, e) for e in etas]
        ax.plot(etas * 100, ys, color=S.SEQ[i], label=b)
        # 盈亏平衡点
        if parts.get("WORK", 0):
            be = amortized(parts) / (P.HARVEST_POWER * parts["WORK"])
            ax.plot([be * 100], [0], marker="o", color=S.SEQ[i], markersize=6)
            ax.annotate("η=%.0f%%" % (be * 100), (be * 100, 0),
                        textcoords="offset points", xytext=(6, 8), fontsize=7.5,
                        color=S.SEQ[i])
    cur = P.ROOM["measured_income"] / (P.HARVEST_POWER * 9)  # 9 WORK 实际产出
    ax.axvline(cur * 100, color=S.BAD, linewidth=1.4, linestyle=(0, (4, 3)))
    ax.annotate("当前 η ≈ %.0f%%" % (cur * 100), (cur * 100, ax.get_ylim()[1] * 0.9),
                textcoords="offset points", xytext=(6, 0), fontsize=8, color=S.BAD)
    ax.axhline(0, color=S.NEUTRAL, linewidth=1)
    ax.set_xlabel("有效工时占比 η（%）")
    ax.set_ylabel("净产出（energy/tick）")
    ax.set_title("η 才是真正的生产力：同一个人，干活时间决定盈亏")
    ax.legend(loc="lower right")
    return S.save(fig, "fig11_eta_sensitivity",
                  "圆点 = 该 body 的盈亏平衡 η；竖虚线 = 本房间实测值")


def fig_population_cost():
    """fig12：当前人口的成本构成（累计横向条形）。"""
    mix = P.ROOM["body_mix"]
    rows = []
    for b, n in sorted(mix.items(), key=lambda kv: -P.body_cost(kv[0]) * kv[1]):
        c = P.body_cost(P.parse_body(b))
        rows.append((b, n, c, c * n))
    total = sum(r[3] for r in rows)

    fig, ax = S.figure(7.8, 3.4)
    ys = np.arange(len(rows))
    left = 0.0
    for i, (b, n, c, tot) in enumerate(rows):
        ax.barh(ys[i], tot, left=left, color=S.SEQ[i], height=0.55,
                label="%s ×%d" % (b, n))
        ax.annotate("%s ×%d = %d" % (b, n, tot), (left + tot / 2, ys[i]),
                    ha="center", va="center", fontsize=8,
                    color="#FFFFFF" if tot > total * 0.12 else S.TEXT)
        left += tot
    ax.set_yticks([])
    ax.set_xlabel("造价（能量）")
    ax.set_title("当前 13 个兵的总造价 %d 能量  →  摊销 %.2f e/tick"
                 % (total, total / P.CREEP_LIFE_TIME))
    ax.legend(ncol=3, loc="upper center", bbox_to_anchor=(0.5, -0.28))
    return S.save(fig, "fig12_population_cost",
                  "摊销 = 总造价 / 1500 tick，与是否干活无关，属于固定税")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 人口经济模型 ==")
    for b, cn in SAMPLES:
        parts = P.parse_body(b)
        print("  %-8s %-10s 造价 %4d · %2d 部件 · 生成 %3d tick · 摊销 %.3f e/tick · 满负荷净产出 %+.2f"
              % (b, cn, P.body_cost(parts), P.body_size(parts), spawn_ticks(parts),
                 amortized(parts), net_yield(parts, 1.0)))
    total = sum(P.body_cost(P.parse_body(b)) * n for b, n in P.ROOM["body_mix"].items())
    print("  当前 13 个兵：总造价 %d，固定摊销 %.2f e/tick（占 20 e/tick 天花板的 %.1f%%）"
          % (total, total / P.CREEP_LIFE_TIME, 100 * total / P.CREEP_LIFE_TIME / 20))
    paths = [fig_body_tradeoff(), fig_eta_sensitivity(), fig_population_cost()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
