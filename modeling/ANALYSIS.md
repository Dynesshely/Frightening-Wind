# Screeps 数学建模分析报告

> 13 个模型 · **41 张图** · 依据官方文档全站（65 个页面 / 605 KB）与私服运行时实测。
> 复现方式：`cd modeling && python run_all.py`（约 6 秒）。
> 展开的公式推导见 [../docs/MODEL.md](../docs/MODEL.md)；机制出处见辅助产物目录的 `MECHANICS.md`。

![全部图表总览](output/overview.png)

---

## 0. 摘要

| 问题 | 模型给出的答案 |
| --- | --- |
| 这个房间的能量天花板 | 20 e/tick（2 个 source，Q=3000） |
| 实测收入 | 0.6–1.6 e/tick（有效工时占比 8–13%） |
| 差距在哪 | 不是产能，是调度：16 个 WORK 里只有 8% 的时间在矿位上 |
| 最大的隐性成本 | 维护税 3.41 e/tick（rampart 独占 3.00），是当前收入的 3 倍 |
| 最该先做的事 | 砍 rampart 段数、塔改成有敌情才开火、开启 pixel 兑换 |

---

## 1. 方法与数据来源

### 1.1 文档
官方文档全站已抓取到 `.meta/.../screeps-docs/full/`：28 个根章节 + 37 个 API 页，共 65 个页面。
`/api/` 单页 1.33 MB（含全部 Constants），转文本后 288,716 字符。

### 1.2 参数核对
`mw/params.py` 从 61 个常量补到 **80 个**，并与官方 Constants 逐项比对：**所有已有常量的值都正确**，
缺的是 16 个机制常量（renew 溢价、墓碑衰减、市场费率、safe mode 冷却等）。

### 1.3 偏差审计
审计发现 16 处模型与官方文档不一致：**8 处公式算错（A 级）+ 8 处整块缺失（B 级）**。
完整的量化见第 11 节。

---

## 2. 移动与空间

**公式**：每次移动 `φ += w·c(g)`，每 tick `φ -= 2·n_MOVE`，可动当且仅当 `φ=0`。
单格耗时 `T = ceil(w·c / (2·n_MOVE))`，满速条件 `2·n_MOVE ≥ w·c`。

![每格 tick 热力图](output/fig01_tile_ticks_heatmap.png)

**结论**：平地（c=2）满速需要 **MOVE ≥ 其他部件数（1:1）**，不是 1:2。这条之前写错了，
导致所有往返时间被低估 1.5 倍 —— 也是线上 31% 移动调用报 ERR_TIRED 的原因。

![载重对速度](output/fig02_speed_vs_cargo.png)

空 CARRY 不产生疲劳，所以**空车返程比满载去程快一倍**，这个不对称性决定了"单程 24 步"的真实代价。

![本房间往返](output/fig03_room_trip_ticks.png)

本房间：source A 24 步、source B 6 步。2C1M 在 source A 的往返是 72 tick（无路）/ 48 tick（有路）。

---

## 3. 人口与生命周期

**公式**：摊销 `ċ = cost/1500`；净产出 `Ė = 2·n_WORK·η − ċ`。

![造价与摊销](output/fig10_body_tradeoff.png)

![η 敏感性](output/fig11_eta_sensitivity.png)

**结论**：兵的数量不产生收益，只有 η（有效工时占比）产生收益。本房间 η ≈ 8%，
所以"加兵"在数学上是无效动作。

![人口成本构成](output/fig12_population_cost.png)

![孵化耗时](output/fig80_spawn_time.png)

**M04**：孵化 3 tick/部件，50 部件的巨兽要占 spawn 150 tick（50 秒墙钟）。

![续命 vs 重造](output/fig81_renew_vs_rebuild.png)

**M06/M07 反直觉结论**：续命和重造的单位 TTL 成本**完全相同**（2C1M 都是 0.100 能量/TTL）。
差别只在 spawn 占用时间（2.5N vs 3N tick）。而 renew 会**清空 boost**。

![回收天花板](output/fig82_recycle_limit.png)

回收返还上限 **125 能量/部件** —— 便宜身体能全额回收，昂贵身体会撞上天花板。

---

## 4. 采集

**公式**：`Y(n;Q) = Q / (Q/(2n) + 300)`，Q 由房间状态决定。

![矿工数与产出](output/fig20_source_yield.png)

**结论**：source 没有饱和点，只有边际递减。第 22 个 WORK 的边际产出才降到 WORK 的摊销成本。

![库存锯齿](output/fig21_regen_sawtooth.png)

![当前距离天花板](output/fig22_room_gap.png)

![三档容量](output/fig72_source_tiers.png)

**M08 修正**：source 容量分三档 —— 中立未预订 1500 / 已占或已预订 3000 / 中心房 4000。
远程房的天花板只有本房间的一半，这一点之前的模型完全没考虑。

---

## 5. 运输与物流

**公式**：`Thr = 50·n_CARRY / (T_空 + T_满 + 2)`

![距离与吞吐](output/fig30_hauler_throughput.png)

![需要几个 hauler](output/fig31_haulers_needed.png)

![修路回本](output/fig32_road_payback.png)

![link vs hauler](output/fig85_link_vs_hauler.png)

**结论**：吞吐上 link 是 hauler 的 20 倍以上（d=24 时 32.3 vs 1.35），永远不会被追上。
但**能量成本**在 9.3 格（无路）/ 14.0 格（有路）交叉 —— link 固定抽 3%，hauler 抽的是 body 摊销。

---

## 6. 建造与维护

![维护预算](output/fig83_upkeep_budget.png)

**M12 最关键的一条**：维护税被严重低估。

| 结构 | 折旧 | 能量成本 |
| --- | --- | --- |
| container（有主） | 5,000 hits / 500 tick | 0.10 e/tick/个 |
| container（无主） | 5,000 hits / 100 tick | 0.50 e/tick/个 |
| rampart | 300 hits / 100 tick | 0.03 e/tick/段 |
| road 平地 | 100 hits / 1000 tick + 交通项 | 0.001 e/tick/段起 |

参考配置总维护 **3.41 e/tick**，rampart 独占 3.00 —— 是当前收入的 3 倍。

![修路门槛](output/fig84_road_payback.png)

修路有交通量门槛：24 格路要求每 tick ≥0.0107 次通过（约每 94 tick 一次），低于这个量是纯亏。

![维护税全景](output/fig71_maintenance_truth.png)

**M12 修正**：rampart 建成时只有 1 hit，"修满 RCL4 上限（300 万 hits）"要 **30,000 能量/段** ——
之前写"修满免费"是彻底的误读。

---

## 7. 控制器与增长

![RCL 曲线](output/fig40_rcl_curve.png)

![到 RCL5 的时间](output/fig41_time_to_rcl5.png)

![收入场景对比](output/fig42_income_vs_rcl.png)

**M09/M10 修正**：
- 15 能量/tick 的升级上限**只约束已满级的 8 级控制器**，RCL2–7 无此限制；
- 升级/降级都把计时器设为上限的 **50%**，且**计时器不满无法升级**。

---

## 8. 防御与战斗

![塔的衰减](output/fig50_tower_falloff.png)

![维护税](output/fig51_maintenance_tax.png)

![攻城时间](output/fig52_siege_time.png)

![部件衰减](output/fig90_part_decay.png)

**M03**：伤害按 body 顺序削部件，能力是台阶式衰减。12 部件的兵承伤 600 后只剩 6 个活跃部件（火力 50%）。

![防御预算](output/fig91_defense_budget.png)

**M20 关键**：入侵不是"看敌情"，是**确定性支出** —— 每累计约 100,000 采出能量触发一次。

| 收入 | 入侵间隔 |
| --- | --- |
| 2 e/tick | 50,000 tick（4.6 小时） |
| 6 e/tick | 16,667 tick（1.5 小时） |
| 13 e/tick | 7,692 tick（43 分钟） |

![塔吃掉的产能](output/fig92_tower_supply.png)

**最反直觉的一条**：塔每座每 tick 吃 10 能量，**3 座 = 30 e/tick**，是当前全部收入的 26 倍。
塔不该常开。

---

## 9. 市场与后期

![跨房运费](output/fig86_market_transport.png)

**公式**：`r*(d) = (1 − e^(−d/30)) · 0.05 / (0.95 · p)`

**结论**：盈亏平衡由**价差**决定，不由手续费决定（两边都付 5%，互相抵消）。
本服地图 12×12（最远 11 格）：卖能量本身需要 32.3% 溢价才划算（基本不可行），
卖高价矿物只需 3.2%。

![矿物速率](output/fig87_mineral_income.png)

矿物长期速率 0.70 单位/tick，折能量只有 source 收入的 14% —— 不值得为矿花 CPU。

![lab 与 boost](output/fig88_lab_chain.png)

**boost 的反直觉结论**：**采集 boost 是亏的**（省 400 能量 body，花 680 能量成品，净 −280），
**升级 boost 是赚的**（一命 +1200 能量，净 +520）。因为采集受 source 再生速率封顶，boost 省不下时间。

---

## 10. 系统层

![bucket 积累](output/fig93_cpu_bucket.png)

limit 110、实际用量约 2 CPU → bucket 每 93 tick 就满。

![pixel 收益](output/fig94_pixel_economics.png)

**白捡的收益**：结余算力换成 pixel 是 **~116 pixel/小时**（10,000 CPU = 1 pixel）。之前完全没利用。

![寻路代价](output/fig95_path_cost.png)

**M23**：PathFinder 默认 plain=1/swamp=5，而 moveTo 实际是 2/10 —— 用默认参数估时会**低估整整一倍**。

---

## 11. 偏差审计汇总

![满速判据](output/fig70_speed_rule_fix.png)

![spawn 被动回能](output/fig73_spawn_passive.png)

**D5**：房间能量 < 300 时 spawn 每 tick 被动 +1。在当前收入水平下相当于 **+88%** 的额外收入，
这解释了为什么实测 spawn 能量总在 0–300 之间锯齿。

![偏差影响排序](output/fig74_deviation_rank.png)

| 编号 | 问题 | 量级 |
| --- | --- | --- |
| D9 | 平地满速判据（1:1 不是 1:2） | 往返时间低估 1.5 倍 |
| D2 | container 折旧 10 hits/tick | 旧值差 100 倍 |
| D15 | rampart 修满要 30,000 能量/段 | "免费"是错的 |
| D5 | spawn 被动回能 1 e/tick | 收入 +88% |
| D3 | road 交通折旧项 | 繁忙路段 11 倍 |
| D1 | source 三档容量 | 远程房天花板高估 2 倍 |
| D7 | 15 e/tick 只限 RCL8 | RCL4 被多套约束 |
| D14 | 入侵是确定性支出 | 每 10 万采出能量一次 |

---

## 11.5 综合配置优化

![配置空间](output/fig60_config_heatmap.png)

把采集、运输、人口三条约束放在一起，扫描"每源 WORK 数 × hauler 数"的配置空间：
横轴是矿工带宽，纵轴是运输能力，颜色是净升级速率。对角脊线就是"两个瓶颈刚好对齐"的位置。

![当前 vs 最优](output/fig61_current_vs_best.png)

当前配置在左下角（1 WORK/源、3 hauler），净升级 2.90 e/tick（模型口径）；
最优配置在右上（14 WORK/源、5 hauler），净 12.37 —— 差一个量级。

![行动优先级](output/fig62_action_priority.png)

按"每 1000 能量投入换回多少 e/tick"排序：**补矿工 4.72 ≫ 补 hauler 0.38 ≫ 修路 0.28**。
修路 ROI 低是因为 hauler 本身很便宜，它的价值体现在 η（减少空跑）而不是稳态吞吐。

---

## 12. 综合结论与行动优先级

### 12.1 三个垄断性结论

1. **瓶颈是调度不是产能**：理论 20 e/tick、实测 0.6–1.6，16 个 WORK 的有效利用率只有 8%。
2. **维护是隐形黑洞**：3.41 e/tick 的维护税 vs 1.13 e/tick 的收入，rampart 是主要税基。
3. **防御是确定性支出**：RCL4 起必然面对重型入侵，频率与收入成正比。

### 12.2 按"投入产出比"排序的行动

| # | 动作 | 收益 | 成本 |
| --- | --- | --- | --- |
| 1 | 砍 rampart 段数到必要范围 | 每段省 0.03 e/tick | 0 |
| 2 | 塔改成有敌情才开火 | 省最多 30 e/tick | 0 |
| 3 | 开启 pixel 兑换 | +116 pixel/小时 | 0 |
| 4 | 补矿工 WORK 数（1W→5W） | +6.7 e/tick | 1,200 能量 |
| 5 | 修 source A 的 24 段路（先验证交通量） | +0.65 e/tick | 7,200 能量 |
| 6 | 升级 boost（如果上 lab） | 一命 +520 能量 | lab 链成本 |

前三项是**纯配置改动、零能量成本**，应该立刻做。

### 12.3 还缺什么

- 模型给的是**稳态上限**，不含排队、抢位、寻路失败等实现损耗；
- 市场参数（价格、boost 成品价、运费指数）是假设值，不是实测；
- 入侵强度（6 只 × 2000 hp）是文档量级估算。

这些都需要线上数据回填，才能把"上限"变成"预测"。
