# -*- coding: utf-8 -*-
"""防御模型：tower 距离衰减与围墙维护税。

    sigma(r) = clamp( 1 − 0.75·(r−5)/15 , 0.25 , 1 )      （TOWER_FALLOFF = 0.75）
    dmg(r)    = 600·sigma(r)
    heal(r)   = 400·sigma(r)
    repair(r) = 800·sigma(r)
    每次动作固定消耗 10 energy

    维护税：rampart 掉血 300 hit / 100 tick = 3 hit/tick
    修 1 hit 花 REPAIR_COST = 0.01 energy  →  0.03 e/tick 每段
"""
from __future__ import annotations

import numpy as np

from mw import params as P
from mw import style as S


def sigma(r: float) -> float:
    """距离衰减系数。"""
    raw = 1.0 - P.TOWER_FALLOFF * max(0.0, r - P.TOWER_OPTIMAL_RANGE) / \
          (P.TOWER_FALLOFF_RANGE - P.TOWER_OPTIMAL_RANGE)
    return float(np.clip(raw, 1.0 - P.TOWER_FALLOFF, 1.0))


def tower_stat(r: float, kind: str = "attack") -> float:
    base = {"attack": P.TOWER_POWER_ATTACK, "heal": P.TOWER_POWER_HEAL,
            "repair": P.TOWER_POWER_REPAIR}[kind]
    return base * sigma(r)


def damage_per_energy(r: float) -> float:
    """每点能量换来的伤害。"""
    return tower_stat(r, "attack") / P.TOWER_ENERGY_COST


def rampart_tax(segments: int) -> float:
    """segments 段 rampart 的维护能量（e/tick）。"""
    per_tick_hits = P.RAMPART_DECAY_AMOUNT / P.RAMPART_DECAY_TIME
    return segments * per_tick_hits * P.REPAIR_COST


def road_tax(segments: int) -> float:
    per_tick_hits = P.ROAD_DECAY_AMOUNT / P.ROAD_DECAY_TIME
    return segments * per_tick_hits * P.REPAIR_COST


# ---------------------------------------------------------------- 图表
def fig_tower_falloff():
    """fig50：距离 → 伤害 / 治疗 / 修理，以及每能量伤害。"""
    rs = np.arange(1, 33)
    fig, ax = S.figure(8.0, 4.3)
    for i, (kind, label) in enumerate([("attack", "伤害"), ("heal", "治疗"),
                                       ("repair", "修理")]):
        ys = [tower_stat(r, kind) for r in rs]
        ax.plot(rs, ys, color=S.SEQ[i], label=label)
    ax.axvspan(1, 5, color=S.MORANDI["sand"], alpha=0.4, zorder=0)
    ax.annotate("满效率区", (3, 640), ha="center", fontsize=8, color=S.TEXT)
    ax.axvline(20, color=S.MORANDI["rose"], linewidth=1.1, linestyle=(0, (4, 3)))
    ax.annotate("r ≥ 20 只剩 25%", (20.4, 300), fontsize=8, color=S.MORANDI["rose"])
    ax.set_xlabel("与塔的距离（格）")
    ax.set_ylabel("每次动作的效果（hit）")
    ax.set_title("塔的效率随距离线性衰减，但每次固定烧 10 能量")
    ax.legend(loc="upper right")

    ax2 = ax.twinx()
    ax2.plot(rs, [damage_per_energy(r) for r in rs], color=S.MORANDI["stone"],
             linewidth=1.4, linestyle=(0, (2, 3)))
    ax2.set_ylabel("每能量伤害（hit / energy）", color=S.MORANDI["stone"])
    ax2.tick_params(axis="y", colors=S.MORANDI["stone"])
    for side in ("top", "right", "left", "bottom"):
        ax2.spines[side].set_visible(False)
    return S.save(fig, "fig50_tower_falloff",
                  "sigma(r) = clamp(1 − 0.75(r−5)/15, 0.25, 1)")


def fig_maintenance_tax():
    """fig51：rampart / road 段数 → 维护能量（与房间总收入对比）。"""
    segs = np.arange(0, 601, 10)
    fig, ax = S.figure(7.8, 4.3)
    ax.plot(segs, [rampart_tax(s) for s in segs], color=S.BAD,
            label="rampart 维护（0.03 e/tick/段）")
    ax.plot(segs, [road_tax(s) for s in segs], color=S.MORANDI["sage"],
            label="road 维护（0.001 e/tick/段）")
    income = P.ROOM["measured_income"]
    ax.axhline(income, color=S.MUTED, linewidth=1.2, linestyle=":")
    ax.annotate("当前房间总收入 %.2f e/tick" % income, (10, income + 0.4),
                fontsize=8, color=S.MUTED)
    ax.fill_between(segs, [rampart_tax(s) for s in segs], color=S.BAD, alpha=0.12)
    ax.set_xlabel("结构段数")
    ax.set_ylabel("维护能量（e/tick）")
    ax.set_title("围墙是要交税的：200 段 rampart 就吃掉 6 e/tick")
    ax.legend(loc="upper left")
    ax.set_ylim(0, 20)
    return S.save(fig, "fig51_maintenance_tax",
                  "rampart 掉血 3 hit/tick，修 1 hit 花 0.01 能量")


def fig_siege_time():
    """fig52：击杀一个目标需要多少 tick（几种塔数与距离）。"""
    hp = 5000
    configs = [("1 塔 @5 格", 1, 5), ("1 塔 @10 格", 1, 10),
               ("2 塔 @10 格", 2, 10), ("3 塔 @15 格", 3, 15)]
    fig, ax = S.figure(7.6, 4.0)
    names, ticks = [], []
    for label, n, r in configs:
        dps = n * tower_stat(r, "attack")
        names.append(label)
        ticks.append(hp / dps)
    bars = ax.barh(np.arange(len(names)), ticks, 0.55,
                   color=[S.SEQ[i] for i in range(len(names))])
    for i, t in enumerate(ticks):
        ax.annotate("%.0f tick（%.1f 秒）" % (t, t * P.SERVER["ms_per_tick"] / 1000),
                    (t, i), textcoords="offset points", xytext=(6, 0),
                    va="center", fontsize=8, color=S.TEXT)
    ax.set_yticks(np.arange(len(names)))
    ax.set_yticklabels(names, fontsize=8.5)
    ax.set_xlabel("击杀 5000 hit 目标所需 tick")
    ax.set_title("塔的持续火力受补给限制，不只看单次伤害")
    ax.set_xlim(0, max(ticks) * 1.35)
    return S.save(fig, "fig52_siege_time",
                  "纯伤害估算，未计入治疗、护盾与走位")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 防御模型 ==")
    for r in (1, 5, 10, 15, 20, 30):
        print("  r=%2d：伤害 %5.0f · 治疗 %4.0f · 修理 %5.0f · 每能量伤害 %.1f"
              % (r, tower_stat(r, "attack"), tower_stat(r, "heal"),
                 tower_stat(r, "repair"), damage_per_energy(r)))
    print("  维护税：rampart 100 段 = %.2f e/tick，road 500 段 = %.2f e/tick"
          % (rampart_tax(100), road_tax(500)))
    paths = [fig_tower_falloff(), fig_maintenance_tax(), fig_siege_time()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
