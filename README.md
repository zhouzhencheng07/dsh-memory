<h1 align="center">dsh-memory</h1>

<p align="center">跨会话记忆插件：Auto-Memory 每轮提醒主模型自行判断并增量写入，memory_search 检索</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/green" alt="license">
</p>

跨会话、跨项目的**全局经验记忆**：主 agent 的每次模型请求都会在 system prompt 里收到【自动记忆】提醒，自行判断本轮是否有值得跨会话保留的内容并**增量写入**每日记忆文件；`memory_search` 检索这些每日笔记（块级、可选向量融合、按日衰减）。形态：官方 **bundle 插件**（`dsh.bundle` + dshClient 通道），0 patch，**零 npm 依赖**（`@deepseek-ai/*` 由 dsh 运行时扁平 fallback 提供，与运行实例共享同一份包）。

## 能力

**工具**（`defineTool` 注册，模型侧）：

| 工具 | 说明 |
|---|---|
| `memory_search` | 搜索记忆库（每日笔记）：**块级检索 + 渐进取用**（标题感知块：任意 `##`+ 级小节独立成块、带 `rel#主题 > 小节` 面包屑；**snippet 返回整个块** ≤1000 字符——通常无需开源文件即可继续，超大块才截取并提示长度；同文件多块可同时返回、同块不重复）、长度归一子串匹配（中文友好）、**按日衰减**（旧笔记降权但收敛下限、不会消失）；配置向量服务后自动升级为子串 + 向量 RRF 融合（块级精确去重、输出统一融合分） |

**命令**：无（记忆写入靠每轮自动提醒，检索靠 `memory_search` 工具）。

**系统集成**（无 UI 组件，零官方改动）：

| 功能 | 说明 |
|---|---|
| Auto-Memory | 每轮 system prompt 注入记忆提醒（`dsh-memory:auto`，order 200），主 agent 自行判断并写入；子 agent 不提示 |
| 配置卡片 | 设置 → 插件 → 插件配置 → 记忆（dsh-memory），改完保存即热生效（settings.yaml 持久化，无需重启） |

## 存储布局

单一全局记忆根（用户决定 2026-08-18：原来 `memory/` + `digest/` + `dream/` 三层精简为只留记忆一层，目录名用 `dsh-memory` 避免与官方未来可能的 `memory` 能力撞名）：

```
$DSH_HOME/dsh-memory/
└── YYYY-MM-DD/
    └── <workspace-slug>.md   # 每个工作区每天一个文件，正常 markdown 多级标题组织
```

- **无任何状态文件**：Auto-Memory 无水位/轮次计数（日期在组装时现取，跨午夜自动切日）
- rel 路径自带日期（`2026-08-18/--D-Project-xxx--.md`），检索结果里 agent 天然看得见每条记忆的新旧

## 记忆写入：Auto-Memory

记忆由**主 agent 在对话中直接整理**——没有后台 LLM 调用（实测两次失败：手拼请求破坏 tool-call 配对 → 400；`reasoningEffort: max` 模型把 token 全花在思考 → 空回答。对话机制组装合法请求、主模型正常回答，两种失败都不存在）：

- **机制**：`autoMemory: true`（默认）时，插件注册一段 system prompt context（`order: 200`），**每次模型请求组装时重新求值**，提醒主 agent 审视本轮内容；有值得记的（决策及原因、偏好/纠正/约定、踩坑与修复、可复用命令/流程、状态变化）就主动写入，没有就不动文件
- **执行规则**：文件不存在 → `write` 新建；已存在 → 只用 `edit` 精确修改（禁止整体 write 覆盖）；只写尚未覆盖的新内容，旧内容过时或错误时更新修正；关键处逐字引用；用正常 markdown 多级标题组织；首行来源注释；全文不写日期/时间戳
- **跨日天然正确**：提醒里的文件路径在组装时取**当天**日期——跨午夜的会话自动切到新一天文件，无水位、无轮次计数
- **新旧冲突靠召回时解决**：检索按日衰减 + 工具描述明确指引「多条命中间一主题时优先采信较新笔记（反映最新状态），旧笔记可能仍含新笔记没保留的细节——合并两者而非只信其一」——这正是原 digest 层做的收敛工作，现在在查询时按需完成
- **子 agent 不参与**（`delegationDepth > 0` 不注入）；`autoMemory: false` 时注入为空（段落常驻、开关即时生效，无需重挂）
- **无重试**（失败即设计问题，如实暴露）；无专用写入工具（直接用 dsh 自带的 read/edit/write）；无手动命令（每轮提醒即捕获路径）

## 检索

`memory_search` 只检索上述每日笔记（2026-08-18 起不再有 digest 层）：

- **块级**：任意标题（`#`–`######`）都是切块边界，`###` 子节自成一块并带祖先面包屑（`主题 > 小节 > 子节`）；块文本以面包屑标题行开头（自包含），`#`-only 无正文的标题块跳过
- **子串路**：大小写不敏感子串命中次数，按块长度归一（BM25 式阻尼，长块不天然压分）
- **按日衰减（2026-08-18 新增）**：每块分数乘 `max(floor, 0.5^(days/30))`——30 天半衰，但**永不低于 0.4 下限**：旧但强相关的块不会被截断吃掉，只有更新的更好记忆才把它压下去；衰减同时作用于子串与融合后的分数
- **向量路（可选）**：配置 `embeddingBaseUrl` 后，子串 + 向量 RRF 融合（k=60），块级精确去重；向量服务不可用时自动回退纯子串，`memory_search` 永不因向量失败
- **渐进取用**：snippet 返回整个块（≤1000 字符），通常无需开源文件即可继续；超块截取命中窗口并提示长度

## 向量检索（可选）

配置 `embeddingBaseUrl`（Ollama 兼容 `/api/embed`，如 `http://localhost:11434`）后，`memory_search` 自动升级为**子串 + 向量 RRF 融合**（k=60）：

- 记忆文件按标题分块（空节不产生向量），余弦相似度 ≥ 0.45 才参与融合（按 bge-m3 实测分布调校）
- **内存索引 + sha1 签名缓存**：文件未变不重复嵌入；向量服务不可用时自动回退纯子串，`memory_search` 永不因向量失败
- 嵌入模型默认 `bge-m3`，可经 `embeddingModel` 覆盖；不配置则零网络依赖

## 安装

```sh
dsh plugin --profile web add "github:zhouzhencheng07/dsh-memory"
```

装完 **重启 web** 生效（bundle 挂载在启动时合成）；之后可在设置页「插件」面板停用/启用（运行时生效 + 持久化）。

> 本包**零 npm 依赖**：`@deepseek-ai/dsh-tools` / `dsh-settings` / `dsh-llm` / `dsh-home-paths` / `schemastery` 在运行时经 dsh 的扁平模块 fallback（`$DSH_HOME/profiles/node_modules`）解析，保证与运行中的 dsh 共享同一份包实例。更新：push 后 `dsh plugin --profile web update dsh-memory` + 重启。

## 使用

```sh
# 模型侧（工具）：检索记忆库（旧笔记降权但可达，新笔记优先；命中同主题多条时较新的更可信）
memory_search query="向量检索阈值"
```

Auto-Memory 无需任何操作：开启后每轮自动提醒，主 agent 自行决定写入。

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  searchLimit: 5          # memory_search 默认返回条数（1-10）
  embeddingBaseUrl: ''    # Ollama 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3'  # embeddingBaseUrl 提供的嵌入模型名
  autoMemory: true        # 自动记忆开关：每轮 system prompt 提醒；false = 无提醒
```

## 开发

- Node half：`src/*.js`——纯 ESM 手写，**无构建步骤**（`index.js` 入口 + `auto.js` 每轮注入 / `search.js` 检索（含按日衰减） / `embed.js` 向量 / `store.js` 存储 / `config-http.js` 配置端点）
- client：`client/bundle.js`——手写 bundle 格式（`window.__ModuleLoader__.load`，与官方 `lib/client.js` 同形），注册到 `settings.plugin.item` 槽（**keyed 槽，`register` 必须带 `key: 'dsh-memory'`（settings 命名空间）——dsh 新版对 keyed 槽强校验，缺 key 会 apply 失败**）
- 本地开发：源码目录 `node_modules`（真实 pnpm 安装，版本与运行时一致）负责解析 `@deepseek-ai/*`；运行时解析靠 dsh 扁平模块 fallback，两者互不干扰

## 变更记录

- **0.2.0（2026-08-18）**：移除 Dream/digest 层（用户决定）——`digest/`、`dream/` 工作区、`.agent-presets/dream`、旧 `$DSH_HOME/dream/` 全部清除；`memory/` 子层并入插件根，记忆直接存 `$DSH_HOME/dsh-memory/YYYY-MM-DD/`；`memory_search` 只检索笔记，新增**按日衰减**（半衰 30 天、下限 0.4）；`dreamTime` 配置移除；检索指引明确「较新笔记更可信、旧笔记补细节」。
- 历史：0.1.1/0.1.2 曾实现 Dream 逐文件批量管线（后重构为后台对话会话），已随本次移除。

## 许可

MIT License