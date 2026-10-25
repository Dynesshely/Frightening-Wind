# Screeps 数学建模

> 数据分层：**规则**取自 [Screeps 官方文档](https://docs.screeps.com/)；**参数**取自本私服运行时导出（`dump_constants.py`）；**实测**取自房间 `W7N2`（tick ≈ 378372）。
> 目标不是"介绍游戏"，而是给出**可直接编码的公式** —— 每个式子都能对应到 `src/` 里的一个决策点。

---

## 0. 结论速览

| 问题 | 模型给出的答案 | 当前实况 |
| --- | --- | --- |
| 本房间能量天花板 | 20 energy/tick（2 source × 10） | **1.13 energy/tick**，利用率 5.6% |
| RCL 4 → 5 | 405,000 energy = 405,000 tick；满速 37.5 小时 | 按当前速率 **≈ 22.2 小时** |
| 矿工边际 | 边际收益递减，n≈22 才不划算 | 全房间 9 个 WORK，有效工时占比仅 6.3% |
| 远程运输 | source A（24 步）必须修路，否则单 hauler 吞吐 1.35 e/tick | 0 段路，3 个 2C1M hauler |
| 人口成本 | 200 能量的 3 部件兵 = 0.133 e/tick | 13 个兵 ≈ 1.75 e/tick |

**一句话**：不是没钱，是 η（有效工时占比）太低。同等人力，把路修通、矿工配足，收入能从 1.13 提到 12–15 e/tick。

---

## 1. 符号表

| 符号 | 含义 | 单位 |
| --- | --- | --- |
| t | 游戏 tick（`Game.time`） | tick |
| τ | 单 tick 墙钟时长 | s/tick |
| n_p | 某类 body 部件数，p ∈ {MOVE, WORK, CARRY, ATTACK, …} | 个 |
| N | body 总部件数，上限 50 | 个 |
| w | **加权重量**：产生疲劳的有效部件数（空 CARRY 不计） | 个 |
| φ | 疲劳值（`creep.fatigue`） | 点 |
| c(g) | 格子 g 的疲劳系数 | 无量纲 |
| E | 能量 | energy |
| h | 结构 hit points | hit |
| r | Chebyshev 距离 | 格 |
| η | 有效工时占比（真在干活的时间 / 存活时间） | % |

---

## 2. 时间模型

### 2.1 tick 与墙钟

τ = Δt_wall / Δt_game

| 环境 | 实测 τ | 1500 tick 一代 creep 的存活时间 |
| --- | --- | --- |
| 官方服务器 | 1000 ms（目标） | 25.0 分钟 |
| **本私服** | **333.7 ms**（10 s 采样 = 30 tick） | **8.34 分钟** |

推论（重要）：私服 tick 速率是官方的 3 倍，于是

- 一代 creep 只活 8.3 分钟墙钟 → 兵员更替压力 ×3；
- 每 tick 收入在墙钟意义上 ×3，但**造价不变**，因此
  单位墙钟成本 = cost(body) / 1500 × 3.0 = cost(body) / 500 [energy/s]
- 一切"等待"（站桩、堵路、来回踱步）的损失同样 ×3。

### 2.2 CPU 预算

| 量 | 实测 |
| --- | --- |
| `Game.cpu.limit` | **110** |
| `Game.cpu.tickLimit` | 500（bucket 满时） |
| `Game.cpu.bucket` | **10000（已满）** |

约束：每 tick 可用 C = 110 CPU，bucket 允许突发到 500。110 CPU × 3 tick/s = 330 CPU/s，非常宽裕 —— **本项目的瓶颈从来不是 CPU，而是能量调度**。

### 2.3 单 tick 动作互斥（pipeline）

同一 pipeline 内，**同一 tick 只有最右侧调用生效**：

```
work  链 : harvest → build → repair → dismantle → upgradeController
carry 链 : withdraw / transfer / drop / pickup
独立     : move, attack, rangedAttack, rangedMassAttack, heal, rangedHeal,
           claimController, reserveController, signController
```

推论：一个 1W 兵每 tick 最多做 1 件 work 事，不可能"边采边建"；但 `move` 与任意 work 动作可以同 tick。

---

## 3. 空间与移动模型

### 3.1 距离度量

房间是 50×50 方格，距离用 **Chebyshev**：

    d(p,q) = max(|x_p − x_q|, |y_p − y_q|)

`range: 1` = 8 邻域；`range: 3` = 7×7 方框。**真实路径步数 ≥ Chebyshev 距离**，墙多时可达 2 倍差距。

本房间实例：`spawn → source A` 的 Chebyshev = 23，实际步数 24；`spawn → controller` 的 Chebyshev = 14，实际步数 18。

### 3.2 疲劳动力学（差分方程）

每次**成功移动**到格子 g：

    φ ← φ + w · c(g),    w = Σ_{p ≠ MOVE} n_p · 1[该部件有载荷]

每 tick 开始：

    φ ← max(0, φ − 2·n_MOVE)

可移动的充要条件：**φ = 0**（否则 `ERR_TIRED`）。地形系数：

    c(g) = 1  (road)
           2  (plain)
          10  (swamp)

> 官方原文就是 "1 on roads, 2 on plain, 10 on swamp"，这三个数**已含倍率**，不要再乘。
> **空 CARRY 部件不产生疲劳** —— 这决定了空车返程比满载去程快一倍。

### 3.3 稳态速度

单格耗时：

    T(g) = ceil( w · c(g) / (2·n_MOVE) )   [tick/格]
    v(g) = 1 / T(g)                        [格/tick]

达成"每 tick 1 格"的条件：**w ≤ 2·n_MOVE**，即 MOVE 数 ≥ 其他有效部件数。

算例（本房间，无路）：

| body | 载重 | w | 平原 c=2 | 沼泽 c=10 |
| --- | --- | --- | --- | --- |
| 1W1C1M | 0 | 1 | 2/2 = **1 tick/格** | 10/2 = 5 |
| 1W1C1M | 50 | 2 | 4/2 = **2 tick/格** | 20/2 = 10 |
| 2C1M | 0 | 0 | **1 tick/格** | **1 tick/格** |
| 2C1M | 100 | 2 | 4/2 = **2 tick/格** | 10 |
| 5W5C5M | 250 | 10 | 10/10 = **1 tick/格** | 50/10 = 5 |

### 3.4 路径成本

一次 A→B 行走的总 tick 数：

    T_AB = Σ_{g ∈ path} T(g) ≈ T̄ · L_AB

L 是**真实步数**（不是 Chebyshev）。所以 nav 层必须复用 `moveTo` 的缓存路径，不能用直线估算。

### 3.5 本房间实测距离（tick 378372，A* 于真实地形）

| 起终点 | 步数 | Σc（疲劳成本） | 备注 |
| --- | --- | --- | --- |
| spawn(21,27) → source A 邻格 (44,30) | **24** | 48 | container 已建在该格 |
| spawn(21,27) → source B 邻格 (22,33) | **6** | 12 | container 尚在工地 |
| spawn(21,27) → controller 邻格 | **18** | 36 | |
| spawn(21,27) → mineral H (13,37) | **9** | 18 | |
| source A → source B | 25 | 50 | |
| 地形统计 | plain 1538 / swamp 90 / **wall 872** / road **0** | | 可行走 1628 格 |

---

## 4. 采集模型

### 4.1 source：周期库存

    Q_max = 3000 energy,  T_regen = 300 tick

抽干后整块回填（非线性恢复）。长期平均产出：

平均产出**不是常数**，取决于抽干速度：

    D(n)  = Q_max / (2·n_WORK)          抽干耗时
    C(n)  = D(n) + T_regen              稳态周期
    Y(n)  = Q_max / C(n) = 10n/(5+n)    [energy/tick]

| n_WORK | 1 | 2 | 3 | 5 | 10 | 20 | →∞ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Y(n) | 1.67 | 2.86 | 3.75 | 5.00 | 6.67 | 8.00 | 10 |

瞬时产出上限仍是 P_max = 2·n_WORK，但它只能维持 D(n) 个 tick。

### 4.2 单次结算

    ΔE = min( 2·n_WORK , Q(t) , freeCap )

freeCap 是 creep 剩余容量。**满仓时 harvest 返回 `ERR_FULL`** —— 这是"矿工站在矿上干等"的数学原因。

### 4.3 饱和条件与矿工数

跑满 10 e/tick 需要 2·n_WORK ≥ 10，即 **n_WORK ≥ 5**。

**没有饱和点，只有边际递减。** 第 n 个 WORK 的边际产出：

    dY/dn = 50 / (5+n)²

| n_WORK | 累计产出 | 边际产出 | 评价 |
| --- | --- | --- | --- |
| 1 | 1.67 | 1.667 | 极划算 |
| 5 | 5.00 | 0.556 | 仍然远超成本 |
| 10 | 6.67 | 0.238 | 两个 5W 矿工 |
| 22 | 8.15 | 0.067 | **盈亏平衡**（= WORK 摊销 100/1500） |
| 40 | 8.89 | 0.025 | 亏 |

结论：**矿工永远不嫌多，直到第 22 个 WORK**。现实约束是 spawn 能量上限（RCL4 = 1300）
与 body 的 50 部件上限，所以先上 **每 source 2 个 5W 矿工**（10 个 WORK/源，稳态 6.67 e/tick）。
当前每个 source 只有 0.5 个 WORK，产出被压到 1.67 e/tick/source。

---

## 5. 运输模型

### 5.1 往返时间

    T_AB = T_空(L) + T_满(L)
    T_空 = ceil(0 / (2·n_M)) · L = L              （空 CARRY 不计疲劳）
    T_满 = ceil(n_C · c / (2·n_M)) · L

### 5.2 吞吐

    Thr = C_cap / (T_AB + 2)   [energy/tick]
    C_cap = 50 · n_CARRY

（+2 是装卸各 1 tick）

### 5.3 本房间算例（2C1M，载 100）

| source | 步数 | 无路 Thr | 有路 Thr | 满采所需 hauler 数（无路 / 有路） |
| --- | --- | --- | --- | --- |
| A (44,30) | 24 | 100/(24+48+2) = **1.35** | 100/(24+24+2) = **2.00** | **7.4 / 5.0** |
| B (22,33) | 6 | 100/(6+12+2) = **5.00** | 100/(6+6+2) = **7.14** | **2.0 / 1.4** |

**这就是当前真正的瓶颈**：source A 太远，不修路要 7 个 hauler 才喂满一个矿工；修路后 5 个。彻底解决要等 **RCL5 的 link**。

### 5.4 运输方式性价比

| 方式 | 损耗 | 前置条件 | 单位成本 |
| --- | --- | --- | --- |
| hauler 人工搬运 | 0（但占人口） | — | 见上表 |
| link 链 | **3%/次**（`LINK_LOSS_RATIO`） | RCL5，2 个 link，800 容量 | 0.03 E per E |
| container + 定点矿工 | 0 | RCL0（可建 5 个） | 矿工 drop，hauler 短驳 |

---

## 6. creep 经济模型

### 6.1 造价与生成时间

    cost(body) = Σ_p n_p · k_p
    k = { MOVE:50, WORK:100, CARRY:50, ATTACK:80,
          RANGED_ATTACK:150, HEAL:250, TOUGH:10, CLAIM:600 }

    T_spawn = 3 · N   [tick]      （CREEP_SPAWN_TIME = 3）

1W1C1M = 200 能量 / 9 tick；50 部件 = 150 tick（50 秒）。

### 6.2 生命与摊销

    T_life = 1500 tick
    ċ = cost(body) / 1500   [energy/tick]

| body | 造价 | 摊销 e/tick | 私服墙钟成本 e/s |
| --- | --- | --- | --- |
| 1W1C1M | 200 | 0.133 | 0.40 |
| 2C1M | 150 | 0.100 | 0.30 |
| 5W1C1M | 600 | 0.400 | 1.20 |
| 5W5C5M | 1500 | 1.000 | 3.00 |

当前 13 个兵 ≈ **1.75 e/tick** 固定开销，占 20 e/tick 天花板的 8.8%。

### 6.3 性价比判据

一个采集型 creep 的净产出：

    Ė_net = 2·n_WORK·η − cost(body)/1500

η 是有效工作占比。**当前实况 η ≈ 1.13 / 18 ≈ 6.3%** —— 这就是"兵不少但经济不动"的量化解释。

**优化目标是 η，不是兵的数量。**

---

## 7. 控制器与 GCL

### 7.1 RCL 能量曲线（实测，与官方一致）

| RCL | progressTotal（本级升下一级所需） | 到达该级的累计能量 |
| --- | --- | --- |
| 1 | 200 | 0（初始） |
| 2 | 45,000 | 200 |
| 3 | 135,000 | 45,200 |
| **4** | **405,000** | 180,200 |
| 5 | 1,215,000 | 585,200 |
| 6 | 3,645,000 | 1,800,200 |
| 7 | 10,935,000 | 5,445,200 |
| 8 | — | 16,380,200 |

> 每级 progress 归零，所以"累计"必须逐级相加，**不能拿两级 progressTotal 相减**。

> 私服 `CONTROLLER_LEVELS` 与官方完全一致。曾误记为 200,000，实测 `controller.progressTotal = 405000`（tick 378372），已纠正。

升级速率：

    ṗ = min( n_WORK · η , 15 , Ė_alloc )

15 是 RCL8 的硬上限（`CONTROLLER_MAX_UPGRADE_PER_TICK`），RCL4 无此限制，真正约束是**能量分配**。

剩余时间：

    T_left = (405000 − p_now) / ṗ

当前 p = 134,100，实测 ṗ ≈ 1.13 → **239,735 tick ≈ 22.2 小时墙钟**。

### 7.2 降级风险

    ticksToDowngrade(RCL4) = 40,000 tick ≈ 3.7 小时

每次 upgrade 动作恢复 100 tick。RCL4 的缓冲只有 3.7 小时 —— **必须保证持续有 upgrader**，断档 3.7 小时就掉级。

### 7.3 GCL

    GCL = floor( (E_total / 10^6) ^ (1/2.4) )
    E_total = 10^6 · GCL^2.4

| GCL | 需要的累计升级能量 |
| --- | --- |
| 1 | 1.00e6 |
| 2 | 5.28e6 |
| 3 | 1.40e7 |

投给 controller 的能量**同时计入 RCL 与 GCL** —— 冲 RCL 和冲 GCL 是同一件事，不是竞争关系。

---

## 8. 建造与维护

### 8.1 建造

    ḣ_build = 5 · n_WORK   [hit/tick]
    能量消耗 = ḣ_build / 5 [energy/tick]

结构造价（`CONSTRUCTION_COST`）：extension 3000、road 300（**沼泽 ×5**）、storage 30000、tower 5000、container 5000、spawn 15000。

工时换算：1W 工兵建 5 hit/tick → 一个 extension 需 **600 tick**（3.3 分钟墙钟）。在 3 tick/s 下这"很久"，所以建造必须多工兵并行。

### 8.2 折旧与维护

| 结构 | 自然折旧 | 折成能量成本 |
| --- | --- | --- |
| road | 100 hit / 1000 tick = **0.1 hit/tick** | 0.001 e/tick/段（可忽略） |
| rampart | 300 hit / 100 tick = **3 hit/tick** | **0.03 e/tick/段**（1000 段 = 30 e/tick，致命） |
| container | 5000 hit / 100 tick（无主）或 500（有主） | 需定期修 |
| wall | 无自然折旧 | 只被人打 |

repair 折算：`REPAIR_POWER = 100`，`REPAIR_COST = 0.01` → **1 能量修 100 hit**。

    Ė_maint = (1/100) · Σ ḣ_i

**建模结论**：rampart 必须按最小必要面积建。每多 100 段就多 3 e/tick 的固定税。

### 8.3 修路的收益判据

一段路成本 300（沼泽 1500），维护 0.001 e/tick。收益是让 T(g) 从 2 降到 1：

    ΔThr = C/(T_wo) − C/(T_w)

source A 的 24 段：投入 24×300 = 7,200 能量，收益 **+0.65 e/tick**（1.35 → 2.00），回本 11,077 tick ≈ 1 小时。**当前最高性价比的投资**。

---

## 9. 防御模型

### 9.1 tower 距离衰减

    σ(r) = clamp( 1 − 0.75 · (r − 5)/15 , 0.25 , 1 )

    dmg(r)    = 600 · σ(r)
    heal(r)   = 400 · σ(r)
    repair(r) = 800 · σ(r)

r ≤ 5 满效率；r ≥ 20 只剩 25%（`TOWER_FALLOFF = 0.75`）。

每次动作固定耗 10 energy → **每点伤害边际成本 0.0167（贴身）～ 0.0667（极限距离）energy/hit**。

    Ḋ_max = 60 · σ   [hit/energy 补给]

### 9.2 rampart 上限

| RCL | RAMPART_HITS_MAX |
| --- | --- |
| 2 | 300,000 |
| 3 | 1,000,000 |
| **4** | **3,000,000** |
| 5 | 10,000,000 |
| 6 | 30,000,000 |
| 7 | 100,000,000 |
| 8 | 300,000,000 |

折旧量与上限无关（恒 3 hit/tick/段），所以**修满上限是免费的**，只要有人修。

---

## 10. 全局能量平衡方程

    收入 = Σ_s min( Q_s/T_s , 2·Σ_{i∈s} n_WORK,i )
    支出 = Σ_i cost_i/1500  +  ṗ_upgrade  +  ḣ_build/5  +  (1/100)Σḣ_maint  +  Ė_tower

本房间当前：

    收入 = 2（实采） ≪ 20（潜在）
    支出 = 1.75（人口） + 1.13（升级） + ≤2（建造） + ≈0（维护）

**结论**：不是"没钱"，是 **η 太低**。同等人力让矿工真在矿上、hauler 真在跑，收入可达 12–15 e/tick，RCL4→5 从 22 小时压到 **7–8 小时**。

---

## 11. 优化问题（可直接编码）

### P1 矿工配置

    max  Σ_s 2·min( Σ_i n_WORK_i^s , 5 )
    s.t. Σ_i cost_i ≤ energyCapacityAvailable

解：**每个 source 先上 2 个 5W 矿工**（各造价 600）。RCL4 的 1300 上限一次只够造 2 个。

### P2 运输配置

    n_hauler^s = ceil( 10 / Thr(L_s) )

本房间：source A 需 5（有路）或 7（无路）；source B 需 2。合计 **7 个 2C1M**（有路）或 9 个（无路）。

### P3 加兵的边际判据

只有 `2·n_WORK·η > 人口摊销 + 采集机会成本` 时加兵才有意义。当前 η 极低，**加兵无意义 —— 先修路、先补矿工带宽**。

### P4 行动优先级（按 Δe/tick per energy 排序）

1. **矿工 1W → 5W/源**：+6.67 e/tick，投入 1,200 E，回本 < 200 tick
2. **修 source A 的 24 段路**：+0.65 e/tick，投入 7,200 E，回本 ~11,000 tick
3. **建成 source B 的 container**（(22,33) 工地）：矿工 drop、hauler 短驳，+3 e/tick
4. **RCL5 的 2 个 link**：消除全部远程运输损耗
5. rampart / 防御：当前无敌对压力，暂缓

---

## 12. 校准清单

| 模型预测 | 实测方法 | 状态 |
| --- | --- | --- |
| τ = 333.7 ms | `GET /api/game/time` 双采样 | ✅ 已测 |
| 无路 2C1M 满载 2 tick/格 | 逐 tick 采样 `creep.fatigue` | 待测 |
| source 300 tick 回满 | `ticksToRegeneration` | ✅ 已测（regenIn 300） |
| 升级速率 1.13 p/tick | `controller.progress` 差分 | ✅ 已测（t 355478→378372） |
| hauler 吞吐 1.35 e/tick | 单 hauler 往返计时 | 待测 |
| tower 衰减 600→150 | 对空地测 `tower.attack` 前后 hits | 待测 |

---

## 附录 A：本私服参数快照（tick 378372）

| 项 | 值 |
| --- | --- |
| tick / 墙钟 | 3.0 tick/s（333.7 ms） |
| CPU | limit 110 / tickLimit 500 / bucket 10000（满） |
| 世界大小 | **12 × 12 房间**（官方 202，私服大幅缩小） |
| 房间 W7N2 | RCL 4，progress 134,100 / 405,000，downgrade 40,000 tick |
| 地形 | plain 1538 / swamp 90 / wall 872 / road 0 |
| source | 2 个，各 3000 能量，300 tick 再生 |
| mineral | H，57,446（密度 4） |
| 结构 | 1 spawn / 20 extension（1300 上限）/ 1 tower / 1 container / 1 storage（在建） |
| 人口 | 13（upgrader×3, hauler×3, miner×1, harvester×2, builder×2, soldier×1, remoteHarvester×1） |
| 有视野房间 | W7N1、W8N2 |

## 附录 B：文档对应表

| 本文档 | 官方页面 |
| --- | --- |
| 2.1 / 2.3 | `game-loop.html`, `simultaneous-actions.html`, `cpu-limit.html` |
| 3.x | `creeps.html` § Movement + `api/Creep.html` |
| 4.x / 5.x | `resources.html` + Constants |
| 7.x | `control.html` + Constants |
| 9.x | `defense.html` + `api/StructureTower.html` |
| 全部常数 | `api/` § Constants（1.33 MB 完整页，已存本地） |

---

## 附录 C：官方向导

### 已核对的文件

| 页面 | 本地副本 | 大小 |
| --- | --- | --- |
| `/api/`（完整 Constants + 全对象 API） | `screeps-docs/api.html` | 1.33 MB / 312k 字 |
| `/api/Creep.html` | `screeps-docs/api-creep.html` | 116 KB |
| `/api/StructureTower.html` | `screeps-docs/api-tower.html` | 16 KB |
| `creeps.html` / `control.html` / `defense.html` | 同名 .txt | 4–7 KB |
| `resources.html` / `market.html` / `power.html` / `invaders.html` | 同名 .txt | 4–16 KB |
| `game-loop.html` / `simultaneous-actions.html` / `cpu-limit.html` | 同名 .txt | 3 KB |

### 官方文档没有写、必须实测的部分

1. **跨房间移动必须两步**（先走到本房间边缘格，再 `move(exitDir)`）—— 文档只字未提，这是本轮重构的核心发现。
2. **`move()` 目标格被占时返回 OK 但不移动** —— 文档没写。
3. 私服参数覆盖（tick 速率、世界大小、CPU 上限）—— 只能运行时导出。

---

## 13. 可执行模型

本文件的所有公式都已落地为可运行的 Python 代码：[../modeling/](../modeling/)

```bash
cd modeling
python run_all.py      # 7 个模型 / 21 张图 / 约 4 秒
```

| 模块 | 主题 | 图 |
| --- | --- | --- |
| `models/movement.py` | 疲劳、速度、路径耗时 | fig01–03 |
| `models/economy.py` | 造价、摊销、η 敏感性 | fig10–12 |
| `models/mining.py` | source 稳态产出与边际收益 | fig20–22 |
| `models/logistics.py` | hauler 吞吐、修路回本 | fig30–32 |
| `models/growth.py` | RCL / GCL 与墙钟预测 | fig40–42 |
| `models/defense.py` | 塔衰减、维护税、围城 | fig50–52 |
| `models/optimize.py` | 配置空间与行动优先级 | fig60–62 |

模型的已知边界写在 `modeling/README.md` 末尾：它给的是**配置维度的上限**，
不含移动时间与调度损耗。实测链路效率 η ≈ 39%（1.13 / 2.90），
这部分差距正是 `src/` 后续要吃掉的空间。
