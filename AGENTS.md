# Agents Guide

这是一个基于 **Bun + Vite + React + TypeScript** 的可运行 VS Code 扩展。主要功能是提供智能代码审查和交互式聊天，文件编辑界面。

What must you do： 开始工作前，必须完整查阅项目下的所有 `AGENTS.md` 文件，确认改动范围内的规范。查询当前所有可用 skills，优先使用匹配的 skills 进行实现。

## File References

- `webview/AGENTS.md`：Webview 界面部分相关规范

## Skills

请你查阅 skills-lock.json 文件，核对 `.agents/skills` 目录下的 skills 是否一致，如不一致，请执行 `npx skills experimental_install` 更新。
skill 核对通过后将可用 skills 加载入上下文。
