[English](README.en.md) | 中文

# dsh-memory

面向 DeepSeek Harness (dsh) 的**跨会话全局记忆插件**。

主 agent 自行判断本轮是否有值得跨会话保留的内容，通过路径固定的 **`memory` 工具**（mode=read/write/edit）读写今日记忆文件——捕获时机与质量规则写在工具描述里（随工具 schema 每个请求下发），**没有每轮 system prompt 提醒**；`memory_search` 工具对这些笔记做**块级检索**（可选向量融合、按日衰减）。官方 bundle 插件形态（`dsh.bundle`），0 patch、**零 npm 依赖、零构建**——`@deepseek-ai/*` 由 dsh 运行时扁平 fallback 提供，与运行实例共享同一份包。

## 能力

| 能力 | 说明 |
|---|---|
| **工具驱动的捕获** | `memory` 工具描述自带使用时机（决策/纠正/踩坑/可复用流程/状态变化）与质量规则（合并优先、弃用一两句带过、长节拆子标题、不写流水账），随工具 schema 每请求下发；主 agent 自行判断调用，无每轮 system prompt 提醒 |
| **memory_search 工具** | 标题感知块级检索（任意标题切块、带面包屑）、分层关键词匹配（字面 ×1.0 → 去格式符宽容 ×0.95 → 多词 AND 兜底 ×0.7——模糊允许但按度扣分，精确永远优先）、**按日衰减**（30 天半衰、下限 0.4——旧笔记降权但不会消失）、snippet 返回整个块（≤1000 字符，通常无需再开文件） |
| **memory 工具** | 单工具三 mode（`read`/`write`/`edit`）：内部计算今日工作区记忆文件路径（模型不可改），**透传宿主原生 read/write/edit 管线**——与模型自己的文件工具同一套沙箱栅栏与"改前必读"观察（mode=edit 未读先改会被拒，mode=write 覆盖未读文件会被拒；`$DSH_HOME` 写入需要 danger-full-access）；任何一次调用返回都会回显文件路径，agent 首次调用后即可用原生工具；首行 `<!-- 会话来源: ... -->` 注释自动维护（write 内联合并，edit 后自动收尾） |
| **向量融合（可选）** | 配置 Ollama 兼容嵌入服务后自动升级为关键词 + 向量 RRF 融合（k=60）；服务不可用自动回退纯关键词，`memory_search` 永不因向量失败 |
| **配置卡片** | 设置 → 插件 → 插件配置 → 记忆，改完保存即热生效（settings.yaml 持久化，无需重启） |

命令：无——写入靠工具描述引导的模型自主判断 + `memory` 工具，检索靠 `memory_search` 工具。

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

## 工作原理

- `src/index.js`：单工具 `memory`（mode=read/write/edit）——路径固定为今日工作区记忆文件，`ctx.tools.execute()` 子派发宿主原生 read/write/edit（同一套沙箱栅栏与"改前必读"观察；mode=write 落盘前把来源注释合并进 content，mode=edit 成功后做一次来源收尾）；任何返回都回显文件路径
- `src/search.js`：任意标题（`#`–`######`）都是切块边界，子节自成一块并带祖先面包屑；分层关键词匹配——整串字面 ×1.0 → 去格式符（反引号/引号/加粗记号，标识符 `-` `_` `.` 保留）宽容 ×0.95 → 多词 AND 兜底 ×0.7，命中数按块长度归一；每块分数乘 `max(0.4, 0.5^(days/30))` 按日衰减；`rel#面包屑` 精确去重
- `src/embed.js`：可选向量路——内存索引 + sha1 签名缓存（文件未变不重复嵌入），余弦 ≥ 0.45 参与融合，RRF k=60；嵌入模型默认 `bge-m3`
- `src/store.js`：纯函数词汇——路径/slug/日期派生、来源注释解析与合并、`walkMemory`（插件本身不再直接写磁盘，写改全部走宿主原生工具的透传）
- `client/bundle.js`：手写 client bundle，注册到 `settings.plugin.item` keyed 槽（`key: 'dsh-memory'`）；读写走官方客户端 settings scope（`ctx.settingsScope.bind`）——写入自带 revision 设栅，文档提交/重连自动重读。（rc.7 之前因 api-proxy 命名空间白名单自建的 `/dsh-memory/config` HTTP 端点已删除：rc.7 移除了该白名单）
- 新旧冲突在召回端解决：衰减让新笔记优先，工具描述指引「同主题多条命中时合并新旧而非只信其一」

## 使用

```sh
# 模型侧工具：检索记忆库（旧笔记降权但可达，新笔记优先）
memory_search query="向量检索阈值"

# 模型侧工具：读取今日记忆（返回路径+行内容；改前必读由此满足）
memory mode="read"

# 模型侧工具：全量重写今日记忆（时机与质量规则见工具描述；需要 danger-full-access；
# 文件不存在即新建，已存在的笔记需先读过）
memory mode="write" content="# 主题名

- 要点……"

# 模型侧工具：局部修改（未读先改会被宿主拦截，先 mode="read" 再来）
memory mode="edit" old_string="旧句子" new_string="新句子"
```

记忆无需任何操作：`memory` 工具描述自带时机与纪律，主 agent 自行判断调用；任一调用返回都带文件路径，首次调用后即可用原生工具直接读写。

## 配置

`$DSH_HOME/settings.yaml`（热更新，不用重启；也可在设置页配置卡片改）：

```yaml
dsh-memory:
  searchLimit: 5            # memory_search 返回条数（1-10）；硬约束，agent 不可覆盖
  embeddingBaseUrl: ''      # Ollama 兼容 /api/embed 基地址（如 http://localhost:11434）；留空禁用向量检索
  embeddingModel: 'bge-m3'  # 嵌入模型名
```

## 环境要求

- Node.js ≥ 22（dsh 自身要求）
- 纯 ESM、零依赖、零构建；不配向量则零网络依赖

## 许可证

MIT
