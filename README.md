# Review Bot · VS Code Sidebar

基于 **Bun + Vite + React + TypeScript** 的可运行 VS Code 扩展。通过官方 `contributes.viewsContainers.activitybar`、`contributes.views` 与 `registerWebviewViewProvider`，在活动栏添加 **Review Bot** 图标，点击后打开独立侧栏，提供代码审查、聊天和历史记录。原生 Git 提交、暂存、分支与 Graph 功能继续由 VS Code 提供。

## 快速开始

开发工具：**Bun ≥ 1.3.13、Node.js ≥ 22.12、VS Code ≥ 1.96**。VSIX 安装后使用 VS Code 内置的 Node.js Extension Host，无需终端安装 Bun 或 Node。

```sh
bun install
bun run build
code .
```

在 VS Code 中按 **F5**，选择 `Run Review Bot Extension`。调试窗口打开后点击活动栏的 **Review Bot** 图标，打开插件侧栏。也可以从命令面板执行 **Review Bot: Open Panel**。启动前的 `dev` 任务会等待 Extension 与 Webview 首轮构建完成。

调试窗口可通过 **File → Open Folder** 打开目标工作区。未打开文件夹时，面板会显示空工作区和 Git 状态。

面板在独立侧栏中默认展开，由 VS Code 提供标题栏和视图布局。活动栏图标、视图位置和大小可以由用户调整。如果升级前曾移动过 Review Bot，VS Code 可能保留旧布局；可执行 `View: Reset View Locations` 恢复默认位置。隐藏入口后也可通过命令面板执行 **Review Bot: Open Panel** 重新打开。

## 脚本

| 命令                                      | 用途                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `bun run build`                           | 运行 Oxlint、检查 Host / Webview / 工具类型，生成两个生产构建入口 |
| `bun run build:extension`                 | 使用独立 Vite 配置生成 CommonJS Extension Host 入口               |
| `bun run build:webview`                   | 使用独立 Vite 配置生成浏览器脚本、CSS 和静态资源                  |
| `bun run dev` / `bun run watch`           | 轮询源码和构建配置，串行调用两个 Vite 开发构建                    |
| `bun run typecheck`                       | 检查各环境的独立 TypeScript 配置                                  |
| `bun run typecheck:watch`                 | 全项目监听类型检查                                                |
| `bun run test`                            | 通信、安全、持久化、输出隔离、静态资源及监听恢复回归测试          |
| `bun run lint` / `bun run lint:fix`       | Oxlint 静态检查 / 修复，警告也使检查失败                          |
| `bun run format` / `bun run format:check` | Oxfmt 格式化 / 格式检查，包括 Tailwind 类名排序                   |
| `bun run check`                           | 依次运行 lint、格式检查、类型检查与测试                           |
| `bun run package`                         | 通过 `vsce` 自动运行完整生产构建，输出 VSIX                       |
| `bun run clean`                           | 删除 `dist` 与 `artifacts`                                        |

开发监听以 500ms 间隔轮询源码、Shared、对应 Vite / TypeScript 配置和 manifest，支持挂载盘、增删文件和编辑器原子保存；使用磁盘资源，不启动 Vite HTTP 服务。两个构建串行执行，只清理各自输出目录。首轮失败时继续监听修复，两个目标都成功且没有待构建改动后才输出 `[watch] ready`，让 F5 加载最新产物。失败版本不会反复重试刷屏，下一次相关文件改动会重新构建。

修改 React、CSS、Shared 后，构建自动更新，点击视图标题栏 **Reload Webview**（重启图标）加载新 UI；修改 Extension 后重启 F5 调试会话加载新 Host 代码。这里采用监听构建与手动重载，没有 HMR。需要实时类型诊断时另外运行 `bun run typecheck:watch`。

F5 结束后，开发任务可能继续监听；可通过 `Tasks: Terminate Task` 结束 `dev`，终止构建子进程并释放监听锁。生产构建、测试、清理或打包前先结束 `dev`，避免其他命令同时写入产物。重复启动 `dev` 会被拒绝；若进程被强制杀死，确认旧进程已退出后删除 `dist/.watch.lock` 再启动。若 VS Code 找不到 Bun，请确保其终端 PATH 包含 Bun 的安装目录，然后重新启动 VS Code。

## 目录与运行边界

```text
.
├── .vscode/                 # F5、构建任务
├── scripts/                 # Bun 开发监听编排、VSIX 打包、清理
├── resources/               # 活动栏 SVG 图标
├── src/
│   ├── extension/           # VS Code Node.js Extension Host
│   │   ├── index.ts         # 激活与资源生命周期
│   │   ├── providers/       # WebviewViewProvider 与消息路由
│   │   ├── services/        # Workspace、Settings、State、Git
│   │   └── webview/         # HTML、CSP、nonce
│   ├── shared/              # JSON 数据类型、消息联合类型与运行时校验
│   └── webview/             # 浏览器 / Webview 环境
│       ├── App.tsx
│       ├── main.tsx
│       ├── components/     # 工作区信息、按钮与输入框
│       ├── hooks/          # 握手、请求关联、超时处理
│       ├── services/       # 私有 acquireVsCodeApi 封装
│       └── state/          # React reducer
├── tests/                  # Bun 测试
├── dist/
│   ├── extension/extension.cjs
│   └── webview/            # main.js、style.css、assets/、chunks/、第三方许可证
├── artifacts/              # vscode-review-bot-0.1.0.vsix
├── bun.lock
├── package.json
├── tsconfig*.json
├── vite.config.extension.ts # Vite Library Mode，Node / CommonJS
└── vite.config.webview.ts   # Vite 浏览器构建，React / Tailwind
```

单仓库单份依赖。Bun 负责依赖管理、脚本执行和开发构建编排，Host 与 Webview 都由 Vite 8 打包。Host 使用 Library Mode，目标为 Node 20 语法，`vscode` 与所有 Node 内置模块设为 external；Host 的官方 Agents SDK、OpenAI Client 与 OAuth 依赖全部打包为本地 CommonJS chunks。Webview 使用普通浏览器构建，React 完全打包，构建时禁止导入 Node、Bun 或 VS Code API。`package.json` 的 `type: module` 用于工程配置和脚本，Host 入口明确使用 `.cjs`。

HTML 继续由现有 Provider 生成；浏览器入口固定输出 `dist/webview/main.js` 和 `style.css`，无需第二套 HTML 模板。图片、字体等静态资源使用源码中的 `import`、`new URL(..., import.meta.url)` 或 CSS `url()` 引用，Vite 输出到 `assets/` 并生成相对资源路径；不要使用网站根路径 `/image.png`。资源不内联为 data URL，保持现有 CSP。动态 JS chunk 输出到 `chunks/`；VSIX 包含这些目录中的实际文件。两个构建都禁用默认 public 目录复制，避免混入无关资源。

三个独立 tsconfig 限制环境：Host 只有 Node / VS Code 类型，Webview 只有 DOM / Vite 类型，工具脚本可以使用 Bun。根 tsconfig 用于编辑器和全项目监听。Shared 只包含 JSON 数据与纯校验函数，禁止引入任何运行平台 API。

## WebView 布局与交互

面板采用全高布局：44px Header、72px Context / Status、40px 标签栏、可滚动内容和约 87–99px 的底部输入区。输入支持 Enter 发送、Shift+Enter 换行，以及中文输入法；多行内容在 36–48px 内自适应增长，超出后在输入框内滚动。滚动内容和长代码块不会移动 Header 或输入区，也不会撑宽侧栏。

- **Chat**（默认）：基于 `assistant-ui` 的 `AssistantRuntimeProvider`、AI SDK Runtime、Host Stream 代理和 Thread primitives；消息布局采用官方 `elements-message-pair` 的 Runtime 方案：用户消息为右侧圆角气泡，助手回复为无气泡正文，悬停或键盘聚焦显示回复复制按钮。通过 Extension Host 复制完整回复；支持真实流式文本及工具调用显示，当前不提供重生成。消息支持安全 Markdown、可横向滚动的代码块、复制和在编辑器打开代码。文件引用采用 `[文件名](review-file:编码后的文件URI)`，点击后由 Host 检查工作区范围再打开。
- **Files**：按 Changes / Staged Changes 显示当前仓库未暂存、已暂存的真实 Git 变更，包含未跟踪文件和冲突。新增 / 修改（含重命名）/ 删除使用 Git 主题颜色及 A / M / R / D / U 字符区分。仓库、分支、暂存或工作树变化会自动同步；多仓库可在上下文区切换。顶部数量按文件 URI 去重，避免重复计算部分暂存的文件。
- **History**：恢复已有会话并回到 Chat；输入区的加号新建会话。草稿、选中标签、仓库和最近 20 个会话（每个最多 100 条消息）通过 VS Code Webview state 保存，输入上限 4000 字符。
- **更多操作**：打开扩展设置、会话历史或将当前会话作为未保存的 Markdown 文档打开，可自行保存导出。

**已接入 ChatGPT OAuth 与 OpenAI Agents SDK。** 点击 Continue with ChatGPT 完成动态注册，选择账户可用模型后发送消息，支持真实流式文本、本地 Function Tool、多轮会话和停止运行。webview 通过 Host 代理消费官方 AI SDK UI Message Stream，不持有 Provider 或本地 HTTP 凭据。PR 服务仍未接入。完整架构、HTTP API、首次授权与真实账户验收见 [Agent Bridge 文档](docs/agent-bridge.md)。Host 重启后须新建 Agent 会话；现有 webview 历史保留文字摘要。可选 `PanelSnapshot.review` 元数据支持 PR 编号和 Idle / Analyzing… / Issues / Ready 徽章，仅对匹配的仓库显示；没有该元数据时使用真实工作区名和 Idle 状态。

## 消息协议

- 打开视图后，Webview 注册监听，再发送 `webview/ready`；Host 返回 `host/snapshot`。
- **刷新工作区**发送 `workspace/refresh`，返回工作区、配置及仓库分支、remote 名称、Changes 和 Staged Changes。
- `file/open`、`code/open`、`clipboard/write` 和 `settings/open` 只执行相应的固定编辑器操作，以 `host/action` 确认成功；代码以未保存的文档打开，不直接修改工作区文件。原有 `demo/hello` 协议保留兼容。
- 工作区目录、信任、扩展配置和 Git 状态变化会主动推送新快照。

并行请求和回复通过独立 `requestId` 对应。请求超时显示可重试错误；过期回复会被忽略。两端都以 `unknown` 接收数据，并通过共享协议校验，Host 只执行白名单中的消息类型。文件打开限制为当前工作区内的 `file` / `vscode-remote` URI；代码、剪贴板与语言标记有长度限制。新增功能时先扩展 `shared/models.ts` 与 `shared/protocol.ts`（联合类型和校验），然后添加 Service、Provider 分支及 UI。

## 扩展接口

**Git**：`GitService.getApi()` 惰性激活内置 `vscode.git` 并请求公开 `getAPI(1)`，读取仓库、分支、remote 名称及工作树 / index / untracked / merge 变更，并订阅仓库打开、关闭和状态变化事件。监听器由扩展生命周期统一释放。Git 未启用、无仓库或受限模式均有空状态。使用的是公开接口的最小结构类型；新增 diff 或 review 功能时，根据官方 `git.d.ts` 补充类型和 Service。无需强制 `extensionDependencies`，也不创建替代内置 Git 的 SourceControl Provider。

**状态管理**：Webview 使用 `useReducer` 管理业务状态，`usePanel` 管理通信；需求增长后可在 `state/` 替换为独立 store。Host 的 `StateService` 串行写入 `workspaceState`，避免并发丢失；跨工作区数据可以另加 `globalState`。Webview 的会话、输入草稿与布局选择通过 `getState` / `setState` 保存，不依赖 `retainContextWhenHidden`。

**配置持久化**：`SettingsService` 读取 VS Code Configuration API，配置由 VS Code 持久化。在 Settings 中搜索 `Review Bot`，或设置：

```json
{
  "reviewBot.greeting": "你好，来自 Extension Host！",
  "reviewBot.showWorkspacePaths": true
}
```

后续若增加面板内设置编辑，给 Service 添加明确的 `configuration.update` 与目标作用域。凭据应使用 `context.secrets`。

## Webview 安全与主题

HTML 由 Provider 生成，资源 URI 使用 `webview.asWebviewUri`，`localResourceRoots` 只允许 `dist/webview`。每次加载生成随机 nonce；CSP 默认 `default-src 'none'`，只允许本地脚本、样式、图像、字体，禁止网络连接、表单提交和内联执行，不使用 `unsafe-inline` 或 `unsafe-eval`。React 以文本渲染消息及工作区内容。

UI 的颜色、字体、边框、输入框、按钮和焦点环使用 `--vscode-*` 主题变量，自动跟随深色、浅色和高对比主题。原生按钮、表单标签、键盘焦点与状态播报支持可访问性。布局允许窄侧栏换行。

### Tailwind CSS

使用 **Tailwind CSS 4** 的 CSS 配置方式，由 `@tailwindcss/vite` 编译；不需要额外的 `tailwind.config.js` 或 PostCSS 配置。`src/webview/styles.css` 只负责 Tailwind 导入、`@theme inline` 主题 token、`@source` 扫描范围与少量 Webview 基础样式。组件的布局、间距、字体、按钮、输入框、焦点和状态样式使用 Tailwind 工具类。

例如 `bg-sidebar`、`text-muted`、`bg-button`、`focus-visible:outline-focus` 映射到对应的 VS Code 变量；`high-contrast:border-contrast` 使用 VS Code 注入的高对比主题类。间距基准为 `4px`，根字号仍由 `--vscode-font-size` 决定，以保持原有侧栏密度。所有样式编译到本地 `dist/webview/style.css`，继续遵循原有 CSP，不使用 CDN 或运行时样式注入。

`@source './'` 只扫描 Webview 目录。新增样式时使用完整静态类名，避免动态拼接如 `bg-${color}`；复用主题 token 时在 `@theme inline` 中添加映射。

### Oxlint 与 Oxfmt

`.oxlintrc.json` 启用 correctness / suspicious 检查及 TypeScript 规则；Webview 额外启用 React（含 Hooks）和 JSX 可访问性规则。环境按目录区分：Extension 使用 Node，Webview 使用浏览器，工具和测试使用 Node / Bun。VS Code 的 `webview.postMessage` 与封装桥接 API 不接受浏览器 `targetOrigin` 参数，因此仅在对应通信文件关闭 `unicorn/require-post-message-target-origin` 的误报；消息协议校验与 CSP 继续生效。

`.oxfmtrc.json` 统一 2 空格缩进、单引号、分号和 LF，并以 Webview 的 Tailwind CSS 入口排序 JSX 类名。源码、配置和文档已按该规则格式化；构建产物、依赖和锁文件排除在检查之外。

已添加 **Oxc** 与 **Tailwind CSS IntelliSense** 的 VS Code 扩展推荐和工作区保存格式化设置。保留原生 CSS 语言模式以支持 Oxfmt 保存格式化，并忽略 Tailwind 指令引起的原生 CSS `unknownAtRules` 诊断。按推荐安装后，可使用自动格式化、主题 token 补全和保存时 lint；CLI 命令不依赖这些编辑器扩展。CI 可执行：

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

## VSIX

```sh
bun run package
code --install-extension artifacts/vscode-review-bot-0.1.0.vsix
```

也可执行 VS Code 命令 **Extensions: Install from VSIX...**。打包会通过 `vscode:prepublish` 重新生成两个生产构建，仅包含 manifest、活动栏图标、文档、许可证、Host 的 `.cjs` 文件和 Webview 的全部静态产物；排除源码、开发配置、source maps、监听锁和 `node_modules`。React 已打包，当前 Host 的 external 仅由 VS Code / Node 提供，因此保留 `--no-dependencies`。以后若增加需 external 的 npm 运行时依赖，必须同步调整依赖打包规则。开发构建生成两端 source maps，生产构建不生成。

### 人工调试与安装验证

1. 按 F5，确认 `dev` 任务完成两个首次构建后才启动 Extension Development Host；在源码入口设置断点，检查 Host source map。
2. 点击活动栏的 Review Bot，确认打开独立侧栏，检查固定布局、Git 变更、刷新、聊天与历史；切换到其他活动栏入口后再返回，确认草稿与会话保持。执行 **Review Bot: Open Panel**，确认能重新打开并聚焦侧栏。
3. 修改 React / CSS，等待 `[watch] ready` 后点击 **Reload Webview**；修改 Host 后重启调试会话。检查控制台没有资源 404、CSP 或模块加载错误。
4. 切换深色、浅色及高对比主题，检查窄侧栏布局、输入框、按钮和焦点样式。
5. 结束 `dev`，运行 `bun run package` 并安装 VSIX；关闭构建终端，在普通 VS Code 窗口重复上述功能检查。安装后无需 Bun 或 Vite；Agent Bridge 的 loopback HTTP 服务由扩展自身管理。

自动测试在临时项目副本中检查构建与监听，不代替实际 VS Code UI、Remote 场景和最低支持版本验证。

`publisher: local-dev` 可用于本地 VSIX；发布 Marketplace 前替换为自己的 publisher，添加真实 repository 信息。当前打包允许缺少 repository，不执行发布。Bun 可能提示 `@vscode/vsce-sign` 的 postinstall 被阻止；本项目生成未签名 VSIX，不需要运行其签名下载脚本。

## 官方资料

- [View contribution points](https://code.visualstudio.com/api/references/contribution-points#contributes.views)
- [Activity Bar view containers](https://code.visualstudio.com/api/references/contribution-points#contributes.viewsContainers)
- [Webview API、消息、资源、CSP 与持久化](https://code.visualstudio.com/api/extension-guides/webview)
- [内置 Git 扩展公开 API 类型](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts)
- [Vite Library Mode](https://vite.dev/guide/build#library-mode)
- [Vite 构建配置](https://vite.dev/config/build-options)
- [VSIX 打包](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Tailwind CSS Vite 插件](https://tailwindcss.com/docs/installation/using-vite)
- [Tailwind CSS 主题变量](https://tailwindcss.com/docs/theme)
- [Oxlint 配置](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Oxfmt 配置与类名排序](https://oxc.rs/docs/guide/usage/formatter/sorting.html)
