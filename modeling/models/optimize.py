# -*- coding: utf-8 -*-
"""综合优化：在矿工、hauler、升级之间做资源分配。

策略是**串行瓶颈**而不是加总：
    每个 source 的可用产出 = min( 矿工稳态产出 , 运输吞吐 )
    全房间流转          = Σ_sources 上式
    净升级速率          = 流转 − 人口摊销 − 维护

于是在"矿工不够"和"hauler 不够"之间存在一条脊线，
参数量在该脊线上把净升级速率推到最大。
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S
from .growth import hours
from .logistics import throughput
from .mining import steady_yield

HAULER_BODY = "2C1M"
HAULER_PARTS = P.parse_body(HAULER_BODY)
HAULER_COST = P.body_cost(HAULER_PARTS) / P.CREEP_LIFE_TIME     # 摊销 e/tick


def evaluate(n_work: int, n_hauler: int, road: bool = False) -> dict:
    """给定配置，算能量收支。n_work 是**每个 source** 的 WORK 总数。"""
    terrain = "road" if road else "plain"
    per_src_yield = steady_yield(n_work)
    # hauler 按产出等分
    srcs = P.ROOM["sources"]
    total_thr = 0.0
    for src in srcs:
        share = n_hauler / len(srcs)
        total_thr += share * throughput(HAULER_PARTS, src["spawn_steps"], terrain)
    flow = min(per_src_yield * len(srcs), total_thr)
    upkeep = 2 * n_work * P.BODYPART_COST["WORK"] / P.CREEP_LIFE_TIME \
        + n_hauler * HAULER_COST
    return {
        "yield": per_src_yield * len(srcs),
        "haul": total_thr,
        "flow": flow,
        "upkeep": upkeep,
        "net": flow - upkeep,
    }


def best_config(road: bool = False, max_work: int = 14, max_hauler: int = 22):
    best = None
    for w in range(1, max_work + 1):
        for h in range(1, max_hauler + 1):
            r = evaluate(w, h, road)
            if best is None or r["net"] > best[0]["net"]:
                best = (r, w, h)
    return best


# ---------------------------------------------------------------- 图表
def fig_config_heatmap():
    """fig60：矿工 × hauler 配置空间的净升级速率。"""
    works = np.arange(1, 15)
    haulers = np.arange(1, 17)
    grid = np.zeros((len(haulers), len(works)))
    for i, h in enumerate(haulers):
        for j, w in enumerate(works):
            grid[i, j] = evaluate(int(w), int(h), False)["net"]

    fig, ax = S.plt.subplots(figsize=(9.2, 5.0))
    fig.patch.set_facecolor(S.BG)
    ax.set_facecolor(S.BG)
    im = ax.imshow(grid, origin="lower", aspect="auto", cmap=S.CMAP_SEQ,
                   vmin=0.0, vmax=float(grid.max()),
                   extent=[works[0] - 0.5, works[-1] + 0.5,
                           haulers[0] - 0.5, haulers[-1] + 0.5])
    cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
    cb.set_label("净升级速率（e/tick）", fontsize=8)
    cb.outline.set_visible(False)

    best, bw, bh = best_config(False)
    ax.plot([bw], [bh], marker="*", markersize=17, color=S.BAD,
            markeredgecolor="#FFFFFF", zorder=6)
    ax.annotate("最优 (%d WORK/源, %d hauler)\n→ %.2f e/tick" % (bw, bh, best["net"]),
                (bw, bh), textcoords="offset points", xytext=(-16, -34),
                fontsize=8.5, color=S.BAD, ha="right",
                bbox=dict(boxstyle="round,pad=0.3", fc=S.BG, ec=S.BAD, lw=0.8, alpha=0.92))

    ax.plot([1], [3], marker="o", markersize=11, color=S.MORANDI["dust"],
            markeredgecolor="#FFFFFF", zorder=6)
    ax.annotate("当前 (1, 3)\n→ %.2f e/tick" % evaluate(1, 3)["net"],
                (1, 3), textcoords="offset points", xytext=(16, 20),
                fontsize=8.5, color=S.MORANDI["slate"],
                bbox=dict(boxstyle="round,pad=0.3", fc=S.BG, ec=S.MORANDI["slate"],
                          lw=0.8, alpha=0.92))

    # 脊线：最优 hauler 数随矿工数变化
    ridge = []
    for w in works:
        best_h = max(haulers, key=lambda h: evaluate(int(w), int(h), False)["net"])
        ridge.append(best_h)
    ax.plot(works, ridge, color=S.MORANDI["rose"], linewidth=1.8,
            linestyle=(0, (5, 3)), label="最优 hauler 数")
    ax.legend(loc="lower left", fontsize=7.5)
    ax.set_xlabel("每个 source 的 WORK 总数")
    ax.set_ylabel("hauler 数量（2C1M）")
    ax.set_title("配置空间：对角线是瓶颈脊线，越往右上越接近天花板")
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    return S.save(fig, "fig60_config_heatmap",
                  "净 = min(矿工产出, 运输吞吐) − 人口摊销；无路场景")


def fig_current_vs_best():
    """fig61：当前配置 vs 模型最优。"""
    cur = evaluate(1, 3, False)
    best, bw, bh = best_config(False)
    best_road, _, _ = best_config(True)

    need = P.CONTROLLER_LEVELS[4] - P.ROOM["progress"]
    rows = [
        ("当前", cur, S.BAD),
        ("最优（无路）", best, S.MORANDI["clay"]),
        ("最优（修路）", best_road, S.MORANDI["sage"]),
    ]

    fig, (ax1, ax2) = S.plt.subplots(1, 2, figsize=(11.4, 4.3))
    fig.patch.set_facecolor(S.BG)
    for ax in (ax1, ax2):
        ax.set_facecolor(S.BG)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.grid(axis="y", color=S.GRID, linewidth=0.8)
        ax.set_axisbelow(True)

    x = np.arange(len(rows))
    w = 0.36
    ax1.bar(x - w / 2, [r[1]["flow"] for r in rows], w,
            color=[r[2] for r in rows], label="能量流转")
    ax1.bar(x + w / 2, [r[1]["upkeep"] for r in rows], w,
            color=S.MORANDI["sand"], label="人口摊销")
    for i, r in enumerate(rows):
        ax1.annotate("%.2f" % r[1]["flow"], (i - w / 2, r[1]["flow"]),
                     textcoords="offset points", xytext=(0, 3), ha="center",
                     fontsize=8, color=S.TEXT)
    ax1.set_xticks(x)
    ax1.set_xticklabels([r[0] for r in rows], fontsize=8.5)
    ax1.set_ylabel("energy / tick")
    ax1.set_title("能量流转 vs 人口开销")
    ax1.legend(loc="upper left")

    ts = [hours(need / max(1e-6, r[1]["net"])) for r in rows]
    ax2.bar(x, ts, 0.55, color=[r[2] for r in rows])
    for i, t in enumerate(ts):
        ax2.annotate("%.1f 小时" % t, (i, t), textcoords="offset points",
                     xytext=(0, 3), ha="center", fontsize=8, color=S.TEXT)
    ax2.set_yscale("log")
    ax2.set_xticks(x)
    ax2.set_xticklabels([r[0] for r in rows], fontsize=8.5)
    ax2.set_ylabel("到 RCL5 的墙钟时间（小时，对数轴）")
    ax2.set_title("折算成 RCL5 到达时间")
    ax2.set_ylim(0.5, max(ts) * 3)

    fig.suptitle("当前配置 vs 模型建议：差的是 1 个量级", fontsize=12, color=S.TEXT, y=1.02)
    return S.save(fig, "fig61_current_vs_best",
                  "净升级速率 = 流转 − 摊销；时间 = (405000 − progress) / 净速率")


def fig_priority():
    """fig62：行动优先级 —— 每投入 1000 能量买到多少 e/tick（由模型逐级算增量）。"""
    a = evaluate(5, 3)
    b = evaluate(5, 6)
    c = evaluate(14, 6)
    # 修路的价值在「同样的 hauler 数能多运多少」，所以要固定 hauler 比
    d_no = evaluate(14, 4)
    d_road = evaluate(14, 4, True)
    items = [
        ("矿工 1W → 5W/源", 1200, a["net"] - evaluate(1, 3)["net"]),
        ("补 3 个 hauler", 3 * P.body_cost(HAULER_PARTS), b["net"] - a["net"]),
        ("矿工 5W → 14W/源", 2 * 9 * P.BODYPART_COST["WORK"], c["net"] - b["net"]),
        ("修 source A 的 24 段路", 7200, d_road["net"] - d_no["net"]),
    ]
    fig, ax = S.figure(7.8, 4.0)
    labels = [i[0] for i in items]
    roi = [i[2] / i[1] * 1000 for i in items]
    order = np.argsort(roi)[::-1]
    labels = [labels[i] for i in order]
    roi = [roi[i] for i in order]
    bars = ax.barh(np.arange(len(labels)), roi, 0.55,
                   color=[S.SEQ[i] for i in range(len(labels))])
    for i, v in enumerate(roi):
        ax.annotate("%.2f e/tick per 1000E" % v, (v, i), textcoords="offset points",
                    xytext=(5, 0), va="center", fontsize=8, color=S.TEXT)
    ax.set_yticks(np.arange(len(labels)))
    ax.set_yticklabels(labels, fontsize=8.5)
    ax.invert_yaxis()
    ax.set_xlabel("每投入 1000 能量带来的收益（e/tick）")
    ax.set_title("按回报率排序：先补矿工，再补 hauler，最后修路")
    ax.set_xlim(0, max(roi) * 1.45)
    return S.save(fig, "fig62_action_priority",
                  "收益为长期稳态增量；成本含 creep 造价或建造能量")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 综合优化 ==")
    cur = evaluate(1, 3, False)
    best, bw, bh = best_config(False)
    best_road, rw, rh = best_config(True)
    print("  当前 (1 WORK/源, 3 hauler)：流转 %.2f，摊销 %.2f，净 %.2f"
          % (cur["flow"], cur["upkeep"], cur["net"]))
    print("  最优无路 (%d, %d)：流转 %.2f，摊销 %.2f，净 %.2f"
          % (bw, bh, best["flow"], best["upkeep"], best["net"]))
    print("  最优修路 (%d, %d)：流转 %.2f，摊销 %.2f，净 %.2f"
          % (rw, rh, best_road["flow"], best_road["upkeep"], best_road["net"]))
    need = P.CONTROLLER_LEVELS[4] - P.ROOM["progress"]
    for label, r in [("当前", cur), ("最优无路", best), ("最优修路", best_road)]:
        print("    %-8s → RCL5 需 %.1f 小时" % (label, hours(need / max(1e-6, r["net"]))))
    paths = [fig_config_heatmap(), fig_current_vs_best(), fig_priority()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
