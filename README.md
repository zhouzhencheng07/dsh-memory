[English](README.en.md) | 中文

# dsh-memory

面向 DeepSeek Harness (dsh) 的**跨会话记忆插件**。

两个模型侧工具构成全部机制：**`memory` 文件工具**（read/write/edit 三模式，语义镜像原生文件工具，读写面锁定在本插件数据根 `$DSH_HOME/dsh-memory` 内）负责记忆的读写维护；**`memory_search` 工具**对记忆做**块级检索**（可选向量融合、按日衰减）。提示词分两层：捕获**时机**由用户写进全局 AGENTS.md（文末有可粘贴模板，只写时机）；**组织与写作规则**（记什么、`#` 标题组织、合并、就地修正）随工具描述每个请求下发。官方 bundle 插件形态（`dsh.bundle`），0 patch、**零 npm 依赖、零构建**——`@deepseek-ai/*` 由 dsh 运行时扁平 fallback 提供，与运行实例共享同一份包。

## 能力

| 能力 | 说明 |
|---|---|
| **memory 工具（三模式文件工具，2026-08-28）** | **无参 = 读今日笔记**：返回本工作区今日记忆文件全文（不存在返回 ABSENT 并列出现有长期 topic，**零写盘**）；`mode:"write"` + `content` 新建/整文件替换；`mode:"edit"` + `old_string`/`new_string`（+`replace_all`）唯一匹配字面替换；可选 `topic` 参数定位长期库文件 `memory/<topic>.md`。**观察守卫镜像原生**：按会话记录 present/absent + 版本——未读已存在时 write 拒绝（createIfAbsent）、读后被改动时 write/edit 拒绝（CAS "read it again"）、edit 未读拒绝（FS_NOT_OBSERVED 同款）、old_string 多处匹配拒绝（FS_AMBIGUOUS_EDIT 同款）；tmp+rename 原子写。**插件直写自己的数据根**（node:fs 可信写入，路径由工具派生或白名单校验，模型只提供内容）——绕开 fs backend 内置的沙箱栅栏（其 per-write 人工升级通道对自动捕获不可用），**任何权限模式下（含 workspace-write）捕获均可用**。**组织规则在描述里**：记经验不记流水、`#` 标题组织、同类合并、过时就地修正，随工具 schema 每请求下发 |
| **memory_search 工具** | 标题感知块级检索（任意标题切块、带面包屑）、**单字段位置加权关键词**（2026-08-25）：一个 `keywords` 参数最多 7 个空格分隔的词——**前 3 个高权重**（每个命中 ×3）、后 4 个低权重（每个命中 ×1），逐词部分分、无硬 AND 门禁；**最低分过滤 `MIN_SCORE=0.5`**；去格式符宽容匹配、命中数按块长归一、**按日衰减**（30 天半衰、下限 0.4）；snippet 返回整个块（≤1000 字符）；**每条命中带绝对路径**。纯检索不附加输出（2026-08-28）；检索后的固化/修正指引在**工具描述**里（2026-08-29） |
| **两层记忆库** | 日记层 `YYYY-MM-DD/`（流水，**硬窗口** `dailyWindowDays` 默认 90 天——过期笔记不再参与检索但保留在磁盘；0=不限）+ 长期层 `memory/<topic>.md`（**自由主题分文件**，2026-08-28：一个主题一个文件，永不衰减、不受窗口限制；检索层零改动天然支持）。分工判据：**换个项目还成立的经验进长期层**（环境/工具教训、协作偏好、通用模式）；事件流水进日记；**必须遵守的规则进 AGENTS.md，不进记忆**；项目特定的长期事实毕业进 AGENTS.md 或随日记窗口自然过期（有意的取舍，逼着显式策展）。无计数器、零状态文件 |
| **向量融合（可选）** | 配置 Ollama 兼容嵌入服务后自动升级为关键词 + 向量 RRF 融合（k=60）；服务不可用自动回退纯关键词，`memory_search` 永不因向量失败 |
| **配置卡片** | 设置 → 插件 → 插件配置 → 记忆，改完保存即热生效（settings.yaml 持久化，无需重启） |

命令：无——捕获**时机**在用户的全局 AGENTS.md（组织规则在工具描述里）；检索靠 `memory_search` 工具。

## 存储布局

单一全局记忆根，所有工作区共享，项目目录零污染：

```
$DSH_HOME/dsh-memory/
├── memory/
│   ├── <topic>.md          # 长期记忆：一个主题一个文件（短 kebab-case 名），永不衰减、不受窗口限制
│   └── ...
└── YYYY-MM-DD/
    └── <workspace-slug>.md # 每个工作区每天一个文件（日记层，受检索窗口约束）
```

- **两层语义**：事件流水写日记；跨项目长青经验写长期主题文件（`topic` 参数，捕获时按 AGENTS.md 规则分流，或复用时固化——检索命中长期块以它为准、过时就地修正、同主题合并）
- **无任何状态文件**：无水位/轮次/命中计数，日期与窗口在检索时现算，跨午夜自动切到新一天文件
- rel 路径自带日期，检索结果里每条记忆的新旧一目了然

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-memory"
```

本包声明了 `dsh.bundle.patch`，会被激活为 profile 的 bundle 层（而不是仅仅装成一个不生效的普通依赖）。安装后**重启 `dsh web`** 生效；之后可在设置页「插件」面板停用/启用。更新：push 到 GitHub 后 `dsh plugin --profile web update dsh-memory` + 重启（git 依赖按 commit 缓存，必须 update 才拉到新 commit）。

> 零 npm 依赖：`@deepseek-ai/*` 在运行时经 dsh 的扁平模块 fallback（`$DSH_HOME/profiles/node_modules`）解析，与运行中的 dsh 共享同一份包实例。

## 工作原理

- `src/index.js`：`memory` 三模式文件工具——无参（或 `mode:"read"`）读今日笔记/topic 文件全文并记录观察；`mode:"write"` 走 createIfAbsent/CAS 守卫后 tmp+rename 原子写；`mode:"edit"` 先校验观察与唯一匹配再读-改-写。观察守卫按会话记录（镜像 `@deepseek-ai/dsh-fs-observation-policy` 语义），文件操作由**插件自身**以 node:fs 完成（沙箱栅栏位于 fs backend 内部——`dsh-fs-sandbox` 的 `checkedTarget`，原生管线与 `ctx.fs` 直调在 workspace-write 下均拒写 `$DSH_HOME`，工具层唯一放宽通道需逐次人工批准；插件写自己的数据根属宿主可信行为，路径派生/白名单保证写面不越界）。**不注册任何宿主 hook、无每轮提醒**（2026-08-29 起提示词分层：时机规则外置 AGENTS.md，组织规则在工具描述）
- `src/search.js`：任意标题（`#`–`######`）都是切块边界，子节自成一块并带祖先面包屑；**单字段位置加权关键词**——一个 `keywords` 字符串空格切分后**前 3 个为核心词**（每个命中 ×3）、**后 4 个为辅助词**（每个命中 ×1），首现去重、超限丢弃并在结果里提示；逐词部分分、加权命中数按块长度归一；每块分数乘 `max(0.4, 0.5^(days/30))` 按日衰减；**低于 `MIN_SCORE=0.5` 的块不返回**；`rel#面包屑` 精确去重
- `src/embed.js`：可选向量路——内存索引 + sha1 签名缓存（文件未变不重复嵌入），余弦 ≥ 0.45 参与融合，RRF k=60；嵌入模型默认 `bge-m3`
- `src/store.js`：纯函数词汇——路径/slug/日期派生（两种斜杠拼法的 cwd 归一到同一 slug）、`walkMemory(windowDays)`（硬窗口只作用于**目录名能解析成日期**的子目录，过期日记出窗不删盘；`memory/` 等非日期目录永在索引内）
- `client/bundle.js`：手写 client bundle，注册到 `settings.plugin.item` keyed 槽（`key: 'dsh-memory'`）；读写走官方客户端 settings scope（`ctx.settingsScope.bind`）——写入自带 revision 设栅，文档提交/重连自动重读
- 新旧冲突在召回端解决：衰减让新笔记优先，礼仪（AGENTS.md 侧）指引「同主题多条命中时合并新旧而非只信其一」

## 使用

```sh
# 模型侧工具：检索记忆库（一个 keywords 参数，最多 7 个词，最重要的放最前）
memory_search keywords="向量检索 阈值 embedding"

# 模型侧工具：读今日记忆笔记（无参即 read）——返回全文；ABSENT 表示还没有
memory

# 创建（mode:"write"）/ 就地修改（mode:"edit"）
memory mode="write" content="# 主题名 ..."
memory mode="edit" old_string="旧句子" new_string="新句子"

# 跨项目长青经验写进长期主题文件（topic 参数）
memory topic="windows-env" mode="write" content="# Windows 环境教训 ..."
memory topic="windows-env" mode="edit" old_string="pnpm 双实例" new_string="pnpm 双实例（2026-08 起用 --allow-scripts 规避）"
```

## AGENTS.md 时机规则模板（手动粘贴）

插件不带捕获提醒，也**没有机制替你把规则写进 AGENTS.md**。AGENTS.md 只需要补一层**时机**——什么时候该用哪个工具；组织与写作规则（记什么、怎么组织）已在 `memory`/`memory_search` 工具描述里随每个请求下发，不用写进 AGENTS.md。把下面的模板粘进你的全局 AGENTS.md（用户级，跨项目生效）：

```markdown
# 记忆机制

## 每日记忆

- 一轮工作结束时，若有值得跨会话保留的内容 → 用 memory 工具：无参先读今日
  笔记，再用 mode:"write"（不存在，创建）或 mode:"edit"（存在，就地修改）写入。

## 长期记忆

- 出现换个项目仍然成立的经验（环境/工具教训、协作偏好、通用模式）→ 用
  memory 工具带 topic 参数写入长期主题文件 memory/<topic>.md。
- 需要过去的经验或旧细节时 → 用 memory_search 检索。
```

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  searchLimit: 5            # memory_search 返回条数（1-10）；硬约束，agent 不可覆盖
  dailyWindowDays: 90       # 日记硬窗口（天）：过期日记不再参与检索（0=不限）；memory/ 长期层不受限
  embeddingBaseUrl: ''      # Ollama 兼容 /api/embed 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3'  # 嵌入模型名
  longtermAppend: true      # 无长期块入榜时，在其后追加一条最佳长期块（不挤占名额）；false = 纯 top-N
```

## 环境要求

- Node.js ≥ 22（dsh 自身要求）
- 纯 ESM、零依赖、零构建；不配向量则零网络依赖

## 许可证

MIT
