import type { InferUITools, ToolLoopAgent, UIMessage } from 'ai';
import type { reviewTools } from '../extension/bridge/tools/reviewTools';
import type { ReviewRunState, SubmitReviewResult } from './review';

// Type-only link to the server agent: no backend code or credentials enter the webview.
export type ReviewAgent = ToolLoopAgent<never, ReturnType<typeof reviewTools>>;
export type ReviewChatMessage = UIMessage<
  unknown,
  {
    'review-status': ReviewRunState;
    'review-receipt': { run: ReviewRunState; result: SubmitReviewResult };
  },
  InferUITools<ReturnType<typeof reviewTools>>
>;
