# 仓库审查工具

Extension Host 为共享 AI SDK Agent 注册下列六个只读工具。OpenAI Provider 会将它们放入 `review` namespace；其他 Provider 共用相同定义和执行逻辑。VS Code 的编辑器、文件查找与诊断由 `VSCodeReviewWorkspace` 适配，Git 与快照由 `ReviewContext` 管理。

| 工具                 | 输入                                              | 结果                                                                                         |
| -------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `get_review_context` | `{}`                                              | 工作区、仓库列表、当前仓库根目录/分支/HEAD、活动文件/语言/选区、未保存文件列表、工程配置入口 |
| `list_changes`       | `{ scope, baseRef? }`                             | `reviewId`、创建/过期时间、固定的 HEAD/base、变更状态与 `oldPath`/`newPath`                  |
| `get_diff`           | `{ reviewId, paths, cursor? }`                    | Git unified patch 片段、hunks、每行的旧/新行号、二进制标记、`truncated`/`nextCursor`         |
| `read_file`          | `{ reviewId, path, version, startLine, endLine }` | 指定快照版本的带行号代码、总行数、截断标记、`nextStartLine`                                  |
| `search_code`        | `{ query, glob?, limit? }`                        | 当前代码中区分大小写的单行字面量匹配、文件/行/列、前后各一行上下文                           |
| `get_diagnostics`    | `{ paths }`                                       | VS Code 当前诊断的来源、严重级别、代码、消息、位置及截断标记                                 |

所有工具路径均相对当前仓库根目录；上下文中的工作区、活动文件和未保存文件使用绝对路径。行号与列号从 1 开始，列按 VS Code 的 UTF-16 单位计数；选区与诊断的结束位置不包含在范围内，`read_file.endLine` 包含在范围内。多仓库时优先选择活动文件所属的最深层仓库；只有一个仓库时可以直接使用它。没有明确仓库时，上下文返回 `repository: null`，其他工具返回 `repository_unavailable`。

## 审查范围与版本

| `scope`        | `version: old`                  | `version: new`                               |
| -------------- | ------------------------------- | -------------------------------------------- |
| `staged`       | 固定 HEAD；未创建初始提交时为空 | 暂存区                                       |
| `working-tree` | 暂存区；冲突文件使用 ours 阶段  | 磁盘工作区及未保存编辑器内容，包含未跟踪文件 |
| `all`          | 固定 HEAD；未创建初始提交时为空 | 磁盘工作区及未保存编辑器内容，包含未跟踪文件 |
| `branch`       | `merge-base(baseRef, HEAD)`     | 固定 HEAD                                    |

`branch` 必须提供现有 commit/ref 的 `baseRef`，其余范围不接受 `baseRef`。忽略文件不作为未跟踪文件加入快照。冲突状态以 `conflict` 返回；未解决的暂存区条目没有可读的 stage-0 新版本或 staged patch，应使用 `all` / `working-tree` 审查冲突标记。符号链接返回链接本身的文本，子模块返回 commit 变更且不能作为源文件读取。

`list_changes` 固定 Git blob ID，捕获本地改动与未保存内容；未改动的文件也能通过同一 `reviewId` 读取。之后修改文件、暂存或移动 HEAD 不会改变该快照。每个聊天会话保留最近四个快照，有效期 15 分钟；删除会话或关闭 Bridge 会清理快照。未知、跨会话或过期 ID 返回 `review_not_found`。

## 调用示例

```text
get_review_context({})
list_changes({ scope: "all" })
get_diff({ reviewId: "上一步的 UUID", paths: ["src/example.ts"] })
read_file({ reviewId: "同一个 UUID", path: "src/example.ts", version: "new", startLine: 1, endLine: 120 })
search_code({ query: "exampleFunction", glob: "**/*.{ts,tsx}", limit: 30 })
get_diagnostics({ paths: ["src/example.ts"] })
```

`get_diff` 每页返回一个文件的部分或完整 patch，保留请求路径顺序。使用相同 `reviewId` 和 `paths` 携带 `nextCursor` 继续读取，直至 `truncated: false`。将同一文件的 `patch` 按页拼接即可恢复完整文本 patch；`patchOffset` 标识字符偏移，超长行的结构化片段带 `partial: true`。新增行的 `oldLine`、删除行的 `newLine` 为 `null`。二进制文件返回 Git 风格的二进制差异提示，不返回可应用的二进制载荷。

`search_code` 和 `get_diagnostics` 查询当前编辑器状态，可能与快照不同；诊断也可能尚未随编辑器更新。搜索优先使用未保存内容，跳过 `.git`、`node_modules`、`dist`、`build`、二进制文件、过大文件和不可访问文件，并返回 `skippedFiles`。

## 限制与错误

- 快照最多 20,000 个文件；捕获的本地内容总计最多 24 MiB，单文件最多 1 MiB。超限会显式失败，不创建不完整快照。
- diff patch 片段每页最多 24,000 字符；文件读取每次 1–500 行、最多 24,000 字符。`contentTruncated` 表示单行自身超长，`nextStartLine` 用于继续读取后续行。
- 搜索最多扫描 2,000 个候选文件，默认返回 50 条、最多 100 条；诊断最多返回 200 条。达到上限时返回截断标记。
- 文件请求最多 100 条路径；禁止绝对路径、路径穿越、反斜杠路径与 `.git` 元数据。磁盘读取校验符号链接解析后的边界；不会读取仓库外的链接目标。
- 工具收到 Bridge 的取消信号，Git 子进程会随之终止。Git 调用使用参数数组与固定的只读命令，禁用外部 diff、textconv 和 fsmonitor；不会写入用户的工作区或 Git 索引。
- 可恢复错误以 `{ error: { code, message } }` 返回，取消保持为取消状态。没有宿主上下文时，工具仍注册但返回 `review_unavailable`。

## 测试

```sh
bun test tests/reviewTools.test.ts tests/reviewAgent.test.ts tests/provider.test.ts
bun run check
bun run build
```

仓库 fixtures 使用真实 Git，验证各范围、重命名、插入行号、分页与快照稳定性；文本 patch 通过 `git apply --check` 验证。SDK 集成测试通过真实 AI SDK、OpenAI Provider 与 Bridge runtime 执行全部六个工具，并检查工具结果历史、跨轮复用和会话删除清理。VS Code 适配测试检查原生 API 参数、未保存文档过滤、坐标转换及诊断等级映射。
