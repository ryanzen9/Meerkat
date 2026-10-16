# Layout Guide

## Structure

┌────────────────────────────┐
│ Header（固定） │
├────────────────────────────┤
│ Account / Status（固定） │
├────────────────────────────┤
│ Tabs（固定） │
├────────────────────────────┤
│ │
│ Main Content（可滚动） │
│ - Chat / Files / History │
│ │
├────────────────────────────┤
│ Input + Actions（固定） │
│ Git 摘要单行 │
└────────────────────────────┘

1. Header（高度约 44px，固定）

左侧：小图标（Agent 头像或代码审查图标）+ 短标题 「Review」
右侧：两个小图标按钮
刷新 / 重新分析
更多菜单（设置、历史、导出）

2. Account / Status（固定）
   ChatGPT 账户、登出、添加账户与账户切换。工作区级上下文不再占用这里。

3. Tabs

Tab 1：Agent Chat Windows（默认）

标准聊天消息流（Agent 与用户）
Agent 消息用浅色气泡，用户消息用深色
支持代码块（可横向滚动）。 代码块可包含语法高亮。右上角通常有「复制」，「打开」按钮。
消息中可能包含文件引用，使用蓝色下划线进行标记。

输入框下方只保留一行 Git 摘要：分支（等宽字体，过长时截断）+ Git 状态 + 新增 / 修改 / 删除数量。
单行 `whitespace-nowrap`，不换行、不撑高输入区；拖窄侧栏时先截断分支名。

Tab 2：File Change Status

顶部为工作区上下文面板（从原固定 Context / Status 区移入）：

- 摘要行：折叠按钮 + 仓库名（多仓库时为下拉）+ 状态徽章（Idle / Analyzing… / 3 Issues / Ready）
- 详情行：分支 + Git 状态 + 新增 / 修改 / 删除数量，可整体收起

下方为变更文件列表，分为 Changes 和 Staged Changes 两组：

- 每组标题行可点击收起 / 展开（`aria-expanded`），折叠只隐藏本组文件
- 每个文件一行：图标 + 文件名 + 目录（灰色缩小显示）+ A / M / R / D / U 标记；文件名颜色提供标识：(绿色)新增文件 (黄色)修改文件 (红色)删除文件
- 点击行打开文件；完整路径在 title 与 aria-label 中保留

Tab 3：History（可选）

会话历史列表
点击后跳转至 Tab 1（Agent Chat Windows） 展示历史会话记录

4. Input + Actions（底部固定）

输入框（单行或多行自适应，高度约 36–48px）
Placeholder：「Ask the agent…」或「询问这个 diff…」
右侧发送按钮（小图标）
输入框下方的 Git 摘要行与「Enter 发送 · Shift+Enter 换行」提示、新建会话按钮同属固定底部区域，滚动内容不会推动它们。
