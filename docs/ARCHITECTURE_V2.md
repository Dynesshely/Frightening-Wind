# ARCHITECTURE V2 —— 预算驱动的五层架构

> 本文件是重构的**接口契约**。所有实现必须遵守，不要各自发明接口。
> 依据：`modeling/ANALYSIS.md` 的结论（η 是唯一生产力、能量是唯一预算、每个决策都有 ROI）。

## 0. 一句话

旧架构：**按角色配额 + 各部门自己花钱**。
新架构：**按能量预算 + 中央分配 + 用 η 闭环**。

## 1. 五层与文件

| 层 | 文件 | 职责 | 允许依赖 |
| --- | --- | --- | --- |
| L0 观测 | `core.ledger.js` | 每 tick 流水、滑动窗口统计 | config |
| L1 估计 | `core.estimator.js` | 模型公式的 JS 版（纯函数） | config |
| L2 决策 | `core.budget.js` + `core.policy.js` | 预算分配、配置求解 | config, core.ledger, core.estimator |
| L3 执行 | `core.task.js` + 改造后的 `roles.js` | 任务队列、角色取任务 | 上面全部 + utils |
| L4 驱动 | `fw.nav` / `fw.store` / `fw.build` | **不改** | config |

**铁律**：
- L4（nav/store/build）一行都不许改。
- `main.js` 不许改。
- 所有新行为必须能被 `config.core.v2` 关掉（false 时走旧的 quota/economy 路径）。

## 2. L0 账本 `core.ledger.js`

每 tick 记录能量收支，**滑动窗口 300 tick**。

```js
// 写入（每 room 每 tick 一次）
ledger.record(roomName, {
    income:  { harvest, passive, link },     // 收入分项（e/tick）
    spend:   { spawn, upkeep, upgrade, build, tower }, // 支出分项
    state:   { stored, creepCount, workActive }        // 状态量
});

// 读取（返回窗口内的滚动平均 + 总计）
ledger.snapshot(roomName) → {
    income:    number,   // 平均收入 e/tick
    spend:     number,   // 平均支出 e/tick
    net:       number,   // income - spend
    eta:       number,   // 实际产出 / 理论产能（0..1）
    upkeepDebt:number,   // 维护负债 e/tick
    samples:   number
}
```

存储：`Memory.fw.ledger2[roomName]{ring: [...], head}` 环形缓冲，最多 300 条，**不要存对象数组超过 300**（Memory 有大小限制）。

## 3. L1 估计器 `core.estimator.js`

纯函数，无副作用，可直接单测。

```js
yieldOf(nWork, q)     // Y = q / (q/(2n) + 300)          fig20/fig72
workFor(targetY, q)   // n = q·Y / (2·(q − 300·Y)) 反解    fig20
                      // （原契约写成了 q*300/(2*(q−Y))，量纲错：q 是能量、Y 是 e/tick）
bodyCost(parts)       // Σ 造价
bodyWeight(parts, loaded) // 非 MOVE 部件数（空 CARRY 不计）
tileTicks(parts, terrain, loaded) // ceil(w*c/(2*m))      fig01
tripTicks(parts, steps, terrain)  // 往返（满载去空载回）  fig70
haulersFor(rate, steps, terrain)  // ceil(rate / throughput)
throughput(parts, steps, terrain)// 50*n_carry / trip
upkeepDebt(structs)   // Σ 折旧率 × 0.01                   fig83
linkThroughput(d)     // 776 / d                           fig85
repairCostPerTick(hitsPerTick) // hits * 0.01
```

## 4. L2 预算 `core.budget.js`

**唯一**决定"谁花多少"的地方。按 ROI 从高到低分配。

```js
budget.allocate(room, data, snap) → {
    total,              // 可支配 e/tick
    upkeep,             // 硬约束：维护负债（不足则要求降级基建）
    spawn,              // 繁殖预算（ROI 4.72，最高）
    upgrade,            // 升级预算
    build,              // 建造预算（有门槛）
    defense,            // 防御储备（按入侵频率）
    reserve             // 其余（pixel / 市场）
}
```

规则：
- `total = snap.net`（窗口净收入），不足时为负 → 触发"收缩模式"
- `upkeep = snap.upkeepDebt`，若 `upkeep > total * 0.3` 则返回 `overBudget: true`，由 policy 决定砍哪类结构
- 剩余按 `spawn 0.5 / upgrade 0.3 / build 0.15 / defense 0.05` 分配（比例进 config）

## 5. L2 策略 `core.policy.js`

把预算解成配置，**不写死人数**。

```js
policy.plan(room, data, snap, bud) → {
    target: { yield, haulerRate },        // 目标速率
    roles:  { miner, hauler, upgrader, builder, ... }, // 目标人数
    bodies: { miner: [...], hauler: [...] },           // 目标 body
    etaMode: 'optimize' | 'expand',       // η<0.4 禁止扩军
    upkeepCap: { rampart, container, road } // 各类结构数量上限
}
```

关键规则（都来自模型）：
1. `eta = snap.eta`；`eta < 0.4` → `etaMode='optimize'`，roles 不增长，只优化动线
2. body 的 MOVE 配比用 **1:1**（平地满速），不是 1:2
3. `n_work = workFor(targetYield, q)`，`n_miner = ceil(n_work / 5)`
4. `n_hauler = max(1, haulersFor(yieldPerSource, steps, terrain))`
5. `upkeepCap`：按 `budget.upkeep / 单件成本` 反解"最多养几段"

## 6. L3 任务 `core.task.js`

```js
// Task 是一个可比较、可度量的对象
{ type, targetId, priority, created, deadline, estGain, estCost }

task.push(roomName, task)
task.pick(creep, data)    // 按 priority × ROI 给 creep 挑一个
task.finish(creep, ok)    // 记录实际耗时 → 反馈给 ledger 的 η
```

任务类型（第一批）：`harvest` / `haul` / `upgrade` / `build` / `repair` / `renew` / `recycle`

## 7. 集成点（只在两处 hook）

1. `economy.runRoom` 每 tick 结束前调 `ledger.record`
2. `roles.run` 在分发角色前，若 `config.core.v2` 为真则先问 `task.pick`

**其它地方一律不动**。

## 8. 验收

| 项 | 标准 |
| --- | --- |
| 回归 | `node all.js` 全绿（离线 harness） |
| 灰度 | `config.core.v2 = false` 时行为与现在完全一致 |
| 单测 | estimator 的 6 个纯函数在 `harness/` 里有用例 |
| 线上 | 本地服务器跑 2 小时，η 有提升且无异常 |
