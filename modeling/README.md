# modeling —— Screeps 数学建模工具箱

用 Python 复现游戏机制、量化殖民地瓶颈、生成决策依据。产出供 \`src/\` 的配额与调度逻辑使用。

> 公式推导与结论：[../docs/MODEL.md](../docs/MODEL.md)

## 环境

使用 DSH 内置 Python（已装 matplotlib / numpy / pandas）：

    C:\Users\Dynesshely\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe

或者：

    py -3 -m pip install -r requirements.txt

## 运行

    cd modeling
    python run_all.py            # 跑全部模型，生成 modeling/output/*.png

单跑某个模型：

    python -m models.movement
    python -m models.mining

## 目录

    modeling/
      mw/                 公共包
        params.py         参数唯一来源（官方常数 / 私服环境 / 房间实测）
        style.py          莫兰迪色系 + 中文排版 + 保存规则
      models/             每个文件一个主题，含 main() 与出图
      output/             生成的图表（*.png，21 张）
      run_all.py          批量运行

## 模型与产物

| 模块 | 主题 | 核心公式 | 图 |
| --- | --- | --- | --- |
| \`movement.py\` | 疲劳与速度 | T(g) = ceil(w·c(g) / (2·n_MOVE)) | fig01–03 |
| \`economy.py\` | 人口成本 | 摊销 = cost/1500；净产出 = 2·n_WORK·η − 摊销 | fig10–12 |
| \`mining.py\` | 采集 | Y(n) = 10n/(5+n) | fig20–22 |
| \`logistics.py\` | 运输 | Thr = 50·n_CARRY / (T_空+T_满+2) | fig30–32 |
| \`growth.py\` | RCL / GCL | T = (progressTotal − progress) / ṗ | fig40–42 |
| \`defense.py\` | 塔与围墙 | sigma(r) = clamp(1 − 0.75(r−5)/15, 0.25, 1) | fig50–52 |
| \`optimize.py\` | 综合配置 | 净 = min(采集, 运输) − 摊销 | fig60–62 |

### 图表索引

| 文件 | 内容 |
| --- | --- |
| \`fig01_tile_ticks_heatmap\` | MOVE 数 × 其他部件数 → 每格 tick（三种地形） |
| \`fig02_speed_vs_cargo\` | 载重比例 → 速度（空 CARRY 不计疲劳） |
| \`fig03_room_trip_ticks\` | 本房间两个 source 的往返 tick（修路前后） |
| \`fig10_body_tradeoff\` | 造价 / 生成时间 / 摊销 / 净产出 |
| \`fig11_eta_sensitivity\` | 有效工时占比 η → 净产出（含盈亏平衡点） |
| \`fig12_population_cost\` | 当前 13 个兵的成本构成 |
| \`fig20_source_yield\` | 矿工数 → 稳态产出与边际产出（盈亏平衡 n≈22） |
| \`fig21_regen_sawtooth\` | source 库存锯齿（1/3/5/10 个 WORK） |
| \`fig22_room_gap\` | 单 source 产出曲线 + 本房间当前位置 |
| \`fig30_hauler_throughput\` | 距离 → 单 hauler 吞吐（有路/无路） |
| \`fig31_haulers_needed\` | 距离 → 喂满目标速率需要几个 hauler |
| \`fig32_road_payback\` | 修路回本时间 |
| \`fig40_rcl_curve\` | 各 RCL 的 progressTotal 与累计能量 |
| \`fig41_time_to_rcl5\` | 升级速率 → 到 RCL5 的墙钟时间 |
| \`fig42_income_vs_rcl\` | 四种收入场景下到 RCL5/6/7 的时间 |
| \`fig50_tower_falloff\` | 距离 → 伤害 / 治疗 / 修理 / 每能量伤害 |
| \`fig51_maintenance_tax\` | rampart / road 段数 → 维护能量 |
| \`fig52_siege_time\` | 击杀 5000 hit 目标所需 tick |
| \`fig60_config_heatmap\` | 矿工 × hauler 配置空间的净升级速率 |
| \`fig61_current_vs_best\` | 当前 vs 最优（能量流转与 RCL5 时间） |
| \`fig62_action_priority\` | 行动优先级（每 1000 能量的收益） |

## 约定

* **不在模型里写魔法数字**：所有常数从 \`mw.params\` 取。
* **图表统一莫兰迪**：用 \`mw.style\` 的 \`figure()\` / \`save()\` / \`SEQ\`，不要自己调色。
* 每个模型都能独立运行，并在 stdout 打印关键数字。

## 模型已知边界

* 采集模型给的是**稳态上限**，不含移动时间与调度损耗；
  实测链路效率 η ≈ 39%（1.13 / 2.90），差距就是执行损耗，这也是 \`src/\` 需要优化的部分。
* 运输模型假设 hauler 只要往返，不计排队与抢位。
* 优化模型的"最优配置"是**配置维度**的最优，不解决代码实现层面的忙等与空转。
