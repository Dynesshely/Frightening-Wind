# -*- coding: utf-8 -*-
"""审计模型：把 MECHANICS.md 的 D1–D16 偏差量化成图。

这个模块刻意**不依赖**其它 models 的旧公式，全部按官方文档重新算一遍，
用来回答一个问题：旧模型到底错在多少量级上。
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S

# ---------------------------------------------------------------- 基础量
REPAIR_PER_ENERGY = 1.0 / P.REPAIR_COST          # 1 能量 = 100 hits
REGEN = P.ENERGY_REGEN_TIME                      # 300

#: source 三档容量（api-Source: 4000 中心房 / 3000 已占或已预订 / 1500 未预订中立房）
SOURCE_TIERS = {"中心房（SK/central）": 4000, "本房间（已占）": 3000, "中立房（未预订）": 1500}


def yield_of(n_work: int, q: int, regen: int = REGEN) -> float:
    """source 稳态产出：Y(n;Q) = Q / (Q/(2n) + T_regen)。"""
    if n_work <= 0:
        return 0.0
    return q / (q / (2.0 * n_work) + regen)


def tile_ticks(w: float, c: int, n_move: int) -> float:
    if n_move <= 0:
        return float("inf")
    if w <= 0:
        return 1.0
    return float(np.ceil(w * c / (2.0 * n_move)))


def trip(steps: int, w: float, c: int, n_move: int) -> float:
    """往返：满载去、空载回（空 CARRY 不计疲劳）。"""
    return tile_ticks(w, c, n_move) * steps + tile_ticks(0, c, n_move) * steps


# ---------------------------------------------------------------- fig70 满速判据
def fig_speed_rule():
    # 横轴用 "MOVE : 其它部件" 的比例，直接暴露旧判据的错位区间。
    # 固定权重 w=10（比如 5W5C5M 满载），让 MOVE 数从 0.2w 变到 2w。
    w = 10.0
    ratios = np.linspace(0.4, 2.0, 33)
    c = P.TERRAIN_FATIGUE["plain"]
    actual = [tile_ticks(w, c, max(1, int(round(r * w)))) for r in ratios]
    # 旧模型：只要 n_MOVE ≥ w/2 就当作"满速 1 tick/格"
    old = [1.0 if r >= 0.5 else 2.0 for r in ratios]

    fig, (ax1, ax2) = S.plt.subplots(1, 2, figsize=(11.8, 4.3))
    fig.patch.set_facecolor(S.BG)
    for ax in (ax1, ax2):
        ax.set_facecolor(S.BG)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.grid(axis="y", color=S.GRID, linewidth=0.8)
        ax.set_axisbelow(True)

    ax1.plot(ratios, actual, color=S.MORANDI["clay"], linewidth=2.4, label="实际（平地 c=2）")
    ax1.step(ratios, old, where="post", color=S.MORANDI["sand"], linewidth=2.0,
             linestyle=(0, (5, 2)), label="旧模型认为的耗时")
    ax1.axvspan(0.5, 1.0, color=S.MORANDI["rose"], alpha=0.12)
    ax1.annotate("旧模型认为已满速，\n实际还是 2 tick/格", (0.75, 3.4),
                 fontsize=8.5, color=S.MORANDI["rose"], ha="center")
    ax1.axvline(0.5, color=S.MORANDI["rose"], linewidth=1.0, linestyle=":")
    ax1.axvline(1.0, color=S.MORANDI["moss"], linewidth=1.0, linestyle=":")
    ax1.annotate("真正满速\n(1:1)", (1.02, 2.35), fontsize=8, color=S.MORANDI["moss"])
    ax1.set_xlabel("MOVE : 其它部件 的比例（权重 w=10 固定）")
    ax1.set_ylabel("单程每格 tick")
    ax1.set_ylim(0.8, 6.2)
    ax1.set_title("D9：平地要 1:1 才满速，旧判据 1:2 就宣告满速")
    ax1.legend(loc="upper right")

    # 右：用真实往返算「所以时间到底差多少」
    steps = 24
    bodies = [("2C1M", 2, 1), ("4C2M", 4, 2), ("6C3M", 6, 3), ("5W5C5M", 10, 5)]
    labels = [b[0] for b in bodies]
    old_t = [steps * 1 + steps * 1 for _ in bodies]          # 旧模型：往返都按满速
    new_t = [trip(steps, w_, P.TERRAIN_FATIGUE["plain"], m_) for _, w_, m_ in bodies]
    ratio = [n / o for n, o in zip(new_t, old_t)]
    ax2.barh(np.arange(len(labels)), ratio, 0.55, color=S.MORANDI["dust"])
    for i, r in enumerate(ratio):
        ax2.annotate("×%.2f（%.0f → %.0f tick）" % (r, old_t[i], new_t[i]),
                     (r, i), textcoords="offset points", xytext=(4, 0),
                     va="center", fontsize=8, color=S.TEXT)
    ax2.axvline(1.0, color=S.NEUTRAL, linewidth=1)
    ax2.set_yticks(np.arange(len(labels)))
    ax2.set_yticklabels(labels, fontsize=8.5)
    ax2.invert_yaxis()
    ax2.set_xlabel("24 步往返：实际 / 旧模型")
    ax2.set_xlim(0, max(ratio) * 1.8)
    ax2.set_title("折算成 %d 步往返的时间差" % steps)
    return S.save(fig, "fig70_speed_rule_fix",
                  "D9 依据：creeps.txt §Movement 原文 \"as many MOVE parts as all the other parts combined\"")


# ---------------------------------------------------------------- fig71 维护税
def fig_maintenance():
    fig, (ax1, ax2) = S.plt.subplots(1, 2, figsize=(12.0, 4.4))
    fig.patch.set_facecolor(S.BG)

    # 左：单件结构的维护税（能量/tick）
    items = [
        ("container（有主）", P.CONTAINER_DECAY / P.CONTAINER_DECAY_TIME_OWNED * P.REPAIR_COST),
        ("container（无主）", P.CONTAINER_DECAY / P.CONTAINER_DECAY_TIME * P.REPAIR_COST),
        ("rampart", P.RAMPART_DECAY_AMOUNT / P.RAMPART_DECAY_TIME * P.REPAIR_COST),
        ("road（时间项）", P.ROAD_DECAY_AMOUNT / P.ROAD_DECAY_TIME * P.REPAIR_COST),
        ("road（交通项, 2 兵/tick×5 部件）", 2 * 5 * P.ROAD_DECAY_AMOUNT / P.ROAD_DECAY_TIME * P.REPAIR_COST),
    ]
    names = [i[0] for i in items]
    vals = [i[1] for i in items]
    ax1.barh(np.arange(len(names)), vals, 0.55, color=[S.SEQ[i] for i in range(len(names))])
    for i, v in enumerate(vals):
        ax1.annotate("%.3f" % v, (v, i), textcoords="offset points", xytext=(5, 0),
                     va="center", fontsize=8, color=S.TEXT)
    ax1.set_yticks(np.arange(len(names)))
    ax1.set_yticklabels(names, fontsize=8)
    ax1.invert_yaxis()
    ax1.set_xlabel("维护能量（e/tick 每件）")
    ax1.set_title("D2/D3：维护税比旧模型高 1~2 个数量级")
    ax1.set_facecolor(S.BG)
    for side in ("top", "right"):
        ax1.spines[side].set_visible(False)
    ax1.grid(axis="x", color=S.GRID, linewidth=0.8)
    ax1.set_axisbelow(True)
    ax1.set_xlim(0, max(vals) * 1.35)

    # 右：rampart 修到上限的一次性成本（D15）
    levels = [2, 3, 4, 5, 6, 7, 8]
    caps = [P.RAMPART_HITS_MAX[l] for l in levels]
    costs = [c / REPAIR_PER_ENERGY for c in caps]
    ax2.bar([str(l) for l in levels], costs, 0.55, color=S.MORANDI["clay"])
    ax2.set_yscale("log")
    for i, c in enumerate(costs):
        ax2.annotate("%.0f" % c, (i, c), textcoords="offset points", xytext=(0, 3),
                     ha="center", fontsize=7.5, color=S.TEXT)
    ax2.set_xlabel("RCL")
    ax2.set_ylabel("修满 1 段 rampart 的能量（对数轴）")
    ax2.set_title("D15：建成时只有 1 hit，「修满」要花真金白银")
    ax2.set_facecolor(S.BG)
    for side in ("top", "right"):
        ax2.spines[side].set_visible(False)
    ax2.grid(axis="y", color=S.GRID, linewidth=0.8)
    ax2.set_axisbelow(True)

    fig.suptitle("被低估的固定成本", fontsize=12, color=S.TEXT, y=1.02)
    return S.save(fig, "fig71_maintenance_truth",
                  "D2/D3/D15：container 10~50 hits/tick，rampart 3 hits/tick，road 还有按部件的交通项")


# ---------------------------------------------------------------- fig72 source 三档
def fig_source_tiers():
    works = np.arange(1, 21)
    fig, ax = S.figure(7.8, 4.3)
    for i, (name, q) in enumerate(SOURCE_TIERS.items()):
        ys = [yield_of(int(n), q) for n in works]
        ax.plot(works, ys, color=S.SEQ[i], linewidth=2.0, label="%s（Q=%d）" % (name, q))
        ax.fill_between(works, ys, color=S.SEQ[i], alpha=0.10)
    ax.set_xlabel("该 source 上同时采矿的 WORK 数")
    ax.set_ylabel("稳态产出（e/tick）")
    ax.set_title("D1：同样的矿工数，中立房的天花板只有本房间的一半")
    ax.legend(loc="lower right")
    ax.set_ylim(0, 11)
    return S.save(fig, "fig72_source_tiers",
                  "Y(n;Q) = Q / (Q/(2n) + 300)；Q 由房间状态决定：1500 / 3000 / 4000")


# ---------------------------------------------------------------- fig73 能量平衡
def fig_energy_balance():
    """D5：spawn 在房间能量 < 300 时被动回能 1 e/tick。"""
    fig, ax = S.figure(7.8, 4.2)
    ticks = np.arange(0, 600)
    # 场景：纯 spawn 被动回能，没有采集
    e, curve = 0.0, []
    for t in ticks:
        if e < 300:
            e = min(300, e + 1)
        curve.append(e)
    ax.plot(ticks, curve, color=S.MORANDI["sage"], linewidth=2.2,
            label="spawn 被动回能（无采集）")
    ax.axhline(300, color=S.MORANDI["rose"], linewidth=1.2, linestyle=(0, (4, 3)))
    ax.annotate("到 300 就停（SPAWN_ENERGY_CAPACITY）", (10, 310), fontsize=8, color=S.MORANDI["rose"])
    ax.set_xlabel("tick")
    ax.set_ylabel("spawn 能量")
    ax.set_title("D5：即使一个矿工都没有，spawn 也在以 1 e/tick 回能")
    ax.legend(loc="lower right")
    ax.set_ylim(0, 360)
    return S.save(fig, "fig73_spawn_passive",
                  "api-StructureSpawn：energy < 300 时每 tick +1；这是旧模型完全没有的收入项")


# ---------------------------------------------------------------- fig74 偏差影响排序
DEVIATIONS = [
    ("D9 满速判据（平地 1:1）", 9, "formula"),
    ("D2 container 折旧", 8, "formula"),
    ("D15 rampart 修满成本", 7, "formula"),
    ("D5 spawn 被动回能", 7, "missing"),
    ("D3 road 交通折旧", 6, "formula"),
    ("D1 source 三档容量", 6, "formula"),
    ("D7 15 e/tick 只限 RCL8", 5, "formula"),
    ("D14 入侵是确定性支出", 5, "missing"),
    ("D13 safe mode 冷却", 4, "formula"),
    ("D4 link 冷却=距离", 4, "formula"),
    ("D10 renew/recycle", 4, "missing"),
    ("D8 PathFinder 代价", 3, "missing"),
    ("D11 drop 到容器格", 3, "missing"),
    ("D12 同 tick 能量冲突", 3, "missing"),
    ("D6 升级需计时器满", 2, "formula"),
    ("D16 常量缺项", 2, "missing"),
]


def fig_deviation_rank():
    items = sorted(DEVIATIONS, key=lambda x: x[1])
    names = [i[0] for i in items]
    vals = [i[1] for i in items]
    colors = [S.MORANDI["clay"] if i[2] == "formula" else S.MORANDI["dust"] for i in items]
    fig, ax = S.figure(8.4, 5.4)
    ax.barh(np.arange(len(names)), vals, 0.62, color=colors)
    for i, v in enumerate(vals):
        ax.annotate(str(v), (v, i), textcoords="offset points", xytext=(5, 0),
                    va="center", fontsize=8, color=S.TEXT)
    ax.set_yticks(np.arange(len(names)))
    ax.set_yticklabels(names, fontsize=8.5)
    ax.set_xlabel("对当前决策的影响权重（1–9，主观打分）")
    ax.set_xlim(0, 11)
    ax.set_title("16 处偏差的影响排序")
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(color=S.MORANDI["clay"], label="公式算错（A 级）"),
                       Patch(color=S.MORANDI["dust"], label="整块缺失（B 级）")],
              loc="lower right")
    return S.save(fig, "fig74_deviation_rank",
                  "依据 MECHANICS.md D1–D16；权重 = 它对当前房间决策的影响程度")


def main():
    S.setup()
    print("== 审计模型（MECHANICS D1–D16）==")
    for name, q in SOURCE_TIERS.items():
        print("  %-22s Q=%4d → 8 个 WORK 时稳态 %.2f e/tick" % (name, q, yield_of(8, q)))
    print("  container 维护：有主 %.3f / 无主 %.3f e/tick"
          % (P.CONTAINER_DECAY / P.CONTAINER_DECAY_TIME_OWNED * P.REPAIR_COST,
             P.CONTAINER_DECAY / P.CONTAINER_DECAY_TIME * P.REPAIR_COST))
    print("  rampart 修到 RCL4 上限 300 万 hits 需要 %.0f 能量/段"
          % (P.RAMPART_HITS_MAX[4] / REPAIR_PER_ENERGY))
    print("  平地满速判据：n_MOVE ≥ w（旧模型写成了 ≥ w/2）")
    paths = [fig_speed_rule(), fig_maintenance(), fig_source_tiers(),
             fig_energy_balance(), fig_deviation_rank()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
