# 仓库审查工具

Extension Host 为共享 AI SDK Agent 注册下列七个只读工作区工具；审查轮另提供 `submit_review` 和 `finish_review`。OpenAI Provider 会将它们放入 `review` namespace；其他 Provider 共用相同定义和执行逻辑。VS Code 的编辑器、文件查找与诊断由 `VSCodeReviewWorkspace` 适配，Git、快照与文件区域引用由 `ReviewContext` 管理。

| 工具                 | 输入                                                                          | 结果                                                                                         |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `get_review_context` | `{}`                                                                          | 工作区、仓库列表、当前仓库根目录/分支/HEAD、活动文件/语言/选区、未保存文件列表、工程配置入口 |
| `list_changes`       | `{ scope, baseRef? }`                                                         | `reviewId`、创建/过期时间、固定的 HEAD/base、变更状态与 `oldPath`/`newPath`                  |
| `get_diff`           | `{ reviewId, paths, cursor? }`                                                | Git unified patch 片段、hunks、每行的旧/新行号、二进制标记、`truncated`/`nextCursor`         |
| `read_file`          | `{ reviewId, path, version, startLine, endLine }`                             | 指定快照版本的带行号代码、总行数、截断标记、`nextStartLine`                                  |
| `cite_files`         | `{ reviewId, references: [{ path, version, scope?, startLine?, endLine? }] }` | 文件或区域的 `referenceId`、`scope`、仓库/路径/版本、可选行范围、显示标签与 Markdown         |
| `search_code`        | `{ query, glob?, limit? }`                                                    | 当前代码中区分大小写的单行字面量匹配、文件/行/列、前后各一行上下文                           |
| `get_diagnostics`    | `{ paths }`                                                                   | VS Code 当前诊断的来源、严重级别、代码、消息、位置及截断标记                                 |

所有工具路径均相对当前仓库根目录；上下文中的工作区、活动文件和未保存文件使用绝对路径。行号与列号从 1 开始，列按 VS Code 的 UTF-16 单位计数；选区与诊断的结束位置不包含在范围内，`read_file.endLine` 包含在范围内。多仓库时优先选择活动文件所属的最深层仓库；只有一个仓库时可以直接使用它。没有明确仓库时，上下文返回 `repository: null`，其他工具返回 `repository_unavailable`。

## 增量式审查

前端不再提供“交互模式”入口，也不发送或保存模式。每轮用户消息到达 Host 后，`runtime/modeRouter` 先复用当轮模型与用户选择的推理强度做一次意图路由：模型通过唯一的 `select_interaction_mode` 工具返回 `chat` 或 `review`，只有明确要求审查、核实改动或继续未完成审查的请求才进入审查流程，其余按普通聊天处理；路由失败、缺少工具调用或置信度不足时一律降级为普通聊天。请求体中的 `mode` 字段仍然保留，旧客户端显式传入时直接采用且不再路由。两种流程共用现有 `ToolLoopAgent` 多轮循环；审查工具在 Host 执行，前端仅注册渲染器。

每确认一个问题，立即调用：

```json
{
  "reviewId": "本轮 list_changes 返回的 UUID",
  "title": "问题标题",
  "priority": "P1",
  "description": "触发条件、实际影响及依据",
  "referenceIds": ["cite_files 返回的范围引用 ID"]
}
```

`submit_review` 接收一条意见，优先级为 P0–P3。Host 校验标题、描述、当前运行的快照及每个已登记的范围引用，拒绝跨快照、跨会话、过期、未知或整文件引用。成功后先写入会话独立的 `ReviewJournal`，再返回 `{ accepted: true, duplicate, finding }`。卡片字段只读取此结果；流式参数和模型普通文本不能生成问题卡片。描述按 Markdown 渲染，其中的文件链接仅允许跳转到该条意见已验证的引用；刷新恢复后使用同一渲染逻辑。Host 按规范化标题、描述及排序去重后的仓库/路径/版本/行范围计算身份，同一意见重复或并发提交复用原记录、原工具调用 ID，不新增卡片。

审查结束时单独调用 `finish_review`：

```json
{ "status": "completed", "unfinishedItems": [], "limitations": [] }
```

仅接受 `completed` / `incomplete`、未完成事项和审查限制，禁止意见列表及模型声明的数量。`completed` 必须已建立快照、完整读取每个变更文件的连续 diff 分页、没有未修正的工具错误及未完成事项。校验失败作为工具反馈交回模型，允许修正或声明 `incomplete`。成功后直接停止循环，绝不额外调用模型生成总结；模型只输出普通文本而没有成功收尾时，本轮失败，不能据此认定完成。系统最终结合运行成功/取消/失败、收尾结果与账本实际意见数生成状态提示。前端收尾卡片及导出中的收尾提示仅展示实际状态和已收录问题数，未完成事项和审查限制保存在运行记录中，不追加到展示报告。读取了全部 diff 只验证工具覆盖范围，不证明模型发现了所有缺陷。

Host 在执行工具前检查本轮完整调用列表；`finish_review` 与任何其他工具混用时先返回校验错误，模型需在下一轮单独重试。成功收尾的停止状态不能被后续错误通知撤销。系统生成的未完成事项和限制分别最多保存 2,000 条，超出时保留前 1,999 条，并用最后一条注明省略的数量；取消、失败及未完成状态使用同一上限，保证终态能通过前端校验并刷新恢复。

`data-review-receipt` 为与提交结果相同的 transient 保存回执，前端即时缓存；最终 `data-review-status` 为持久消息部分，由 assistant-ui Data UI 展示。每条意见使用 `display: "standalone"` 的 assistant-ui Tool UI，独立于读取工具的时间线。审查轮不向前端发送模型的普通文本，普通聊天仍保留。

点击已收录意见的代码引用时，Host 从该会话账本查找对应意见，在当前活动编辑器分组内以预览方式打开代码并展开 VS Code 原生评论线程，显示优先级、标题和 Markdown 描述。批注绑定已验证的行范围，只读且不接受回复；重复点击复用同一批注，切换编辑器分组后跟随当前分组打开。当前文件与审查内容不同时，批注显示在原始只读快照上，旧位置的批注会被移除。标注栏提供“归档批注”：后端先持久化该意见的 `editorArchived`，再销毁该意见所有引用对应的 CommentThread；不修改解决状态、意见正文、引用快照或收录数量。重复点击、过期线程参数及并发状态修改受到校验。保存失败保留批注并允许重试，较旧响应不会恢复已经归档的批注。刷新及重启后保持归档；卡片显示“批注已归档”，可通过“恢复批注”保存取消归档并重新打开代码。扩展关闭时清理评论控制器及线程。

`GET /v1/sessions/:id/reviews` 返回 Host 的运行记录与已保存意见。账本按对话保存至扩展工作区存储；刷新、停止、断线或 Host 重启后按稳定的运行/意见/工具调用 ID 恢复同一 Tool UI。取消或失败不会删除已收录意见，也不依赖成功提交完整模型历史；运行中的旧记录在重启后显示中断，继续审查需要新建 Agent 会话。意见的解决状态、批注归档状态与引用快照同样保留，点击引用后恢复对应的原生标注和状态按钮。Markdown 导出使用同一批回执。每个会话最多保存 1,000 个运行和 1,000 条不同意见。

## 审查范围与版本

| `scope`        | `version: old`                  | `version: new`                               |
| -------------- | ------------------------------- | -------------------------------------------- |
| `staged`       | 固定 HEAD；未创建初始提交时为空 | 暂存区                                       |
| `working-tree` | 暂存区；冲突文件使用 ours 阶段  | 磁盘工作区及未保存编辑器内容，包含未跟踪文件 |
| `all`          | 固定 HEAD；未创建初始提交时为空 | 磁盘工作区及未保存编辑器内容，包含未跟踪文件 |
| `branch`       | `merge-base(baseRef, HEAD)`     | 固定 HEAD                                    |

`branch` 必须提供现有 commit/ref 的 `baseRef`，其余范围不接受 `baseRef`。忽略文件不作为未跟踪文件加入快照。冲突状态以 `conflict` 返回；未解决的暂存区条目没有可读的 stage-0 新版本或 staged patch，应使用 `all` / `working-tree` 审查冲突标记。符号链接返回链接本身的文本，子模块返回 commit 变更且不能作为源文件读取。

`list_changes` 固定 Git blob ID，捕获本地改动与未保存内容；未改动的文件也能通过同一 `reviewId` 读取。之后修改文件、暂存或移动 HEAD 不会改变该快照。供模型读取及提交新意见的快照每个会话保留最近四个，有效期 15 分钟；删除会话或关闭 Bridge 会清理这些内存快照。未知、跨会话或过期 ID 返回 `review_not_found`。已经由 `cite_files` 保存的用户导航引用独立保留，不随这些内存快照过期，也不能替代新意见所需的当前快照校验。

## 调用示例

```text
get_review_context({})
list_changes({ scope: "all" })
get_diff({ reviewId: "上一步的 UUID", paths: ["src/example.ts"] })
read_file({ reviewId: "同一个 UUID", path: "src/example.ts", version: "new", startLine: 1, endLine: 120 })
cite_files({ reviewId: "同一个 UUID", references: [{ path: "src/example.ts", version: "new", startLine: 42, endLine: 48 }] })
cite_files({ reviewId: "同一个 UUID", references: [{ path: "src/example.ts", version: "new", scope: "file" }, { path: "src/example.ts", version: "new", scope: "range", startLine: 42, endLine: 48 }] })
search_code({ query: "exampleFunction", glob: "**/*.{ts,tsx}", limit: 30 })
get_diagnostics({ paths: ["src/example.ts"] })
```

`get_diff` 每页返回一个文件的部分或完整 patch，保留请求路径顺序。使用相同 `reviewId` 和 `paths` 携带 `nextCursor` 继续读取，直至 `truncated: false`。将同一文件的 `patch` 按页拼接即可恢复完整文本 patch；`patchOffset` 标识字符偏移，`patchEnd` 表示本页到达该文件 patch 末尾，超长行的结构化片段带 `partial: true`。新增行的 `oldLine`、删除行的 `newLine` 为 `null`。二进制文件返回 Git 风格的二进制差异提示，不返回可应用的二进制载荷。

`search_code` 和 `get_diagnostics` 查询当前编辑器状态，可能与快照不同；诊断也可能尚未随编辑器更新。搜索优先使用未保存内容，跳过 `.git`、`node_modules`、`dist`、`build`、二进制文件、过大文件和不可访问文件，并返回 `skippedFiles`。

## 文件与区域引用

`cite_files` 一次登记 1–20 个文件或区域，可在同一批次混合两种类型。每项必须明确指定快照的 `old` / `new` 版本：

| `scope` | 行号参数                            | 含义与点击行为                                                    |
| ------- | ----------------------------------- | ----------------------------------------------------------------- |
| `file`  | 禁止提供 `startLine`、`endLine`     | 引用整份文本文件，点击打开文件，不主动选区或滚动定位              |
| `range` | 必须同时提供 `startLine`、`endLine` | 引用指定代码区域，点击打开文件并选中、滚动到对应行范围            |
| 省略    | 必须同时提供 `startLine`、`endLine` | 兼容原有调用，等价于 `range`，返回结果仍明确标注 `scope: "range"` |

范围引用的起止行从 1 开始且都包含在范围内。工具会实际读取对应快照并校验整个范围；不会把超出 EOF 的结束行静默截短。单区域最多 500 行、24,000 字符，空文件和截断区域不能作为行范围引用。单行引用使用相同的起止行。整文件引用支持空文件、超过 500 行或含超长行的文本文件，继续受单文件 1 MiB 限制；二进制文件与子模块不支持文本引用。未指定 `scope` 且缺少行号、仅提供一端行号或在 `file` 类型混入行号均会报错。

返回示例（ID 为示意，实际为 `ref_` 加 64 位十六进制摘要）：

```json
{
  "references": [
    {
      "referenceId": "ref_example",
      "reviewId": "来自 list_changes 的 UUID",
      "repository": "/workspace/project",
      "path": "src/example.ts",
      "version": "new",
      "scope": "range",
      "startLine": 42,
      "endLine": 48,
      "label": "src/example.ts:42–48",
      "markdown": "[src/example.ts:42–48](review-file:ref_example)"
    },
    {
      "referenceId": "ref_file_example",
      "reviewId": "来自 list_changes 的 UUID",
      "repository": "/workspace/project",
      "path": "src/example.ts",
      "version": "new",
      "scope": "file",
      "label": "src/example.ts",
      "markdown": "[src/example.ts](review-file:ref_file_example)"
    }
  ]
}
```

`referenceId` 唯一绑定快照、路径、版本与引用类型；范围类型还绑定起止行。整文件与覆盖全部行的范围引用具有不同 ID。旧调用和显式 `scope: "range"` 使用相同的区域 ID，原有区域 ID 算法保持不变；重复登记同一目标会复用 ID。不同文件、版本、行范围或快照使用不同 ID。重命名和删除代码应使用对应版本真实存在的路径，旧版本的显示标签带 `(old)`。Markdown 标签会转义文件名中的语法字符，原始 `path` 保持不变。整文件结果不含虚构的起止行，链接标签只显示文件名。

一个批次全部校验成功后才会登记引用；每个快照最多 1,000 个不同文件或区域，重复引用不占用额外容量。引用与快照共用 15 分钟有效期和最近四个快照的保留限制；过期、淘汰或删除会话会一起清理。Host 可通过 `ReviewContext.getFileReference(referenceId)` 取得定位信息，该接口不是模型工具，并会重新检查工作区信任与仓库是否仍然打开。

Agent instructions 要求模型先用 `read_file` / `get_diff` 核对证据，再批量调用 `cite_files`，将返回的 `markdown` 原样放在对应结论旁。讨论文件职责或入口使用 `scope: "file"`；具体代码问题使用精确的 `scope: "range"`。实时搜索和诊断的位置应先用快照核对；工具报错时修正参数或说明无法引用，不得编造 ID。工具验证目标是否存在，不判断它是否足以支持模型结论；通用解释不强制引用。

引用通过标准 AI SDK 工具结果进入 UI 与模型历史。正文中的 `review-file:<referenceId>` 由 Markdown 链接组件高亮；用户点击后，通过独立的 `reference/open` 消息传递对应会话的 Host `sessionId` 与 `referenceId`，不会将引用 ID 当作文件 URI。旧的 `review-file:<encoded-file-uri>` 链接仍使用原有文件打开路径。

Host 只在对应会话内解析引用，并重新检查工作区信任与仓库边界。`cite_files` 返回成功前，引用元数据及完整源文本已按对话写入扩展工作区存储的 `file-references-v1` 目录；同一份文本共用内容摘要命名的文件，整个批次通过原子替换清单发布。保存失败返回工具错误，允许重试，不发布半条引用。每个会话最多保存 20,000 条不同引用，重复登记不占用额外数量。聊天引用和审查引用使用相同的保存机制。

新版本引用的完整快照内容与当前编辑器内容一致时，在现有 editor 中打开原文件；内容已变化、文件已删除、符号链接被替换或引用旧版本时，使用 `meerkat-review` 的只读虚拟文档展示原快照。不会把旧版本行号套用到不同的当前文件上。`readFileReference` 保留完整快照文本（含 CRLF、结尾换行），不受模型工具每页 500 行的限制。归档读取独立于模型会话及 Git blob，重启后无需恢复 Provider 会话即可打开。

编辑器选区从 `startLine - 1` 的第 0 列开始，直到 `endLine - 1` 的行尾，包含所引用的所有行；随后滚动到选区。默认使用 `ViewColumn.Active`，即左侧聊天旁现有的编辑区，点击后将焦点移入 editor。取消、失败和 Host 关闭保留已保存引用，删除对话时清理对应清单及源文本。旧版本中已失效且从未保存完整源文本的引用无法补回，损坏或缺失的归档明确报错，不使用当前文件冒充原快照。

`cite_files` 本身只登记引用，用户点击才会打开编辑器；不会修改任何文件。

## 限制与错误

- 快照最多 20,000 个文件；捕获的本地内容总计最多 24 MiB，单文件最多 1 MiB。超限会显式失败，不创建不完整快照。
- diff patch 片段每页最多 24,000 字符；文件读取每次 1–500 行、最多 24,000 字符。`contentTruncated` 表示单行自身超长，`nextStartLine` 用于继续读取后续行。
- 搜索最多扫描 2,000 个候选文件，默认返回 50 条、最多 100 条；诊断最多返回 200 条。达到上限时返回截断标记。
- 文件请求最多 100 条路径；禁止绝对路径、路径穿越、反斜杠路径与 `.git` 元数据。磁盘读取校验符号链接解析后的边界；不会读取仓库外的链接目标。
- 工具收到 Bridge 的取消信号，Git 子进程会随之终止。Git 调用使用参数数组与固定的只读命令，禁用外部 diff、textconv 和 fsmonitor；不会写入用户的工作区或 Git 索引。
- 可恢复错误以 `{ error: { code, message } }` 返回，取消保持为取消状态。没有宿主上下文时，工具仍注册但返回 `review_unavailable`。

## 测试

```sh
bun test tests/fileReferences.test.ts tests/fileReferencePersistence.test.ts tests/reviewTools.test.ts tests/reviewAgent.test.ts tests/provider.test.ts tests/modeRouter.test.ts
bun run check
bun run build
```

仓库 fixtures 使用真实 Git，验证各范围、重命名、插入行号、分页与快照稳定性；文本 patch 通过 `git apply --check` 验证。SDK 集成测试通过真实 AI SDK、OpenAI Provider 与 Bridge runtime 执行全部七个工具，并检查引用指令、工具结果历史、最终回答引用、跨轮复用和会话删除清理。`modeRouter.test.ts` 覆盖审查/聊天判定、低置信度与非法输出降级、路由失败降级、取消透传，以及路由始终使用用户选择的模型与推理强度；`bridgeServer.test.ts` 覆盖显式 mode 绕过路由与自动审查分流。`fileReferences.test.ts` 覆盖区域精度、范围校验、版本/路径绑定、Markdown 转义、容量限制、会话隔离、完整快照读取与引用生命周期。VS Code 适配测试检查原生 API 参数、未保存文档过滤、坐标转换及诊断等级映射；引用导航测试验证 IPC、选区、滚动以及旧版/修改/删除/符号链接文件的快照回退。Webview 测试覆盖高亮链接点击、历史会话绑定、旧 URI 链接兼容、无效链接和错误展示。
