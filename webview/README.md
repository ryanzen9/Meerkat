# Meerkat Webview

独立的 React / assistant-ui 前端工程，由根目录的 Bun workspace 和 `bun.lock` 管理。

先在仓库根目录执行 `bun install --frozen-lockfile`，再在本目录运行：

```sh
bun run build
bun run typecheck
bun run test
```

`build` 检查前端源码、构建配置及测试类型，再生成 `../dist/webview/`，无需构建 Extension Host。`bun run dev` 使用 Vite 监听并生成带 source map 的开发产物；挂载盘和完整 F5 开发请使用根目录 `bun run dev`，它轮询两端源码与配置并协调构建。

源码位于 `src/`，`@/*` 指向该目录，`@shared/*` 指向 `../src/shared/`。共享层仅提供数据类型和纯校验函数，前端运行代码不得导入 Extension Host、Node、Bun 或 VS Code 模块。HTML、CSP、nonce 和资源 URI 由 Extension Host 提供，因此这里不需要 `index.html` 或开发 HTTP 服务。

前端依赖通过本目录的 `bun add` / `bun add --dev` 维护；shadcn / assistant-ui CLI 也在本目录执行，使用本地 `components.json`。Lint、格式化、TypeScript 严格选项和编辑器规则统一保留在仓库根目录；根目录 `bun run check` 检查两个工程。

`tests/` 包含状态回归测试和 UI / Bridge 集成测试；后者直接使用 `../src/extension/` 的真实 Bridge 实现，替换远端 Provider、浏览器和 VS Code 外壳。详细的 F5、Bridge 和 VSIX 工作流参见[开发文档](../README.md)。
