import type { InferAgentUIMessage, ToolLoopAgent } from 'ai';
import type { reviewTools } from '../extension/bridge/tools/reviewTools';

// Type-only link to the server agent: no backend code or credentials enter the webview.
export type ReviewAgent = ToolLoopAgent<never, ReturnType<typeof reviewTools>>;
export type ReviewChatMessage = InferAgentUIMessage<ReviewAgent>;
