# -*- coding: utf-8 -*-
"""市场与后期系统模型：跨房运费、矿物再生、lab 反应链与 boost、后期里程碑。

公式一律取自 MECHANICS.md（官方文档摘录 + 偏差审计），不凭记忆。

M17 市场：运费、手续费、付费方
------------------------------
跨房运费（单位：能量）  M17 官方原文
                      Math.ceil( amount * (1 - Math.exp(-distanceBetweenRooms/30)) )
    此处  C(a, d) = ceil( a · (1 − e^(−d/30)) )，d 为两房 Chebyshev 距离。
    **能量成本随距离指数趋近于 a（100%），随交易量线性增长**（只有 ceil 的量化误差，
    所以小额交易的单位成本更高）。

单位运费占比          rho(a, d) = C(a, d) / a                    [能量 / 单位]
挂单手续费            fee = MARKET_FEE = 5%，一次性，与成交量无关（M17）
terminal             容量 TERMINAL_CAPACITY = 300,000；最小发送 100 单位；每 tick ≤ 10 笔
付费方               **运费与 terminal 冷却由执行成交的一方承担**（M17）

把手续费（credits）与运费（能量）折到同一口径，才能回答"本地卖 vs 跨房卖"：
    成交额折币   = p                        [credits / 单位]
    运费折币     = rho(a, d) · CREDITS_PER_ENERGY
    手续费折币   = fee · p
跨房卖相对本地卖的**盈亏平衡溢价率**（跨房价必须比本地价高多少才不亏）：
    r*(d) = rho(d) · CREDITS_PER_ENERGY / ((1 − fee) · p)
反解，给定溢价 r 的**盈亏平衡距离**：
    d*(r) = −MARKET_DISTANCE_SCALE · ln( 1 − (1 − fee) · p · r / CREDITS_PER_ENERGY )
另有一个口径无关的参照点"运费折币 = 手续费"：
    d_fee(p) = −30 · ln( 1 − fee · p / CREDITS_PER_ENERGY )

M18 矿物与 boost
----------------
长期可采速率          v = min( 矿藏量 / MINERAL_REGEN_TIME,
                              n_WORK · HARVEST_MINERAL_POWER / EXTRACTOR_COOLDOWN )
                      即"再生上限"与"提取器产能上限"取小。（提取器冷却语义按"同一提取器
                      相邻两次 harvest 至少隔 EXTRACTOR_COOLDOWN tick"理解。）
boost 成本            每部件 LAB_BOOST_MINERAL(30) 单位矿物 + LAB_BOOST_ENERGY(20) 能量
产能乘数              harvest 最高 ×7、upgrade ×1.8（M18 给出的上限，不减能量成本）
lab 反应（M19）       每级：2 种原料各 LAB_REACTION_AMOUNT(5) 单位 → 5 单位产物，
                      另耗 LAB_REACTION_ENERGY(10) 能量
                      链深 n 的每 5 单位成品 = 5(n+1) 单位基础矿物 + 10n 能量

M19 后期里程碑
--------------
lab     RCL6 起 3 个，CONSTRUCTION_COST["lab"] = 50,000 能量/个
nuker   RCL8，CONSTRUCTION_COST["nuker"] = 100,000 能量，NUKER_COOLDOWN = 100,000 tick
observer CONSTRUCTION_COST["observer"] = 8,000 能量，OBSERVER_RANGE = 10 格
powerSpawn CONSTRUCTION_COST["powerSpawn"] = 100,000 能量，
           1 power + POWER_SPAWN_ENERGY_RATIO(50) 能量 → 1 GPL 进度

默认参数（params.py 未收录，按 MECHANICS / 官方文档给值，调用方可覆盖）
--------------------------------------------------------------------
MARKET_DISTANCE_SCALE = 30      api.txt calcTransactionCost 公式里的指数尺度
TERMINAL_MIN_SEND = 100         market.txt 最小发送量
MAX_DEALS_PER_TICK = 10         market.txt 每 tick 成交上限
MINERAL_DEPOSIT_DEFAULT = 35000 矿藏单位数（params 只有再生周期；本房实测 57,445.9）
HARVEST_MINERAL_POWER = 1       api.txt HARVEST_MINERAL_POWER
LAB_BOOST_MINERAL / LAB_BOOST_ENERGY = 30 / 20   M18
LAB_REACTION_ENERGY = 10        lab 每次反应的能量消耗（params 未收录）
HARVEST_BOOST_MAX / UPGRADE_BOOST_MAX = 7.0 / 1.8    M18
CREDITS_PER_ENERGY = 0.05       1 能量 ≈ 0.05 credit（能量市价口径，纯假设，可改）
MINERAL_PRICE_CREDITS = 0.5     被测矿物的成交价（纯假设，可改）
MINERAL_VALUE_ENERGY = 4.0      1 单位矿物折合多少能量（用于 fig87 的换算，纯假设）
"""
from __future__ import annotations

import math
import re

import numpy as np

from mw import params as P
from mw import style as S

# ---------------------------------------------------------------- 默认参数
MARKET_DISTANCE_SCALE = 30.0
TERMINAL_MIN_SEND = 100
MAX_DEALS_PER_TICK = 10

MINERAL_DEPOSIT_DEFAULT = 35_000.0
HARVEST_MINERAL_POWER = 1

LAB_BOOST_MINERAL = 30
LAB_BOOST_ENERGY = 20
LAB_REACTION_ENERGY = 10

HARVEST_BOOST_MAX = 7.0
UPGRADE_BOOST_MAX = 1.8

CREDITS_PER_ENERGY = 0.05
MINERAL_PRICE_CREDITS = 0.5
MINERAL_VALUE_ENERGY = 4.0

#: 用来扫图的网格（都不参与建模，只是坐标轴范围）
DIST_MIN, DIST_MAX = 1.0, 40.0
TRANSPORT_AMOUNTS = [100, 1_000, 10_000, 100_000]
PRICE_LEVELS = [(0.05, "能量本身 p=0.05"), (0.5, "高价矿物 p=0.50")]
REGEN_MIN, REGEN_MAX = 20_000.0, 100_000.0
PRICE_GRID_MAX = 60.0
CHAIN_DEPTHS = [1, 2, 3]


# ---------------------------------------------------------------- 市场
def parse_room_name(name: str) -> tuple[int, int]:
    """'W7N2' → (-7, 2)；'E5S3' → (5, -3)。"""
    m = re.fullmatch(r"([WE])(\d+)([NS])(\d+)", name.strip().upper())
    if not m:
        raise ValueError("无法解析房间名: %r" % name)
    ew, ns, x, y = m.group(1), m.group(3), int(m.group(2)), int(m.group(4))
    return (-x if ew == "W" else x, -y if ns == "S" else y)


def room_distance(a: str, b: str) -> int:
    """两房 Chebyshev 距离（M17：运费公式里的 distanceBetweenRooms）。"""
    ax, ay = parse_room_name(a)
    bx, by = parse_room_name(b)
    return max(abs(ax - bx), abs(ay - by))


def transaction_cost(amount: float, distance: float) -> int:
    """M17：跨房成交要付的运费（能量）。官方示例 1000 单位 10 格 = 284。"""
    if amount <= 0 or distance <= 0:
        return 0
    share = 1.0 - math.exp(-distance / MARKET_DISTANCE_SCALE)
    return math.ceil(round(amount * share, 9))


def cost_ratio(amount: float, distance: float) -> float:
    """单位运费占比（能量 / 单位）。"""
    return transaction_cost(amount, distance) / amount


def transport_share_continuous(distance: float) -> float:
    """忽略 ceil 的连续版占比，用于反解距离。"""
    return 1.0 - math.exp(-distance / MARKET_DISTANCE_SCALE)


def cost_share(amount: float, distance: float,
               price: float = MINERAL_PRICE_CREDITS) -> float:
    """运费占成交额的比例（与手续费同口径：都折 credits）。"""
    return cost_ratio(amount, distance) * CREDITS_PER_ENERGY / price


def fee_equivalent_distance(price: float = MINERAL_PRICE_CREDITS) -> float:
    """运费折币正好等于 5% 手续费的距离（离得比它远，运费就比手续费更贵）。"""
    f_star = P.MARKET_FEE * price / CREDITS_PER_ENERGY
    if f_star >= 1.0:
        return math.inf
    return -MARKET_DISTANCE_SCALE * math.log(1.0 - f_star)


def breakeven_distance(price: float = MINERAL_PRICE_CREDITS,
                       premium: float = P.MARKET_FEE) -> float:
    """给定跨房价相对本地价的溢价 premium，跨房卖与本地卖打平的距离。

    跨房净收 = (1−fee)·p·(1+premium) − rho·CREDITS_PER_ENERGY
    本地净收 = (1−fee)·p
    令两者相等即得 rho* = (1−fee)·p·premium / CREDITS_PER_ENERGY。
    premium=0 时 d*=0（同样价格下跨房恒亏，亏的正是运费）。
    """
    f_star = (1.0 - P.MARKET_FEE) * price * premium / CREDITS_PER_ENERGY
    if f_star >= 1.0:
        return math.inf
    if f_star <= 0.0:
        return 0.0
    return -MARKET_DISTANCE_SCALE * math.log(1.0 - f_star)


def breakeven_premium(distance: float,
                      price: float = MINERAL_PRICE_CREDITS) -> float:
    """给定距离，跨房价至少要比本地价高多少（比例）才值得付这笔运费。"""
    return (transport_share_continuous(distance) * CREDITS_PER_ENERGY
            / ((1.0 - P.MARKET_FEE) * price))


def deals_per_tick(amount: float, capacity: int = P.TERMINAL_CAPACITY) -> float:
    """跑完 terminal 容量要几 tick（受每 tick 10 笔、terminal 容量 30 万双重限制）。"""
    return max(math.ceil(capacity / amount), math.ceil(capacity / (amount * MAX_DEALS_PER_TICK)))


# ---------------------------------------------------------------- 矿物
def mineral_rate(deposit: float, regen: float = P.MINERAL_REGEN_TIME) -> float:
    """再生上限决定的长期可采速率（单位 / tick）。M18：矿物 50,000 tick 再生。"""
    return deposit / regen


def extractor_rate(n_work: int) -> float:
    """提取器产能上限（单位 / tick）：一个动作产 n_WORK 单位，之后冷却 5 tick。"""
    return n_work * HARVEST_MINERAL_POWER / P.EXTRACTOR_COOLDOWN


def sustainable_rate(n_work: int, deposit: float = MINERAL_DEPOSIT_DEFAULT,
                     regen: float = P.MINERAL_REGEN_TIME) -> float:
    """长期可持续速率 = min(再生上限, 提取器产能上限)。"""
    return min(mineral_rate(deposit, regen), extractor_rate(n_work))


def energy_income_per_tick() -> float:
    """本房 source 的长期能量收入（e/tick）= Σ 容量/再生周期。"""
    return sum(s["capacity"] / s["regen"] for s in P.ROOM["sources"])


# ---------------------------------------------------------------- lab / boost
def lab_chain_cost(depth: int = 3,
                   mineral_value_energy: float = MINERAL_VALUE_ENERGY) -> dict:
    """一条 depth 级 lab 反应链，每产出 LAB_REACTION_AMOUNT(5) 单位成品的累计投入。

    每级：5 单位 A + 5 单位 B → 5 单位产物（LAB_REACTION_AMOUNT），因此链深 n 需要
    5(n+1) 单位基础矿物与 10n 能量（LAB_REACTION_ENERGY）。
    """
    base_units = P.LAB_REACTION_AMOUNT * (depth + 1)
    reactions = depth
    reaction_energy = reactions * LAB_REACTION_ENERGY
    mineral_energy = base_units * mineral_value_energy
    total = mineral_energy + reaction_energy
    return {
        "depth": depth,
        "base_units": base_units,
        "reactions": reactions,
        "mineral_energy": mineral_energy,
        "reaction_energy": reaction_energy,
        "total_energy": total,
        "per_unit_energy": total / P.LAB_REACTION_AMOUNT,
    }


def boost_unit_cost(depth: int = 3,
                    mineral_price: float = MINERAL_VALUE_ENERGY) -> float:
    """1 单位 boost 化合物折合多少能量（含整条链的 2:1 质量损耗）。"""
    return lab_chain_cost(depth, mineral_price)["per_unit_energy"]


def boost_part_cost(depth: int = 3,
                    mineral_price: float = MINERAL_VALUE_ENERGY) -> float:
    """boost 一个部件要多少能量（LAB_BOOST_MINERAL 单位矿物 + LAB_BOOST_ENERGY）。"""
    return LAB_BOOST_MINERAL * boost_unit_cost(depth, mineral_price) + LAB_BOOST_ENERGY


def upgrade_boost_gain(source_rate: float = 10.0, depth: int = 3,
                       mineral_price: float = MINERAL_VALUE_ENERGY,
                       multiplier: float = UPGRADE_BOOST_MAX) -> dict:
    """一个打了 boost 的 WORK 部件，在一条命里多升多少 progress（1 progress = 1 能量）。"""
    extra = (multiplier - 1.0) * P.UPGRADE_CONTROLLER_POWER * P.CREEP_LIFE_TIME
    cost = boost_part_cost(depth, mineral_price)
    return {"extra_energy": extra, "cost_energy": cost, "net_energy": extra - cost,
            "multiplier": multiplier}


def harvest_boost_gain(source_rate: float = 10.0, depth: int = 3,
                       mineral_price: float = MINERAL_VALUE_ENERGY,
                       multiplier: float = HARVEST_BOOST_MAX) -> dict:
    """采集 boost 的收益。

    关键：source 的产出速率是**封顶**的（容量/再生周期），boost 采得快不会让房间多产
    能量，只是让"吃满这个 source"所需 WORK 部件变少 → 收益 = 省下的 body 造价。
    """
    per_work = P.HARVEST_POWER
    need_plain = math.ceil(source_rate / per_work)
    need_boost = math.ceil(source_rate / (per_work * multiplier))
    saved_parts = need_plain - need_boost
    saved_energy = saved_parts * P.BODYPART_COST["WORK"]
    cost = boost_part_cost(depth, mineral_price)
    nominal = (multiplier - 1.0) * per_work * P.CREEP_LIFE_TIME
    return {"need_plain": need_plain, "need_boosted": need_boost,
            "saved_parts": saved_parts, "extra_energy": saved_energy,
            "cost_energy": cost, "net_energy": saved_energy - cost,
            "nominal_energy": nominal, "multiplier": multiplier}


def late_game_requirements() -> list[tuple[str, str]]:
    """M19 的后期门槛（文本行，供 main() 打印）。"""
    tps = P.SERVER["tick_per_second"]
    income = energy_income_per_tick()
    rows = []
    lab_n = 3
    rows.append(("lab ×%d（RCL6）" % lab_n,
                 "%s 能量（≈ %s tick 收入）" % (
                     _num(lab_n * P.CONSTRUCTION_COST["lab"]),
                     _num(lab_n * P.CONSTRUCTION_COST["lab"] / income))))
    rows.append(("nuker（RCL8）",
                 "%s 能量，冷却 %s tick（≈ %.1f 小时）" % (
                     _num(P.CONSTRUCTION_COST["nuker"]), _num(P.NUKER_COOLDOWN),
                     P.NUKER_COOLDOWN / tps / 3600.0)))
    rows.append(("observer",
                 "%s 能量，视野 %d 格" % (_num(P.CONSTRUCTION_COST["observer"]),
                                       P.OBSERVER_RANGE)))
    rows.append(("powerSpawn（RCL8）",
                 "%s 能量，1 GPL = 1 power + %d 能量" % (
                     _num(P.CONSTRUCTION_COST["powerSpawn"]),
                     P.POWER_SPAWN_ENERGY_RATIO)))
    return rows


# ---------------------------------------------------------------- 小工具
def _num(x: float, nd: int = 0) -> str:
    """千分位数字。"""
    return ("{:,." + str(nd) + "f}").format(x)


# ---------------------------------------------------------------- 图表
def fig86_market_transport() -> str:
    """fig86：距离 × 交易量 → 运费占成交额比例（标 5% 手续费线）；右侧为盈亏平衡溢价。"""
    dists = np.linspace(DIST_MIN, DIST_MAX, 400)
    fee_pct = P.MARKET_FEE * 100.0

    fig, axes = S.plt.subplots(1, 2, figsize=(12.6, 4.4))
    fig.patch.set_facecolor(S.BG)

    # ---- 左：运费占成交额
    ax = axes[0]
    S.tidy(ax)
    ymax = 0.0
    for i, amount in enumerate(TRANSPORT_AMOUNTS):
        ys = np.array([cost_share(amount, d) * 100.0 for d in dists])
        ymax = max(ymax, float(ys.max()))
        ax.plot(dists, ys, color=S.SEQ[i], label="单笔 %s 单位" % _num(amount))
    ax.set_xlim(DIST_MIN, DIST_MAX)
    ax.set_ylim(0.0, ymax * 1.25)
    ax.set_xlabel("两房 Chebyshev 距离（格）")
    ax.set_ylabel("运费 / 成交额（%）")
    ax.set_title("跨房运费吃掉多少成交额（单价 %.2f credit/单位）" % MINERAL_PRICE_CREDITS)

    d_fee = fee_equivalent_distance(MINERAL_PRICE_CREDITS)
    ax.axvline(d_fee, color=S.MORANDI["stone"], linewidth=1.2, linestyle=(0, (4, 3)))
    ax.annotate("运费 = 手续费\n%.1f 格" % d_fee, (d_fee, ymax * 0.72),
                xytext=(-6, 0), textcoords="offset points", ha="right",
                fontsize=8, color=S.MUTED)
    S.hline(ax, fee_pct, "5% 手续费线")
    ax.annotate("运费与成交量严格成正比：\n四条曲线只在低量区差 ≤1%（ceil 台阶）",
                (DIST_MIN, ymax * 1.16), xytext=(6, 0), textcoords="offset points",
                fontsize=8, color=S.MUTED, va="top")
    ax.legend(loc="lower right", title="单笔批量", title_fontsize=8)

    # ---- 右：盈亏平衡溢价
    ax2 = axes[1]
    S.tidy(ax2)
    for i, (price, label) in enumerate(PRICE_LEVELS):
        ys = np.array([breakeven_premium(d, price) * 100.0 for d in dists])
        ax2.plot(dists, ys, color=S.SEQ[i], label=label)
    server_max = P.SERVER["world_size"] - 1
    ax2.set_xlim(DIST_MIN, DIST_MAX)
    ax2.set_ylim(0.0, 45.0)
    ax2.set_xlabel("两房 Chebyshev 距离（格）")
    ax2.set_ylabel("跨房价至少要比本地价高（%）")
    ax2.set_title("跨房卖的盈亏平衡溢价")
    ax2.axvline(server_max, color=S.MORANDI["clay"], linewidth=1.4)
    for i, (price, _label) in enumerate(PRICE_LEVELS):
        pm = breakeven_premium(server_max, price) * 100.0
        ax2.annotate("本服最远 %d 格\n需 %.1f%%" % (server_max, pm),
                     (server_max, pm), xytext=(24.0, 32.0 - 16.0 * i),
                     textcoords="data", ha="left", fontsize=8, color=S.SEQ[i],
                     arrowprops=dict(arrowstyle="-", color=S.SEQ[i], linewidth=1.0,
                                     shrinkA=2, shrinkB=2))
    ax2.legend(loc="upper left")

    fig.suptitle("市场：运费随距离指数上升、随批量线性摊薄；手续费是固定的 5%",
                 fontsize=12, color=S.TEXT, y=1.02)
    return S.save(fig, "fig86_market_transport",
                  "C = ceil(a·(1−e^(−d/30)))，运费由成交执行方承担")


def fig87_mineral_income() -> str:
    """fig87：矿物再生周期 → 长期可采速率，以及与 energy 收入的量级对比。"""
    regens = np.linspace(REGEN_MIN, REGEN_MAX, 300)
    deposits = [(MINERAL_DEPOSIT_DEFAULT, "默认矿藏 35,000 单位"),
                (P.ROOM["mineral"]["amount"],
                 "本房 H 矿 %s 单位" % _num(P.ROOM["mineral"]["amount"]))]

    fig, axes = S.plt.subplots(1, 2, figsize=(12.6, 4.4),
                               gridspec_kw={"width_ratios": [1.7, 1.0]})
    fig.patch.set_facecolor(S.BG)

    # ---- 左：速率 vs 再生周期
    ax = axes[0]
    S.tidy(ax)
    for i, (deposit, label) in enumerate(deposits):
        ax.plot(regens, deposit / regens, color=S.SEQ[i], label=label)
    ax.set_xlim(REGEN_MIN, REGEN_MAX)
    ax.set_ylim(0.0, 3.0)
    ax.set_xlabel("矿物再生周期（tick）")
    ax.set_ylabel("长期可采速率（单位 / tick）")
    ax.set_title("再生周期越长，可持续速率越低（官方 %s tick）"
                 % _num(P.MINERAL_REGEN_TIME))

    for i, n_work in enumerate((1, 5)):
        ax.axhline(extractor_rate(n_work), color=S.SEQ[2 + i], linewidth=1.3,
                   linestyle=(0, (4, 3)))
        ax.annotate("%d WORK 提取上限 %.2f 单位/tick" % (n_work, extractor_rate(n_work)),
                    (REGEN_MIN, extractor_rate(n_work)), xytext=(4, 2),
                    textcoords="offset points", ha="left", va="bottom",
                    fontsize=8, color=S.SEQ[2 + i])
    ax.axvline(P.MINERAL_REGEN_TIME, color=S.MORANDI["stone"], linewidth=1.2,
               linestyle=(0, (4, 3)))
    ax.legend(loc="upper right")

    # ---- 右：与能量收入的量级对比
    ax2 = axes[1]
    S.tidy(ax2, grid_axis="x")
    e_income = energy_income_per_tick()
    items = [
        ("source 能量收入", e_income),
        ("矿物长期（再生口径）", mineral_rate(MINERAL_DEPOSIT_DEFAULT) * MINERAL_VALUE_ENERGY),
        ("矿物峰值（5 WORK 提取）", extractor_rate(5) * MINERAL_VALUE_ENERGY),
    ]
    ypos = np.arange(len(items))
    vals = [v for _l, v in items]
    ax2.barh(ypos, vals, height=0.55, color=[S.SEQ[1], S.SEQ[3], S.SEQ[5]])
    for y, v in zip(ypos, vals):
        ax2.annotate("%.1f e/tick（占能量 %.0f%%）" % (v, v / e_income * 100.0),
                     (v, y), xytext=(4, 0), textcoords="offset points",
                     va="center", fontsize=8, color=S.TEXT)
    ax2.set_yticks(ypos)
    ax2.set_yticklabels([l for l, _v in items], fontsize=8)
    ax2.set_xlim(0.0, e_income * 1.55)
    ax2.invert_yaxis()
    ax2.set_xlabel("折合能量（e / tick）")
    ax2.set_title("矿物收入只有能量的零头")

    fig.suptitle("矿物：5 万 tick 的再生周期把长期速率压到 1 单位/tick 量级",
                 fontsize=12, color=S.TEXT, y=1.02)
    return S.save(fig, "fig87_mineral_income",
                  "v = min(矿藏/再生周期, n_WORK·1/5)；矿物 1 单位按 %.1f 能量折算（默认参数）"
                  % MINERAL_VALUE_ENERGY)


def fig88_lab_chain() -> str:
    """fig88：lab 反应链的投入产出（左）与 boost 的产能收益/盈亏平衡（右）。"""
    fig, axes = S.plt.subplots(1, 2, figsize=(12.6, 4.4))
    fig.patch.set_facecolor(S.BG)

    # ---- 左：链深 → 每 5 单位成品的累计投入
    ax = axes[0]
    S.tidy(ax)
    costs = [lab_chain_cost(d) for d in CHAIN_DEPTHS]
    x = np.arange(len(CHAIN_DEPTHS))
    mineral_e = np.array([c["mineral_energy"] for c in costs])
    reaction_e = np.array([c["reaction_energy"] for c in costs])
    ax.bar(x, mineral_e, width=0.55, color=S.SEQ[3], label="基础矿物（折能量）")
    ax.bar(x, reaction_e, width=0.55, bottom=mineral_e, color=S.SEQ[4],
           label="lab 反应能量")
    for xi, c in zip(x, costs):
        ax.annotate("%s 单位矿物\n%.1f 能量/单位成品"
                    % (_num(c["base_units"]), c["per_unit_energy"]),
                    (xi, c["total_energy"]), xytext=(0, 4),
                    textcoords="offset points", ha="center", fontsize=8,
                    color=S.TEXT)
    ax.set_xticks(x)
    ax.set_xticklabels(["链深 1\n(直接买前体)", "链深 2\n(两级反应)",
                        "链深 3\n(XGH2O 类)"], fontsize=8)
    ax.set_ylim(0.0, max(mineral_e + reaction_e) * 1.45)
    ax.set_ylabel("每 %d 单位成品的投入（能量）" % P.LAB_REACTION_AMOUNT)
    ax.set_title("lab 反应链：每深一级，原料多 5 单位")
    ax.legend(loc="upper left")

    # ---- 右：boost 的净收益 vs 基础矿物单价
    ax2 = axes[1]
    S.tidy(ax2)
    prices = np.linspace(0.0, PRICE_GRID_MAX, 300)
    depth = max(CHAIN_DEPTHS)
    unit = (P.LAB_REACTION_AMOUNT * (depth + 1) * prices
            + depth * LAB_REACTION_ENERGY) / P.LAB_REACTION_AMOUNT
    cost = LAB_BOOST_MINERAL * unit + LAB_BOOST_ENERGY

    up = upgrade_boost_gain(depth=depth)
    hv = harvest_boost_gain(depth=depth)
    up_net = up["extra_energy"] - cost
    hv_net = hv["extra_energy"] - cost

    ax2.plot(prices, up_net, color=S.SEQ[0], label="upgrade boost（×%.1f）" % UPGRADE_BOOST_MAX)
    ax2.plot(prices, hv_net, color=S.SEQ[1], label="harvest boost（×%.0f，source 封顶）"
             % HARVEST_BOOST_MAX)
    ax2.set_xlim(0.0, PRICE_GRID_MAX)
    ax2.set_ylim(-700.0, 1300.0)
    ax2.set_xlabel("基础矿物单价（能量 / 单位）")
    ax2.set_ylabel("每个 boosted WORK 部件的净收益（能量）")
    ax2.set_title("boost 值不值：寿命内的增量产能 vs 矿物成本")

    zero = ax2.axhline(0.0, color=S.MORANDI["stone"], linewidth=1.2,
                       linestyle=(0, (4, 3)))
    for net, key, lbl in ((up_net, 0, "upgrade 盈亏平衡"), (hv_net, 1, "harvest 盈亏平衡")):
        idx = int(np.argmax(net <= 0.0))
        if net[idx] <= 0.0:
            px = prices[idx]
            ax2.plot([px], [0.0], marker="o", markersize=5, color=S.SEQ[key])
            ax2.annotate("%s\n%.1f 能量/单位" % (lbl, px), (px, 0.0),
                         xytext=(22, 40) if key == 0 else (110, -46),
                         textcoords="offset points", fontsize=8, color=S.SEQ[key],
                         ha="left",
                         arrowprops=dict(arrowstyle="-", color=S.SEQ[key],
                                         linewidth=1.0, shrinkA=0, shrinkB=4))
    ax2.legend(loc="upper right")

    fig.suptitle("lab 链与 boost：产能乘数的收益要用整条反应链的成本来折算",
                 fontsize=12, color=S.TEXT, y=1.02)
    return S.save(fig, "fig88_lab_chain",
                  "每级反应 5+5→5（LAB_REACTION_AMOUNT）；boost 每部件 30 矿物 + 20 能量")


# ---------------------------------------------------------------- 入口
def main():
    S.setup()
    print("== 市场与后期系统 ==")

    # 1) 官方示例自检
    magic = transaction_cost(1000, 10)
    print("[自检] 1000 单位 / 10 格 → %d 能量（api.txt 示例 284）" % magic)

    # 2) 运费占比
    marks = [1, 5, 11, 20, 30]
    print("[运费] 能量/单位：" + " · ".join(
        "d=%d %.1f%%" % (d, transport_share_continuous(d) * 100.0) for d in marks))
    print("[运费折币] 11 格 %d 单位 = %d 能量 = %.2f credits（成交额 %.2f）"
          % (1000, transaction_cost(1000, 11),
             transaction_cost(1000, 11) * CREDITS_PER_ENERGY, 1000 * MINERAL_PRICE_CREDITS))

    # 3) 盈亏平衡
    for price, label in PRICE_LEVELS:
        print("[盈亏平衡] %s：5%% 溢价口径 → %.1f 格；%d 格需要溢价 %.1f%%"
              % (label, breakeven_distance(price),
                 P.SERVER["world_size"] - 1,
                 breakeven_premium(P.SERVER["world_size"] - 1, price) * 100.0))
    print("[手续费等价] 运费 = 5%% 成交额 的距离：矿物价 %.1f 格 / 能量价 %.1f 格"
          % (fee_equivalent_distance(MINERAL_PRICE_CREDITS),
             fee_equivalent_distance(PRICE_LEVELS[0][0])))
    print("[本服边界] 地图 %d×%d → 最远 %d 格；terminal %s、最小发送 %d、每 tick ≤ %d 笔"
          % (P.SERVER["world_size"], P.SERVER["world_size"],
             P.SERVER["world_size"] - 1, _num(P.TERMINAL_CAPACITY),
             TERMINAL_MIN_SEND, MAX_DEALS_PER_TICK))

    # 4) 矿物
    e_income = energy_income_per_tick()
    v_long = mineral_rate(MINERAL_DEPOSIT_DEFAULT)
    print("[矿物] %s 单位 / %s tick = %.2f 单位/tick（折 %.2f e/tick）"
          % (_num(MINERAL_DEPOSIT_DEFAULT), _num(P.MINERAL_REGEN_TIME), v_long,
             v_long * MINERAL_VALUE_ENERGY))
    print("       提取上限 1 WORK = %.2f、5 WORK = %.2f；能量收入 %.1f e/tick → 矿物只占 %.0f%%"
          % (extractor_rate(1), extractor_rate(5), e_income,
             v_long * MINERAL_VALUE_ENERGY / e_income * 100.0))

    # 5) lab / boost
    c3 = lab_chain_cost(3)
    up = upgrade_boost_gain()
    hv = harvest_boost_gain()
    print("[lab] 三级链：每 %d 单位成品要 %s 单位基础矿物 + %d 能量 → %.1f 能量/单位"
          % (P.LAB_REACTION_AMOUNT, _num(c3["base_units"]),
             c3["reaction_energy"], c3["per_unit_energy"]))
    print("[boost] upgrade ×%.1f：部件寿命多产 %.0f 能量，成本 %.0f → 净 %+.0f"
          % (UPGRADE_BOOST_MAX, up["extra_energy"], up["cost_energy"], up["net_energy"]))
    print("[boost] harvest ×%.0f：%d WORK → %d WORK，只省 %.0f 能量 body，成本 %.0f → 净 %+.0f"
          % (HARVEST_BOOST_MAX, hv["need_plain"], hv["need_boosted"],
             hv["extra_energy"], hv["cost_energy"], hv["net_energy"]))

    # 6) 后期门槛
    for name, desc in late_game_requirements():
        print("[后期] %-16s %s" % (name, desc))

    paths = [fig86_market_transport(), fig87_mineral_income(), fig88_lab_chain()]
    for p in paths:
        print("  图:", p)
    return paths


if __name__ == "__main__":
    main()
