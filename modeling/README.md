# modeling —— Screeps 数学建模工具箱

用 Python 复现游戏机制、量化殖民地瓶颈、生成决策依据。产出供 src/ 的配额与调度逻辑使用。

> **完整分析报告：[ANALYSIS.md](ANALYSIS.md)**（41 张图，逐条结论）
> 公式推导：[../docs/MODEL.md](../docs/MODEL.md)
> 机制出处：官方文档全站已抓取到辅助产物目录的 `screeps-docs/full/`，审计报告 `MECHANICS.md`

## 分析结果一览

![全部图表总览](output/overview.png)

13 个模型、41 张图，分五个主题：

| 主题 | 回答的问题 | 关键结论 |
| --- | --- | --- |
| **移动与空间** | 走一格要几 tick？ | 平地满速要 MOVE ≥ 权重（1:1），不是 1:2 —— 往返时间比旧模型长 1.5 倍 |
| **人口与生命周期** | 续命还是重造？ | 两者单位 TTL 成本**完全相同**，差别只在 spawn 占用时间 |
| **采集与运输** | 产出天花板在哪？ | source 没有饱和点，只有边际递减；link 吞吐是 hauler 的 20 倍 |
| **建造与维护** | 维护要花多少？ | 参考配置 3.41 e/tick，其中 rampart 独占 3.00 —— 是当前收入的 3 倍 |
| **防御与系统** | 塔要常开吗？ | 3 座塔全速 = 30 e/tick，是全部收入的 26 倍；**不该常开** |

**一句话**：瓶颈是调度不是产能（16 个 WORK 只有 8% 时间在矿位上），
而最大的隐性成本是维护税和塔的常开。

## 环境

使用 DSH 内置 Python（已装 matplotlib / numpy / pandas）：

    C:/Users/Dynesshely/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe

或者：

    py -3 -m pip install -r requirements.txt

## 运行

    cd modeling
    python run_all.py            # 跑全部 13 个模型，生成 output/*.png（41 张）

单跑某个模型：

    python -m models.movement
    python -m models.audit

## 目录

    modeling/
      mw/                 公共包
        params.py         参数唯一来源（80 个常量，已与官方 Constants 逐项核对）
        style.py          莫兰迪色系 + 中文排版 + 保存规则
      models/             每个文件一个主题，含 main() 与出图
      output/             生成的图表（41 张 + overview 拼图）
      ANALYSIS.md         完整分析报告
      run_all.py          批量运行

## 模型清单

| 模块 | 主题 | 核心公式 | 图 |
| --- | --- | --- | --- |
| movement.py | 疲劳与速度 | T(g) = ceil(w·c(g) / (2·n_MOVE)) | fig01–03 |
| economy.py | 人口成本 | 摊销 = cost/1500；净产出 = 2·n_WORK·η − 摊销 | fig10–12 |
| mining.py | 采集 | Y(n;Q) = Q / (Q/(2n) + 300) | fig20–22 |
| logistics.py | 运输 | Thr = 50·n_CARRY / (T_空 + T_满 + 2) | fig30–32 |
| growth.py | RCL / GCL | T = (progressTotal − progress) / ṗ | fig40–42 |
| defense.py | 塔与围墙 | sigma(r) = clamp(1 − 0.75(r−5)/15, 0.25, 1) | fig50–52 |
| optimize.py | 综合配置 | 净 = min(采集, 运输) − 摊销 | fig60–62 |
| audit.py | 官方文档偏差审计 | 按 D1–D16 独立重算 | fig70–74 |
| lifecycle.py | 人口生命周期 | 孵化 3N tick / renew / recycle | fig80–82 |
| upkeep.py | 折旧与维护 | container 10~50、rampart 3、road 含交通项；link 776/d | fig83–85 |
| market.py | 市场与后期 | 运费随距离指数上升、5% 手续费、boost 增益 | fig86–88 |
| combat.py | 战斗与入侵 | 部件级失效；每 10 万采出能量一次入侵 | fig90–92 |
| systems.py | 系统层 | bucket 换 pixel；PathFinder 代价低估 2 倍 | fig93–95 |

每张图的详细解读（公式、出处、结论）见 **[ANALYSIS.md](ANALYSIS.md)**。

## 约定

* **不在模型里写魔法数字**：所有常数从 mw/params.py 取。
* **图表统一莫兰迪**：用 mw/style.py 的 figure() / save() / SEQ，不要自己调色。
* 每个模型都能独立运行，并在 stdout 打印关键数字。

## 模型已知边界

* 采集模型给的是**稳态上限**，不含移动时间与调度损耗（实测链路效率 η ≈ 8~39%）。
* 运输模型假设 hauler 只要往返，不计排队与抢位。
* 优化模型的"最优配置"是**配置维度**的最优，不解决代码实现层面的忙等与空转。
* 市场模型里的价格、boost 成品价、运费指数都是**参数**，不是实测值。
