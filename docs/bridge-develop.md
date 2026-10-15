# Agent Bridge Development

你是一名资深 TypeScript / Node.js 架构师，请完整查看该项目。你将帮我完成 `src/extension` Bridge 部分的开发。该模块运行在 `VS Code Node.js Extension Host`。 该模块的核心目标是在 **assistant-ui Runtime** 与不同 AI Provider 之间建立统一、可扩展的通信层，由 Bridge 负责接收前端请求、管理会话、调度 Agent、转发流式事件，并将不同 Provider 的输出转换为 assistant-ui 可直接消费的标准协议。

**架构要求：** 采用模块化、接口驱动的架构。参考官方 [OpenAI Agents SDK 集成文档](https://www.assistant-ui.com/docs/integrations/frameworks/openai-agents)，采用 `@assistant-ui/ai-sdk` 对接方式，并优先使用官方 `@openai/agents-extensions/ai-sdk-ui` 将 Agent 运行结果转换为 AI SDK UI Message Stream，避免自行重复实现已有的流式通信协议。Bridge 应提供清晰的 HTTP API，支持流式文本输出、工具调用事件、Agent 运行状态、错误处理、取消运行、多轮会话及后续扩展能力。前端不得直接访问 AI Provider 或持有任何敏感令牌。

**多 Provider 扩展要求：** Bridge 必须设计统一的 `AgentProvider` 抽象接口，将 Provider 的初始化、认证、模型列表、Agent 执行、流式事件、工具调用、会话管理和取消操作封装起来。实现 Provider Registry / Factory，根据请求中的 Provider ID 和模型配置动态选择 Provider。不同 Provider 可以拥有不同的认证机制和内部 SDK，但应向 Bridge 暴露统一能力，并允许扩展 Provider 专有功能。首版仅实现 `OpenAIAgentsProvider`，后续应能低成本接入 Anthropic、Google Gemini、Codex SDK、本地模型及其他自定义 Agent Provider。避免在核心业务代码中硬编码 OpenAI 专属逻辑。

**首版 OpenAI Provider 要求：** 使用官方 `@openai/agents` SDK 实现 Agent 执行、模型调用、Streaming、Function Tools 和 Agent 会话管理。认证必须使用 **OpenAI 官方 Sign in with ChatGPT OAuth + Dynamic Client Registration**，让用户使用自己的 ChatGPT 订阅额度，而不是传统 OpenAI Platform API Key。项目面向符合官方接入条件的本地开源应用，不要求开发者预先在 OpenAI 后台申请固定 Client ID。首次授权使用 `dynamic_agent_client`，通过 OAuth 2.0 Authorization Code + PKCE（S256）完成动态客户端注册，申请 `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` 等必要权限，并保存官方返回的应用 Client ID。必须验证 OAuth `state`、`nonce`、ID Token 签名、Issuer、Audience 和过期时间。用户首次授权后，Bridge 应通过安全的本地持久化存储保存 Client ID、Host ID、账户身份、Access Token、Refresh Token、Scopes 和过期时间，支持应用重启后自动恢复登录、提前刷新 Access Token、处理 Refresh Token 轮换、并发刷新互斥、失效令牌清理及主动登出。优先使用系统安全凭证存储，禁止将敏感令牌返回前端或写入普通日志。该 Provider 不应依赖本机 Codex CLI 或 Codex App Server 进程。

**Agents SDK 兼容性要求：** 使用 OAuth Access Token 创建账户隔离的 OpenAI Client，并注入 Agents SDK 的 Model Provider / Runner，而不是通过进程全局状态混用不同账户。所有推理请求必须符合官方 ChatGPT Plan Usage 的接口约束，例如使用公共 Responses API、`store: false`、`stream: true`，以及当前 OAuth 模式支持的参数、模型和工具类型。必须核对官方最新文档，不能假设 Agents SDK 的默认请求行为与 ChatGPT OAuth 完全兼容。如果存在不兼容参数、工具或会话续接机制，应设计专门的兼容适配层，明确限制并提供验证测试。

**服务接口与工程要求：** 提供 OAuth 登录、回调、登录状态、登出、模型列表、Provider 列表、创建及管理会话、发送消息、流式响应和取消任务等 API。支持 CORS 白名单、请求校验、统一错误处理、AbortSignal、超时控制、日志脱敏及本地服务安全防护。目录结构应清晰划分 `auth`、`providers`、`runtime`、`transport`、`sessions`、`tools` 和 `server` 等模块，并提供完整 TypeScript 类型定义。首版可以先采用单用户本地运行模式，但架构上需要预留多用户账户隔离和持久化扩展能力。

**交付要求：** 请先阅读 assistant-ui、OpenAI Agents SDK、ChatGPT OAuth / Dynamic Client Registration 的最新官方文档，确认所采用 API 的实际可用性及兼容限制，直接实现一个能够运行，进行测试的模块。提供从安装依赖、首次 OAuth 登录、获取可用模型、发送消息到验证流式响应的完整运行步骤与架构说明文档。优先使用官方现成 SDK 和协议，避免重复造轮子；所有关键功能必须是真实实现，不要用伪代码或 Mock 冒充已完成的功能，并明确标注尚未验证或受官方预览限制的部分。

## References

## Package

assistant-ui React: [@assistant-ui/react](https://www.assistant-ui.com/docs) assistant-ui 核心 React UI 组件与 Runtime Provider
assistant-ui AI SDK: [@assistant-ui/ai-sdk](https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7) assistant-ui 与 Vercel AI SDK 的 Runtime 集成
Vercel AI SDK: [ai](https://ai-sdk.dev/docs/introduction) AI SDK 核心库，提供统一消息类型与流式通信协议
AI SDK React: [@ai-sdk/react](https://ai-sdk.dev/docs/ai-sdk-ui/overview) AI SDK React Hooks，提供 useChat 等状态管理能力
OpenAI Agents SDK: [@openai/agents](https://openai.github.io/openai-agents-js/) OpenAI Agents SDK 核心库，支持 Agent、Runner、Tools、Handoffs 和 Sessions
OpenAI Agents Extensions: [@openai/agents-extensions](https://openai.github.io/openai-agents-js/extensions/ai-sdk/) OpenAI Agents SDK 扩展包，支持与 AI SDK 集成
Agents AI SDK UI: [@openai/agents-extensions/ai-sdk-ui](https://www.assistant-ui.com/docs/integrations/frameworks/openai-agents) 将 Agents SDK 流式运行结果转换为 AI SDK UI Message Stream，属于 @openai/agents-extensions 的子路径导出
OpenAI Node.js SDK: [openai](https://github.com/openai/openai-node) OpenAI 官方 Node.js SDK，用于创建自定义 OpenAI Client 和调用 Responses API

### Documentation

assistant-ui OpenAI Agents 集成: [OpenAI Agents SDK Integration](https://www.assistant-ui.com/docs/integrations/frameworks/openai-agents) assistant-ui 官方提供的 OpenAI Agents SDK 前后端集成方案
assistant-ui AI SDK Runtime: [AI SDK v7 Runtime](https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7) assistant-ui 与 AI SDK v7 的 Runtime 配置文档
OpenAI Agents SDK 文档: [Agents SDK Documentation](https://openai.github.io/openai-agents-js/) Agent 架构、工具调用、运行流程与会话管理
OpenAI Agents SDK 示例: [AI SDK UI Example](https://github.com/openai/openai-agents-js/tree/main/examples/ai-sdk-ui) OpenAI 官方 AI SDK UI Stream 集成示例
ChatGPT OAuth 总览: [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) 官方 ChatGPT 订阅授权及 OAuth 接入说明
OAuth 动态客户端注册: [Registration and Sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) Dynamic Client Registration、OAuth 2.0、PKCE 和授权回调
OAuth 会话管理: [Accounts and Sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) OAuth 账户、凭证持久化与 Token 刷新
OAuth Token 说明: [Token Reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference) Access Token、Refresh Token、ID Token 及权限范围
OAuth 模型调用: [Models and Inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) 使用 ChatGPT OAuth Access Token 调用 OpenAI Responses API
OAuth 接口限制: [Preview Limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) ChatGPT Plan Usage 当前支持的模型、请求参数和工具限制
