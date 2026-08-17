<h1 align="center">dsh-memory</h1>

<p align="center">跨会话记忆插件：Auto-Memory 每轮提醒主模型自行判断并增量写入，memory_search 检索，Dream 长期巩固</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/green" alt="license">
</p>

跨会话、跨项目的**全局经验记忆**：主 agent 的每次模型请求都会在 system prompt 里收到【自动记忆】提醒，自行判断本轮是否有值得跨会话保留的内容并**增量写入**每日记忆文件；`memory_search` 检索「Dream 精炼库 + 每日笔记」；Dream 定时把笔记提炼成长期 digest。形态：官方 **bundle 插件**（`dsh.bundle` + dshClient 通道），0 patch，**零 npm 依赖**（`@deepseek-ai/*` 由 dsh 运行时扁平 fallback 提供，与运行实例共享同一份包）。

## 能力

**工具**（`defineTool` 注册，模型侧）：

| 工具 | 说明 |
|---|---|
| `memory_search` | 搜索 memory + digest：**块级检索 + 渐进取用**（标题感知块：任意 `##`+ 级小节独立成块、带 `rel#主题 > 小节` 面包屑；**snippet 返回整个块** ≤1000 字符——通常无需开源文件即可继续，超大块才截取并提示长度；同文件多块可同时返回、同块不重复）、长度归一子串匹配（中文友好）、digest 加成；配置向量服务后自动升级为子串 + 向量 RRF 融合（块级精确去重、输出统一融合分） |

**命令**：
- Dream 无手动命令（`/dream` 与 `memory_dream` 已于 2026-08-17 移除）：巩固只由 `dreamTime` 定时触发，每次在 **dream/ 工作区**里跑一个后台 agent 会话

**系统集成**（无 UI 组件，零官方改动）：

| 功能 | 说明 |
|---|---|
| Auto-Memory | 每轮 system prompt 注入记忆提醒（`dsh-memory:auto`，order 200），主 agent 自行判断并写入；子 agent 与 Dream 工作区会话不提示 |
| Dream 定时 | `dreamTime`（默认 23:00）每日触发一次后台 Dream 会话；空 = 关 |
| 配置卡片 | 设置 → 插件 → 插件配置 → 记忆（dsh-memory），改完保存即热生效（settings.yaml 持久化，无需重启） |

## 记忆写入：Auto-Memory

记忆由**主 agent 在对话中直接整理**——没有后台 LLM 调用（实测两次失败：手拼请求破坏 tool-call 配对 → 400；`reasoningEffort: max` 模型把 token 全花在思考 → 空回答。对话机制组装合法请求、主模型正常回答，两种失败都不存在）：

- **机制**：`autoMemory: true`（默认）时，插件注册一段 system prompt context（`order: 200`），**每次模型请求组装时重新求值**，提醒主 agent 审视本轮内容；有值得记的（决策及原因、偏好/纠正/约定、踩坑与修复、可复用命令/流程、状态变化）就主动写入，没有就不动文件
- **执行规则**：文件不存在 → `write` 新建；已存在 → 只用 `edit` 精确修改（禁止整体 write 覆盖）；只写尚未覆盖的新内容，旧内容过时或错误时更新修正；关键处逐字引用；多级标题（# 主题 + ## 小节）；首行来源注释；全文不写日期/时间戳
- **跨日天然正确**：提醒里的文件路径在组装时取**当天**日期——跨午夜的会话自动切到新一天文件，无水位、无轮次计数
- **子 agent 不参与**（`delegationDepth > 0` 不注入）；`autoMemory: false` 时注入为空（段落常驻、开关即时生效，无需重挂）
- **无重试**（失败即设计问题，如实暴露）；无专用写入工具（直接用 dsh 自带的 read/edit/write）；无手动命令（每轮提醒即捕获路径）

## Dream 机制（V2：后台对话会话，2026-08-17 重构；0.1.2+ 修正工具面）

- **触发**：`dreamTime`（默认 23:00；非空 = 定时开，空 = 关）。无 `/dream` 命令、无 `memory_dream` 工具（已移除——用户希望机制是「专门用一个工作区跑 Dream」）
- **存储布局**（用户决定 2026-08-17）：插件数据集中在 `$DSH_HOME/dsh-memory/` 一个根下——`memory/`（每日笔记）、`digest/`（精炼库，原 `$DSH_HOME/dream` 目录更名而来）、`dream/`（**Dream 会话工作区**）。旧 `$DSH_HOME/dream/` 目录**原样保留在磁盘上供人工对比**，但**不再被索引**——所有查询与 Dream 运行只看新布局
- **执行**：每次定时触发 = 启动**一个后台 agent 会话**（`agents.create`，同 `dsh-headless` 的一发任务路径，无需主对话参与），cwd 绑定 `dream/` 工作区。会话挂载插件安装的**专用 `dream` agent preset**（`$DSH_HOME/.agent-presets/dream/`，最小面：文件工具 read/glob/grep/write/edit + 规则加载器）并以 `danger-full-access` 权限运行（digest 根是 dream 工作区的兄弟目录，workspace-write 会拦掉写入）。**巩固规则全集**在 `dream/AGENTS.md`（插件首次运行写入，用户可编辑、不会被覆盖，自动进入每次 Dream 会话的 system prompt）；任务书包含水位筛出的变更笔记清单 + 目录 + 报告 schema。会话直接读写 `digest/<桶>/<主题>.md`，最后输出严格 JSON 报告。**该会话是真实对话**——UI 侧边栏归入名为 **dream** 的工作区（插件显式登记工作区记录并 attach 每次会话），可点开查看每一步（读了什么、写了什么），等于自带审计日志
- **桶**：`personal`（偏好/约定/约束）、`procedure`（流程/方法）、`wiki`（知识/原则/先例/事实）
- **窗口 + 水位（QwenPaw/ReMe 对齐）**：扫描「今天 + 昨天」；水位 catalog（`digest/.catalog.json`，`{笔记 rel: mtime}`）只放行**新增/变更**的笔记——无变更直接跳过（不耗 LLM）；会话报告里列出的笔记才写水位、失败/超时文件不写（下次自动重试）；改过的笔记自动重扫
- **成本优势**：一个会话内多轮工具调用共享上下文，provider 前缀缓存命中——相比旧管线（每文件 + 每 unit 各一次全量无状态大请求）显著省 token
- **LLM 模型**：默认使用 agent 默认模型（`model` 覆盖配置已移除——Dream 会话是普通 agent 对话，无需单独指定）；无 maxTokens（模型自身输出上限）
- **正文结构**：首行 `# 一句话标题`（与 memory 笔记的 `# 主题` 对齐）+ `##` 小节（procedure: Trigger/Steps/Pre-conditions/Failure modes；personal: Rule/Why/How to apply；wiki: 定义/原则/事实）；不引入更深层级
- **互链与溯源**：文件尾 `Related: [[digest/...]] — 关系说明` 行（系统维护，只增不删、按 rel 去重）+ `derived_from:: [[memory/...]]` 溯源；原始笔记永不删除；UPDATE 保留旧要点与全部来源
- **质量 gate**：宁缺毋滥——只提炼可长期复用的抽象（禁止 passing mention/已知概念复述/事件总括/一次性时间戳）；不进 digest 的笔记仍被 `memory_search` 全库检索
- **语言**：不强制——digest 语言跟随源笔记/会话模型（同 QwenPaw）

## 向量检索（可选）

配置 `embeddingBaseUrl`（Ollama 兼容 `/api/embed`，如 `http://localhost:11434`）后，`memory_search` 自动升级为**子串 + 向量 RRF 融合**（k=60）：

- 记忆文件按 `#` 小节分块（空节不产生向量），余弦相似度 ≥ 0.45 才参与融合（按 bge-m3 实测分布调校）
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
# 模型侧（工具）
memory_search query="向量检索阈值"  # 查记忆库（digest 优先，可向量融合）

# Dream：无手动命令，dreamTime 定时在 dream/ 工作区自动跑后台会话；
# 每次巩固后可到 UI 的 dream 工作区打开对应会话查看完整过程
```

Auto-Memory 无需任何操作：开启后每轮自动提醒，主 agent 自行决定写入。

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  searchLimit: 5          # memory_search 默认返回条数（1-10）
  dreamTime: '23:00'      # Dream 每日触发时间（HH:MM）；显式设为 '' = 关闭定时
  embeddingBaseUrl: ''    # Ollama 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3'  # embeddingBaseUrl 提供的嵌入模型名
  autoMemory: true        # 自动记忆开关：每轮 system prompt 提醒；false = 无提醒
```

## 开发

- Node half：`src/*.js`——纯 ESM 手写，**无构建步骤**（`index.js` 入口 + `auto.js` 每轮注入 / `search.js` 检索 / `dream.js` 巩固 / `dream-setup.js` Dream 会话引导（预设安装、工作区登记、setup 挂载）/ `embed.js` 向量 / `store.js` 存储 / `config-http.js` 配置端点）；`preset/` 目录是随插件分发的 Dream agent 预设与规则模板（首次运行复制到 `$DSH_HOME/.agent-presets/dream/` 与 `dream/AGENTS.md`，只写缺失、不覆盖用户编辑）
- client：`client/bundle.js`——手写 bundle 格式（`window.__ModuleLoader__.load`，与官方 `lib/client.js` 同形），注册到 `settings.plugin.item` 槽
- 本地开发：源码目录 `node_modules`（真实 pnpm 安装，版本与运行时一致）负责解析 `@deepseek-ai/*`；运行时解析靠 dsh 扁平模块 fallback，两者互不干扰

## 许可

MIT License
