# Agent Bridge 架构要求

后端使用 Vercel AI SDK 7 统一定义、配置和执行 Agent。`ToolLoopAgent` 负责模型与工具循环，`tool()` 定义本地工具，`toUIMessageStream` 和 `createUIMessageStreamResponse` 生成官方 UI Message Stream。前端通过 `useChat` 和 assistant-ui 的 `useAISDKRuntime` 管理消息、发送、运行与取消状态。

厂商实现仅通过官方 AI SDK Providers 适配。`ModelProvider.resolveModel` 提供 `LanguageModel`、厂商 `providerOptions` 和工具选项；共享 runtime 管理 Agent instructions、步数限制、运行互斥、AbortSignal、超时、历史提交与 UI 流。新增厂商不得再引入独立 Agent 编排 SDK 或重写工具循环。

当前 OpenAI 适配使用 `@ai-sdk/openai`，保留 Sign in with ChatGPT OAuth、动态注册、PKCE、ID Token 验证、SecretStorage、刷新轮换、互斥和失效清理。推理访问公共 Responses API；`store:false`、`stream:true`，发送完整历史，使用 developer instructions 和 namespaced function tools。兼容层校验实际序列化请求、校验流完成、处理额度错误及结束输出缺失，避免向 SDK 默认参数妥协。

完整 `ModelMessage[]` 历史由 Host 保存，包含工具调用、结果和厂商 metadata；只有完整成功后原子提交，失败或取消不污染会话。凭据始终留在 Host。受保护 loopback HTTP 与 webview IPC 共用 API；保留 Host/Origin/大小校验、ACK 背压、日志脱敏、视图销毁取消及扩展退出清理。

实现和运行步骤见 [Agent Bridge](agent-bridge.md)。要求 `bun run check`、`bun run build` 与 VSIX 打包通过，使用真实 SDK 和显式远端 fixtures 验证多轮、工具循环、失败、截断、取消和前端状态。真实账户验收通过 `bun run bridge:smoke` 完成。

参考：[AI SDK Agent](https://ai-sdk.dev/docs/agents/building-agents)、[OpenAI Provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)、[assistant-ui AI SDK v7](https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7)、[ChatGPT 推理限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
