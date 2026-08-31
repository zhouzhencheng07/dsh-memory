[English](README.en.md) | 中文

# dsh-memory

面向 DeepSeek Harness (dsh) 的**跨会话记忆插件**。

主 agent 每轮判定是否有值得跨会话保留的内容：**每轮 system prompt 提醒**（"When this turn produced something worth keeping across sessions, you MUST use the `memory` tool."——`autoMemory: false` 可关）把时机指给 **唯一的 `memory` 工具**（`recall` = 检索 + 读，`remember` = 新建/整文件替换/就地编辑；读写面锁定在记忆根内，描述承载使用机制与组织规则）。检索（`recall` + `keywords`）做**块级检索**（可选向量融合、按日衰减），**长期层的写入跟随检索结果的组成指引**——被搜到才说明值得长存，不在捕获时预判。官方 bundle 插件形态（`dsh.bundle`），0 patch、**零 npm 依赖、零构建**——`@deepseek-ai/*` 由 dsh 运行时扁平 fallback 提供，与运行实例共享同一份包。

> ⚠️ **谨慎使用。** 这是一套个人参考部分agent后，凭个人想法设计的记忆系统，自用良好但不一定适合大家。存储布局、工具接口与配置项都可能**频繁调整且不含兼容性保证**（破坏性改动是常态）。升级前请先看提交记录；记忆根下的记忆文件如有价值请自行备份。

## 能力

| 能力 | 说明 |
|---|---|
| **每轮提醒（可关）** | 短 system-prompt 提醒（英文，对齐官方提示词口径），每次请求重新组装，**只讲时机**："When this turn produced something worth keeping across sessions, you MUST use the \`memory\` tool."；`autoMemory: false` 关闭后走"仅在要求时记录"路线，`memory` 工具照常可用。使用手法与组织规则全部在 `memory` 工具描述里，不占提醒篇幅 |
| **单工具两模式（2026-09-01）** | 检索与读写合并为一个 `memory` 工具：`mode:"recall"` = **取**（`keywords` 全库块级检索；`date`/`topic` 打开一条笔记；`block` 只读其中一块），`mode:"remember"` = **存**（`content` 新建不存在的笔记或整文件替换刚读过的；`old_string`/`new_string` 就地编辑刚读过的）。**形态由文件状态决定，不是让 agent 先选模式**——不存在用 `content` 建，存在有内容用 `old_string` 改。命名随语义：`recall` 覆盖"检索 + 读"，`remember` 覆盖"新建 + 替换 + 编辑"且不区分新建还是修订 |
| **输出不含文件路径（2026-09-01）** | 命中行与读写回执一律用**身份标识**：`2026-08-20 · D-Project-x`（日记）、`topics/windows-env`（长期）、`today (2026-09-01)`。模型**始终不知道记忆库在磁盘的哪里**，因此无法用原生 read/write/edit 绕过本工具去改记忆文件，写入面完整留在观察守卫之内；久远日记更无法被翻出来手改（它们本就靠衰减退场）。**命中行同时就是读取键**：`date` + `workspace` + `block` 原样抄回 `recall` 即可读完整块（长块被截断时这是唯一入口） |
| **观察守卫（镜像原生）** | 按会话记录 present/absent + 版本——未读已存在时 `remember` 拒绝（createIfAbsent）、读后被改动时写/编辑拒绝（CAS "recall it again"）、编辑未读拒绝（FS_NOT_OBSERVED 同款）、`old_string` 多处匹配拒绝（FS_AMBIGUOUS_EDIT 同款）；tmp+rename 原子写。**插件直写自己的数据根**（node:fs 可信写入，路径由工具派生或白名单校验，模型只提供内容）——绕开 fs backend 内置的沙箱栅栏（其 per-write 人工升级通道对自动捕获不可用），**任何权限模式下（含 workspace-write）捕获均可用** |
| **检索（`recall` + `keywords`）** | 标题感知块级检索（任意标题切块、带面包屑）、**单字段位置加权关键词**（2026-08-25）：一个 `keywords` 参数最多 5 个空格分隔的词——**前 3 个高权重**（每个命中 ×3）、后 2 个低权重（每个命中 ×1），逐词部分分、无硬 AND 门禁；**覆盖率分数线 `MIN_COVERAGE=0.3`**（2026-08-29）：块须占本次查询实际可用证据的至少 30%，词多只中一个会被掐、错词/泛词不抬高门槛；**IDF 词权重**（2026-08-29）：按全库文档频率归一，**稀有词保持原权重、全库皆有的泛词权重趋零**（泛词独力撑不过 `MIN_SCORE=0.5`，专治高频词拽出无关块），某词全库无命中或人人命中都会在提示里说明；**ASCII 词边界**（2026-08-29）：纯字母词按边界匹配（`log` 不再命中 `catalog`），带数字/点号的版本串与 CJK 保持子串语义；去格式符宽容匹配、命中数按块长归一、**按日衰减**（30 天半衰、下限 0.4）；snippet 返回整个块（≤1000 字符）。**固化/修正指引按结果组成分支附加在输出末尾**：命中长期块 → 以它为准、过时就地修正、重叠主题合并；纯日记命中 → 值得长存的事实经 `remember` 写入 `topics/<topic>.md`；空结果只报关键词健康、不给固化指引 |
| **两层记忆库** | 日记层 `YYYY-MM-DD/`（流水，**硬窗口** `dailyWindowDays` 默认 45 天——agent 迭代快，过期笔记不再参与检索但保留在磁盘；0=不限）+ 长期层 `topics/<topic>.md`（**自由主题分文件**，一个主题一个文件，永不衰减、不受窗口限制）。分工判据：**换个项目还成立的经验进长期层**（环境/工具教训、协作偏好、通用模式）；事件流水进日记；**必须遵守的规则进 AGENTS.md，不进记忆**；项目特定的长期事实毕业进 AGENTS.md 或随日记窗口自然过期（有意的取舍，逼着显式策展）。**长期层只在复用时固化**——是否写入跟随检索结果的组成指引，不在捕获时预判。**旧日记只读**（`remember` 带 `date` 一律拒绝），无计数器、零状态文件 |
| **话题不列清单（2026-09-01）** | 工具输出**任何地方都不列全部长期话题**：清单会无限膨胀成噪音，并诱导 agent 按文件名浏览而非检索。想知道某个话题存在，唯一途径是它在某次 `recall` 结果里浮现；命中行给出 `topics/<name>`，再用 `topic` 参数读/改 |
| **向量融合（可选）** | 配置 Ollama 兼容嵌入服务后自动升级为关键词 + 向量 RRF 融合（k=60）；向量索引**持久缓存到记忆根 `.vector-cache.json`**（sha1 签名键控，dsh 重启零重建；窗口过期/删除/改名在检索前对账剪除，换模型整体失效）；服务不可用自动回退纯关键词，检索永不因向量失败 |
| **配置卡片** | 设置 → 插件 → 插件配置 → 记忆，改完保存即热生效（settings.yaml 持久化，无需重启） |

命令：无——开启每轮提醒时，提醒告知模型何时**必须使用 `memory` 工具**；检索是 `memory` 工具的 `recall` 模式。

## 存储布局

单一全局记忆根，所有工作区共享，项目目录零污染。根由 **`memoryRoot` 设置项**决定，留空回落插件数据根 `$DSH_HOME/dsh-memory`：

```
<记忆根>/
├── topics/
│   ├── <topic>.md          # 长期记忆：一个主题一个文件（短 kebab-case 名），永不衰减、不受窗口限制
│   └── ...
└── YYYY-MM-DD/
    └── <workspace-slug>.md # 每个工作区每天一个文件（日记层，受检索窗口约束）
```

- **两层语义**：事件流水写日记；长期主题文件只在**复用时固化**——是否写入跟随检索结果的组成指引（命中长期块以它为准、过时就地修正、重叠合并；纯日记命中且内容值得长存 → 写入 `topics/<topic>.md`），不在捕获时预判
- **改名过渡**（`memory/` → `topics/`）：检索索引任何非日期目录，旧 `memory/` 里的存量文件照常可搜可读（命中行给 `memory/<name>`，可直接寻址读取）；新写入一律落 `topics/`
- **无捕获簿记状态**：无水位/轮次/命中计数，日期与窗口在检索时现算，跨午夜自动切到新一天文件；唯一落盘的派生数据是向量缓存 `.vector-cache.json`（仅配置向量时，可再生，对检索语料不可见）
- rel 路径自带日期，检索结果里每条记忆的新旧一目了然

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-memory"
```

本包声明了 `dsh.bundle.patch`，会被激活为 profile 的 bundle 层（而不是仅仅装成一个不生效的普通依赖）。安装后**重启 `dsh web`** 生效；之后可在设置页「插件」面板停用/启用。更新：push 到 GitHub 后 `dsh plugin --profile web update dsh-memory` + 重启（git 依赖按 commit 缓存，必须 update 才拉到新 commit）。

> 零 npm 依赖：`@deepseek-ai/*` 在运行时经 dsh 的扁平模块 fallback（`$DSH_HOME/profiles/node_modules`）解析，与运行中的 dsh 共享同一份包实例。

## 工作原理

- `src/index.js`：每轮提醒是 `systemPrompt.context` 贡献（`dsh-memory:auto`，order 200），受 `autoMemory` 与子代理（delegationDepth>0）门控，文本只讲时机。单工具 `memory`：`recall` 按 `keywords` 走检索、按 `date`/`topic`(+`block`) 读一条笔记并记录观察；`remember` 按 `content` 走 createIfAbsent/CAS 守卫后 tmp+rename 原子写，按 `old_string` 先校验观察与唯一匹配再读-改-写。观察守卫按会话记录（镜像 `@deepseek-ai/dsh-fs-observation-policy` 语义），文件操作由**插件自身**以 node:fs 完成（沙箱栅栏位于 fs backend 内部——`dsh-fs-sandbox` 的 `checkedTarget`，原生管线与 `ctx.fs` 直调在 workspace-write 下均拒写 `$DSH_HOME`，工具层唯一放宽通道需逐次人工批准；插件写自己的数据根属宿主可信行为，路径派生/白名单保证写面不越界）。检索输出末尾按结果组成附加固化指引（命中长期块/纯日记两分支）
- `src/search.js`：任意标题（`#`–`######`）都是切块边界，子节自成一块并带祖先面包屑；**单字段位置加权关键词**——一个 `keywords` 字符串空格切分后**前 3 个为核心词**（每个命中 ×3）、**后 2 个为辅助词**（每个命中 ×1），首现去重、超限丢弃并在结果里提示；**IDF 词权重**（BM25 式 idf 按语料归一：df=1 的词权重恰为 1，df=N 的词趋零——泛词无法独力过线）、**纯字母 ASCII 词按边界计数**（`log` 不再命中 `catalog`）；逐词部分分、加权命中数按块长度归一；每块分数乘 `max(0.4, 0.5^(days/30))` 按日衰减；**低于 `MIN_SCORE=0.5` 的块不返回**；`rel#面包屑` 精确去重。`hitAddress()` 把 rel 渲染成身份标识（无路径），`findBlock()` 让命中行的面包屑成为跨调用稳定的读取键
- `src/embed.js`：可选向量路——内存索引 + sha1 签名缓存（文件未变不重复嵌入），余弦 ≥ 0.45 参与融合，RRF k=60；嵌入模型默认 `bge-m3`
- `src/store.js`：纯函数词汇——路径/slug/日期派生（两种斜杠拼法的 cwd 归一到同一 slug）、记忆根解析（`memoryRoot` 设置项优先，回落 `$DSH_HOME/dsh-memory`）、`walkMemory(windowDays, root)`（硬窗口只作用于**目录名能解析成日期**的子目录，过期日记出窗不删盘；`topics/` 等非日期目录永在索引内）、`resolveDiary()`（日记寻址：日期戳校验 + workspace 标签精确/片段模糊匹配，多匹配报错而非静默落到错的工作区）
- `client/bundle.js`：手写 client bundle，注册到 `settings.plugin.item` keyed 槽（`key: 'dsh-memory'`）；读写走官方客户端 settings scope（`ctx.settingsScope.bind`）——写入自带 revision 设栅，文档提交/重连自动重读
- 新旧冲突在召回端解决：衰减让新笔记优先，工具描述指引「同主题多条命中时合并新旧而非只信其一」

## 使用

```sh
# 检索：一个 keywords 参数，最多 5 个词，最重要的放最前
memory mode="recall" keywords="向量检索 阈值 embedding"

# 读今日笔记（recall 不带寻址参数）
memory mode="recall"

# 命中行就是读取键：把行里的地址原样抄回来读完整块
#   命中行形如  - [2026-08-20 · D-Project-dsh-plugin-dsh-memory] 工具链 > pnpm (score 1.2)
memory mode="recall" date="2026-08-20" workspace="dsh-memory" block="工具链 > pnpm"

# 读写长期主题文件
memory mode="recall" topic="windows-env"
memory mode="remember" topic="windows-env" content="# Windows 环境教训 ..."
memory mode="remember" topic="windows-env" old_string="pnpm 双实例" new_string="pnpm 双实例（2026-08 起用 --allow-scripts 规避）"

# 写今日笔记：不存在 → content 新建；已读过 → old_string 就地改
memory mode="remember" content="# 主题名 ..."
memory mode="remember" old_string="旧句子" new_string="新句子"
```

`autoMemory: true`（默认）时每轮带一条短提醒——本轮有值得跨会话保留的内容时**必须使用 `memory` 工具**；`autoMemory: false` 时无提醒——仅在明确要求时记录。

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  memoryRoot: ''           # 记忆库根目录；留空 = $DSH_HOME/dsh-memory。改动即切换记忆库，原有笔记留在原处
  searchLimit: 2           # recall 检索返回条数（1-10）；硬约束，agent 不可覆盖；长期块由 longtermAppend 席位兜底
  dailyWindowDays: 45      # 日记硬窗口（天）：过期日记不再参与检索（0=不限）；topics/ 长期层不受限
  embeddingBaseUrl: ''     # Ollama 兼容 /api/embed 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3' # 嵌入模型名
  autoMemory: true         # 每轮提醒（"值得保留→必须用 memory 工具"）；false = 仅在要求时记录
  longtermAppend: true     # 无长期块入榜时，在其后追加一条最佳长期块（不挤占名额）；false = 纯 top-N
```

## 环境要求

- Node.js ≥ 22（dsh 自身要求）
- 纯 ESM、零依赖、零构建；不配向量则零网络依赖

## 许可证

MIT
