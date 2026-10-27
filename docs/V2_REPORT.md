# V2 架构重构报告

> 五层预算驱动架构的落地情况、本地推演数据、以及已知问题。
> 契约见 [ARCHITECTURE_V2.md](ARCHITECTURE_V2.md)；模型依据见 [../modeling/ANALYSIS.md](../modeling/ANALYSIS.md)。

## 1. 架构总览

| 层 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| L0 观测 | `src/core.ledger.js` | 257 | 每 tick 能量流水，300 样本环形缓冲，输出 income/spend/eta/upkeepDebt |
| L1 估计 | `src/core.estimator.js` | 479 | 模型公式的 JS 版（纯函数，与 modeling/ 对拍误差 < 1e-15） |
| L2 预算 | `src/core.budget.js` | 115 | 按 ROI 分配能量：维护是硬约束，其余按比例分摊 |
| L2 策略 | `src/core.policy.js` | 289+ | η 闸门 + 人数反解 + 1:1 body + 维护上限 + 补员计划 |
| L3 执行 | `src/core.task.js` | 748 | 任务队列（7 种 type、意图粘性、priority x ROI 排序） |
| L4 驱动 | `fw.nav` / `fw.store` / `fw.build` | — | **一行未动** |

集成只动三处：

1. `economy.runRoom` 末尾调 `runCore()`（账本 → 预算 → 策略，结果挂 `data.v2plan`）
2. `mgr.spawn` 读 `data.v2plan.roles/.bodies/.recruit`（替代 quota 与 planBody）
3. `roles.run` 加 6 行 hook（v2 时先问 `task.pick`，且不跳过发呆兜底）

灰度开关 `config.core.v2` 默认 `false`，关闭时行为与重构前完全一致（已验证 `task.pick` 调用 0 次）。

## 2. 推演基础设施

| 项 | 值 |
| --- | --- |
| 服务端 | 官方 `screeps@4.3.0` + LokiJS，容器 `fw-screeps-local` |
| 端口 | 21026（不占用线上私服 21025） |
| tick 间隔 | 20ms |
| 实测速率 | **36~42 tick/s**（线上私服的 12 倍，真实服务器的 36 倍） |
| 上限原因 | 单 tick 流水线（runner → processor → storage）本身 24~28ms，再低只会空转 |
| AI CPU | 0.66~1.35（配额 500），无超时 |

部署位置：`!/.meta/dynesshely/frightening-wind/screeps-local/`（含 `SPEEDUP.md`、`tools/fwctl.js`、`world/mods/`）

## 3. 验证数据

### 3.1 有历史数据的稳态（自然发展 20 分钟）

| 指标 | 值 |
| --- | --- |
| tick 跨度 | 191,648 → 234,650（43,002） |
| progress | 35,702 → 67,886（+32,184） |
| 速率 | **0.748 progress/tick** |
| 基线（v2 关闭） | 0.381/tick |
| 提升 | **1.96x** |
| fw.errors / v2Errors | **全程 0** |

后段因容器衰败消失而崩（已修：builder 紧急维修优先级）。

### 3.2 富裕条件冷启动（RCL5 + storage 20 万 + 双满容器 + 30 扩展）

**失败**：progress 恒为 0，6~8 分钟内一次升级都没有。

    creeps 4（全部 1W1C1M）
    upgrader 1 个，say=📦 全程不变
    spawnStat busy=100%
    storage 20 万能量没动过

### 3.3 结论

| 层面 | 结论 |
| --- | --- |
| 架构正确性（稳态） | 通过：五层协同 4.3 万 tick 零异常、指标翻倍 |
| 架构正确性（冷启动） | **未通过**：仍然锁死，四次修复未解决 |
| 灰度隔离 | 通过：v2=false 完全等价 |

## 4. 本轮修掉的问题（按发现顺序）

| # | 问题 | 修法 |
| --- | --- | --- |
| 1 | 孵化预算差 2 点卡死（448 / 450） | 95% 放行，按实际能量降档拼身体 |
| 2 | v2 下保命过滤把 candidates 裁空 | 仅非 v2 生效 |
| 3 | 升级者取货按"离自己近"挑 | 评分改为"自己距离 + 控制器距离 x 1.5" |
| 4 | 容器积压无人管 | policy 加积压补偿（backlog > 500 时 +1~3 hauler） |
| 5 | body 预算一视同仁 | 产能角色（miner/hauler）预算 x1.8 |
| 6 | 人口同批老死导致断崖 | L2 补员计划：TTL < 300 提前补位 + 错峰 15 tick + 崩溃救援（人口 < 6） |
| 7 | builder 只建造不维修导致容器衰败消失 | 新增 `urgentRepairTarget`：container/road/tower 血量 < 40% 优先维修 |
| 8 | 账本 spend 只填 upgrade 导致 net 偏高 | 改用能量守恒反推总支出 |
| 9 | policy 冷启动 eta=0 判定休克 | 样本不足时乐观（eta=1） |
| 10 | budget 冷启动 net=0 导致预算全 0 | 样本不足时用"每源 3 e/tick"乐观基准 |
| 11 | roster 用旧配额表与 v2 打架 | v2 下用 `data.v2plan.roles` |
| 12 | 计数器键名错：读 `ct.harvest`，白名单里是 `work.harvest` | 兼容两种键名 |

## 5. 已知问题（未解决）

### 5.1 冷启动锁死（P0）

现象：重置世界后 progress 恒 0、人口卡在 4、upgrader 长期 `📦`。

已排除：预算为 0（修了）、eta 判断（修了）、roster 冲突（修了）、计数器键名（修了）。

**仍缺的观测**：creep 的实时坐标、能量、目标、`withdraw` 返回码。
没有这些无法判断它卡在"走不到"还是"取不到"还是"取了不升"。

### 5.2 人口节奏（P1）

即便在稳态跑，人口也从 14 波动到 2 再回升。补员计划已接入，但长跑效果未验证。

### 5.3 nav 跨房振荡（P2）

harvester 在 60 tick 内跨房 5~8 次被冻结（本地新房间地形与线上不同，出口选择可能退化）。

## 6. 下一步

1. **加观测接口**：`GET /api/fw/creeps` 返回每个 creep 的 `{name, role, x, y, energy, say, task, dest, nav}`
2. 用它跑 10 tick，打印 upgrader 的完整轨迹 → 把"猜"变成"看"
3. 定位并修复冷启动锁死
4. 再做一次长跑（20 分钟 = 线上 4 小时）验证稳定性

## 7. 提交记录

| commit | 内容 |
| --- | --- |
| `f97a653` | V2 五层架构 + 集成 + 5 处死锁修复 |
| `e14cb06` | 人口生命周期接入 L2 + builder 紧急维修 |
| `cc30ed0` | 账本支出改用能量守恒反推 |
| 本次 | 冷启动四处修复（policy / budget / roster / 计数器键名） |
