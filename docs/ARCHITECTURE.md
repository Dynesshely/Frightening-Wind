# Frightening-Wind 架构说明

> 本文描述 **当前** 的模块划分、分层依赖、导航层的意图模型，以及几条用事故换来的铁律。
> 模块名、字段名、函数名均以 `src/` 里的实际代码为准；改动架构时请同步改本文。
> 规模随迭代变化（当前约 40 个模块 / 5600 行），**以模块名与依赖关系为准确信息，不要参考行数**。

---

## 1. 一句话架构

分层 + 门面。历史上十几个"巨石文件"（utils 725 行、defense 748 行、roles.military 554 行、
roles 485 行、economy 483 行）已按职责拆成一模块一职责；对外入口用**门面**保留旧键名，
所以调用点一行没改，行为不变。

```
+----------------------------------------------------------------------------+
| 入口    main.js         循环编排 + 每处调用的 try/catch 隔离                  |
|         status.js       控制台报告 / 遥测快照                                |
+----------------------------------------------------------------------------+
| 编排    economy.js      housekeeping / ownedRooms / runRoom（门面）          |
|         mgr.room  mgr.spawn  mgr.roster        房间侧 / 孵化 / 人口重排       |
|         quota  construction  war               配额 / 建造规划 / 战争        |
+----------------------------------------------------------------------------+
| 角色    roles.js        经济角色注册表（门面）                               |
|         role.harvester miner hauler builder upgrader remote reserve tidy     |
|         roles.military  军事角色注册表（门面）                               |
|         role.soldier patrol scout recon pioneer                             |
|         defense.js      防御编排（门面）                                     |
|         mgr.tower  mgr.wall  mgr.flee         塔 / 工事 / 撤退               |
+----------------------------------------------------------------------------+
| 门面    utils.js        历史导出聚合，只转发；moveTo / say 是纪律入口          |
+----------------------------------------------------------------------------+
| 动作    fw.nav          ★ 全库唯一移动入口（意图模型）                       |
|         fw.store  fw.build                     能量流 / 建造维修升级         |
| 基础    fw.log  fw.room  fw.geo  fw.body  fw.threat  fw.slot  fw.intel   |
+----------------------------------------------------------------------------+
| 参数    config.js       唯一参数来源                                         |
+----------------------------------------------------------------------------+
```

（同层之间只有单向边：`quota → war`、`quota → construction`、`mgr.* → quota/construction`，
以及 `role.builder/upgrader → role.harvester`、`role.soldier → role.patrol` 这几条复用边。）

依赖**只允许自上而下**。任何"从下层 require 上层"的写法都是 bug（会在 Screeps 里表现为
循环 require 得到空对象，崩溃点离现场很远，极难排查）。

---

## 2. 分层与每层的禁令

### L0 · 参数层

| 模块 | 职责 |
|---|---|
| `config.js` | 全部可调参数：身体配置、配额与优先级、阈值、战争策略、导航参数 |

**禁令**：不放逻辑，只放数据。任何新阈值都必须在这里，不允许散落在角色里当魔法数字。

### L1 · 基础设施层（纯计算 / 只读 / 日志）

| 模块 | 职责 |
|---|---|
| `fw.log` | 统一可观测性：计数器 `ct`/`add`、说话 `say`、告警 `alert`、定期整理 `maintain` |
| `fw.geo` | 地形与可达性：`accessCount` / `wouldBlockAccess`（封路判定） |
| `fw.room` | 房间快照 `roomData`（每 tick 每房一次 find）+ `classifyHostiles`（敌对分级，只分类不决策） |
| `fw.body` | 身体成本 `bodyCost` / 组装 `planBody` / 反推 `inferRole` `countRole` |
| `fw.threat` | 防御侧威胁认知：威胁分类、`isEmergency`、安全模式、`Memory.fw.defense` 读写、共享原语 |
| `fw.slot` | 采矿站位：可用格计算、独占分配、远程容器探位 |
| `fw.intel` | 房间情报：`recordIntel` / `getIntel` / 扩张候选 |

**禁令**：
- 不得写 `creep.moveTo` / `creep.move`；
- 不得读写业务记忆（`fw.log` 写 `Memory.fw.ct`/`alerts`、`fw.threat` 写 `Memory.fw.defense` 是唯一例外，属于本层职责）；
- 不得 require `utils`（会成环：utils 在本层之上）；
- `fw.geo` / `fw.threat` / `fw.slot` / `fw.intel` 目前零 require，请保持这个性质。

### L2 · 动作层（会动、会花能量）

| 模块 | 职责 |
|---|---|
| `fw.nav` | **全库唯一移动入口**：意图模型 + 出口格锁定 + 停滞/振荡处理 |
| `fw.store` | 能量流：库存读写、`isWorking` 状态机、采集/取货/交付/倾倒 |
| `fw.build` | 建造/维修/升级：`buildSomething` `buildNearby` `repairSomething` `upgradeController` |

**禁令**：
- ★ **只有 `fw.nav` 可以调用 `creep.moveTo` / `creep.move`**。其它任何模块、任何角色，
  一律走 `utils.moveTo` / `utils.moveToRoom`（它们只转发到 `fw.nav`）；
- `fw.store` / `fw.build` 只能调 `fw.nav` 的接口，不得自己实现寻路或"卡住重试"；
- 动作层不读 `Memory` 业务字段（`fw.nav` 读写自己的 `creep.memory.nav` 属于本层职责）。

### L3 · 门面层

| 模块 | 职责 |
|---|---|
| `utils.js` | 历史导出全部保留的聚合门面：`roomData`、能量链、`moveTo`/`moveToRoom`、`say`、`planBody`、`classifyHostiles`、站位与情报等 |

**禁令**：
- 本文件**只做转发**，不实现业务。新增能力请写进 `fw.*`，再在这里转出；
- `moveTo` / `moveToRoom` 是"纪律入口"，**不允许在里面加任何防抖/防卡/防越界补丁**——
  那类逻辑只允许存在于 `fw.nav` 一处；
- 不得 require 上层（`economy` / `roles` / `defense`）。

### L4 · 角色层（单单位行为）

经济角色（`roles` 门面按角色注册）：

| 模块 | 职责 |
|---|---|
| `role.harvester` | `harvester`（自采自送）+ `pickupLoose`（顺手捡漏，被建造者/升级者复用） |
| `role.miner` | `miner`：站定专属站位挖矿，满了倒 link / 容器 |
| `role.hauler` | `hauler`：容器/仓储 → spawn/扩展/塔 |
| `role.builder` | `builder`：建造 + 维修 |
| `role.upgrader` | `upgrader`：升级控制器，控制器旁容器等货 |
| `role.remote` | `remoteHarvester` + `remoteHauler`：远程采集与接驳 |
| `role.reserve` | `reserver` + `claimer`：预定 / 占领控制器 |
| `role.tidy` | `tidyNearby` + `runDemolishTask` + `bumpDemolish`：周边整理、抢险拆障 |

军事与扩张角色（`roles.military` 门面）：

| 模块 | 职责 |
|---|---|
| `role.soldier` | `soldier`（威胁分级 → 清场 → 拆障 → 转巡逻）+ `escort`（贴身护航） |
| `role.patrol` | `patroller` + `patrolRoute` + 清障原语 `keyNodes` / `firstBlocker` |
| `role.scout` | `scout` + `pickScoutTarget`：按情报新鲜度扫无主房间 |
| `role.recon` | `recon` + `pickReconTarget`：进危险/有主房间短期侦察 |
| `role.pioneer` | `pioneer`：新占房间建 spawn / 升控制器 |

防御执行层（`defense` 门面编排）：

| 模块 | 职责 |
|---|---|
| `mgr.tower` | 塔：打敌 → 治疗 → 维修 |
| `mgr.wall` | 防御工事规划（rampart/wall 工地、来敌方向、候选格打分） |
| `mgr.flee` | 撤退决策：触发、落点、状态清理、`isFleeing` |

**禁令**：
- 角色只能通过 `utils` 的现成动作干活，**不得直接 `creep.moveTo` / `creep.move`**；
- 不得 require `economy` / `main` / `status`；
- 角色之间只允许**单向**复用（现存只有三条：`role.builder → role.harvester`、
  `role.upgrader → role.harvester`、`role.soldier → role.patrol`），不允许互相 require 成环；
- 一个角色一个文件，不要往 `roles` / `roles.military` 门面里加策略。

### L5 · 编排层（房间级决策）

| 模块 | 职责 |
|---|---|
| `economy`（门面） | `housekeeping`（全局清理/迁移）、`ownedRooms`、`runRoom`（单房间每 tick 编排骨架，**顺序即语义**） |
| `mgr.room` | 房间侧：能量流水账 `trackLedger`、威胁信号 `recordThreatSignals`、诊断 `writeDiag`、矿源分配 `assignSource` |
| `mgr.spawn` | 孵化：`tagSpawns`（贴标 + 利用率）、`runSpawns`（选兵/造兵/初始 memory）、`spawnSurplus` |
| `mgr.roster` | 人口重排：`rebalanceRoles`（缺口对比 + 就地转职）、`recycleSurplus`、`canDo` |
| `quota` | 配额推导与裁剪：`computeQuota` / `creepCap` / 远程目标挑选 |
| `construction` | 建造规划：容器/扩展/塔/link/道路/边境工事选址与建站、`runLinks` |
| `war` | 战争：战力评估 → 兵力反算 → 集结/出击、侵略度分档 |

**真实依赖边**（同层单向，无环）：
`economy → { defense, construction, quota, mgr.room, mgr.spawn, mgr.roster }`；
`mgr.room → { construction, quota }`；`mgr.spawn → { quota, mgr.room }`；
`mgr.roster → { quota, construction }`；`quota → { war, construction }`。

**禁令**：
- 编排层不写单角色策略（去 `role.*`）、不写单位动作（去 `utils`）；
- 不得 require `main` / `status`；
- `runRoom` 的调用顺序是语义的一部分，调整顺序必须同步复核 `Memory` 下游读取方。

### 顶层

| 模块 | 职责 |
|---|---|
| `main.js` | `module.exports.loop`：热更新检测 → `housekeeping` → 逐房间 `runRoom` → 逐 creep `roles.run`（跳过逃跑中）→ `status.report`/`snapshot`；每处调用都包 try/catch 并 `status.recordError` |
| `status.js` | 控制台报告（每 `config.reportInterval` tick）与遥测快照 |

**禁令**：`main` 只做编排与异常隔离，不写业务判断。

---

## 3. 导航层（`fw.nav`）：意图模型

### 3.1 为什么要有"意图"

旧实现里每个角色自己调 `creep.moveTo`，每个角色又各自维护一堆补丁
（`_lastPos` / `_lpos` / `_still` / `_stuck` / `_posHist` / `_rmTrail` / `_rmCool` /
`_edgeStuck` / `_jitter` / `_noPath` …）。这些补丁彼此不知情，还会互相篡改角色记忆
（例如清空 `targetRoom`），于是形成正反馈：

```
角色重新决策 → 目标还是它 → 再次触发保护 → 再清空 → 再决策 → 振荡
```

结果就是单位在房间边界左右横跳，越修越乱。根因不是某个补丁写错了，而是**系统里没有"意图"
这个东西**：每 tick 都重新决定去哪，且任何人都能推翻这个决定。

`fw.nav` 的解法：把"想去哪"固化成一个带序号、带过期时间的**承诺**（`creep.memory.nav`），
导航层只负责"怎么去"，角色层只负责"去哪"。

### 3.2 契约（五条，改代码前先读）

1. 角色层 `setIntent`（想去哪），导航层 `step`（怎么去）；
2. 导航层**只读**意图，**永不修改角色的业务记忆**（`targetRoom` / `patrolIndex` / `sourceId` …）；
3. 意图一旦建立，在"到达 / 显式清除 / 过期"之前**保持不变**——
   所以"每 tick 重新决策"这件事在结构上不可能发生；
4. 跨房间时锁定"下一个出口格"（`n.er` 记录它属于哪个房间），进入新房间才重算，
   中途任何情况都不会让它掉头；
5. 出问题时导航层只做两件事：**计数上报 + 拉黑不可达房间**。
   "换个目标"必须由角色层在明确的决策点完成。

### 3.3 字段（`creep.memory.nav`）

| 字段 | 含义 | 写入方 |
|---|---|---|
| `r` | 目标房间名 | `fw.nav` |
| `x`,`y` | 目标格 | `fw.nav` |
| `g` | 到达判定半径；`49` = 进房间即算到（`moveToRoom` 的语义） | `fw.nav` |
| `u` | 意图过期 tick（`config.nav.intentTtl`） | `fw.nav` |
| `s` | 意图序号，每次重建 +1（调试用） | `fw.nav` |
| `e` | 锁定的出口格 `{x,y,dir}`（`dir` = 朝外跨出去的方向） | `fw.nav` |
| `er` | `e` 属于哪个房间（房间变了才重算出口） | `fw.nav` |
| `p` | 上一次位置快照（停滞检测） | `fw.nav` |
| `st` | 连续未移动 tick 数 | `fw.nav` |
| `lr` | 上一个所在房间（房间切换检测） | `fw.nav` |
| `h` | 最近的房间切换 tick 列表（振荡检测，最多 8 个） | `fw.nav` |
| `hold` | 冻结跨房间移动到该 tick | `fw.nav` |
| `np` | 连续 `ERR_NO_PATH` 次数 | `fw.nav` |
| `k` | 出口格重试次数（用于换一个出口格） | `fw.nav` |

> ★ 只有 `fw.nav` 可以写 `creep.memory.nav`。角色层只读（或用 `clear` 显式清除）。

### 3.4 生命周期

```
setIntent(creep, room, x, y, range, ttl)
  ├─ 目标与 range 都没变 且 未过期  → 原样复用（这就是"不重新决策"）
  ├─ 没变但已过期                 → 续期 + 计 nav.overtime，交给角色层决定要不要放弃
  └─ 变了                        → 重置 e/er/np/k/st，序号 s+1，重算出口

step(creep, n)
  ├─ noteRoom：房间变了就记一笔，窗口内跨房次数过多 → hold 冻结跨房间移动
  ├─ 冻结中且不在目标房间 → 在房间内部待命（靠近中心），不碰边界
  ├─ 同房间 → 直达目标格（d <= g 即到达）
  └─ 跨房间（两步走，缺一不可）
       ① moveTo 到「本房间的出口格」——引擎必定能走到自己房间内的格子
       ② 站上出口格后 creep.move(dir) 朝外跨一步——这一步才是真正跨房间
       ★ ② 之后 step 返回 false（'在路上'），避免角色误以为已到位而立刻改主意

到达 / 过期 / clear(creep) → 意图结束
```

### 3.5 对外接口

| 函数 | 用途 |
|---|---|
| `moveTo(creep, target, {range, ttl})` | 移动到对象 / `RoomPosition` / `{x,y,roomName}`；目标在别房时自动跨房间 |
| `moveToRoom(creep, roomName)` | 跨房间，**进入目标房间即算到达**（内部 `g = 49`） |
| `setIntent` / `clear` / `step` | 意图三件套 |
| `arrived` / `targetRoom` / `expired` / `frozen` / `intent` | 状态查询（角色层用它判断"要不要重新决策"） |
| `unstick` | 8 方向脱困（少数需要"原地推一格"的场景） |

### 3.6 参数（`config.nav`）

`intentTtl` 120 · `stuckTicks` 3 · `giveUpAfter` 8 · `exitSpread` 3 ·
`oscWindow` 60 · `oscCount` 5 · `holdTicks` 120 · `holdRadius` 20。

改这些参数前先读 `fw.nav.js` 顶部注释——它们直接决定"会不会在房间边界来回穿梭"。

---

## 4. 必读踩坑记录

### 4.1 跨房间必须"两步走"：先到本房间出口格，再 `creep.move` 跨出去

这条踩坑记录最有价值的地方是：**两种看起来很合理的写法，线上都失败了**。

**错法一：把跨房间坐标（下一房间的入口格）直接喂给 `moveTo`。**
以为引擎会自己走完"当前房间 → 边界 → 跨越"。实测不成立：creep 在边界附近反复寻路失败，
`np` / `k` 计数暴涨到几百，最终触发 `giveUp` 把目标房间拉黑。
**跨房间的坐标不能直接喂给 `moveTo`。**

**错法二：只把 `moveTo` 指到当前房间的边界格。**
Screeps 里走到边界格**并不会**自动进入下一个房间——必须再朝外走一步。于是：

```
停在 (10,49) → 下一 tick 仍"不在目标房间" → 再算还是这格 → 被判停滞
→ 退回房间内部 → 再走出去 → 再停下 …… 在两个房间交界处横跳几十 tick
```

**现在的正确做法（`fw.nav.step` 的跨房间分支）：两步分开做，每一步都有确定的语义。**

1. `moveTo` 到**本房间的出口格**（`pickExit` 选：`Game.map.findRoute` → 出口方向 →
   `room.find(dir)` 取该侧边界格 → 按到自己的距离排序 → 按名字散列分流到
   `config.nav.exitSpread` 个格子上，避免全员挤同一个口）；
2. 站上出口格后，`creep.move(出口方向)` 真正跨出这一房间。

不依赖引擎的跨房间寻路能力，是这套实现能根治"边界横跳"的关键。
另外：跨出去那一步返回 `false`（表示"还在路上"），**不能返回 true** ——
否则角色会以为已经到位，立刻重新决策，又会掉头。

### 4.2 "已经在目标旁 1 格"不等于"卡住"

引擎的 `moveTo` 会停在目标相邻格（目标格被占时尤其如此）。如果停滞检测不区分这二者，
**静止挖矿/驻守的 creep 会被判成停滞 → 触发脱困 → 被随机踢开**，表现就是矿工在矿源周围
来回踱步、永远站不定。

实现见 `fw.nav.doMove` 开头：

- `d === 0` → 已在目标格，清停滞计数；
- `d === 1` 且 `g === 0`（要求踩到目标格）→ 继续尝试，但停滞达阈值后也放行（那格进不去）；
- `d === 1` 且 `g !== 0`（只要求靠近）→ 视为到位，清停滞计数。

**结论：新增任何"卡住"判定前，先想清楚它会不会误伤静止干活的单位。**

### 4.3 振荡保护只冻结"跨房间移动"，绝不清除目标

早期版本在检测到振荡时清空 `targetRoom`，结果制造了新问题："无目标 → 发呆"。
现在的做法是只设 `hold`，冻结跨房间移动 `config.nav.holdTicks` tick，目标一个字段都不动。

### 4.4 "发呆兜底"用背包变化判断是否真在干活

`roles.run` 末尾兜底：位置没变 + `lastSay` 没变 + `utils.usedCap(creep)` 没变，连续
`config.idleTicksBeforeHome`（12）tick 就强制回家待命。

为什么不能只看"没动"：矿工站在矿位上挖矿、升级者站在控制器旁升级，都是静止但完全正常的。
背包储量变化是"是否真在干活"的信号——挖矿会涨，建造/升级/搬运会掉，发呆纹丝不动。

★ 相关陷阱：`economy.housekeeping()` 的旧字段迁移（`Memory.fw.migratedV5` 门控）
**必须只跑一次**。它清理的旧字段里包含 `roles.run` 正在用的位置快照（`_st` / `_ik` /
`_idleTicks` 同类字段），每 tick 清一次会让发呆兜底永远失效（踩过：哨兵在边界站了 250 tick）。

---

## 5. 记忆规范

### 5.1 通用规则

- `Memory` 里**只存** tick 数字、id 字符串、`{x,y}` 坐标、短数组；
  **绝不存游戏对象**（用 `Game.getObjectById` 每次现取）。
- 全局业务状态统一挂在 `Memory.fw.*` 下，不要往 `Memory` 根上新增键。
- `creep.memory` 的键名用 camelCase；内部/瞬时字段用下划线前缀（`_ik` / `_st` / `_idleTicks`）。

### 5.2 `Memory.fw.*`

| 字段 | 用途 | 写入方 |
|---|---|---|
| `version` / `migratedV5` | 配置版本、一次性迁移门控 | `economy.housekeeping` |
| `ct` | 动作计数器（含 `since` / `until`），每 10000 tick 归零并留 `ctPrev` | `fw.log` |
| `ctFull` | 计数器键数触顶（`MAX_KEYS`）的时间戳，只记一次 | `fw.log` |
| `alerts` | 最近 20 条告警环形缓冲 | `fw.log.alert` |
| `errors` | 异常环形缓冲 | `status` |
| `snapshot` | 每 5 tick 的紧凑快照（RCL/能量/角色/工地/GCL/情报） | `status` |
| `ledger` / `ledgerLast` | 能量流水账与结账点（矿源差分算收入、进度差分算支出） | `mgr.room.trackLedger` |
| `diag` | 每 50 tick 的配额/容器化/结构/工地/角色统计 | `mgr.room.writeDiag` |
| `spawnUsage` / `spawnStat` / `spawnTags` | spawn 利用率、空闲统计、业务命名标签 | `mgr.spawn` |
| `patrolSquad` / `patrolRoute` | 巡逻规模、巡逻路线缓存（500 tick） | `mgr.room` / `role.patrol` |
| `lastHostile` / `homeUnderAttack` / `homeAttackAt` / `threatSeen` | 来敌方位、"老家被袭"信号、最近威胁时间 | `mgr.room` / `role.patrol` |
| `clearTarget` | 指定的跨房间清场目标 | `role.soldier` / `war` |
| `safeModeAt` | 安全模式最近触发 tick | `fw.threat` |
| `defense.rooms` | 房间防御记忆（威胁时间戳、工事状态），按房间名索引 | `fw.threat.trackRoom` |
| `intel` | 房间情报（`getIntel` 读） | `fw.intel.recordIntel` |
| `slotOf` / `slotPath` | 采矿站位分配与站位路径缓存 | `fw.slot` |
| `unreachable` | 不可达房间拉黑（`fw.nav.giveUp` 写入，配额侧避开） | ★ 只有 `fw.nav` |
| `war` | 战争状态（侵略度/目标） | `war` |
| `gclBlocked` | GCL 不足导致占房失败的时间戳 | `role.reserve` |

### 5.3 `creep.memory.*`

| 字段 | 用途 | 写入方 |
|---|---|---|
| `role` / `roleSince` | 当前角色、角色切换 tick | `mgr.roster` / `roles.run` 兜底 |
| `home` / `spawn` | 归属房间、出生 spawn | `mgr.spawn` / `housekeeping` |
| `targetRoom` / `sourceId` / `sector` | 远程目标房间、绑定矿源、巡逻扇区 | `mgr.spawn` / `role.remote` |
| `working` | 工作状态机缓存 | `fw.store` 相关路径 / `mgr.roster` 清理 |
| `task` | 任务标记（施工等） | `fw.build` |
| `lastSay` | 头顶文字（外部采样脚本读它判断状态） | ★ `fw.log.say` |
| `nav` | 导航意图（见第 3 节） | ★ 只有 `fw.nav` |
| `_ik` / `_st` / `_idleTicks` | 发呆兜底的位置键 / 背包快照 / 连续发呆数 | ★ 只有 `roles.run` |
| `patrolIndex` / `patrolSince` / `patrolEntered` / `patrolWp` | 巡逻进度 | `role.patrol` |
| `scoutTarget` / `reconTarget` / `reconBack` / `reconSince` | 侦察目标与撤离标记 | `role.scout` / `role.recon` |
| `idleSince` / `noEnemySince` | 闲置/无敌情起算 tick | `role.scout` / `mgr.roster` |
| `mineSlot` | 绑定的采矿站位 | `fw.slot` |
| `fleeUntil` / `fleeTarget` | 撤退截止 tick 与落点 | `mgr.flee` |
| `demolish` / `demolishTicks` / `tidyNext` | 抢险拆障目标、拆障计数、下次整理 tick | `role.tidy` |
| `recycle` | 待回收标记 | `mgr.roster` / `roles.run` |

---

## 6. 可观测性约定

1. **所有计数器走 `fw.log.ct(name)`**，累加走 `add(name, n)`。键名登记在 `fw.log.js` 的
   `KEYS` 里（导航 `nav.*`、经济 `work.*`、孵化 `spawn.*`，以及一批历史键名）。
   > 注意：`ct()` 目前**不做白名单校验**，真正的保护是 `MAX_KEYS`（120）上限 + `ctFull` 告警。
   > 所以"登记"仍是硬约定：不登记会悄悄消耗键位预算，而且看板读不到。
2. **任何"沉默降级"都必须配一条告警**：本该做某事却放弃了（目标不可达、振荡冻结、异常兜底），
   必须 `log.alert(kind, detail)`。`detail` 只放能定位问题的短数据（名字、房间、次数），不要塞大对象。
   现有例子：`nav.unreachable`、`nav.oscillate`。
3. **说话只走 `fw.log.say`**（`utils.say` 就是它）。它会同步写 `creep.memory.lastSay`，
   外部采样脚本靠这个字段判断角色在干什么——绕过它直接 `creep.say()` 等于让观测失真。
4. **异常不吞**：`main` 的 try/catch 只负责隔离与记录（`status.recordError`），
   不允许出现"catch 之后什么也不做"的写法。

---

## 7. 常见改动指引

| 想做的事 | 改哪里 | 注意 |
|---|---|---|
| 加一个角色 | 新建 `role.xxx.js` → 在 `roles.js`（经济）或 `roles.military.js`（军事）注册 → `config.bodies.xxx` 配身体 → `quota` 里给编制 | 导出键名要能被 `BEHAVIORS` 引用；不要往门面里写策略 |
| 加一种动作能力 | `fw.store` / `fw.build` 实现 → `utils.js` 转出 | 不得违反 L2 / L3 禁令 |
| 改移动行为 | **只改 `fw.nav`** | 先跑 `boundary.js`，确认"边界横跳 / 折返"没有回归 |
| 加可调参数 | `config.js` | 角色里不允许出现魔法数字 |
| 加一个计数器 | `fw.log.KEYS` 登记 + 调用点 `log.ct('x.y')` | 不要用动态键名（会撞 120 键上限） |
| 加一个管理器 | 在 `mgr.*` 新建，由 `economy.runRoom` 编排 | 注意 `runRoom` 顺序即语义 |

---

## 8. 自测清单（改完必跑）

工作目录 `D:\Projects\.meta\dynesshely\frightening-wind\harness`：

```
node check.js
node run.js --scenario=rcl3     --ticks=400 --quiet
node run.js --scenario=neighbor --ticks=400 --quiet
node run.js --scenario=enemy    --ticks=300 --quiet
node boundary.js
```

- `check.js` 与三个 `run.js` 必须 **exit 0**，且报告里"结果"为 **PASS（无异常）**；
- `boundary.js` 针对"单位在房间边境来回穿梭"这条最顽固缺陷做断言
  （房间切换次数 / 边界格占比 / 折返次数），是导航层改动唯一有效的回归。

场景全集见 `node run.js --list-scenarios`（rcl1 / rcl1-worker / rcl2 / rcl3 / rcl4 / rcl5 /
rcl-up / neighbor / enemy / empty，共 10 个）。

---

## 9. 三条不能碰的红线

1. **位移只走 `utils.moveTo` / `utils.moveToRoom`**（→ `fw.nav`）。
   除 `fw.nav` 外，全库任何地方出现 `creep.moveTo` / `creep.move` 都是缺陷。
2. **导航层之外不允许任何防抖 / 防卡 / 防越界补丁**。这类逻辑只存在于 `fw.nav` 一处，
   分散补丁正是上一版"越修越乱"的根因。
3. **`roles.run` 的发呆兜底与 `housekeeping` 的一次性迁移**是"单位站边界几百 tick"的
   最后一道防线，逻辑与门控条件都不许改。
