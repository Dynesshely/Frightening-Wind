# Frightening-Wind 经济瓶颈分析（线上真实数据）

- 对象：私有服务器 http://10.0.200.31:21025 （PGS-U26-001），房间 **W3N8**，账号 6adc3c44…
- 数据窗口：**修复前基线 tick 44 746 → 45 732**（986 tick / 23 个采样点）+ **修复后 tick 45 777 → 46 008**（231 tick / 6 个采样点），45 s 间隔；实测服务器 0.29–1.16 tick/s
- **重要：Lead 在 tick ≈45 77x 部署了一版修复（economy 19074 / utils 17709 chars），本报告的核心结论 R0/R1 已被该版采用并实测生效；§9 给出前后 A/B 实测。**
- 代码基线：**线上部署版本**（分析期间发生过一次部署：6 模块 → 7 模块，新增 defense.js）。快照冻结在 analysis/deployed_code/，本文所有函数名指该快照。两版里下文的 B0/B1 都成立。
- 只读承诺：只用 GET 接口（room-objects / user/memory / game/time / user/code / room-terrain），**未调用 console**，**未修改仓库任何文件**；产物只写本目录。

---

## 0. 结论摘要

**一句话：机器人卡在 RCL2 不是"采得慢"，而是一个 1 行的结构过滤器 bug 让整套容器经济（矿工 / 搬运工 / 升级者）从未启用——容器早就建好了，但代码永远看不见它。**

| 指标 | 实测 | 上限 / 目标 | 利用率 |
|---|---|---|---|
| 毛采集收入 | **6.12 E/tick** | 2 矿源 × 10 = 20 E/tick | **31%** |
| 控制器升级 | 基线 **0 progress/tick**（986 tick 内 Δ=0，progress 恒 280/45000）→ 部署后 0.065/tick | — | **0% → 7%** |
| 建造速率 | **4.19 progress/tick**（0.84 E/tick） | 2 builder × 1 WORK × 5 = 10/tick | **42%** |
| 人口 | 基线 7 / 上限 7（4+floor(300/100)）→ 部署后 8 / 8（5+floor） | RCL2 可扩到 9 | 已顶满 |
| 身体 | 7 × 1W2C2M（每只 1 WORK，单兵 1.11 E/tick） | cap 550 可造 3W2C3M | — |
| 移动失败 | **792 次 ERR_TIRED = 移动调用的 31%** | 0 | 移动侧浪费 ~15% creep-tick |
| 交付事件 | **0.02 次/tick（21 次 / 844 tick）** | — | 补给链极脆 |

**已完成的修复（Lead 于 tick ≈45 77x 部署，实测生效）**

- **R0 已采用 ✓**：utils.js 现在变成 `allStructures: findSafe(room, FIND_STRUCTURES)` + `d.containers = d.allStructures.filter(...)`（新文件第 45/60 行，注释写明"容器 / 道路 / 墙 / rampart 属于中立结构"）。效果见 §9：角色立刻从 {harvester:5, builder:2} 变成 {miner:1, hauler:2, harvester:2, builder:2, upgrader:1}，升级计数从 0 → 0.065 progress/tick。
- **R1 已采用 ✓**：computeQuota 现在按 `trimOrder = ['harvester','hauler','builder','upgrader']` + floors（builder 至少 1、upgrader 至少 1）裁剪，并且 `creepCap` 从 `4+` 提到 `5+`（cap 300 → 8 人）。

**Top3 现在（部署后）最该做的动作**

1. **R8（1 行，最紧急）**：roles.js upgrader() 满载分支**第一句是 utils.deliverEnergy()** —— 升级者把 100 能量背到控制器跟前，却先倒给 spawn，然后空手走回 31 格外。实测升级速率只有 **0.065 progress/tick**（231 tick 只升了 15 点），比理论值（0.9）低 **14 倍**。删掉那一句 → 升级者真正升级。
2. **R2（最划算）**：先建 **2 个扩展**（cap 300 → 400）。部署后的实测正好验证了 R4 的预测：cap 300 下切到 miner/hauler，收入从 **6.0 掉到 4.5 E/tick**、空转率从 27.7% 涨到 **48.8%**（2 个 hauler 只有 2 E/tick 的货源，长期 💤）。cap 400 后单兵 1.11 → **1.54 E/tick（+39%）**、creepCap 8 → 9、miner 2W=4 E/tick，容器路线才开始划算。
3. **R3（建造效率）**：建造速率只有理论值的 42%（4.19 vs 10 progress/tick），是"扩展何时能建完"的唯一瓶颈；同时 `quota.hauler` 在 cap 300 下应先降到 1，把名额还给 harvester。

---

## 1. 方法与数据来源

| 项目 | 内容 |
|---|---|
| 采样 | analysis/sample.py（纯 GET，45 s/次，落 samples.jsonl 20 点）→ python sample.py --interval 45 --count 40 复跑 |
| 账本 | analysis/analyze.py（fw.ct 差分 + 工地进度差分 + 造兵 / 死亡能量） |
| 身体 / 配额 | analysis/body_model.js、quota_model.js（**直接 require 线上冻结代码跑 planBody / computeQuota**，非手算；输出见 body_out.txt / quota_out.txt） |
| 距离 / 地形 | analysis/_terrain.py（Dijkstra，plain=2 / swamp=10，与 moveTo 权重一致） |
| 口径 | Memory.fw.ct 是自 tick 42833 起累计的计数器，本报告一律用**差分/Δtick** 换算速率；harvest 每次 OK = 1 WORK = 2 能量 |

**计量缺口（已交叉验证，不影响结论）**：utils.buildSomething() / repairSomething() **没有 bump()**，所以 fw.ct.build 只记到 harvester 的 buildNearby（0.63/tick），真实建造量 4.19 progress/tick——**低报 6.7 倍**。本报告的建造一律用工地 progress 差分。

**收入的两个独立口径互相印证**：

- Δharvest 2583 次 × 2 E = 5166 E → **6.12 E/tick**
- 矿源 energy 字段实测枯竭：**4.18 + 1.86 = 6.04 E/tick**

两者差 1.3% ⇒ 模型与口径可信。（理论天花板 20 E/tick）

---

## 2. 现状数据

### 2.1 房间几何（本房最大的客观成本）

| 项 | 值 |
|---|---|
| spawn Root | (21, 23) |
| controller | (9, 33) — 距 spawn **13 格**（往返 26 tick） |
| source A 9d3307 | (35, 4) — 距 spawn **20 格**（往返 **40 tick**），距 controller **31 格** |
| source B ebdd07 | (42, 36) — 距 spawn **21 格**，距 controller **33 格** |
| 地形 | 1886 plain / 50 swamp / 564 wall；spawn→矿源最短路径 **0 格沼泽**，实测 140 个 creep 采样位置 **100% 在 plain** |

> 一个 1 WORK 采集者的生命周期：采满 100 能量要 50 tick，路上要 40 tick ⇒ **44% 的寿命在走路**。

### 2.2 人口与身体

    creep 7 / 上限 7 = 4 + floor(energyCapacityAvailable/100) = 4 + 3
    角色: harvester 5, builder 2
    身体: 7 × 1W2C2M（7 WORK / 14 CARRY / 14 MOVE，成本 2100 E）

- 单兵吞吐 = 100 / (100/(2×1) + 40) = **1.11 E/tick**；5 只 = 5.56，实测 6.12（含 builder 顺带采集）。
- **上限已经顶满**：再多能量也无法转成产能。

### 2.3 能量账本（844 tick 窗口）

| 项目 | 能量 | E/tick | 占比 | 备注 |
|---|---|---|---|---|
| 收入：采集 | 5166 | **6.12** | 100% | 两个独立口径互证 |
| 支出：造兵换代 | 1800 | **2.13** | 35% | 6 只 × 300 E；长期均值 = 2100/1500 TTL = **1.40（23%）** |
| 支出：建造 | 707 | **0.84** | 14% | 工地 progress +3536 / 5 |
| 支出：升级 | **0** | **0** | **0%** | fw.ct.upgrade 全程恒为 448（自 42833 起一次没涨） |
| 损失：死亡携带 | 208 | 0.25 | 4% | 6 只死亡时合计携带 208 E（未计它们死前最后一刻的携带） |
| 其余 / 未能核销 | ~2450 | ~2.9 | 47% | 见 §8-局限：现有计数器无法核销，已列入待查 |

**造兵换代是第二大支出（23–35%）；升级是 0。**

### 2.4 时间与动作（creep-tick 基数 5908）

| 占比 | 项目 | 次数 |
|---|---|---|
| 43.7% | 采集 harvest | 2583 |
| 29.4% | 移动 move | 1736 |
| 12.0% | 建造（progress/5 估算） | 707 |
| **0%** | **升级** | **0** |
| 14.9% | 空转 / 被抢占 | 882 |
| 额外 | **ERR_TIRED 792 次 = 移动调用的 31%** | — |

- transfer（交付给 spawn）只有 **21 次 / 844 tick = 0.02 次/tick**：补给是极低频事件，每次都要 40 tick 往返垫底。
- fatigue > 0 占采样 16%，**值恒为 2**——与"body 的 MOVE 刚好卡在临界"完全吻合（见 §3-B5）。

### 2.5 控制器与工地

| 项 | 值 |
|---|---|
| controller | RCL2，**280 / 45000（0.6%）**，844 tick 内 **Δ=0** |
| downGrade | 53978（当前 45 613，缓冲约 **8 500 tick ≈ 2.4 h**，暂无降级风险） |
| 已建成 | spawn、controller、**容器 (35,3)（hits 245 000/250 000，store.energy = 0 —— 建好了但从未被用）** |
| 工地 | **7 个**（config maxSitesPerRoom = 3）：容器 943/5000、容器 1825/5000、扩展 539/3000、600/3000、0/3000 ×3 |
| 剩余工作量 | **约 21 100 progress**；按当前 4.19/tick ≈ **5 000 tick ≈ 1.4 h** |

### 2.6 矿源枯竭率（"不是采不动，是运不动"）

| 矿源 | 窗口内被采 | 速率 | 上限 | 利用率 | 说明 |
|---|---|---|---|---|---|
| A (35,4) | 2 936 E / 702 tick | **4.18 E/tick** | 10 | 42% | 4 个 creep 围着 |
| B (42,36) | 1 400 E / 753 tick | **1.86 E/tick** | 10 | 19% | 只有 1 个真在采，几乎满仓浪费 |
| 合计 | — | **6.04 E/tick** | **20** | **30%** | |

---
## 3. 瓶颈排序

### B0【根因，1 行 bug】【已修复 ✓ 见 §9】容器永远"看不见"，整套容器经济从未启用

utils.js roomData()：

    structures: room.find(FIND_MY_STRUCTURES),
    ...
    d.containers = d.structures.filter(s => s.structureType === STRUCTURE_CONTAINER);

**容器（以及路、墙、rampart）不属于"我的建筑"，room.find(FIND_MY_STRUCTURES) 永远不会返回它们。** 线上铁证（机器人自己写进 Memory 的 snapshot，来源就是 room.find(FIND_MY_STRUCTURES)）：

    "structs": {"controller": 1, "spawn": 1}      ← 房间里明明有一个 container！

同时 room-objects 里该容器 user: null（而 spawn/controller 的 user 是我），hits 245000/250000，store.energy = 0。

**连锁后果（全部实测可见）**：

| 下游 | 后果 |
|---|---|
| computeQuota().containerized 恒为 0 | miner = 0、hauler = 0、**upgrader = 0（永远）** |
| sourceHasContainer() 恒 false | 静态矿工永不出现，采集永远是"自采自送 20 格" |
| nearestEnergyStore() / dumpSurplus() 恒 null | 搬运 / 续杯链路全部是死代码 |
| 容器 store.energy 恒 0 | 建成的容器白建，还占用了 5000 progress（≈1000 能量）的建造时间 |
| repairSomething() 只遍历 data.structures | 容器 / 路 / 墙**永远不会被维修**（容器已掉 5000 hits） |

这一条解释了"为什么 RCL2 停在这里"：升级者的存在条件被一个不可达的数据源锁死，机器人永远只会造 harvester + builder，永远走"20 格往返 + 自采自送"，永远 0 升级。

> **状态**：Lead 已在 tick ≈45 77x 的部署里按 R0 修好（`allStructures: findSafe(room, FIND_STRUCTURES)` + `d.containers` 从中立结构过滤）。实测角色立刻出现 miner/hauler/upgrader，升级计数从 0 开始增长（§9）。

### B1【致命 → 部分修复】控制器升级结构性停摆：基线 986 tick 内 0 次升级

- 证据：fw.ct.upgrade 从 44746 到 45613 恒为 448；controller progress 恒为 280。
- 双重机理：
  1. 配额侧：quota.upgrader = containerized > 0 ? (level>=5?3:2) : 0 —— 而 containerized 因 B0 恒为 0 ⇒ **永远没有升级者**。
  2. 行为侧：roles.js harvester() 满载分支**每 tick 重新决策**（deliverEnergy → buildNearby → dumpSurplus → upgrade）。一只满货 harvester 从矿源 B 走向控制器要 33 tick，这期间 spawn 一旦空出一格就被 deliverEnergy 拽回去 ⇒ **走到半路永远被打断**。实测：say 里出现过 ⚡，但 upgrade 计数 0。
- 后果（基线）：RCL3（45000）**永不到达** ⇒ 没有塔（防御）、没有路（速度翻倍）、没有更高建筑上限。
- **部署后的现状**：配额侧已修好（upgrader 出现），升级从 0 变成 **0.065 progress/tick**，但仍比理论值低 14 倍 —— 原因换成了行为侧的 R8（upgrader 把能量倒给 spawn）。**B1 还有一半没修**。

### B2【严重，修好 B0 后会立刻踩到】computeQuota() 的裁剪顺序把 builder 砍到 0

用线上冻结代码实测（cap 300、7 个工地、**假设容器已可见**）：

    { harvester: 2, miner: 1, hauler: 2, builder: 0, upgrader: 2 }   // = 7，正好等于人口上限

原始配额 {h:2, miner:1, hauler:2, builder:2, upgrader:2} = 9 > cap 7，进入裁剪：

    while (total > cap) {
        if (quota.builder > 0) { quota.builder--; total--; continue; }   // ← builder 第一个被砍，连砍两次
        if (quota.hauler > 1)  { ... }
        ...
    }

⇒ builder = **0**，而房间里有 7 个工地、21 100 progress（含全部 5 个扩展）没做完。**修完 B0 之后，从下一个 builder 死亡开始就不会再有 builder**，扩展永远建不完、cap 永远 300。这条必须和 B0 在同一次提交里一起修。

### B3【严重】cap 300 卡死身体：1 WORK / 1.11 E/tick，且 planBody 在 350 / 550 两个台阶上**倒退**

用线上代码实测各预算下的身体与吞吐（往返 40 tick）：

| cap | harvester 身体 | E/tick | miner | hauler |
|---|---|---|---|---|
| 300（现状） | 1W2C2M | **1.11** | 2.00 | 5.00 |
| 350 | 2W1C2M | **0.95**（比 300 低 14%！） | 4.00 | 5.00 |
| 400 | 2W2C2M | **1.54**（+39%） | 4.00 | 6.25 |
| 500 | 2W3C3M | **1.94**（+75%） | 4.00 | 7.50 |
| 550 | 3W2C3M | **1.76**（比 500 低 9%！） | 6.00 | 8.75 |

两个倒退台阶是 planBody() 的缺陷：filler 按固定顺序优先塞 WORK，把 CARRY 挤掉，而 20 格往返恰恰最需要 CARRY 缓冲（详见 §5-#3）。

### B4【严重】建造速率只有理论值 42%：builder 自己在自采自送

- 2 builder × 1 WORK × 5 progress = 10 progress/tick 潜力，实测 **4.19**。
- 原因：roles.js builder() 空仓时走 pickupLoose → harvestSource，即**自己跑 20 格挖矿再跑回来建**。实测 builder 时间分布 ≈ 44% 采集 + 29% 移动 + 12% 建造。
- 更糟：utils.buildSomething() 的优先级是"类型优先，距离只用于同类型"，于是站在矿源 B 的 builder 会跨越 33 格去打矿源 A 旁的容器工地（单程 33 tick）。

### B5【中】所有身体都卡在"MOVE 刚好够"的临界：31% 移动调用因疲劳失败

- 792 次 ERR_TIRED / (1736 + 792) = **31%**；16% 采样疲劳值恒为 2；采样位置 100% plain（已排除"整段路在沼泽"）。
- 1W2C2M：weight（非 MOVE 部件）= 3，MOVE = 2 = ceil(3/2) —— **恰好卡在临界，零余量**。utils.moveTo() 用 ignoreCreeps: false + reusePath: 8，7 个 creep 挤在 20 格走廊里频繁因避让重算路径，任何一次绕路 / 被堵 / 踩沼泽（本图 50 格 swamp，weight×5 疲劳）就换来 1–4 tick 的停滞。
- 代价：等效速度掉到约 0.7–0.9 格/tick（满速 1.0），收入侧约 **-8%**。

### B6【中】能量在 spawn 与 creep 之间堵车

- spawn 能量在 **17 → 300** 之间大幅振荡，多个采样点满仓（300/300）且 idle；creep 携带常年 220–450。
- 机理：spawnSurplus() 要求 energyAvailable >= capacity **且** 总数 < cap，人口顶满时直接 return。此时多余能量只能靠 harvester 自己 buildNearby / upgrade 消化，而 harvester 恰好站在容器工地上 ⇒ 全去建造，**一个 tick 也不升级**（与 B1 同源）。
- 代价：约 400–750 能量（≈70–120 tick 的全部收入）常年躺在库存里不产生收益。

---
## 4. 可执行建议（按 ROI 排序）

### R0【P0，1 行，收益最大】【已采用 ✓】修 utils.js roomData() 的结构数据源

    // 现状（容器 / 路 / 墙永远为空）
    structures: room.find(FIND_MY_STRUCTURES),
    d.containers = d.structures.filter(s => s.structureType === STRUCTURE_CONTAINER);

    // 建议
    const structures = room.find(FIND_STRUCTURES);          // 含容器 / 路 / 墙
    d.structures   = structures;
    d.myStructures = room.find(FIND_MY_STRUCTURES);         // 只在需要"仅我方"时用
    d.containers   = structures.filter(s => s.structureType === STRUCTURE_CONTAINER);
    d.roads        = structures.filter(s => s.structureType === STRUCTURE_ROAD);

- **预期收益（上线后立刻可测）**：containerized 0→1 ⇒ quota 从 {h:4, bui:2, …:0} 变成含 miner/hauler/upgrader 的配置 ⇒ **升级从 0 变成 1–2 progress/tick**；矿工 / 搬运工 / 续杯链路全部激活；容器开始被使用与维修。
- **风险**：低。deliverEnergy() 遍历 data.extensions / data.towers 是"类型过滤"，改成全集后行为不变（房间里只有我的扩展 / 塔）；repairSomething() 会开始修容器 / 路（这是好事，但会让 builder 分心，见 R3）。
- **验证**：上线后 python screeps_api.py memory fw.snapshot 看 structs 是否出现 container；再采样 5 分钟确认 fw.ct.upgrade 开始增长。

### R1【P0，1 行】【已采用 ✓】修 economy.js computeQuota() 的裁剪顺序（builder 不能第一个被牺牲）

    // 现状：builder 第一个被砍
    if (quota.builder > 0) { quota.builder--; total--; continue; }

    // 建议：有工地时 builder 至少保留 1 个，从"最不缺的"开始砍
    const TRIM_ORDER = ['harvester', 'upgrader', 'hauler', 'builder'];   // builder 最后
    while (total > cap) {
        let trimmed = false;
        for (const r of TRIM_ORDER) {
            const floor = (r === 'builder' && data.sites.length > 0) ? 1 : 0;
            if (quota[r] > floor) { quota[r]--; total--; trimmed = true; break; }
        }
        if (!trimmed) break;
    }

- **收益**：保证"建造永不归零"，是 R2 / R3 生效的前提。没有它，R0 反而会让建造停下来（能力倒退）。
- **风险**：极低；可能少 1 个 harvester（-1.1 E/tick），但换来 5 progress/tick 的建造力，几十 tick 回本。
- **验证**：node quota_model.js（已写好）会打印各 cap 下的配额。

### R2【P1，性价比最高】先把 2 个扩展建完：cap 300 → 400

- 成本：2 × 3000 progress，现有两处工地已有 539 / 600 底子 ⇒ **实际还差约 4 860 progress（≈970 能量）**。
- 收益：planBody(harvester, 400) = 2W2C2M，单兵 **1.11 → 1.54 E/tick（+39%）**；人口上限 7 → 8。

| 投入 | progress | 折算能量 | 收入增量 | 回本 |
|---|---|---|---|---|
| **前 2 个扩展（cap→400）** | ~4 860 | ~970 | **+2.1 E/tick** | **~460 tick** |
| 后 3 个扩展（cap→550） | 9 000 | 1 800 | +1.1 E/tick | ~1 600 tick |
| 源 A 容器（已完成） | 985 | 197 | cap300 下只 +0.9；**cap550 下 +6** | 视 cap 而定 |
| 控制器容器（剩 4 057） | 4 057 | 811 | 升级者由"走 31 格自采"变"原地续杯"：+1.0 → +2.0 progress/tick | ~2 000 tick |
| RCL3（45000） | 45 000 | 45 000 | 不直接加产能，解锁塔 / 路 / 上限 | — |

- **行动**：把 4 个扩展工地按进度排（539 → 600 → 0 → 0），**暂时把两个容器工地降级**（cap 550 之前收益小）。
- **风险**：低。唯一代价是 miner/hauler 体系晚 ~30 分钟，但 cap 400 的增益立即且确定。

### R3【P1】修 builder 效率：就近取能量 + 不要跨 33 格打工地

1. roles.js builder() 空仓时：房间里有任何**已建成容器 / 仓储 ≥50 能量**就走 nearestEnergyStore，而不是 harvestSource（R0 之后才有意义）。
2. utils.js buildSomething()：把"类型优先"改成加权分数（类型优先级 × 系数 + 距离），避免被 33 格外的容器工地吸走。
3. economy.js planConstruction()：siteCount() >= siteLimit 与实测 7 个工地冲突，规划器永久 early-return（连 RCL3 的塔 / 路都规划不出来）。建议在 runRoom 加"工地清理"：对 progress=0 且非关键类型的工地 site.remove()（**写操作，需 Lead 决定**），或把口径改成"仅统计本房间计划内的类型"。

- **收益**：建造速率 4.19 → 7–9 progress/tick，21 100 progress 的剩余工作从 1.4 h 压到 40 分钟以内。
- **风险**：1、2 纯代码无状态风险；3 涉及工地删除，中风险。

### R4【P2】容器体系要和 cap 550 配套，别在 cap 300 上切

实测配额转化后的实际产能（cap 300、1 个容器可见）：miner 1W2C2M → 站桩 **2.00 E/tick**（零走路）；hauler 4C2M → **5.00 E/tick**（200 载重 / 40 tick）；只剩 2 个 harvester = 2.22。

⇒ 收入 ≈ **4.2 E/tick，比现在的 6.12 还低**（因为 cap 300 下 miner 只有 1 WORK、hauler 只有 200 载重，而 harvester 被砍到 2 个）。

**cap 550 时才反转**（miner 3W → 6 E/tick，hauler 7C4M → 8.75 E/tick）：

| 配置 | 收入 | 升级 | RCL3 预计 |
|---|---|---|---|
| 现状（5×1.11，0 升级） | 6.1 | **0** | **永不** |
| cap 400（5×1.54）+ R0 后的 1 个自采 upgrader | 7.7 | 1.3 progress/tick | 35 000 tick（9.7 h） |
| cap 550（4×1.76）+ 2 个自采 upgrader | 7.0 | 4.7 progress/tick | 9 600 tick（2.7 h） |
| cap 550 + 2 容器（2 miner + 2 hauler）+ 2 个"喂饱的" upgrader | **12.0** | **6.0 progress/tick** | **7 500 tick（2.1 h）** |
| 上表 + RCL3 后铺路（往返减半） | **20.0**（天花板） | 9.0（3 个 upgrader） | 5 000 tick（1.4 h） |

模型：自采自送 = CARRY/(CARRY/(2·WORK) + 40)；矿工 = 2·WORK；搬运 = CARRY/40；喂饱的升级者 = WORK progress/tick。全部用线上 planBody 的真实输出（quota_out.txt）。

### R5【P2】升级抖动：给 harvester 加"任务粘性"

代码里到处在写 creep.memory.task，**但没有任何地方读它**（写而不用的空转字段）。最小改动：

    // roles.js harvester() 满载分支开头
    if (creep.memory.task === 'upgrade' && utils.freeCap(creep) >= 50) {
        utils.upgradeController(creep, data.room);
        return;                       // 咬住升级目标，直到手上的能量基本花完
    }

- **收益**：在 R0 生效但容器体系尚未成型之前，把"0 升级"变成稳定 1–2 progress/tick。
- **风险**：低。退出条件 freeCap >= 50 保证不会卡死；建议再加 creep.memory.taskUntil = Game.time + 100 的兜底。

### R6【P3】指标与死代码（决定后续调参速度）

1. utils.buildSomething() / repairSomething() 在 r === OK 分支补 bump('build') / bump('repair')（现在低报 **6.7 倍**，任何用它调参都会被误导）。
2. Memory.fw.ct 无窗口（since 永远是 42833）：建议每 200 tick 把窗口值落到 Memory.fw.ctWin 再清零，外部直接读速率。
3. status.snapshot() 每 5 tick 写全量（含所有 creep / site）→ Memory 写放大，建议 20–25 tick。
4. economy.runTowers() 已被 defense.run 取代但没删（死代码 + 双份维修阈值逻辑），建议删掉。
5. utils.pickSource() 与 economy.assignSource() 是两套重复的负载均衡（一个带粘性、一个不带，且 builder 计不计入负载不一致）⇒ 实测矿源 A 4 人 / B 1 人，B 几乎满仓浪费。建议合并到 utils 一份实现。
6. economy.planRoads() 硬编码 if (roadSites >= 3) return; ⇒ RCL3 后**最多只规划 3 块路**，等于没路。应改成受 siteLimit 约束 + 分段推进，否则 RCL3 的 -50% 往返红利拿不到。
7. 新增"能量流水账"：在 transferTo / deliverEnergy / spawnCreep 处累加 Memory.fw.ledger.{harvested, delivered, built, upgraded, spawned, diedWithEnergy}，可彻底消掉 §8 的 ~2.9 E/tick 残差。

### R7【P3】移动与寻路（把 31% 的移动失败压下去）

1. utils.moveTo()：ignoreCreeps: false → true（7 个 creep 不再互相绕路、不被逼进沼泽），配"被挡则 creep.move 朝目标方向"的兜底。
2. config.pathReuse: 8 → 15–20（减少重算导致的绕路）。
3. planRoads 里的 room.findPath 每 tick 每 target 都跑一次 → 加缓存。
4. planBody()：cost + 50 <= energy 时多塞 1 个 MOVE，根治"刚好临界"的疲劳。

### R8【P0，部署后最紧急，1 行】upgrader 不要再往 spawn 倒货

roles.js upgrader() 满载分支（线上部署代码，roles.js 5129 chars 未变）：

    // 没有容器体系时（RCL1）先补 spawn/扩展，别让 spawn 干等
    if (utils.deliverEnergy(creep, data)) return;      // ← 就是这一句
    if (utils.buildSomething(creep, data)) return;
    utils.upgradeController(creep, data.room);

后果（实测）：升级者背着 100 能量走 33 格到控制器附近，`deliverEnergy()` 会优先找 spawn/extension 的缺口 —— spawn 恰好常年 0–300 振荡，于是一路把能量倒给 spawn，然后空手走回矿源。**231 tick 只成功升级 15 点（0.065 progress/tick）**，而按 "1 能量 = 1 progress + 26 格往返" 的理论值应有 0.9 progress/tick，**差 14 倍**。

建议（二选一，都只有 1 行）：

    // 方案 A：升级者完全不管 spawn（交付是 harvester / hauler 的职责）
    // if (utils.deliverEnergy(creep, data)) return;   ← 删掉
    // 方案 B：只在 spawn 完全空（< 50）时才顺路交付
    if (creep.room.energyAvailable < 50 && utils.deliverEnergy(creep, data)) return;

- **预期收益**：升级速率 0.065 → **0.8–0.9 progress/tick（约 +13 倍）**；RCL3 的 ETA 从 69 万 tick（8 天）压到 ~5 万 tick（14 小时），配合 R2/R3 再压到小时级。
- **风险**：低。前提是 harvester/hauler 仍在给 spawn 供货（实测 spawn 频繁满仓 300/300，说明供给充足）。
- **验证**：部署后 5 分钟内看 `python screeps_api.py memory fw.ct` 的 upgrade 是否从 468 持续上涨，以及 controller progress 是否 > 0.5/tick。

---

## 5. Bug / 反模式清单（函数级）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 0 | utils.js roomData() | FIND_MY_STRUCTURES 不含容器 / 路 / 墙 ⇒ data.containers 恒空 | **整套容器经济死掉；0 升级（P0 根因）—— 已修复 ✓** |
| 1 | economy.js computeQuota() | 裁剪时 builder 第一个被砍，cap 300 下变 0 | 建造永久停摆 —— 已修复 ✓（trimOrder + floors） |
| 2 | economy.js computeQuota() | quota.upgrader = containerized>0 ? … : 0 | RCL2 全程 0 升级者 —— 随 #0 一起修好 ✓ |
| 2b | **roles.js upgrader()** | 满载分支第一句 deliverEnergy() 把能量倒给 spawn | **升级速率只有理论值 1/14（0.065 vs 0.9 progress/tick）—— 现在最紧急（R8）** |
| 3 | utils.js planBody() | filler 固定顺序优先 WORK；350 / 550 两档吞吐**倒退**（0.95<1.11、1.76<1.94） | -10~14% 收入 |
| 4 | utils.js buildSomething() / repairSomething() | 成功时不 bump() | 指标低报 6.7 倍，误导调参 |
| 5 | roles.js harvester() / upgrader() | 满载 / 空仓每 tick 重决策；memory.task 写而不读 | 目标抖动，844 tick 0 次升级 |
| 6 | economy.js planConstruction() | data.sites.length 与 siteLimit=3 冲突（实际 7 个工地） | 规划器永久 early-return（RCL3 的塔 / 路永远规划不出来） |
| 7 | economy.js planRoads() | roadSites >= 3 硬编码 | RCL3 后最多 3 块路 |
| 8 | economy.js runTowers() | 被 defense.run 取代但未删 | 死代码 + 双份维修阈值 |
| 9 | utils.js pickSource() vs economy.js assignSource() | 两套重复负载均衡，口径不一致 | 矿源 A 4 人 / B 1 人 |
| 10 | Memory.fw.ct | 无窗口重置 | 外部只能算全局均值 |
| 11 | utils.js moveTo() | ignoreCreeps:false + reusePath:8 + MOVE 无余量 | 31% 移动调用 ERR_TIRED |
| 12 | utils.js / roles.js | withdrawErr_-7（ERR_INVALID_TARGET）累计 34 次 | transferFrom 被传入不可取目标，建议加断言 |
| 13 | economy.js spawnSurplus() | 人口达 cap 后永远 return | spawn 满仓 300/300 + idle |
| 14 | utils.roomData() 缓存于 global.__fwCache | 代码热更新后 global 重置但 Memory 不清，Memory.fw.ct 永久累计 | 需要 R6-2 的窗口化 |

---

## 6. 任务六问速查

1. **收入多少、花在哪**：**6.12 E/tick**（天花板 20，利用率 31%）；造兵换代 2.13（长期 1.40，23–35%）> 建造 0.84（14%）> 升级 **0** > 死亡携带 0.25；余下 ~2.9 未能核销（见 §8）。
2. **升级速率 / RCL3 还要多久**：基线（R0 修复前）**0 progress/tick，永不**。R0/R1 部署后实测 **0.065 progress/tick**（还差 14 倍，卡在 R8）。修掉 R8 → 0.8–0.9/tick（≈14 h 到 RCL3）；再叠加 R2（cap 400）+ R3（建造效率）+ R4（cap 550 + 容器 + 2 喂饱 upgrader）→ 6 progress/tick ≈ **2.1 小时**，铺路后 9/tick → 1.4 小时。
3. **时间花在哪 / 最大浪费**：采集 43.7% + **移动 29.4%** + 建造 12.0% + 空转 14.9% + 升级 0。最大两笔浪费：① 每趟 40 tick 纯走路（占 harvester 寿命 44%）；② 31% 移动调用因疲劳失败（≈15% creep-tick）。
4. **建造投资回报**：见 §4-R2 表。**前 2 个扩展 ROI 最高（4 860 progress 换 +2.1 E/tick，~460 tick 回本）**；容器在 cap 300 下只值 +0.9 E/tick，cap 550 下才 +6 ⇒ **当前"先容器后扩展"的优先级是反的**。
5. **配额与身体是否最优**：cap 300 下 1W2C2M 已是最优（1.11 E/tick），真正的问题是 **cap 太低 + planBody 在 350 / 550 台阶倒退**。推荐 roster：cap 400 = 5 harvester + 1 builder + 1 备；cap 550 = 2 miner + 2 hauler + 2 upgrader + 2 builder（8/9）。**不要**在 cap 300 切到 miner/hauler（会掉到 4.2）。
6. **明显 bug / 反模式**：见 §5 的 15 条，其中 #0 是根因。

---

## 7. 复现与产物

    cd D:\Projects\.meta\dynesshely\frightening-wind\api    # token 自动刷新（客户端需在运行）
    python screeps_api.py state --room W3N8

    cd ..\analysis
    python sample.py --interval 45 --count 40    # 只读采样（45s 一次）
    python analyze.py                            # 账本 / 速率 / 时间分配
    python speed.py ; python scen.py             # 速度实测 / 场景对比
    node body_model.js ; node quota_model.js     # 用线上部署代码跑 planBody / computeQuota

| 文件 | 内容 |
|---|---|
| samples.jsonl | 原始采样点（tick / controller / spawn / 每个 creep 的位置·能量·身体·任务 / 工地进度 / 矿源 / fw.ct） |
| deployed_code/ | 线上部署代码快照（分析基线，含 _meta.json 的 tick 与 SHA1） |
| analyze.py · analyze_out.txt | 能量账本、动作速率、时间分配 |
| body_model.js · body_out.txt | 各预算下 planBody 的精确输出与单位产能 |
| quota_model.js · quota_out.txt | 各 cap 下 computeQuota 的精确输出（B2 / R1 的证据） |
| sample.py · speed.py · scen.py · model.py · _terrain.py | 采样 / 速度实测 / 场景模型 / 地形距离 |

## 8. 局限与待验证

1. **~2.9 E/tick 的能量去向未能核销**（采矿 6.1，可核销 3.2–3.6）。最可能藏在：死亡 creep 死前最后一刻的携带（采样看不到）、transfer 的金额未知（只统计次数）、harvester 在 CARRY 非满时的 1 能量溢出。建议按 R6-7 加"能量流水账"后重算——这是唯一会改变 §2.3 占比结构的待查项。
2. **31% ERR_TIRED 的根因未 100% 钉死**（已排除"整段路在沼泽"：140 个采样位置 100% plain）。建议在 utils.moveTo 的 ERR_TIRED 分支把 creep.body / terrain / fatigue 写进 Memory.fw.tiredLog（环形 20 条），我可以用同样方式只读回采定位。
3. room-objects 不含 ticksToLive，造兵成本用"窗口内重生产"与"身体总成本 / 1500 TTL"两种口径，长期值取 1.40 E/tick。
4. 分析期间线上代码被部署了新版（6→7 模块，新增 defense.js）。实时数据跨越两版，但 **R0 / B1 在两版里都成立**（roomData / computeQuota 逻辑未变）；若继续改这两处，请用 node quota_model.js 复跑确认。
5. 场景模型的 RCL3 预计假设"能量优先供控制器"；实际还要分给 builder 与造兵，真实时间会长 20–40%。


---

## 9. 部署后 A/B 实测（最强证据）

Lead 在 **tick ≈45 77x** 部署了修复版（utils.js 新增 `allStructures: findSafe(room, FIND_STRUCTURES)`、`d.containers` 改从中立结构取；computeQuota 改成 trimOrder + floors；creepCap 4+ → 5+）。同一套采样口径切分前后：

| 指标 | 修复前 tick 44 746–45 732（986 tick） | 修复后 tick 45 777–46 008（231 tick） | 变化 |
|---|---|---|---|
| 角色构成 | harvester 5 + builder 2（无 miner/hauler/upgrader） | **miner 1 + hauler 2 + harvester 2 + builder 2 + upgrader 1** | 容器经济已激活 ✓ |
| controller progress | **+0 / 986 tick = 0.000 /tick** | **+15 / 231 tick = 0.065 /tick** | 从"永不"变成"动" ✓ |
| upgrade OK | 0 | 15 | ✓ |
| 毛采集 | 3.01 creep-tick/tick → **6.0 E/tick** | 2.26 → **4.5 E/tick** | **-25%（R4 预测成立）** |
| 空转占比 | 27.7% | **48.8%** | 恶化（2 个 hauler 货源不足，长期 💤） |
| ERR_TIRED 失败率 | 31% | 29% | 未改善（R7 未做） |
| 人口 | 7 | 8（creepCap 提到 5+） | ✓ |

**结论**

1. **R0/R1 的修复方向完全正确且必要**：没有它，升级永远是 0；有它，升级链路第一次被点亮。
2. **但它是必要条件、不是充分条件**：cap 300 的身体太小，容器路线（1W 矿工 2 E/tick + 2 个 hauler 抢 2 E/tick 货源）把收入从 6.0 拖到 4.5、空转率翻倍 —— 这正是 §4-R4 事先算出来的结论（预测 4.2 E/tick，实测 4.5）。
3. **下一步顺序不能错**：① R8 修 upgrader 的 deliverEnergy（升级速率 ×13）；② R2 建 2 个扩展到 cap 400（单兵 +39%、creepCap 9、矿工 2W）；③ R3 提建造速率 + cap 300 期间把 hauler 配额降到 1，把名额还给 harvester。

> 这一段是"建议有效"的直接证据，也提醒：**在 cap 300 阶段不要扩大 miner/hauler 配额**，否则会用 48.8% 的空转换取一个 0.065 progress/tick 的升级。
