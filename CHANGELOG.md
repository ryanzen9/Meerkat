# Changelog

## 0.1.0

- Split Webview into an independent Bun workspace with its own dependencies, Vite build, and tests.
- Add a dedicated Meerkat Activity Bar entry and sidebar.
- Migrate Webview styles to Tailwind CSS with native VS Code theme tokens.
- Add Oxlint, Oxfmt, Tailwind class sorting, and editor/CLI quality checks.
- Add a collapsible React Webview View to the native Source Control container.
- Add workspace information, validated message passing, optional Git API access, and persisted state.
- Remove the manual interaction-mode selector: the Host now lets the selected model and reasoning effort decide per turn whether to run a code review or ordinary chat.
- Add Bun and Vite builds, development watchers, F5 debugging, and VSIX packaging.
