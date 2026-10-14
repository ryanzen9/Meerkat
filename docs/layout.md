# Layout Guide

## Structure

┌────────────────────────────┐
│ Header（固定） │
├────────────────────────────┤
│ Context / Status（固定） │
├────────────────────────────┤
│ │
│ Main Content（可滚动） │
│ - Findings / Chat / Diff │
│ │
├────────────────────────────┤
│ Input + Actions（固定） │
└────────────────────────────┘

1. Header（高度约 40–48px，固定）

左侧：小图标（Agent 头像或代码审查图标）+ 短标题 「Review」
右侧：两个小图标按钮
刷新 / 重新分析
更多菜单（设置、历史、导出）

2. Context / Status 区（高度约 56–72px，固定）
   用卡片或浅色背景区分，信息优先级从高到低：

PR #123 · feat/login

状态徽章（彩色小标签）：
Idle / Analyzing… / 3 Issues / Ready

Git 分支状态：
branch + git status + file change count (绿色)新增文件 (黄色)修改文件 (红色)删除文件
Optional: git config username(git config email) + git remote name

3. Main Content（中间可滚动区域，占满剩余高度）
   标签切换（Tab）

Tab 1：Agent Chat Windows（默认）

标准聊天消息流（Agent 与用户）
Agent 消息用浅色气泡，用户消息用深色
支持代码块（可横向滚动）。 代码块可包含语法高亮。右上角通常有「复制」，「打开」按钮。
消息中可能包含文件引用，使用蓝色下划线进行标记。

Tab 2：File Change Status

显示变更文件列表，包括新增、修改、删除的文件列表。
分为 Changes and Staged Changes, 分别显示未暂存和已暂存的文件变更。与 Git 状态保持一致。
文件名颜色提供标识：(绿色)新增文件 (黄色)修改文件 (红色)删除文件

Tab 3：History（可选）

会话历史列表
点击后跳转至 Tab 1（Agent Chat Windows） 展示历史会话记录

4. Input + Actions（底部固定，高度约 80–100px）

输入框（单行或多行自适应，高度约 36–48px）
Placeholder：「Ask the agent…」或「询问这个 diff…」
右侧发送按钮（小图标）
