# -*- coding: utf-8 -*-
"""基建折旧、维护与吞吐模型（container / road / rampart / wall / link / store / 衰减窗口）。

折旧精确公式（MECHANICS M12，来源 api-Structure*.txt §Decay）
------------------------------------------------------------
hits 换成能量的唯一换算是 **1 能量 = 100 hits**：
    REPAIR_POWER = 100 hit / (WORK·tick)，REPAIR_COST = 0.01 能量 / hit
    → 修 1 hit 花 REPAIR_COST 能量，补满 1 个结构的 hits 花 hits × 0.01

    d(container, 有主) = 5000 / 500  = 10  hit/tick   → 0.10 e/tick/个
    d(container, 无主) = 5000 / 100  = 50  hit/tick   → 0.50 e/tick/个
    d(rampart)         = 300  / 100  = 3   hit/tick   → 0.03 e/tick/段
    d(road, 平地)      = 100  / 1000 = 0.1 hit/tick   → 0.001 e/tick/段
    d(road, 沼泽)      = 500  / 1000 = 0.5 hit/tick   → 0.005 e/tick/段
    d(road, 墙上)      = 15000/ 1000 = 15  hit/tick   → 0.15  e/tick/段
    d(wall)            = 0（无自然折旧，只有被打才掉血）

交通折旧项（M12 原文："every creep step decreases the decay timer for 1 tick
per each creep body part"）
------------------------------------------------------------
一次踩踏让"折旧计时器"多走 n_部件 tick。设该格每 tick 平均被 Λ 个部件踩过，
则计时器每 tick 走 (1 + Λ) 格，掉一次 100 hit 的周期从 1000 缩成 1000/(1+Λ)：

    d(road) = (DECAY_AMOUNT / DECAY_TIME) · (1 + Λ)          [hit/tick]
    Λ       = 过格次数/tick × 单兵部件数                      [部件/tick]
    road 寿命 = hits / d(road) = ROAD_HITS / (0.1·(1+Λ))

link（M13，来源 api-StructureLink.txt §Cooldown time / §Energy loss）
------------------------------------------------------------
    一次最多送 LINK_CAPACITY = 800，目标实收 800 × (1 − 0.03) = 776
    冷却 = 与目标的直线距离 d（Chebyshev，max(|dx|,|dy|)）tick
    稳态吞吐 = 776 / d   [e/tick]

store（M14）
------------------------------------------------------------
通用 store（creep / container / storage / terminal）按总量算容量、可混装；
受限 store（spawn / extension / lab / nuker / tower）只收指定资源，
容量查询传不支持的资源返回 None。混装时总容量是硬约束。

衰减窗口（M15）
------------------------------------------------------------
    墓碑 = 5 × 死者部件数 tick（TOMBSTONE_DECAY_PER_PART）
    ruin = 500 tick（RUIN_DECAY）
    掉落物 = 1000 tick（ENERGY_DECAY / DROP_DECAY_TIME）
    掉在容器格上 → 当 tick 自动归仓，不进入衰减窗口

params.py 未收录、按官方文档补的量
------------------------------------------------------------
    ROAD_DECAY_WALL = 15000    墙上道路折旧（api-StructureRoad §Decay）
    ROAD_WALL_RATIO = 150      墙上道路的造价/hits 倍数（45,000 / 750,000）
    TRAFFIC_PARTS   = 3        一次踩踏的平均部件数（默认按 2C1M）
    LOAD_TICKS      = 2        装卸各 1 tick（与 logistics.throughput 的 +2 同源）
"""
from __future__ import annotations

import math

import numpy as np
from matplotlib.colors import TwoSlopeNorm

from mw import params as P
from mw import style as S
from .movement import trip_ticks

# ---------------------------------------------------------------- 补充常数
#: 墙上道路：15,000 hits / 1,000 tick（M12 / api-StructureRoad §Decay）
ROAD_DECAY_WALL = 15_000
#: 墙上道路的造价与 hits 都是平地的 150 倍（45,000 / 750,000）
ROAD_WALL_RATIO = 150
#: 一次踩踏的平均部件数（默认 2C1M = 3 部件）
TRAFFIC_PARTS = 3
#: 装卸各 1 tick
LOAD_TICKS = 2

#: 每能量可修的 hits（1 能量 = 100 hits）
HITS_PER_ENERGY = 1.0 / P.REPAIR_COST

#: 各结构的自然折旧率（hit/tick），不含交通项
ROAD_DECAY_RATE = {
    "plain": P.ROAD_DECAY_AMOUNT / P.ROAD_DECAY_TIME,
    "swamp": P.ROAD_DECAY_AMOUNT * P.CONSTRUCTION_COST_ROAD_SWAMP_RATIO / P.ROAD_DECAY_TIME,
    "wall": ROAD_DECAY_WALL / P.ROAD_DECAY_TIME,
}
#: 各结构的总 hits（决定"补满"要花多少能量、以及折旧寿命）
ROAD_HITS_TOTAL = {
    "plain": P.ROAD_HITS,
    "swamp": P.ROAD_HITS * P.CONSTRUCTION_COST_ROAD_SWAMP_RATIO,
    "wall": P.ROAD_HITS * ROAD_WALL_RATIO,
}
#: 通用 store 与受限 store（M14）
GENERAL_STORES = ("creep", "container", "storage", "terminal")
LIMITED_STORES = ("spawn", "extension", "lab", "nuker", "tower")


# ---------------------------------------------------------------- M12 折旧
def container_hits_per_tick(owned: bool = True) -> float:
    """container 自然折旧（hit/tick）。有主 5000/500，无主 5000/100。"""
    period = P.CONTAINER_DECAY_TIME_OWNED if owned else P.CONTAINER_DECAY_TIME
    return P.CONTAINER_DECAY / period


def rampart_hits_per_tick() -> float:
    """rampart 自然折旧（hit/tick）：300 / 100 tick = 3。"""
    return P.RAMPART_DECAY_AMOUNT / P.RAMPART_DECAY_TIME


def wall_hits_per_tick() -> float:
    """wall 无自然折旧（M12），只有被攻击才掉血。"""
    return 0.0


def road_hits_per_tick(terrain: str = "plain", traffic_parts: float = 0.0) -> float:
    """road 折旧（hit/tick），含交通项：d = 自然率 × (1 + Λ)。

    Λ = 每 tick 踩过该格的部件数。一辆 3 部件兵每 3 tick 过一次 → Λ = 1，
    折旧翻倍；每 tick 过一次 → Λ = 3，折旧 ×4。
    """
    return ROAD_DECAY_RATE[terrain] * (1.0 + max(0.0, traffic_parts))


def decay_hits_per_tick(kind: str, traffic_parts: float = 0.0) -> float:
    """按结构名取折旧率（hit/tick）。

    kind ∈ {container_owned, container_unowned, rampart,
            road_plain, road_swamp, road_wall, wall}
    """
    if kind == "container_owned":
        return container_hits_per_tick(True)
    if kind == "container_unowned":
        return container_hits_per_tick(False)
    if kind == "rampart":
        return rampart_hits_per_tick()
    if kind == "wall":
        return wall_hits_per_tick()
    if kind.startswith("road_"):
        return road_hits_per_tick(kind[len("road_"):], traffic_parts)
    raise ValueError("未知结构: %r" % (kind,))


def decay_energy_per_tick(kind: str, traffic_parts: float = 0.0) -> float:
    """单个结构每 tick 的维护能量（e/tick）＝ hit/tick × REPAIR_COST。"""
    return decay_hits_per_tick(kind, traffic_parts) * P.REPAIR_COST


def repair_energy(hits: float) -> float:
    """修 hits 点血要花的能量（1 能量 = 100 hits）。"""
    return hits * P.REPAIR_COST


def full_repair_energy(kind: str) -> float:
    """把整个结构从 0 补到满血的能量（hits × 0.01）。

    container 250,000 hits = 2,500；rampart RCL4 3M hits = 30,000；
    wall 300M hits = 3,000,000（这就是"墙不是免费的"）。
    """
    if kind == "container_owned" or kind == "container_unowned":
        return repair_energy(P.CONTAINER_HITS)
    if kind == "rampart":
        return repair_energy(P.RAMPART_HITS_MAX[4])
    if kind == "wall":
        return repair_energy(P.WALL_HITS_MAX)
    if kind.startswith("road_"):
        return repair_energy(ROAD_HITS_TOTAL[kind[len("road_"):]])
    raise ValueError("未知结构: %r" % (kind,))


def road_lifetime(terrain: str = "plain", traffic_parts: float = 0.0) -> float:
    """一段路从满血掉到 0 的 tick 数（含交通项）。"""
    rate = road_hits_per_tick(terrain, traffic_parts)
    return ROAD_HITS_TOTAL[terrain] / rate if rate > 0 else math.inf


def road_traffic_parts(passes: float, parts: int = TRAFFIC_PARTS) -> float:
    """过格次数/tick → 部件/tick（交通项 Λ）。"""
    return passes * parts


# ---------------------------------------------------------------- 预算
def budget(counts: dict, traffic_parts: float = 0.0) -> dict:
    """一组结构每 tick 的维护预算。

    counts 形如 {"container_owned": 3, "rampart": 100, "road_plain": 60,
                 "road_swamp": 10, "road_wall": 0, "wall": 50}
    返回 {"detail": {kind: e/tick}, "total": e/tick}
    """
    detail = {k: n * decay_energy_per_tick(k, traffic_parts)
              for k, n in counts.items() if n}
    return {"detail": detail, "total": sum(detail.values())}


def sustainable_structures(income: float, kind: str, traffic_parts: float = 0.0) -> float:
    """收入 income 最多养得起几个该结构（不亏损）。"""
    per = decay_energy_per_tick(kind, traffic_parts)
    return income / per if per > 0 else math.inf


# ---------------------------------------------------------------- M13 link
def link_send(distance: int) -> dict:
    """一次 link 传输：送出 800、实收 776、冷却 = 距离 tick。"""
    d = max(1, int(distance))
    received = P.LINK_CAPACITY * (1.0 - P.LINK_LOSS_RATIO)
    return {"sent": P.LINK_CAPACITY, "received": received, "cooldown": d,
            "throughput": received / d}


def link_throughput(distance) -> float:
    """link 稳态吞吐 776/d（e/tick）。"""
    return P.LINK_CAPACITY * (1.0 - P.LINK_LOSS_RATIO) / np.maximum(1, distance)


def link_cost_per_energy() -> float:
    """link 每送 1 能量的损耗成本（3%）。"""
    return P.LINK_LOSS_RATIO


def hauler_round_trip(distance: int, parts, terrain: str = "plain") -> float:
    """搬运兵往返 tick（含装卸）。"""
    return trip_ticks(parts, int(distance), terrain, round_trip=True)["total"] + LOAD_TICKS


def hauler_throughput(distance, parts, terrain: str = "plain") -> float:
    """单个搬运兵的吞吐（e/tick）。"""
    cap = P.CARRY_CAPACITY * parts.get("CARRY", 0)
    if cap <= 0:
        return 0.0
    return cap / hauler_round_trip(int(distance), parts, terrain)


def hauler_cost_per_energy(distance, parts, terrain: str = "plain") -> float:
    """搬运兵每送 1 能量的成本（孵化摊销，e/e）。

    送 F e/tick 需要 N = F / Thr 个兵，每个兵摊销 body_cost / CREEP_LIFE_TIME：
        成本率 = body_cost / (CREEP_LIFE_TIME · Thr)
    """
    thr = hauler_throughput(distance, parts, terrain)
    if thr <= 0:
        return math.inf
    return P.body_cost(parts) / (P.CREEP_LIFE_TIME * thr)


def link_breakeven_distance(parts, terrain: str = "plain",
                            max_d: int = 200) -> float:
    """link 运费（3%）与 hauler 运费相等处的距离（格，线性插值）。

    超过这个距离，hauler 的孵化摊销比 link 的 3% 损耗更便宜。
    """
    prev_d, prev = 1.0, hauler_cost_per_energy(1, parts, terrain) - link_cost_per_energy()
    for d in range(2, max_d + 1):
        cur = hauler_cost_per_energy(d, parts, terrain) - link_cost_per_energy()
        if prev <= 0 <= cur:
            return prev_d + (0 - prev) / (cur - prev)
        prev_d, prev = float(d), cur
    return math.inf


# ---------------------------------------------------------------- M14 store
def store_accepts(kind: str, resource: str = "energy") -> bool:
    """该 store 是否接受这个资源（M14）。

    通用 store 任何资源都收；受限 store 只收自己那几种（这里只建模能量，
    lab 另可存 2 种矿物、nuker 只存能量+G，属于细节，不展开）。
    """
    if kind in GENERAL_STORES:
        return True
    if kind in LIMITED_STORES:
        return resource == "energy"
    raise ValueError("未知 store: %r" % (kind,))


def store_free(kind: str, capacity: float, used: float, resource: str = "energy"):
    """剩余容量。通用 store 传不传 resource 结果相同；受限 store 不收则返回 None。"""
    if not store_accepts(kind, resource):
        return None
    return max(0.0, capacity - used)


# ---------------------------------------------------------------- M15 衰减窗口
def tombstone_lifetime(parts: int) -> float:
    """墓碑寿命 = 5 × 部件数（tick）。"""
    return parts * P.TOMBSTONE_DECAY_PER_PART


def decay_window(kind: str, parts: int = 0) -> float:
    """可回收窗口（tick）：tombstone / ruin / drop。"""
    if kind == "tombstone":
        return tombstone_lifetime(parts)
    if kind == "ruin":
        return P.RUIN_DECAY
    if kind == "drop":
        return P.ENERGY_DECAY
    raise ValueError("未知衰减物: %r" % (kind,))


def salvage_ratio(kind: str, parts: int, ticks_needed: float,
                  on_container: bool = False) -> float:
    """能不能在衰减窗口内取回。

    掉在容器格上 → 当 tick 自动归仓，比例 1.0（M15 "All dropped resources
    automatically goes to the container at the same tile"）。
    """
    if on_container:
        return 1.0
    return 1.0 if ticks_needed <= decay_window(kind, parts) else 0.0


# ---------------------------------------------------------------- 修路经济
def road_build_cost(terrain: str = "plain") -> float:
    """修一段路的能量（平地 300 / 沼泽 1500 / 墙上 45,000）。"""
    base = P.CONSTRUCTION_COST["road"]
    if terrain == "swamp":
        return base * P.CONSTRUCTION_COST_ROAD_SWAMP_RATIO
    if terrain == "wall":
        return base * ROAD_WALL_RATIO
    return float(base)


def road_gain_per_tile(traffic: float, distance: int, parts) -> float:
    """修路让"同一批搬运兵"多搬的能量，摊到每格（e/tick/格）。

    交通量 q（过格次数/tick）反推兵数 N = q·T_road/2，于是
        ΔF = N·C·(1/T_road − 1/T_no) = q·C/2 · (T_no − T_road)/T_no
        每格收益 = ΔF / L

    T_no、T_road 用 movement.trip_ticks 的往返时间（含装卸 2 tick）。
    """
    cap = P.CARRY_CAPACITY * parts.get("CARRY", 0)
    if cap <= 0 or distance <= 0:
        return 0.0
    t_no = hauler_round_trip(distance, parts, "plain")
    t_road = hauler_round_trip(distance, parts, "road")
    return traffic * cap * (t_no - t_road) / (2.0 * t_no * distance)


def road_payback_ticks(traffic: float, distance: int, parts=None,
                       terrain: str = "plain") -> float:
    """修一段路的回本 tick = 造价 / 每 tick 净收益（收益 − 维护）。

    净收益 ≤ 0 → 永远回不了本，返回 inf。
    """
    parts = parts if parts is not None else P.parse_body("2C1M")
    gain = road_gain_per_tile(traffic, distance, parts)
    maint = decay_energy_per_tick("road_" + terrain,
                                  road_traffic_parts(traffic, P.body_size(parts)))
    net = gain - maint
    return road_build_cost(terrain) / net if net > 0 else math.inf


def breakeven_traffic(distance: int, parts=None, terrain: str = "plain") -> float:
    """路在"自己寿命内回本"所需的最低交通量（过格次数/tick）。

    解 造价 / 净收益 = 路寿命：
        造价·d(hits/tick) / 净收益 = hits_total
    """
    parts = parts if parts is not None else P.parse_body("2C1M")
    build = road_build_cost(terrain)
    hits = ROAD_HITS_TOTAL[terrain]
    b = P.body_size(parts)
    lo, hi = 0.0, 10.0
    for _ in range(200):
        mid = (lo + hi) / 2
        net = road_gain_per_tile(mid, distance, parts) - \
            decay_energy_per_tick("road_" + terrain, road_traffic_parts(mid, b))
        if net <= 0:
            lo = mid
            continue
        payback = build / net
        life = hits / road_hits_per_tick(terrain, road_traffic_parts(mid, b))
        if payback > life:
            lo = mid
        else:
            hi = mid
    return hi


# ---------------------------------------------------------------- 图表
def fig_upkeep_budget():
    """fig83：结构数量 → 维护 e/tick，以及交通项开关对比。"""
    fig, axes = S.plt.subplots(1, 2, figsize=(12.6, 4.5),
                               gridspec_kw={"width_ratios": [1.15, 1.0]})
    fig.patch.set_facecolor(S.BG)

    # ---- 左：数量 → e/tick（对数轴，含交通开关）
    ax = axes[0]
    S.tidy(ax)
    ns = np.arange(1, 302)
    traffic_parts = road_traffic_parts(0.1, TRAFFIC_PARTS)   # 每 10 tick 过一次
    series = [
        ("container（有主）0.10/个", lambda n: n * decay_energy_per_tick("container_owned")),
        ("container（无主）0.50/个", lambda n: n * decay_energy_per_tick("container_unowned")),
        ("rampart 0.03/段", lambda n: n * decay_energy_per_tick("rampart")),
        ("road 平地（无交通）0.001/段", lambda n: n * decay_energy_per_tick("road_plain")),
        ("road 平地（交通 Λ=%.1f）" % traffic_parts,
         lambda n: n * decay_energy_per_tick("road_plain", traffic_parts)),
        ("road 墙上 0.15/段", lambda n: n * decay_energy_per_tick("road_wall")),
    ]
    for i, (label, f) in enumerate(series):
        ax.plot(ns, [f(float(n)) for n in ns], color=S.SEQ[i], label=label)
    ax.set_yscale("log")
    ax.set_ylim(8e-4, 4e3)
    ax.set_xlabel("结构数量（个 / 段）")
    ax.set_ylabel("维护能量（e/tick，对数轴）")
    ax.set_title("单位折旧成本差 3 个数量级：墙上的路比 rampart 还贵")
    ax.legend(fontsize=7, loc="upper left", ncol=1)
    ax.annotate("wall 无自然折旧 = 0", (150, 1.4e-3), fontsize=7.5,
                color=S.MORANDI["stone"], ha="left")

    # ---- 右：路网段数 × 交通量 → road 维护，与 rampart 基准/收入线对比
    ax2 = axes[1]
    S.tidy(ax2)
    ns2 = np.arange(0, 801, 5)
    for i, passes in enumerate([0.0, 0.3, 1.0, 3.0]):
        lam = road_traffic_parts(passes, TRAFFIC_PARTS)
        ys = [n * decay_energy_per_tick("road_plain", lam) for n in ns2]
        ax2.plot(ns2, ys, color=S.SEQ[i], label="交通 %.1f 次/tick（Λ=%.1f）" % (passes, lam))
    rampart_base = 100 * decay_energy_per_tick("rampart")
    S.hline(ax2, rampart_base, color_=S.MORANDI["slate"])
    ax2.annotate("100 段 rampart = %.2f e/tick" % rampart_base, (10, rampart_base),
                 xytext=(0, 4), textcoords="offset points", fontsize=7.5,
                 color=S.MORANDI["slate"])
    income = P.ROOM["measured_income"]
    S.hline(ax2, income, color_=S.MORANDI["stone"])
    ax2.annotate("房间实测收入 %.2f e/tick" % income, (10, income),
                 xytext=(0, -11), textcoords="offset points", fontsize=7.5,
                 color=S.MORANDI["stone"])
    ax2.set_xlabel("road 段数（平地）")
    ax2.set_ylabel("road 维护能量（e/tick）")
    ax2.set_title("交通项把折旧放大 (1+Λ) 倍：800 段高流量路 = %.1f e/tick"
                  % (800 * decay_energy_per_tick("road_plain",
                                                 road_traffic_parts(3.0, TRAFFIC_PARTS))))
    ax2.legend(fontsize=7.5, loc="upper left")
    ax2.set_ylim(0, 8.5)
    return S.save(fig, "fig83_upkeep_budget",
                  "e/tick = hit/tick × REPAIR_COST(0.01)；1 能量 = 100 hits")


def fig_road_payback():
    """fig84：交通量 × 距离 → 修路回本 tick（对数轴），标出亏损区。"""
    parts = P.parse_body("2C1M")
    qs = np.logspace(-4, 0, 61)
    ds = np.arange(2, 41)
    grid = np.zeros((len(ds), len(qs)))
    for i, d in enumerate(ds):
        for j, q in enumerate(qs):
            pb = road_payback_ticks(float(q), int(d), parts)
            life = road_lifetime("plain", road_traffic_parts(float(q), P.body_size(parts)))
            grid[i, j] = pb / life if np.isfinite(pb) else 1e2

    fig, ax = S.figure(8.8, 4.8)
    logz = np.log10(np.clip(grid, 1e-2, 1e2))
    norm = TwoSlopeNorm(vcenter=0.0, vmin=-2, vmax=2)
    mesh = ax.contourf(qs, ds, logz, levels=np.linspace(-2, 2, 41),
                       cmap=S.CMAP_DIV.reversed(), norm=norm)
    ax.set_xscale("log")
    cs = ax.contour(qs, ds, logz, levels=[0.0], colors=[S.MORANDI["slate"]],
                    linewidths=1.4)
    ax.clabel(cs, fmt={0.0: "回本 = 路寿命"}, fontsize=8, colors=S.MORANDI["slate"])
    pb_levels = [1500.0, 20000.0]
    pb_grid = np.zeros_like(grid)
    for i, d in enumerate(ds):
        for j, q in enumerate(qs):
            pb_grid[i, j] = road_payback_ticks(float(q), int(d), parts)
    cs2 = ax.contour(qs, ds, np.clip(pb_grid, 0, 1e9), levels=pb_levels,
                     colors=[S.MORANDI["stone"]], linewidths=0.9,
                     linestyles="dashed")
    ax.clabel(cs2, fmt={1500.0: "回本 1500 tick（一代兵）", 20000.0: "回本 2 万 tick"},
              fontsize=7.5, colors=S.MORANDI["stone"])
    ax.annotate("亏损区：回本期长过路本身的寿命", (1.2e-4, 36), fontsize=8.5,
                color=S.MORANDI["cream"], ha="left")
    for y, nm in [(24, "source A 24 步"), (6, "source B 6 步")]:
        ax.axhline(y, color=S.MUTED, linewidth=0.9, linestyle=":")
        ax.annotate(nm, (1.05e0, y), xytext=(2, 3), textcoords="offset points",
                    fontsize=7.5, color=S.MUTED, ha="right")
    cb = fig.colorbar(mesh, ax=ax, fraction=0.046, pad=0.03)
    cb.set_label("log10(回本 tick ÷ 路寿命)", fontsize=8)
    cb.outline.set_visible(False)
    ax.grid(False)
    ax.set_xlabel("交通量（过格次数 / tick）")
    ax.set_ylabel("单程距离（格）")
    ax.set_title("修路回本：交通量越低、路越长，越容易修成一条吃能量的死路")
    return S.save(fig, "fig84_road_payback",
                  "绿 = 寿命内回本，玫 = 回本期超过寿命")


def fig_link_vs_hauler():
    """fig85：距离 → link 吞吐 776/d 与 2C1M hauler 吞吐，以及运费交叉点。"""
    parts = P.parse_body("2C1M")
    ds = np.arange(1, 31)
    fig, axes = S.plt.subplots(1, 2, figsize=(12.4, 4.4))
    fig.patch.set_facecolor(S.BG)

    # ---- 左：吞吐
    ax = axes[0]
    S.tidy(ax)
    ax.plot(ds, link_throughput(ds), color=S.SEQ[0], label="link 776/d")
    ax.plot(ds, [hauler_throughput(int(d), parts, "road") for d in ds],
            color=S.SEQ[2], label="2C1M hauler（有路）", linestyle=(0, (5, 2)))
    ax.plot(ds, [hauler_throughput(int(d), parts, "plain") for d in ds],
            color=S.SEQ[1], label="2C1M hauler（无路）", linestyle=(0, (1, 2)))
    ax.set_yscale("log")
    ax.set_xlabel("单程距离（格）")
    ax.set_ylabel("吞吐（e/tick，对数轴）")
    ax.set_title("吞吐维度没有交叉点：link 在任何距离都是 hauler 的 20 倍以上")
    ratio = link_throughput(24) / hauler_throughput(24, parts, "plain")
    ax.annotate("d=24：%.1f vs %.2f e/tick（×%.0f）"
                % (link_throughput(24), hauler_throughput(24, parts, "plain"), ratio),
                (24, link_throughput(24)), textcoords="offset points",
                xytext=(-8, -16), fontsize=8, color=S.SEQ[0], ha="right")
    ax.legend(fontsize=8, loc="upper right")

    # ---- 右：每送 1 能量的成本
    ax2 = axes[1]
    S.tidy(ax2)
    ax2.axhline(link_cost_per_energy(), color=S.SEQ[0], label="link 损耗 3%/次")
    ax2.plot(ds, [hauler_cost_per_energy(int(d), parts, "road") for d in ds],
             color=S.SEQ[2], label="hauler 孵化摊销（有路）", linestyle=(0, (5, 2)))
    ax2.plot(ds, [hauler_cost_per_energy(int(d), parts, "plain") for d in ds],
             color=S.SEQ[1], label="hauler 孵化摊销（无路）")
    d_plain = link_breakeven_distance(parts, "plain")
    d_road = link_breakeven_distance(parts, "road")
    for x, lab, col in [(d_plain, "d*≈%.1f 格（无路）" % d_plain, S.SEQ[1]),
                        (d_road, "d*≈%.1f 格（有路）" % d_road, S.SEQ[2])]:
        ax2.axvline(x, color=col, linewidth=1.1, linestyle=(0, (4, 3)))
        ax2.annotate(lab, (x, 0.075), xytext=(4, 0), textcoords="offset points",
                     fontsize=8, color=col, rotation=90, va="top")
    ax2.set_xlabel("单程距离（格）")
    ax2.set_ylabel("每送 1 能量的成本（e/e）")
    ax2.set_title("真正的交叉点在运费：%.1f 格内 link 更便宜，再远该用 hauler"
                  % d_plain)
    ax2.legend(fontsize=8, loc="upper left")
    return S.save(fig, "fig85_link_vs_hauler",
                  "link = 3% 损耗；hauler = body_cost/(1500·吞吐)，未计建造费")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 基建维护模型 ==")
    for kind, cn in [("container_owned", "container 有主"), ("container_unowned", "container 无主"),
                     ("rampart", "rampart"), ("road_plain", "road 平地"),
                     ("road_swamp", "road 沼泽"), ("road_wall", "road 墙上"),
                     ("wall", "wall")]:
        print("  %-16s %6.2f hit/tick → %.3f e/tick/个（满血补满 %.0f e）"
              % (cn, decay_hits_per_tick(kind), decay_energy_per_tick(kind),
                 full_repair_energy(kind)))

    lam = road_traffic_parts(1.0, TRAFFIC_PARTS)
    print("  交通项：每 tick 过一格 1 次（3 部件）→ Λ=%.1f，road 折旧 ×%.1f，"
          "寿命 %.0f tick" % (lam, 1 + lam, road_lifetime("plain", lam)))

    counts = {"container_owned": 3, "rampart": 100, "road_plain": 60,
              "road_swamp": 10, "road_wall": 0, "wall": 50}
    for tag, tp in [("无交通", 0.0), ("交通 0.3 部件/tick", 0.3)]:
        b = budget(counts, tp)
        print("  参考配置（%s）：%.2f e/tick %s" % (
            tag, b["total"], {k: round(v, 3) for k, v in b["detail"].items()}))
    print("  房间实测收入 %.2f e/tick → 最多养 %d 段 rampart"
          % (P.ROOM["measured_income"],
             sustainable_structures(P.ROOM["measured_income"], "rampart")))

    parts = P.parse_body("2C1M")
    for d in (6, 12, 24, 40):
        print("  修路回本门槛：%2d 格 → 交通量 ≥ %.4f 次/tick（约每 %.0f tick 过一次）"
              % (d, breakeven_traffic(d, parts), 1 / max(breakeven_traffic(d, parts), 1e-9)))
    for passes in (0.0, 0.5, 2.0):
        print("  路寿命：交通 %.1f 次/tick → %.0f tick"
              % (passes, road_lifetime("plain", road_traffic_parts(passes, TRAFFIC_PARTS))))
    print("  link：d=6 → %.1f e/tick，d=24 → %.1f e/tick（776/d）"
          % (link_throughput(6), link_throughput(24)))
    print("  2C1M hauler：d=24 无路 %.2f / 有路 %.2f e/tick"
          % (hauler_throughput(24, parts, "plain"), hauler_throughput(24, parts, "road")))
    print("  link 运费 3%% vs hauler：交叉点 无路 d*≈%.1f 格 / 有路 d*≈%.1f 格"
          % (link_breakeven_distance(parts, "plain"), link_breakeven_distance(parts, "road")))
    print("  衰减窗口：3 部件兵墓碑 %.0f tick；ruin %.0f；掉落物 %.0f"
          % (tombstone_lifetime(3), decay_window("ruin"), decay_window("drop")))

    paths = [fig_upkeep_budget(), fig_road_payback(), fig_link_vs_hauler()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
