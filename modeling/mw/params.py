# -*- coding: utf-8 -*-
"""参数唯一来源（single source of truth）。

三层数据，后层覆盖前层：

1. OFFICIAL —— Screeps 官方文档 / API Constants 给出的规则常数。
   已用 dump_constants.py 从本私服逐项导出核对，**完全一致**。
2. SERVER   —— 本私服的环境参数（官方文档没有，只能实测）。
3. ROOM     —— 房间 W7N2 的实测事实（tick 378372）。

任何模型脚本都必须从这里取数，不允许在模型里写魔法数字。
"""
from __future__ import annotations

__all__ = [
    "BODYPART_COST", "PART_LETTERS", "CARRY_CAPACITY", "HARVEST_POWER",
    "BUILD_POWER", "REPAIR_POWER", "DISMANTLE_POWER", "UPGRADE_CONTROLLER_POWER",
    "REPAIR_COST", "DISMANTLE_COST", "ATTACK_POWER", "RANGED_ATTACK_POWER",
    "HEAL_POWER", "RANGED_HEAL_POWER", "CREEP_LIFE_TIME", "CREEP_SPAWN_TIME",
    "MAX_CREEP_SIZE", "CONTROLLER_LEVELS", "CONTROLLER_DOWNGRADE",
    "CONTROLLER_MAX_UPGRADE_PER_TICK", "GCL_POW", "GCL_MULTIPLY",
    "SOURCE_ENERGY_CAPACITY", "SOURCE_ENERGY_NEUTRAL_CAPACITY", "ENERGY_REGEN_TIME",
    "TOWER_POWER_ATTACK", "TOWER_POWER_HEAL", "TOWER_POWER_REPAIR",
    "TOWER_OPTIMAL_RANGE", "TOWER_FALLOFF_RANGE", "TOWER_FALLOFF",
    "TOWER_ENERGY_COST", "TOWER_CAPACITY", "LINK_CAPACITY", "LINK_LOSS_RATIO",
    "CONSTRUCTION_COST", "CONSTRUCTION_COST_ROAD_SWAMP_RATIO", "ROAD_HITS",
    "ROAD_WEAROUT", "ROAD_DECAY_AMOUNT", "ROAD_DECAY_TIME", "RAMPART_DECAY_AMOUNT",
    "RAMPART_DECAY_TIME", "RAMPART_HITS_MAX", "WALL_HITS_MAX", "CONTAINER_CAPACITY",
    "CONTAINER_HITS", "STORAGE_CAPACITY", "TERMINAL_CAPACITY",
    "TERRAIN_FATIGUE", "SERVER", "ROOM", "parse_body", "body_cost", "body_size",
    "body_letters", "energy_per_hit_repair", "rcl_cumulative",
]

# ---------------------------------------------------------------- 1. 官方常数
BODYPART_COST = {
    "MOVE": 50, "WORK": 100, "CARRY": 50, "ATTACK": 80,
    "RANGED_ATTACK": 150, "HEAL": 250, "TOUGH": 10, "CLAIM": 600,
}

#: body 紧凑字符串里用的单字母（R=RANGED_ATTACK，L=CLAIM 以避开 C）
PART_LETTERS = {
    "T": "TOUGH", "W": "WORK", "C": "CARRY", "M": "MOVE",
    "A": "ATTACK", "R": "RANGED_ATTACK", "H": "HEAL", "L": "CLAIM",
}
LETTER_OF = {v: k for k, v in PART_LETTERS.items()}

CARRY_CAPACITY = 50
HARVEST_POWER = 2          # 每 WORK 每 tick 采 2 能量
BUILD_POWER = 5            # 每 WORK 每 tick 建 5 hit
REPAIR_POWER = 100         # 每 WORK 每 tick 修 100 hit
DISMANTLE_POWER = 50
UPGRADE_CONTROLLER_POWER = 1
REPAIR_COST = 0.01         # 修 1 hit 花 0.01 能量 → 1 能量修 100 hit
DISMANTLE_COST = 0.005
ATTACK_POWER = 30
RANGED_ATTACK_POWER = 10
HEAL_POWER = 12
RANGED_HEAL_POWER = 4

CREEP_LIFE_TIME = 1500
CREEP_SPAWN_TIME = 3       # 每部件 3 tick
MAX_CREEP_SIZE = 50
CREEP_CORPSE_RATE = 0.2

CONTROLLER_LEVELS = {1: 200, 2: 45000, 3: 135000, 4: 405000,
                     5: 1215000, 6: 3645000, 7: 10935000}
CONTROLLER_DOWNGRADE = {1: 20000, 2: 10000, 3: 20000, 4: 40000,
                        5: 80000, 6: 120000, 7: 150000, 8: 200000}
CONTROLLER_DOWNGRADE_RESTORE = 100
CONTROLLER_MAX_UPGRADE_PER_TICK = 15
CONTROLLER_STRUCTURES = {
    "spawn":      {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3},
    "extension":  {1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60},
    "tower":      {1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6},
    "link":       {1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6},
    "storage":    {1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1},
    "terminal":   {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1},
    "container":  {1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5},
}
EXTENSION_ENERGY_CAPACITY = {1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50,
                             7: 100, 8: 200}
SPAWN_ENERGY_CAPACITY = 300

GCL_POW = 2.4
GCL_MULTIPLY = 1_000_000

SOURCE_ENERGY_CAPACITY = 3000
SOURCE_ENERGY_NEUTRAL_CAPACITY = 1500
ENERGY_REGEN_TIME = 300

TOWER_POWER_ATTACK = 600
TOWER_POWER_HEAL = 400
TOWER_POWER_REPAIR = 800
TOWER_OPTIMAL_RANGE = 5
TOWER_FALLOFF_RANGE = 20
TOWER_FALLOFF = 0.75
TOWER_ENERGY_COST = 10
TOWER_CAPACITY = 1000

LINK_CAPACITY = 800
LINK_LOSS_RATIO = 0.03

CONSTRUCTION_COST = {
    "spawn": 15000, "extension": 3000, "road": 300, "constructedWall": 1,
    "rampart": 1, "link": 5000, "storage": 30000, "tower": 5000,
    "observer": 8000, "powerSpawn": 100000, "extractor": 5000, "lab": 50000,
    "terminal": 100000, "container": 5000, "nuker": 100000, "factory": 100000,
}
CONSTRUCTION_COST_ROAD_SWAMP_RATIO = 5

ROAD_HITS = 5000
ROAD_WEAROUT = 1
ROAD_DECAY_AMOUNT = 100
ROAD_DECAY_TIME = 1000

RAMPART_DECAY_AMOUNT = 300
RAMPART_DECAY_TIME = 100
RAMPART_HITS_MAX = {2: 300_000, 3: 1_000_000, 4: 3_000_000, 5: 10_000_000,
                    6: 30_000_000, 7: 100_000_000, 8: 300_000_000}
WALL_HITS_MAX = 300_000_000

CONTAINER_CAPACITY = 2000
CONTAINER_HITS = 250_000
CONTAINER_DECAY = 5000
CONTAINER_DECAY_TIME = 100
CONTAINER_DECAY_TIME_OWNED = 500
STORAGE_CAPACITY = 1_000_000
TERMINAL_CAPACITY = 300_000

#: 地形疲劳系数：官方 creeps.html §Movement 原文 "1 on roads, 2 on plain, 10 on swamp"
TERRAIN_FATIGUE = {"road": 1, "plain": 2, "swamp": 10}

# ---------------------------------------------------------------- 2. 私服环境
SERVER = {
    "name": "PGS-U26-001",
    "tick_per_second": 3.0,      # 实测：10 s 采样 30 tick
    "ms_per_tick": 333.7,
    "cpu_limit": 110,
    "cpu_tick_limit": 500,
    "cpu_bucket": 10000,
    "world_size": 12,            # 12×12 房间（官方 202）
    "shard": "shard0",
}

# ---------------------------------------------------------------- 3. 房间实测
ROOM = {
    "name": "W7N2",
    "tick": 378372,
    "rcl": 4,
    "progress": 134_100,
    "progress_total": 405_000,
    "ticks_to_downgrade": 40_000,

    # 地形（50×50 = 2500 格）
    "terrain": {"plain": 1538, "swamp": 90, "wall": 872},
    "road_tiles": 0,

    # 结构
    "structures": {"spawn": 1, "extension": 20, "tower": 1,
                   "container": 1, "controller": 1},
    "energy_capacity_available": 1300,   # spawn 300 + 20×50
    "energy_available": 25,

    # source：各 3000 能量、300 tick 再生
    "sources": [
        {"xy": (43, 31), "capacity": 3000, "regen": 300,
         "adjacent_container": (44, 30), "spawn_steps": 24, "spawn_cost": 48},
        {"xy": (23, 34), "capacity": 3000, "regen": 300,
         "adjacent_container": (22, 33), "spawn_steps": 6, "spawn_cost": 12},
    ],
    "spawn_xy": (21, 27),
    "controller_xy": (37, 11),
    "controller_steps": 18,
    "mineral": {"type": "H", "amount": 57445.9, "xy": (13, 37),
                "spawn_steps": 9},

    # 人口（tick 378372 房间内 13 个）
    "population": {
        "upgrader": 3, "hauler": 3, "miner": 1, "harvester": 2,
        "builder": 2, "soldier": 1, "remoteHarvester": 1,
    },
    "body_mix": {"1W1C1M": 9, "2C1M": 3, "1W1M1A": 1},   # 合计 13

    # 实测速率（tick 355478 → 378372）
    "measured_upgrade_rate": 1.13,   # progress/tick
    "measured_income": 1.13,         # energy/tick（几乎全部来自升级消耗）
}


# ---------------------------------------------------------------- 工具函数
def parse_body(compact: str) -> dict[str, int]:
    """把 "5W1C1M" 解析成 {"WORK":5,"CARRY":1,"MOVE":1}。

    >>> parse_body("5W1C1M")["WORK"]
    5
    """
    parts: dict[str, int] = {}
    num = ""
    for ch in compact.strip():
        if ch.isdigit():
            num += ch
            continue
        if ch not in PART_LETTERS:
            raise ValueError("未知部件字母: %r (来自 %r)" % (ch, compact))
        name = PART_LETTERS[ch]
        parts[name] = parts.get(name, 0) + (int(num) if num else 1)
        num = ""
    if num:
        raise ValueError("body 字符串以数字结尾: %r" % compact)
    return parts


def body_cost(parts: dict[str, int] | str) -> int:
    """造价（能量）。接受 dict 或 "5W1C1M"。"""
    if isinstance(parts, str):
        parts = parse_body(parts)
    return sum(BODYPART_COST[k] * v for k, v in parts.items())


def body_size(parts: dict[str, int] | str) -> int:
    """部件总数（决定生成时间 3×N）。"""
    if isinstance(parts, str):
        parts = parse_body(parts)
    return sum(parts.values())


def body_letters(parts: dict[str, int]) -> str:
    """dict → 紧凑字符串（用于图表标签）。"""
    return "".join("%d%s" % (v, LETTER_OF[k]) for k, v in sorted(
        parts.items(), key=lambda kv: list(PART_LETTERS.values()).index(kv[0])) if v)


def energy_per_hit_repair() -> float:
    """修 1 hit 需要多少能量（REPAIR_COST / REPAIR_POWER 已合并）。"""
    return 1.0 / REPAIR_POWER


def rcl_cumulative(level: int) -> int:
    """到达某个 RCL 需要的累计升级能量（含该级之前的全部增量）。"""
    return sum(CONTROLLER_LEVELS[l] for l in range(1, level))
