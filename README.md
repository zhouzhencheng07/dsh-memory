[English](README.en.md) | 中文

# dsh-memory

面向 DeepSeek Harness (dsh) 的**跨会话全局记忆插件**。

主 agent 每轮判定是否有值得跨会话保留的内容：**每轮 system prompt 提醒**（"本轮有值得跨会话保留的新内容时，必须使用 memory 工具"——`autoMemory: false` 可关）把时机指给**路径定位型 `memory` 工具**——它返回今日记忆文件路径（不存在自动创建，同时维护会话来源注释），之后用**原生 read/write/edit 工具**维护笔记本身；捕获时机与内容要求全部写在 `memory` 工具描述里（随工具 schema 每个请求下发）。`memory_search` 工具对这些笔记做**块级检索**（可选向量融合、按日衰减）。官方 bundle 插件形态（`dsh.bundle`），0 patch、**零 npm 依赖、零构建**——`@deepseek-ai/*` 由 dsh 运行时扁平 fallback 提供，与运行实例共享同一份包。

## 能力

| 能力 | 说明 |
|---|---|
| **每轮提醒（可关）** | 短 system-prompt 提醒，每次请求重新组装："本轮有值得跨会话保留的新内容时，必须使用 memory 工具"。刻意极短——时机、内容要求、用法全部放在 `memory` 工具描述；`autoMemory: false` 关闭后走"仅在要求时记录"路线，中性的 `memory` 工具照常可用 |
| **memory 工具** | **无参数路径定位器**：返回本工作区今日记忆文件（每工作区每天一个）；文件不存在时**自动创建**（内容=首行 `<!-- 会话来源: ... -->` 注释），存在时把当前会话合并进来源注释（**精确幂等**，已含则零写）。描述承载捕获时机（决策及原因、偏好/纠正/约定、踩坑与修复、可复用命令/流程、状态变化）与质量规则（先读后改；edit 局部修改、write 新建/整文件重写；`#` 标题组织主题、同类合并、过时一两句修正、不写流水账）。文件操作**透传宿主原生 read/write 管线**——与模型自己的文件工具同一套沙箱栅栏与"改前必读"观察（`$DSH_HOME` 写入需要 danger-full-access） |
| **memory_search 工具** | 标题感知块级检索（任意标题切块、带面包屑）、**两组关键词加分**（2026-08-24）：`primary` ≤2 个高权重（每个命中 ×3）+ `secondary` ≤3 个低权重（每个命中 ×1），逐词部分分、无硬 AND 门禁——块里缺某个词不再整条消失；去格式符宽容匹配、命中数按块长归一、**按日衰减**（30 天半衰、下限 0.4）；snippet 返回整个块（≤1000 字符，通常无需再开文件） |
| **两层记忆库（2026-08-24）** | 日记层 `YYYY-MM-DD/`（流水，**硬窗口** `dailyWindowDays` 默认 90 天——过期笔记不再参与检索但保留在磁盘；0=不限）+ 长期层 `memory/memory.md`（单文件按主题标题组织，**永不衰减、不受窗口限制**）。检索时按结果组成给条件提示：命中长期层→以它为准并就地修正过时内容；只命中较旧日记→建议把长期有效的事实固化进 memory.md；纯当日流水不打扰。无计数器、零状态文件 |
| **向量融合（可选）** | 配置 Ollama 兼容嵌入服务后自动升级为关键词 + 向量 RRF 融合（k=60）；服务不可用自动回退纯关键词，`memory_search` 永不因向量失败 |
| **配置卡片** | 设置 → 插件 → 插件配置 → 记忆，改完保存即热生效（settings.yaml 持久化，无需重启） |

命令：无——开启每轮提醒时，提醒告知模型何时**必须使用 `memory` 工具**；检索靠 `memory_search` 工具。

## 存储布局

单一全局记忆根，所有工作区共享，项目目录零污染：

```
$DSH_HOME/dsh-memory/
├── memory/
│   └── memory.md           # 长期记忆：单文件按主题标题组织，永不衰减、不受窗口限制
└── YYYY-MM-DD/
    └── <workspace-slug>.md # 每个工作区每天一个文件（日记层，受检索窗口约束）
```

- **两层语义**：当日工作写日记；用户偏好、环境事实、长期约定等长青事实在**被复用时**由 agent 固化进 `memory/memory.md` 对应主题块（先读后改、过时就地修正——唯一事实源收敛在这一处）；日记原件不回改，到期自然出窗
- **无任何状态文件**：无水位/轮次计数/命中计数，日期与窗口在检索时现算，跨午夜自动切到新一天文件
- rel 路径自带日期，检索结果里每条记忆的新旧一目了然

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-memory"
```

本包声明了 `dsh.bundle.patch`，会被激活为 profile 的 bundle 层（而不是仅仅装成一个不生效的普通依赖）。安装后**重启 `dsh web`** 生效；之后可在设置页「插件」面板停用/启用。更新：push 到 GitHub 后 `dsh plugin --profile web update dsh-memory` + 重启（git 依赖按 commit 缓存，必须 update 才拉到新 commit）。

> 零 npm 依赖：`@deepseek-ai/*` 在运行时经 dsh 的扁平模块 fallback（`$DSH_HOME/profiles/node_modules`）解析，与运行中的 dsh 共享同一份包实例。

## 工作原理

- `src/index.js`：路径定位型 `memory` 工具（无参数）——按会话 cwd 算今日路径，先子派发原生 `read` 探测（顺带记录观察，后续合并写通过版本 CAS），文件不存在或来源缺当前会话 id 时子派发原生 `write`（精确幂等，无变化不写）；每轮提醒是 `systemPrompt.context` 贡献（`dsh-memory:auto`，order 200），受 `autoMemory` 与子代理（delegationDepth>0）门控，文本刻意极短，规则全在工具描述。**不注册任何宿主 hook**（无 tools/result / 轮末监听）：知道路径的会话必然已调用过 `memory` 工具，来源已维护
- `src/search.js`：任意标题（`#`–`######`）都是切块边界，子节自成一块并带祖先面包屑；**两组关键词加分**——`primary`（≤2 个，核心词）每个命中 ×3、`secondary`（≤3 个，辅助词）每个命中 ×1，逐词部分分（2026-08-24 取代旧三层匹配：tier-3 硬 AND 对部分命中记零分，是实测漏检根因），两侧都过 `looseNormalize`（去格式符、标识符 `-` `_` `.` 保留）；加权命中数按块长度归一；每块分数乘 `max(0.4, 0.5^(days/30))` 按日衰减；`rel#面包屑` 精确去重
- `src/embed.js`：可选向量路——内存索引 + sha1 签名缓存（文件未变不重复嵌入），余弦 ≥ 0.45 参与融合，RRF k=60；嵌入模型默认 `bge-m3`
- `src/store.js`：纯函数词汇——路径/slug/日期派生、来源注释解析与合并（`mergeProvenance`，精确幂等）、`walkMemory(windowDays)`（硬窗口只作用于**目录名能解析成日期**的子目录，过期日记出窗不删盘；`memory/` 等非日期目录永在索引内。插件本身不直接写磁盘，文件操作全部透传子派发的原生 read/write）
- `client/bundle.js`：手写 client bundle，注册到 `settings.plugin.item` keyed 槽（`key: 'dsh-memory'`）；读写走官方客户端 settings scope（`ctx.settingsScope.bind`）——写入自带 revision 设栅，文档提交/重连自动重读。（rc.7 之前因 api-proxy 命名空间白名单自建的 `/dsh-memory/config` HTTP 端点已删除：rc.7 移除了该白名单）
- 新旧冲突在召回端解决：衰减让新笔记优先，工具描述指引「同主题多条命中时合并新旧而非只信其一」

## 使用

```sh
# 模型侧工具：检索记忆库（两组关键词：primary ≤2 个高权重，secondary ≤3 个低权重；
# 逐词部分分——旧笔记降权但可达，新笔记优先）
memory_search primary="向量检索 阈值" secondary="embedding"

# 模型侧工具：定位今日记忆——返回路径；文件不存在自动创建（含来源注释），
# 已存在则把当前会话合并进首行来源注释
memory

# 之后用原生文件工具维护（先读后改）：
read file_path="<memory 返回的路径>"
edit file_path="<路径>" old_string="旧句子" new_string="新句子"
# 或 write file_path="<路径>" content="# 主题名 ..." 新建/整文件重写
```

`autoMemory: true`（默认）时每轮带一条短提醒——本轮有值得跨会话保留的内容时**必须使用 `memory` 工具**；文件首行 `<!-- 会话来源: ... -->` 注释由工具自动维护。`autoMemory: false` 时无提醒——仅在明确要求时记录（工具描述保持中性，无"必须"字样）。

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  searchLimit: 5            # memory_search 返回条数（1-10）；硬约束，agent 不可覆盖
  dailyWindowDays: 90       # 日记硬窗口（天）：过期日记不再参与检索（0=不限）；memory/ 长期层不受限
  embeddingBaseUrl: ''      # Ollama 兼容 /api/embed 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3'  # 嵌入模型名
  autoMemory: true          # 每轮提醒（"值得保留→必须用 memory 工具"）；false = 仅在要求时记录
```

## 环境要求

- Node.js ≥ 22（dsh 自身要求）
- 纯 ESM、零依赖、零构建；不配向量则零网络依赖

## 许可证

MIT
