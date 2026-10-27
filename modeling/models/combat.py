# -*- coding: utf-8 -*-
"""战斗与入侵模型（MECHANICS M03 / M11 / M20）。

三个问题：
1. 受伤的 creep 还剩多少能力？（部件级失效，能力按**活跃部件数**衰减）
2. 入侵什么时候来、多强？（每累计约 100,000 采出能量触发，RCL4 起换重型）
3. 防御要花多少钱？（塔的持续火力 + rampart 的建造/维护税）
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S

PART_HITS = 100          # 每个 body part 100 hits


# ---------------------------------------------------------------- 伤害
def active_parts(n_parts: int, damage: float) -> float:
    """承受 damage 点伤害后，还剩多少个"完整"部件。

    伤害按 body 顺序从前往后吃（M03），所以是"前缀被削掉"的模型：
    第 k 个部件在受到 k*100 伤害后被完全禁用，部分受损的部件仍算活跃。
    """
    if damage <= 0:
        return float(n_parts)
    disabled = int(damage // PART_HITS)
    return float(max(0, n_parts - disabled))


def effective_power(n_parts: int, damage: float, power_per_part: float) -> float:
    """有效火力/产能。"""
    return active_parts(n_parts, damage) * power_per_part


def tile_time(w: float, c: int, n_move: int) -> float:
    if n_move <= 0:
        return float("inf")
    if w <= 0:
        return 1.0
    return float(np.ceil(w * c / (2.0 * n_move)))


# ---------------------------------------------------------------- 塔
def tower_sigma(r: float) -> float:
    """塔的距离衰减系数（OPTIMAL=5, FALLOFF_RANGE=20, FALLOFF=0.75）。"""
    raw = 1.0 - P.TOWER_FALLOFF * max(0.0, r - P.TOWER_OPTIMAL_RANGE) / \
          (P.TOWER_FALLOFF_RANGE - P.TOWER_OPTIMAL_RANGE)
    return float(np.clip(raw, 1.0 - P.TOWER_FALLOFF, 1.0))


def tower_dps(n_towers: int, r: float) -> float:
    """n 座塔在距离 r 处的每 tick 伤害（每 tick 每塔 10 能量）。"""
    return n_towers * P.TOWER_POWER_ATTACK * tower_sigma(r)


def tower_energy_rate(n_towers: int) -> float:
    """塔的补给速率需求（e/tick）：每塔每 tick 一次动作 = 10 能量。"""
    return n_towers * P.TOWER_ENERGY_COST


# ---------------------------------------------------------------- 入侵
INVASION_ENERGY = 100_000        # 每累计约 10 万采出能量触发一次（M20）


def invasion_interval(income: float) -> float:
    """按收入估算入侵间隔（tick）。"""
    return INVASION_ENERGY / max(1e-9, income)


def raid_strength(rcl: int) -> tuple[str, float]:
    """RCL<4 轻型 / RCL>=4 重型。返回 (类型, 估算 hp)。

    轻型约 3~5 只基础兵（每只 300~600 hits），重型 4~6 只并可能带 boost，
    这里取文档描述的量级做保守估计。
    """
    if rcl < 4:
        return "轻型", 5 * 400.0
    return "重型", 6 * 2000.0


# ---------------------------------------------------------------- 图表
def fig_part_decay():
    """fig90：受伤后剩余有效部件（不同 body 规模）。"""
    damages = np.linspace(0, 1200, 121)
    sizes = [3, 6, 12, 25, 50]
    fig, ax = S.figure(7.8, 4.3)
    for i, n in enumerate(sizes):
        ys = [active_parts(n, d) for d in damages]
        ax.plot(damages, ys, color=S.SEQ[i], label="%d 部件" % n, marker="", linewidth=1.8)
    ax.set_xlabel("累计承伤（hits）")
    ax.set_ylabel("剩余活跃部件数")
    ax.set_title("M03：伤害按 body 顺序削部件，能力是台阶式衰减")
    ax.legend(loc="upper right")
    S.hline(ax, 0, "全灭", S.MUTED)
    return S.save(fig, "fig90_part_decay",
                  "每部件 100 hits；被完全打掉的部件不再计入 getActiveBodyparts")


def fig_defense_budget():
    """fig91：收入 → 入侵间隔 → 需要的常备火力。"""
    incomes = np.linspace(1, 20, 39)
    fig, (ax1, ax2) = S.plt.subplots(1, 2, figsize=(11.8, 4.3))
    fig.patch.set_facecolor(S.BG)
    for ax in (ax1, ax2):
        ax.set_facecolor(S.BG)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.grid(axis="y", color=S.GRID, linewidth=0.8)
        ax.set_axisbelow(True)

    ax1.plot(incomes, [invasion_interval(i) for i in incomes], color=S.MORANDI["clay"], linewidth=2.2)
    ax1.set_xlabel("房间采出收入（e/tick）")
    ax1.set_ylabel("平均入侵间隔（tick）")
    ax1.set_title("M20：按每 10 万采出能量触发一次")
    for inc in (2, 6, 13):
        ax1.plot([inc], [invasion_interval(inc)], marker="o", markersize=7, color=S.BAD)
        ax1.annotate("%d e/tick → %.0f tick" % (inc, invasion_interval(inc)), (inc, invasion_interval(inc)),
                     textcoords="offset points", xytext=(8, 8), fontsize=8, color=S.BAD)

    # 右：打掉一次重型袭击需要的塔火力时间（按 5000 hp/只 × 6 只）
    _, hp = raid_strength(4)
    for i, n in enumerate([1, 2, 3, 6]):
        ts = [hp / tower_dps(n, r) for r in (5, 10, 15, 20)]
        ax2.plot([5, 10, 15, 20], ts, marker="o", color=S.SEQ[i], label="%d 塔" % n)
    ax2.set_yscale("log")
    ax2.set_xlabel("敌人与塔的距离（格）")
    ax2.set_ylabel("清掉一次重型袭击所需 tick（对数轴）")
    ax2.set_title("M03+M11：塔的火力随距离衰减，补能速率是真正的上限")
    ax2.legend(loc="upper left")
    return S.save(fig, "fig91_defense_budget",
                  "重型袭击估算 6 只 × 2000 hp；塔每 tick 每座耗 10 能量")


def fig_tower_supply():
    """fig92：塔的补给需求 vs 房间收入 —— 防御能吃掉的产能比例。"""
    incomes = np.linspace(1, 20, 39)
    fig, ax = S.figure(7.8, 4.2)
    for i, n in enumerate([1, 2, 3, 6]):
        need = tower_energy_rate(n)
        share = [min(1.0, need / inc) for inc in incomes]
        ax.plot(incomes, np.array(share) * 100, color=S.SEQ[i], linewidth=2.0, label="%d 塔" % n)
    ax.axhline(50, color=S.MORANDI["rose"], linewidth=1.1, linestyle=(0, (4, 3)))
    ax.annotate("50% 产能", (2, 52), fontsize=8, color=S.MORANDI["rose"])
    ax.set_xlabel("房间采出收入（e/tick）")
    ax.set_ylabel("塔全速运转吃掉的产能（%）")
    ax.set_title("塔不是免费的：每座每 tick 10 能量，三座就吃掉 30 e/tick")
    ax.set_ylim(0, 105)
    ax.legend(loc="upper right")
    return S.save(fig, "fig92_tower_supply",
                  "只在有敌情时开火；常开维修会直接抽干经济（config.towerRepairRatio 的意义）")


def main():
    S.setup()
    print("== 战斗与入侵模型 ==")
    for d in (0, 100, 300, 600):
        print("  12 部件兵承伤 %4d → 活跃部件 %2.0f（火力 %.0f%%）"
              % (d, active_parts(12, d), 100 * active_parts(12, d) / 12))
    for inc in (2, 6, 13):
        print("  收入 %2d e/tick → 平均 %.0f tick 一次入侵（约 %.1f 分钟）"
              % (inc, invasion_interval(inc), invasion_interval(inc) * P.SERVER["ms_per_tick"] / 60000))
    for rcl in (2, 4, 6):
        kind, hp = raid_strength(rcl)
        print("  RCL%d → %s袭击，估算 %.0f hp" % (rcl, kind, hp))
    print("  塔补给：1 座 %.0f e/tick，3 座 %.0f e/tick" % (tower_energy_rate(1), tower_energy_rate(3)))
    paths = [fig_part_decay(), fig_defense_budget(), fig_tower_supply()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
