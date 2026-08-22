[English](README.en.md) | 中文

# dsh-memory

面向 DeepSeek Harness (dsh) 的**跨会话全局记忆插件**。

主 agent 的每次模型请求都会在 system prompt 里收到【自动记忆】提醒，自行判断本轮是否有值得跨会话保留的内容并通过 **`memory_write` 工具**把结论 upsert 进每日记忆文件（插件宿主侧直写，任何文件沙箱模式下都可用）；`memory_search` 工具对这些笔记做**块级检索**（可选向量融合、按日衰减）。官方 bundle 插件形态（`dsh.bundle`），0 patch、**零 npm 依赖、零构建**——`@deepseek-ai/*` 由 dsh 运行时扁平 fallback 提供，与运行实例共享同一份包。

## 能力

| 能力 | 说明 |
|---|---|
| **Auto-Memory** | 每轮 system prompt 注入记忆提醒（`dsh-memory:auto`，order 200），主 agent 判断后调 `memory_write` 写入；子 agent 不提示；`autoMemory: false` 即时关闭 |
| **memory_search 工具** | 标题感知块级检索（任意标题切块、带面包屑）、长度归一子串匹配（中文友好）、**按日衰减**（30 天半衰、下限 0.4——旧笔记降权但不会消失）、snippet 返回整个块（≤1000 字符，通常无需再开文件） |
| **memory_write 工具** | 把一个 `#` 一级主题节 upsert 进今日工作区记忆文件（新标题新增 / 已有 replace 整节替换或 append 追加）；在插件宿主进程里直接写文件，**read-only / workspace-write / danger-full-access 三种沙箱模式下行为一致，永不触发提权**；首行 `<!-- 会话来源: ... -->` 注释自动维护（多会话 id 合并） |
| **向量融合（可选）** | 配置 Ollama 兼容嵌入服务后自动升级为子串 + 向量 RRF 融合（k=60）；服务不可用自动回退纯子串，`memory_search` 永不因向量失败 |
| **配置卡片** | 设置 → 插件 → 插件配置 → 记忆，改完保存即热生效（settings.yaml 持久化，无需重启） |

命令：无——写入靠每轮自动提醒 + `memory_write` 工具，检索靠 `memory_search` 工具。

## 存储布局

单一全局记忆根，所有工作区共享，项目目录零污染：

```
$DSH_HOME/dsh-memory/
└── YYYY-MM-DD/
    └── <workspace-slug>.md   # 每个工作区每天一个文件，正常 markdown 多级标题组织
```

- **无任何状态文件**：无水位/轮次计数，日期在 `memory_write` 执行时现取，跨午夜自动切到新一天文件
- rel 路径自带日期，检索结果里每条记忆的新旧一目了然

## 安装

```bash
dsh plugin --profile web add "github:zhouzhencheng07/dsh-memory"
```

本包声明了 `dsh.bundle.patch`，会被激活为 profile 的 bundle 层（而不是仅仅装成一个不生效的普通依赖）。安装后**重启 `dsh web`** 生效；之后可在设置页「插件」面板停用/启用。更新：push 到 GitHub 后 `dsh plugin --profile web update dsh-memory` + 重启（git 依赖按 commit 缓存，必须 update 才拉到新 commit）。

> 零 npm 依赖：`@deepseek-ai/*` 在运行时经 dsh 的扁平模块 fallback（`$DSH_HOME/profiles/node_modules`）解析，与运行中的 dsh 共享同一份包实例。

### 本地开发安装

```bash
# 本地开发安装：把路径换成你自己的本地检出目录
dsh plugin --profile web add "file:/path/to/dsh-memory"
```

## 工作原理

- `src/auto.js`：Auto-Memory——注册 system prompt context（order 200），每次模型请求组装时重新求值；主 agent 自行决定调用 `memory_write` 或跳过，无后台 LLM 调用、无水位、无重试
- `src/search.js`：任意标题（`#`–`######`）都是切块边界，子节自成一块并带祖先面包屑；大小写不敏感子串命中按块长度归一；每块分数乘 `max(0.4, 0.5^(days/30))` 按日衰减；`rel#面包屑` 精确去重
- `src/embed.js`：可选向量路——内存索引 + sha1 签名缓存（文件未变不重复嵌入），余弦 ≥ 0.45 参与融合，RRF k=60；嵌入模型默认 `bge-m3`
- `src/store.js`：`$DSH_HOME/dsh-memory/` 下每日笔记的读写（节级 upsert、来源注释合并、进程内写队列）
- `client/bundle.js`：手写 client bundle，注册到 `settings.plugin.item` keyed 槽（`key: 'dsh-memory'`）；读写走官方客户端 settings scope（`ctx.settingsScope.bind`）——写入自带 revision 设栅，文档提交/重连自动重读。（rc.7 之前因 api-proxy 命名空间白名单自建的 `/dsh-memory/config` HTTP 端点已删除：rc.7 移除了该白名单）
- 新旧冲突在召回端解决：衰减让新笔记优先，工具描述指引「同主题多条命中时合并新旧而非只信其一」

## 使用

```sh
# 模型侧工具：检索记忆库（旧笔记降权但可达，新笔记优先）
memory_search query="向量检索阈值"

# 模型侧工具：写入今日记忆（每轮【自动记忆】提醒的落点；沙箱模式下也可用）
memory_write title="主题名" content="- 要点……" mode="replace"
```

Auto-Memory 无需任何操作：开启后每轮自动提醒，主 agent 自行判断并调用 `memory_write`。

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  searchLimit: 5            # memory_search 返回条数（1-10）；硬约束，agent 不可覆盖
  embeddingBaseUrl: ''      # Ollama 兼容 /api/embed 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3'  # 嵌入模型名
  autoMemory: true          # 自动记忆开关：false = 不再注入提醒
```

## 环境要求

- Node.js ≥ 22（dsh 自身要求）
- 纯 ESM、零依赖、零构建；不配向量则零网络依赖

## 许可证

MIT
