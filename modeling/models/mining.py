# -*- coding: utf-8 -*-
"""采集模型：source 的周期库存与矿工边际收益。

    Q_max = 3000 energy，抽干后 T_regen = 300 tick 整块回填

**重要**：source 的平均产出不是常数，而取决于抽干速度。

    抽干耗时  D(n) = Q_max / (2·n_WORK)
    稳态周期  C(n) = D(n) + T_regen
    稳态产出  Ȳ(n) = Q_max / C(n) = 10·n / (5 + n)      [energy/tick]

  n → ∞ 时 Ȳ → 10，但永远达不到。
  边际产出  dȲ/dn = 50 / (5+n)² ，n=5 时还有 0.56 e/tick，
  n=22 时降到 0.067 —— 与一个 WORK 的摊销成本（100/1500）相当，
  再往上加矿工就是亏的。

结论：**没有"饱和点"，只有边际递减。**
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S

CAP = P.SOURCE_ENERGY_CAPACITY          # 3000
REGEN = P.ENERGY_REGEN_TIME             # 300
WORK_COST_PER_TICK = P.BODYPART_COST["WORK"] / P.CREEP_LIFE_TIME   # 0.0667


def steady_yield(n_work: int) -> float:
    """稳态平均产出（energy/tick）。"""
    if n_work <= 0:
        return 0.0
    return CAP / (CAP / (P.HARVEST_POWER * n_work) + REGEN)


def marginal_yield(n_work: int) -> float:
    """第 n 个 WORK 带来的增量。"""
    return steady_yield(n_work) - steady_yield(n_work - 1)


def breakeven_workers() -> float:
    """边际产出 = WORK 摊销成本 时的 WORK 数。"""
    return float(np.sqrt(50.0 / WORK_COST_PER_TICK) - 5)


def simulate(n_work: int, ticks: int = 6000):
    """单 source 的库存与产出仿真，返回 (库存序列, 稳态平均产出, 采集时间占比)。"""
    q = CAP
    regen_at = None
    qs, flows, active = [], [], 0
    for t in range(ticks):
        if q <= 0:
            if regen_at is None:
                regen_at = t + REGEN
            elif t >= regen_at:
                q = CAP
                regen_at = None
        take = min(P.HARVEST_POWER * n_work, q)
        q -= take
        if take > 0:
            active += 1
        qs.append(q)
        flows.append(take)
    flows = np.array(flows)
    tail = flows[ticks // 2:]
    return np.array(qs), tail.mean(), active / ticks


# ---------------------------------------------------------------- 图表
def fig_yield_curve():
    """fig20：稳态产出 + 边际产出 + 盈亏平衡点。"""
    works = np.arange(1, 41)
    yields = [steady_yield(n) for n in works]
    margins = [marginal_yield(n) for n in works]
    be = breakeven_workers()

    fig, ax = S.figure(8.2, 4.4)
    ax.bar(works, yields, 0.65, color=S.MORANDI["sage"], label="稳态产出（e/tick）")
    ax.axhline(10, color=S.BAD, linewidth=1.3, linestyle=(0, (4, 3)))
    ax.annotate("理论上限 10（n→∞）", (33, 10.3), fontsize=8, color=S.BAD, ha="center")
    ax.set_xlabel("矿工 WORK 总数")
    ax.set_ylabel("稳态产出（energy/tick）")
    ax.set_ylim(0, 11.6)
    ax.set_xlim(0.3, 40.7)
    ax.set_title("source 没有饱和点，只有边际递减")

    ax2 = ax.twinx()
    ax2.plot(works, margins, color=S.MORANDI["clay"], marker="o", markersize=3.5,
             linewidth=1.6, label="边际产出（每多 1 个 WORK）")
    ax2.axhline(WORK_COST_PER_TICK, color=S.MORANDI["rose"], linewidth=1.2,
                linestyle=(0, (2, 3)))
    ax2.annotate("WORK 摊销成本 %.3f" % WORK_COST_PER_TICK,
                 (2.0, WORK_COST_PER_TICK + 0.06), fontsize=7.5,
                 color=S.MORANDI["rose"],
                 bbox=dict(boxstyle="round,pad=0.22", fc=S.BG, ec="none", alpha=0.92))
    ax2.axvline(be, color=S.MORANDI["rose"], linewidth=1.0, linestyle=":")
    ax2.annotate("盈亏平衡 n ≈ %.0f" % be, (be, 1.22), fontsize=7.5,
                 color=S.MORANDI["rose"], ha="center",
                 bbox=dict(boxstyle="round,pad=0.25", fc=S.BG, ec="none", alpha=0.9))
    ax2.set_ylabel("边际产出（e/tick per WORK）", color=S.MORANDI["clay"])
    ax2.tick_params(axis="y", colors=S.MORANDI["clay"])
    ax2.set_ylim(0, 1.5)
    for side in ("top", "right", "left", "bottom"):
        ax2.spines[side].set_visible(False)

    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, loc="upper center",
              bbox_to_anchor=(0.5, -0.13), ncol=2)
    return S.save(fig, "fig20_source_yield",
                  "Y(n) = 10n/(5+n)，Q=3000，T_regen=300")


def fig_regen_sawtooth():
    """fig21：不同矿工数下的库存锯齿。"""
    fig, axes = S.plt.subplots(2, 2, figsize=(11.0, 5.8), sharex=False, sharey=True)
    fig.patch.set_facecolor(S.BG)
    for ax, w in zip(axes.ravel(), [1, 3, 5, 10]):
        qs, steady, act = simulate(w, 1800)
        ax.plot(np.arange(len(qs)), qs, color=S.MORANDI["sage"], linewidth=1.2)
        ax.fill_between(np.arange(len(qs)), qs, color=S.MORANDI["sage"], alpha=0.22)
        ax.set_facecolor(S.BG)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.grid(axis="y", color=S.GRID, linewidth=0.8)
        ax.set_title("n_WORK = %d  →  稳态 %.2f e/tick" % (w, steady), fontsize=10)
        ax.set_ylim(0, CAP * 1.08)
        ax.set_xlabel("tick")
    for ax in axes[:, 0]:
        ax.set_ylabel("剩余能量")
    fig.suptitle("source 库存的锯齿：矿工越多，锯齿越陡、周期越短", fontsize=12, color=S.TEXT)
    fig.tight_layout()
    return S.save(fig, "fig21_regen_sawtooth",
                  "抽干后整块回填；平均产出的上限由 300 tick 的再生周期决定")


def fig_room_gap():
    """fig22：单个 source 的产出曲线 + 本房间当前位置。"""
    room = P.ROOM
    works = np.arange(1, 31)
    ys = [steady_yield(int(n)) for n in works]

    fig, ax = S.figure(7.8, 4.2)
    ax.plot(works, ys, color=S.MORANDI["sage"], linewidth=2.4,
            label="单 source 稳态产出 Y(n)")
    ax.fill_between(works, ys, color=S.MORANDI["sage"], alpha=0.16)

    # 当前：全房间 1 个 WORK 摊到两个 source 上
    cur_per_src = 1 / max(1, len(room["sources"]))
    ax.plot([cur_per_src], [steady_yield(1)], marker="o", markersize=9,
            color=S.BAD, zorder=5)
    ax.annotate("当前：每 source 约 %.1f 个 WORK\n→ 全房间仅 %.2f e/tick（实测 %.2f）"
                % (cur_per_src, 2 * steady_yield(1), room["measured_income"]),
                (cur_per_src, steady_yield(1)), xytext=(0.30, 0.30),
                textcoords="axes fraction", fontsize=8.5, color=S.BAD, ha="left",
                arrowprops=dict(arrowstyle="->", color=S.BAD, lw=1.0))

    # 建议：每 source 5 个 WORK
    ax.plot([5], [steady_yield(5)], marker="D", markersize=8, color=S.MORANDI["moss"], zorder=5)
    ax.annotate("建议：每 source 5 个 WORK\n→ 全房间 %.1f e/tick"
                % (2 * steady_yield(5)),
                (5, steady_yield(5)), xytext=(0.42, 0.84),
                textcoords="axes fraction", fontsize=8.5,
                color=S.MORANDI["moss"], ha="left",
                arrowprops=dict(arrowstyle="->", color=S.MORANDI["moss"], lw=1.0))

    ax.set_xlabel("每个 source 的 WORK 数")
    ax.set_ylabel("单 source 稳态产出（e/tick）")
    ax.set_title("我们连半个矿工都没给足：理论 20 e/tick，实收 1.13")
    ax.set_ylim(0, 10)
    ax.legend(loc="lower right")
    return S.save(fig, "fig22_room_gap",
                  "Y(n) = 10n/(5+n)；全房间产出 = 2 × Y(每 source 的 WORK 数)")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 采集模型 ==")
    print("  Q=%d, T_regen=%d → 稳态产出 Y(n) = 10n/(5+n)" % (CAP, REGEN))
    for w in [1, 2, 3, 5, 8, 10, 20]:
        print("  n_WORK=%2d → 稳态 %5.2f e/tick，边际 %+.3f，采集时间占比 %.0f%%"
              % (w, steady_yield(w), marginal_yield(w), simulate(w, 1200)[2] * 100))
    print("  盈亏平衡（边际 = WORK 摊销 %.3f）: n ≈ %.1f" % (WORK_COST_PER_TICK, breakeven_workers()))
    print("  本房间实测收入 %.2f e/tick · 2 个 source 天花板 %.1f"
          % (P.ROOM["measured_income"], 2 * 10))
    paths = [fig_yield_curve(), fig_regen_sawtooth(), fig_room_gap()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
