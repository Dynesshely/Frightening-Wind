# -*- coding: utf-8 -*-
"""移动模型：疲劳 → 速度 → 路径耗时。

核心公式（官方 creeps.html §Movement）
--------------------------------------
每次成功移动，疲劳增加    φ += w · c(g)
每 tick 开始，疲劳减少    φ = max(0, φ − 2·n_MOVE)
可移动当且仅当            φ = 0

  w     = 非 MOVE 部件数（**空 CARRY 不计**）
  c(g)  = 1 道路 / 2 平原 / 10 沼泽

单格稳态耗时            T(g) = ceil( w·c(g) / (2·n_MOVE) )
"""
from __future__ import annotations

import math

import numpy as np

from mw import params as P
from mw import style as S


# ---------------------------------------------------------------- 模型
def weight(parts: dict[str, int], cargo_frac: float = 1.0) -> float:
    """有效重量 w：产生疲劳的部件数。cargo_frac 是 CARRY 的装载率（0=空）。"""
    w = 0.0
    for name, n in parts.items():
        if name == "MOVE":
            continue
        if name == "CARRY":
            w += n * cargo_frac
        else:
            w += n
    return w


def tile_ticks(parts: dict[str, int], terrain: str = "plain",
               cargo_frac: float = 1.0) -> float:
    """走一格需要几个 tick。"""
    n_move = parts.get("MOVE", 0)
    if n_move <= 0:
        return math.inf
    w = weight(parts, cargo_frac)
    if w <= 0:
        return 1.0                       # 空载全 CARRY：零疲劳
    return math.ceil(w * P.TERRAIN_FATIGUE[terrain] / (2 * n_move))


def trip_ticks(parts: dict[str, int], steps: int, terrain: str = "plain",
               round_trip: bool = True) -> dict:
    """一趟行程耗时。round_trip=True 时回程按空载计。"""
    t_out = tile_ticks(parts, terrain, 1.0) * steps
    t_back = tile_ticks(parts, terrain, 0.0) * steps if round_trip else 0.0
    return {"out": t_out, "back": t_back, "total": t_out + t_back,
            "tile_out": tile_ticks(parts, terrain, 1.0),
            "tile_back": tile_ticks(parts, terrain, 0.0)}


# ---------------------------------------------------------------- 图表
def fig_body_heatmap():
    """fig01：MOVE 数 × 其他部件数 → 每格 tick（三种地形）。"""
    others = list(range(0, 13))
    moves = list(range(1, 13))
    terrains = [("road", "道路"), ("plain", "平原"), ("swamp", "沼泽")]

    fig, axes = S.plt.subplots(1, 3, figsize=(12.5, 4.0))
    fig.patch.set_facecolor(S.BG)

    for ax, (key, cn) in zip(axes, terrains):
        grid = np.zeros((len(others), len(moves)))
        for i, o in enumerate(others):
            for j, m in enumerate(moves):
                grid[i, j] = tile_ticks({"MOVE": m, "WORK": o}, key, 1.0)
        im = ax.imshow(grid, origin="lower", aspect="auto", cmap=S.CMAP_SEQ,
                       extent=[moves[0] - 0.5, moves[-1] + 0.5,
                               others[0] - 0.5, others[-1] + 0.5])
        ax.set_title("%s（c=%d）" % (cn, P.TERRAIN_FATIGUE[key]))
        ax.set_xlabel("MOVE 部件数")
        ax.set_xticks(moves[::2])
        ax.set_yticks(others[::2])
        ax.grid(False)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        # 标出「1 tick/格」的临界线：n_MOVE >= w/2
        ax.plot([0.5, 6.5], [1, 13], color=S.MORANDI["rose"], linewidth=1.4,
                linestyle=(0, (4, 3)))
        cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
        cb.set_label("tick / 格", fontsize=8)
        cb.outline.set_visible(False)
    axes[0].set_ylabel("其他部件数（WORK+CARRY+…）")
    fig.suptitle("疲劳模型：走一格要几 tick（红线 = 刚好 1 tick/格）",
                 fontsize=12, color=S.TEXT, y=1.02)
    return S.save(fig, "fig01_tile_ticks_heatmap",
                  "w·c/(2·n_MOVE) 向上取整；空 CARRY 不计疲劳")


def fig_cargo_curve():
    """fig02：载重比例 → 速度（几种代表性 body，平原）。"""
    bodies = ["2C1M", "4C2M", "10C5M", "1W1C1M", "5W5C5M", "20C10M"]
    fracs = np.linspace(0, 1, 101)
    fig, ax = S.figure(7.6, 4.2)
    for i, b in enumerate(bodies):
        parts = P.parse_body(b)
        ys = [1.0 / tile_ticks(parts, "plain", f) for f in fracs]
        ax.plot(fracs * 100, ys, color=S.SEQ[i], label=b,
                markevery=[0, 100], marker="o")
    ax.set_xlabel("载重比例（%）")
    ax.set_ylabel("速度（格 / tick）")
    ax.set_title("载重对速度的影响（平原，无路）")
    ax.set_ylim(0, 1.08)
    S.hline(ax, 1.0, "上限 1 格/tick")
    ax.legend(ncol=3, loc="lower left")
    return S.save(fig, "fig02_speed_vs_cargo",
                  "空 CARRY 不产生疲劳 → 曲线在低载重处是平的")


def fig_room_trip():
    """fig03：本房间两个 source 的 hauler 往返时间（修路前后）。"""
    room = P.ROOM
    bodies = ["2C1M", "4C2M", "6C3M"]
    labels, before, after = [], [], []
    for src in room["sources"]:
        for b in bodies:
            parts = P.parse_body(b)
            t_no = trip_ticks(parts, src["spawn_steps"], "plain", True)["total"]
            t_road = trip_ticks(parts, src["spawn_steps"], "road", True)["total"]
            labels.append("%s\n%s" % (
                "source " + ("A" if src["spawn_steps"] > 12 else "B"), b))
            before.append(t_no)
            after.append(t_road)

    fig, ax = S.figure(8.0, 4.2)
    x = np.arange(len(labels))
    w = 0.36
    b1 = ax.bar(x - w / 2, before, w, color=S.MORANDI["clay"], label="无路")
    b2 = ax.bar(x + w / 2, after, w, color=S.MORANDI["sage"], label="修路后")
    for bars in (b1, b2):
        for r in bars:
            ax.annotate("%.0f" % r.get_height(), (r.get_x() + r.get_width() / 2, r.get_height()),
                        textcoords="offset points", xytext=(0, 3), ha="center",
                        fontsize=7.5, color=S.TEXT)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("往返 tick")
    ax.set_title("本房间：hauler 往返时间（空去满载回）")
    ax.legend()
    return S.save(fig, "fig03_room_trip_ticks",
                  "source A 24 步 / source B 6 步；修路把每格成本 2 → 1")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    room = P.ROOM
    print("== 移动模型 ==")
    for b in ["2C1M", "4C2M", "1W1C1M", "5W5C5M"]:
        parts = P.parse_body(b)
        print("  %-8s 平原满载 %.0f tick/格 · 平原空载 %.0f · 沼泽满载 %.0f"
              % (b, tile_ticks(parts, "plain", 1.0), tile_ticks(parts, "plain", 0.0),
                 tile_ticks(parts, "swamp", 1.0)))
    for src in room["sources"]:
        t = trip_ticks(P.parse_body("2C1M"), src["spawn_steps"], "plain", True)
        print("  source@%s：%d 步 → 往返 %.0f tick（去 %.0f / 回 %.0f）"
              % (src["xy"], src["spawn_steps"], t["total"], t["out"], t["back"]))
    paths = [fig_body_heatmap(), fig_cargo_curve(), fig_room_trip()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
