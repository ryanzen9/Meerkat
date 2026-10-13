# Review Bot · VS Code SCM Webview

基于 **Bun + Vite + React + TypeScript** 的可运行 VS Code 扩展。通过官方 `contributes.views.scm` 与 `registerWebviewViewProvider`，在原生 Source Control 中添加 **Review Bot** 可折叠视图，与 Changes、Graph 同属于 SCM 容器。原生 Git 提交、暂存、分支与 Graph 功能继续由 VS Code 提供。

## 快速开始

开发工具：**Bun ≥ 1.3.13、Node.js ≥ 22.12、VS Code ≥ 1.96**。VSIX 安装后使用 VS Code 内置的 Node.js Extension Host，无需终端安装 Bun 或 Node。

```sh
bun install
bun run build
code .
```

在 VS Code 中按 **F5**，选择 `Run Review Bot Extension`。调试窗口打开后进入 **Source Control**，展开 **Review Bot**。也可以从命令面板执行 **Review Bot: Open Panel**。启动前的 `dev` 任务会等待 Extension 与 Webview 首轮构建完成。

调试窗口可通过 **File → Open Folder** 打开目标工作区。未打开文件夹时也能使用通信示例，面板会显示空工作区状态。

面板默认折叠，由 VS Code 提供标题栏和折叠行为。名称及是否有 Graph 取决于 VS Code 版本和语言；视图的确切排序、高度和位置由 VS Code 与用户保存的布局决定。如果隐藏或移动过视图，可以通过 Source Control 的视图菜单启用，或执行 `View: Reset View Locations`。

## 脚本

| 命令                                      | 用途                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `bun run build`                           | 运行 Oxlint、检查 Host / Webview / 工具类型，生成两个生产构建入口 |
| `bun run dev` / `bun run watch`           | 监听源码改动，分别调用 Bun 与 Vite 构建对应入口                   |
| `bun run typecheck`                       | 检查各环境的独立 TypeScript 配置                                  |
| `bun run typecheck:watch`                 | 全项目监听类型检查                                                |
| `bun run test`                            | 消息边界、CSP、Provider 生命周期、持久化并发与重复构建回归测试    |
| `bun run lint` / `bun run lint:fix`       | Oxlint 静态检查 / 修复，警告也使检查失败                          |
| `bun run format` / `bun run format:check` | Oxfmt 格式化 / 格式检查，包括 Tailwind 类名排序                   |
| `bun run check`                           | 依次运行 lint、格式检查、类型检查与测试                           |
| `bun run package`                         | 通过 `vsce` 自动运行完整生产构建，输出 VSIX                       |
| `bun run clean`                           | 删除 `dist` 与 `artifacts`                                        |

开发监听以 500ms 间隔轮询源码树，支持挂载盘、增删文件和编辑器原子保存；使用磁盘资源，不启动 Vite HTTP 服务。修改 React、CSS、Shared 后，构建自动更新，点击视图标题栏 **Reload Webview**（重启图标）加载新 UI；修改 Extension 后重启 F5 调试会话加载新 Host 代码。这里采用监听构建与手动重载，没有 HMR。需要实时类型诊断时另外运行 `bun run typecheck:watch`。

F5 结束后，开发任务可能继续监听；可通过 `Tasks: Terminate Task` 结束 `dev`。若 VS Code 找不到 Bun，请确保其终端 PATH 包含 Bun 的安装目录，然后重新启动 VS Code。

## 目录与运行边界

```text
.
├── .vscode/                 # F5、构建任务
├── scripts/                 # Bun Host 构建、双入口监听、VSIX 打包
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
│   └── webview/            # main.js、style.css、第三方许可证
├── artifacts/              # vscode-review-bot-0.1.0.vsix
├── bun.lock
├── package.json
├── tsconfig*.json
└── vite.config.ts
```

单仓库单份依赖，不需要 monorepo 工具。Host 由 `Bun.build({ target: 'node', format: 'cjs', external: ['vscode'] })` 打包；Host 源码没有 Bun API。Webview 由 Vite 8 与 React 插件构建，React 完全打包进浏览器产物。`package.json` 的 `type: module` 用于工程配置和脚本，Host 入口明确使用 `.cjs`。

三个独立 tsconfig 限制环境：Host 只有 Node / VS Code 类型，Webview 只有 DOM / Vite 类型，工具脚本可以使用 Bun。根 tsconfig 用于编辑器和全项目监听。Shared 只包含 JSON 数据与纯校验函数，禁止引入任何运行平台 API。

## 最小示例与消息协议

- 打开视图后，Webview 注册监听，再发送 `webview/ready`；Host 返回 `host/snapshot`。
- **刷新工作区**发送 `workspace/refresh`，返回工作区名称、多根目录、信任状态、配置、持久化状态以及可用的 Git 仓库分支。
- 输入称呼并点击 **发送问候**，发送 `demo/hello`；Host 返回 `host/hello`，通信次数写入当前工作区的 `workspaceState`。
- 工作区目录、信任和扩展配置变化会主动推送新快照；Git 仓库变化目前通过刷新获取。

请求和回复通过 `requestId` 对应。请求超时显示可重试错误；过期回复会被忽略。两端都以 `unknown` 接收数据，并通过共享协议校验，Host 只执行白名单中的消息类型，不提供任意命令执行接口。称呼上限 80 字符。新增功能时先扩展 `shared/models.ts` 与 `shared/protocol.ts`（联合类型和校验），然后添加 Service、Provider 分支及 UI。

## 扩展接口

**Git**：`GitService.getApi()` 惰性激活内置 `vscode.git` 并请求公开 `getAPI(1)`，当前只读取仓库与分支。Git 未启用、无仓库或受限模式均有空状态。使用的是公开接口的最小结构类型；新增仓库事件、diff 或 review 功能时，根据官方 `git.d.ts` 补充类型和 Service。无需强制 `extensionDependencies`，也不创建替代内置 Git 的 SourceControl Provider。

**状态管理**：Webview 使用 `useReducer` 管理业务状态，`usePanel` 管理通信；需求增长后可在 `state/` 替换为独立 store。Host 的 `StateService` 串行写入 `workspaceState`，避免并发丢失；跨工作区数据可以另加 `globalState`。Webview 的输入草稿通过 `getState` / `setState` 保存，不依赖 `retainContextWhenHidden`。

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

也可执行 VS Code 命令 **Extensions: Install from VSIX...**。打包仅包含 manifest、文档、许可证和运行产物，排除源码、开发配置、source maps 和 `node_modules`；React 已打包，`--no-dependencies` 是有意配置。源码调试构建保留 Host source map。

`publisher: local-dev` 可用于本地 VSIX；发布 Marketplace 前替换为自己的 publisher，添加真实 repository 信息。当前打包允许缺少 repository，不执行发布。Bun 可能提示 `@vscode/vsce-sign` 的 postinstall 被阻止；本项目生成未签名 VSIX，不需要运行其签名下载脚本。

## 官方资料

- [View contribution points](https://code.visualstudio.com/api/references/contribution-points#contributes.views)
- [Webview API、消息、资源、CSP 与持久化](https://code.visualstudio.com/api/extension-guides/webview)
- [内置 Git 扩展公开 API 类型](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts)
- [Bun Node 目标构建](https://bun.com/docs/bundler)
- [Vite 构建配置](https://vite.dev/config/build-options)
- [VSIX 打包](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Tailwind CSS Vite 插件](https://tailwindcss.com/docs/installation/using-vite)
- [Tailwind CSS 主题变量](https://tailwindcss.com/docs/theme)
- [Oxlint 配置](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Oxfmt 配置与类名排序](https://oxc.rs/docs/guide/usage/formatter/sorting.html)
