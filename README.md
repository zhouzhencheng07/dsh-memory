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
| `memory_search` | 搜索 memory + dream：子串匹配（中文友好）、digest 加权，配置向量服务后自动升级为子串 + 向量 RRF 融合 |
| `memory_dream` | 立即执行一次 Dream 巩固（同 `/dream`，模型侧入口） |

**命令**（用户侧）：

| 命令 | 说明 |
|---|---|
| `/dream` | 立即执行一次 Dream 巩固（不依赖定时开关） |

**系统集成**（无 UI 组件，零官方改动）：

| 功能 | 说明 |
|---|---|
| Auto-Memory | 每轮 system prompt 注入记忆提醒（`dsh-memory:auto`，order 200），主 agent 自行判断并写入；子 agent 不提示 |
| Dream 定时 | `dreamTime`（默认 23:00）每日自动巩固；空 = 关（`/dream` 手动仍可用） |
| 配置卡片 | 设置 → 插件 → 插件配置 → 记忆（dsh-memory），改完保存即热生效（settings.yaml 持久化，无需重启） |

## 记忆写入：Auto-Memory

记忆由**主 agent 在对话中直接整理**——没有后台 LLM 调用（实测两次失败：手拼请求破坏 tool-call 配对 → 400；`reasoningEffort: max` 模型把 token 全花在思考 → 空回答。对话机制组装合法请求、主模型正常回答，两种失败都不存在）：

- **机制**：`autoMemory: true`（默认）时，插件注册一段 system prompt context（`order: 200`），**每次模型请求组装时重新求值**，提醒主 agent 审视本轮内容；有值得记的（决策及原因、偏好/纠正/约定、踩坑与修复、可复用命令/流程、状态变化）就主动写入，没有就不动文件
- **执行规则**：文件不存在 → `write` 新建；已存在 → 只用 `edit` 精确修改（禁止整体 write 覆盖）；只写尚未覆盖的新内容，旧内容过时或错误时更新修正；关键处逐字引用；多级标题（# 主题 + ## 小节）；首行来源注释；全文不写日期/时间戳
- **跨日天然正确**：提醒里的文件路径在组装时取**当天**日期——跨午夜的会话自动切到新一天文件，无水位、无轮次计数
- **子 agent 不参与**（`delegationDepth > 0` 不注入）；`autoMemory: false` 时注入为空（段落常驻、开关即时生效，无需重挂）
- **无重试**（失败即设计问题，如实暴露）；无专用写入工具（直接用 dsh 自带的 read/edit/write）；无手动命令（每轮提醒即捕获路径）

## Dream 机制

- **触发**：`dreamTime`（默认 23:00；非空 = 定时开，空 = 关）每日定时 + `/dream` 命令 + `memory_dream` 工具
- **桶**：`personal`（偏好/约定/约束）、`procedure`（流程/方法）、`wiki`（知识/原则/先例/事实）
- **窗口（固定两天，无水位）**：每次处理「今天 + 昨天」的全部笔记——每个文件有两次扫描机会；重复运行靠 `merge_with` 收敛（不产生重复节点）
- **流程**：窗口内 `memory/` 笔记 → 当前会话模型整合进 `dream/<桶>/<主题>.md`：同主题 `merge_with` 融合（保留旧要点与全部来源）、新主题新建；文件尾写 `derived_from:: [[memory/...]]` 溯源；原始笔记永不删除
- **质量 gate**：宁缺毋滥——只提炼可长期复用的抽象（禁止 passing mention/已知概念复述/事件总括/一次性时间戳）；不进 digest 的笔记仍被 `memory_search` 全库检索

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
# 用户侧
/dream                              # 立即巩固一次（把近两天笔记提炼进 dream/）

# 模型侧（工具）
memory_search query="向量检索阈值"  # 查记忆库（digest 优先，可向量融合）
memory_dream                        # 巩固（同 /dream）
```

Auto-Memory 无需任何操作：开启后每轮自动提醒，主 agent 自行决定写入。

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  searchLimit: 5          # memory_search 默认返回条数（1-10）
  model: ''               # Dream LLM 模型覆盖，provider/model；留空 = 会话模型
  dreamTime: '23:00'      # Dream 每日触发时间（HH:MM）；留空 = 关闭定时（/dream 手动仍可用）
  embeddingBaseUrl: ''    # Ollama 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3'  # embeddingBaseUrl 提供的嵌入模型名
  autoMemory: true        # 自动记忆开关：每轮 system prompt 提醒；false = 无提醒
```

## 开发

- Node half：`src/*.js`——纯 ESM 手写，**无构建步骤**（`index.js` 入口 + `auto.js` 每轮注入 / `search.js` 检索 / `dream.js` 巩固 / `embed.js` 向量 / `store.js` 存储 / `config-http.js` 配置端点）
- client：`client/bundle.js`——手写 bundle 格式（`window.__ModuleLoader__.load`，与官方 `lib/client.js` 同形），注册到 `settings.plugin.item` 槽
- 本地开发：源码目录 `node_modules`（真实 pnpm 安装，版本与运行时一致）负责解析 `@deepseek-ai/*`；运行时解析靠 dsh 扁平模块 fallback，两者互不干扰

## 许可

MIT License
