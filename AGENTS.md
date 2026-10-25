# AGENTS.md — Frightening-Wind 开发约定

本文件约束在本仓库内工作的 AI 助手行为，优先级高于个人习惯。

## 版本控制

- **不要自动提交（commit），更不要自动推送（push）。**
- 只有用户明确说出"提交""推送""commit""push"等指令时，才执行对应操作。
- 日常改动先留在工作区，由用户统一验收后再提交。
- 提交信息使用简体中文，一句话说清"改了什么、为什么"。

## 代码约定

- 运行时代码只放在 `src/`，该目录之外的文件不会被同步到游戏。
- 新增可调参数一律写入 `src/config.js`，不要在角色逻辑里写魔法数字。
- 分层约束（自上而下单向，不允许反向 require，否则会循环 require 得到空对象）：
  `main → economy → { mgr.*, quota, construction, war, roles, defense } → utils → { fw.* } → config`
  （底层的房间快照 / 地形 / 能量 / 建造 / 身体 / 站位 / 情报 / 威胁 / 导航 / 日志全部在 `fw.*` 下）
  - 门面（`utils` / `economy` / `roles` / `roles.military` / `defense`）只做转发与注册，不实现业务；
  - 新能力写进对应 `fw.*` / `role.*` / `mgr.*`，不要往门面里堆；
  - 同层之间只允许单向复用（现存：`quota → war/construction`、`mgr.* → quota/construction`、
    `role.builder/upgrader → role.harvester`、`role.soldier → role.patrol`）。
- **铁律一：位移只走 `utils.moveTo` / `utils.moveToRoom`。**
  全库唯一允许调用 `creep.moveTo` / `creep.move` 的地方是 `src/fw.nav.js`；
  其它任何文件出现这两个调用都视为缺陷。
- **铁律二：导航层之外的防抖 / 防卡 / 防越界补丁一律不允许。**
  `_lastPos` / `_lpos` / `_still` / `_stuck` / `_posHist` / `_edgeStuck` / `_jitter` 这类
  分散补丁正是"单位在房间边界来回穿梭"越修越乱的根因；这类逻辑只存在于 `fw.nav` 一处。
  同理，`roles.run` 末尾的发呆兜底（`config.idleTicksBeforeHome`）与
  `economy.housekeeping` 的一次性迁移门控不许改。
- 修改任何角色行为后，必须让回归全部通过（工作目录
  `D:\Projects\.meta\dynesshely\frightening-wind\harness`）：
  `node check.js`，以及 `run.js` 的 `rcl3` / `neighbor` / `enemy` 三场景（exit 0 且报告结果为 PASS），
  再加 `node boundary.js`（边界横跳 / 折返断言）。

## 部署

- 同步脚本 `tools/deploy.ps1` 含本机路径，已被 `.gitignore` 忽略，不要提交。
- 部署后必须检查 `Memory.fw.errors` 是否新增——历史事故表明"异常被 try/catch 吞掉"会造成静默停摆。

## 安全红线

- 不主动使用 `POST /api/user/console` 修改游戏状态；只读 API 足够完成观测与诊断。
- 任何"沉默降级"的错误处理，都必须配套一条可观测的告警。
