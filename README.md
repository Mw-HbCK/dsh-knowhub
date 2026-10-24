# 知枢 KnowHub（dsh-knowhub）

> DSH 的全局知识中心与项目长期记忆。把项目知识与长期记忆沉淀成可检索、可审核、可追溯、可备份的知识库，并在 DSH 会话中按工作区作用域自动注入或按需检索。

## 界面预览

![知枢知识中心：Repo Wiki 列表与阅读器](https://raw.githubusercontent.com/Mw-HbCK/dsh-knowhub/main/assets/knowhub-panel.png)

## 功能特性

**知识库与作用域**

- 用户级知识库（跨工作区共享）与工作区级知识库（仅当前项目可见），检索、注入、审核都按作用域隔离。
- 每个知识库可绑定不同的模型与生成策略（economy / balanced / quality），初始化、提炼、增量都使用库绑定的模型。
- 创建后可修改名称、模型与策略，不影响已有知识与版本历史。

**Repo Wiki 与增量更新**

- 一键扫描工作区，生成项目概览、架构、模块等 Wiki 候选。
- 内容哈希 + Git 检出双重判据驱动增量更新：只对受影响的知识生成更新候选，并记录每次检查点与变更清单。
- 已批准的知识不会被流水线静默覆盖，写入类更新一律先成为待审核候选。

**长期记忆与知识卡片**

- 七类知识：Wiki、记忆、偏好、决策、约定、问题、待办。
- 每条知识带来源清单、验证态（observed / inferred / assumed / unverified）、版本历史与审核日志。
- Agent 可在会话中通过工具提议新知识；也可开启自动提炼，在回合结束后把有价值的结论沉淀为候选。

**检索与上下文注入**

- SQLite FTS5 trigram 中文全文检索，1–2 字短词自动回退 LIKE；支持标签过滤（AND、最多 6 个）、类型/状态/知识库过滤与分页加载。
- 同一内容的结果按哈希合并，并提示重复来源。
- 会话系统提示按作用域注入已批准知识摘要，可分别关闭全局记忆与项目记忆，并限制摘要字符数与标题数。

**审核与版本**

- 待审核队列分候选、冲突、草稿、过时四类，真实计数、关键字/类型/来源筛选与排序。
- 支持单条与批量审批（单次最多 50 条）、编辑后批准、冲突人工合并。
- 候选与冲突提供文档对比页：绿色新增、红色删除，行内词元高亮，统一视图与并排视图，改动处导航。
- 版本历史可查看、对比与恢复，恢复同样以新版本追加，可回退。

**备份与维护**

- gzip 备份、恢复前预览、破坏性操作前自动创建恢复点；恢复是合并语义，不删除当前已有的知识。
- 存储位置迁移：预检 → 自动备份 → 计数校验 → 切换指针，回滚只需删除指针文件。
- 环境诊断：运行时、存储、工作区、模型、SQLite FTS5 与工具注册状态。

**导入导出**

- 单篇或整库导出 Markdown（带元数据头），可读可改，可进 Git。
- Markdown 导入支持粘贴或选择文件，一律先落为草稿，同名知识跳过不覆盖。

**面板**

- DSH 内嵌的中文知识中心：Repo Wiki / 知识卡片 / 记忆 / 知识库四个页签，加上待审核 / 检索 / 设置三个整页入口。
- 配色全部读取 DSH 主题 token，跟随浅色 / 深色 / 跟随系统。
- 知识正文使用内置零依赖 Markdown 渲染，可切换「渲染 / 源码」。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | 0.2.x（需含 web 面板 bundle，用于知识中心界面） |
| Node.js | ^22.19 或 >=24 |
| 模型 | 一个已在 profile 中注册的 provider / model，初始化、提炼与增量会调用它 |

## 安装

### 从 npm 安装

```powershell
dsh plugin --profile knowhub add dsh-knowhub
dsh --profile knowhub --port 29961 --no-open
```

- 安装会写入 profile 依赖；请确认 profile 的 `package.json` 中 `dsh.profile.bundles` 包含 `dsh-knowhub`。
- 启动日志会打印面板地址（含一次性 token）：`http://127.0.0.1:29961/?token=...`。

### 从本地 tarball 或源码目录安装

```powershell
# tarball
& dsh plugin --profile knowhub add .\dsh-knowhub-0.8.3.tgz

# 开发期：软链到源码目录，构建后重启即生效
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\knowhub\node_modules\dsh-knowhub" "C:\path\to\KnowHub"
```

### 配置模型

知识库需要模型才能生成 Wiki。在 profile 的 `cordis.patch.yml` 中注册默认模型：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: <provider-id>
    model: <model-id>
```

创建知识库时，面板会列出宿主 `/models` 返回的可用模型，选中后绑定到该库。

## 使用流程

1. **新建知识库**：左侧栏「知枢」→「知识库」→「+ 新建」，选择生效范围（用户级 / 工作区级）、模型与策略。
2. **初始化 Wiki**：在知识库详情点「初始化」，扫描工作区并生成候选草稿。
3. **审核**：右上「待审核」里逐条或批量审批；内容有改动可用「编辑后批准」，冲突可人工合并。
4. **增量更新**：初始化完成后点「增量更新」，只对变更文件影响到的知识生成候选。
5. **记忆与卡片**：会话中由 Agent 工具提议，或开启自动提炼；结果都在待审核里确认。
6. **检索与注入**：右上「检索」按关键词或标签查找；「设置」里控制注入开关与摘要预算。

## 界面说明

| 区域 | 内容 |
|---|---|
| Repo Wiki | 按知识库分组的 Wiki 文档树 + 阅读器：正文、来源清单、版本历史、编辑、标记过时、父级 / 子级知识（最多 5 层）、是否有帮助反馈、导出 Markdown；状态过滤与真实分页 |
| 知识卡片 | 决策 / 约定 / 问题 / 待办四类知识，类型与状态过滤，列表 + 阅读器 |
| 记忆 | 记忆 / 偏好两类知识，类型与状态过滤，列表 + 阅读器 |
| 知识库 | 知识库列表 + 详情：新建与编辑配置、初始化与增量任务（进度 / 日志 / 取消 / 重试）、项目索引、模型调用记录、知识列表分页、导出全部、导入 Markdown、删除 |
| 待审核 | 候选 / 冲突 / 草稿 / 过时四类队列，真实计数、筛选、排序、批量审批；点「查看详情与差异」进入文档对比页；版本历史与审核日志 |
| 检索 | 关键词 + 标签 + 知识库 / 类型 / 状态 / 排序；显示来源、作用域、审核状态与检索模式；结果分页加载 |
| 设置 | 默认策略、提炼开关与阈值、审核人与自动批准、知识注入开关与预算、备份保留、排除目录、存储位置迁移、备份预览与恢复、诊断信息 |

## 配置项

设置保存在知识库存储的配置库中，面板「设置」页可修改。

| 设置 | 默认 | 说明 |
|---|---|---|
| 默认模型使用策略 | balanced | economy / balanced / quality，影响扫描文件数、上下文长度与 Wiki 页数 |
| 自动提炼 | 关闭 | 回合结束后把结论提炼成候选；开启后每轮收尾最多多等一次模型调用 |
| 提炼最小字符数 | 200 | 低于该长度的回合不触发提炼 |
| 自动批准 | 关闭 | 仅对「已批准的 Wiki、基线未变、差异不超过阈值」的更新候选生效，并写入审核日志 |
| 自动批准差异上限 | 10 行 | 新增 + 删除行数上限，1–200 |
| 审核人 | 当前系统用户名 | 审核日志中的操作人 |
| 知识注入 | 开启 | 是否向 Agent 系统提示注入知识摘要 |
| 注入全局记忆 | 开启 | 用户级知识是否进入摘要 |
| 注入项目记忆 | 开启 | 当前工作区知识是否进入摘要 |
| 注入摘要字符数 | 900 | 300–4000 |
| 注入标题数 | 6 | 1–20 |
| 备份保留份数 | 10 | 1–50 |
| 破坏性操作前自动备份 | 开启 | 恢复备份、删除知识库文件前先备份 |
| 额外排除目录 | 空 | 追加到默认排除名单的目录名（如 dist、out） |

## HTTP 接口

共 56 条，均挂在 `/knowhub/api` 下，返回 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`。

| 分组 | 端点 |
|---|---|
| 环境与诊断 | `GET /ping`、`/diagnose?section=`、`/workspaces?path=`、`/models`、`/sqlite`、`/storage-probe`、`/current-workspace`、`POST /probe`、`/scan` |
| 知识库与任务 | `GET\|POST /kb`、`GET\|PATCH\|DELETE /kb/:id`、`POST /kb/:id/initialize`、`POST /kb/:id/incremental`、`GET /kb/:id/tasks\|files\|llm-calls\|git\|changes`、`GET /tasks/:id`、`POST /tasks/:id/cancel\|retry` |
| 知识与版本 | `GET\|POST /kb/:id/docs`、`GET\|PATCH /kb/:id/docs/:docId`、`POST /kb/:id/docs/:docId/parent\|feedback\|review\|restore`、`GET /kb/:id/docs/:docId/versions`、`…/versions/:v`、`…/diff`、`…/export`、`GET /kb/:id/export`、`POST /kb/:id/import`、`GET /documents` |
| 检索与概览 | `GET /search`、`GET /overview` |
| 审核 | `GET /review`、`/review/log`、`/review/proposals/:id`、`POST /review/proposals/:id/approve\|reject`、`GET /review/proposals/:id/diff`、`GET /review/conflicts/:id/diff`、`POST /review/conflicts/:id/resolve`、`POST /review/bulk`、`POST /kb/:id/proposals` |
| 设置与备份 | `GET\|PATCH /settings`、`POST /settings/storage/migrate`、`GET\|POST /backups`、`GET /backups/stats`、`GET /backups/:id/preview`、`POST /backups/:id/restore` |
| 提炼 | `POST /distill`、`GET /distill/runs` |

## 数据与存储

默认存储根：`$DSH_HOME/knowledge-center`，可用配置 `storageRoot` 或位置指针文件 `$DSH_HOME/knowhub-location.json` 覆盖。

```
knowledge-center/
  config.json
  database/knowledge.db        # 配置、元数据、任务、审核、版本关系、父级、反馈、FTS5 索引
  knowledge-bases/<kb-id>/     # knowledge-base.json、wiki/、memories/、knowledge/、index.json
  inbox/pending/  history/  backups/  logs/
```

- 正文以 Markdown 落盘（可读可编辑，原子写 + 写意图表），SQLite 存元数据与索引；两者由「先写意图 → 写文件 → 提交事务」保证一致。
- 中文检索使用 FTS5 `trigram`（≥3 字），1–2 字自动回退 `LIKE`。
- 备份为 gzip JSON（仅知识正文与元数据，不含密钥）。

## 安全与隐私

1. 不读取、不落盘、不打印任何明文密钥；模型调用只传 provider / model，凭据由 DSH 适配层管理。
2. 扫描默认排除 `.git`、`node_modules`、构建产物、缓存、`.env*`、`*.pem`、`id_rsa` 等敏感文件；不跟随符号链接；不执行被扫描仓库的任何脚本。
3. 文件访问限制在已注册工作区与当前工作目录内，扫描接口需 realpath 命中授权根。
4. 作用域由服务端从会话 `cwd` 反查得出，客户端参数不能扩大范围；跨知识库的详情与检索一律隔离。
5. 自动生成的知识默认待审核，批准后才成为正式知识；已批准文档不会被流水线静默覆盖。
6. 模型输出必须通过结构校验（JSON 解析、类型/长度/置信度范围、敏感信息清洗、绝对路径剔除）才进候选。
7. Git 只读调用，失败自动降级为内容哈希模式并记录原因。
8. 备份与恢复均在本地完成；恢复是合并语义，恢复前自动创建恢复点。
9. 存储迁移：目标必须是独立绝对路径，先自动备份、校验计数一致后才切换指针；回滚只需删除或改写指针文件。
10. 破坏性操作（删库、迁移、恢复）在界面上均需二次确认；插件禁用或卸载不删除用户知识。
11. Markdown 导入一律以草稿落库（即使文件里写 approved 也不绕过审核），同名知识跳过不覆盖，单次最多 200 篇 / 2 MB。

## 开发

```powershell
& node scripts/build.mjs          # TypeScript → lib（宿主 + 客户端）
& npm run typecheck               # 类型检查
& node tools/verify-client.cjs    # 客户端渲染冒烟
& node scripts/ci.mjs             # 类型检查 + 构建 + 全部测试
& npm pack --cache .npm-cache    # 产出 dsh-knowhub-<版本>.tgz 到仓库根目录
```

```
src/host/      宿主侧：路由、SQLite、检索、审核、流水线、工具、注入
src/client/    知识中心面板（React 由宿主提供）
lib/           构建产物（npm 包内容）
scripts/       构建与 CI
tests/         单元、契约与真机 e2e 脚本
```

## 许可

MIT，见 [LICENSE](LICENSE)。
