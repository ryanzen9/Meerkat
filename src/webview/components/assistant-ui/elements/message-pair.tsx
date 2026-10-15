// Adapted from the official elements-message-pair Runtime recipe (MIT).
// https://www.assistant-ui.com/elements/message-pair
// Source: assistant-ui/assistant-ui at d7ba4e673622c3afbf064dc9c33583af81258548.
// See THIRD_PARTY_NOTICES.md for attribution and license.
import type { ReactNode } from 'react';
import { ActionBarPrimitive, MessagePrimitive } from '@assistant-ui/react';

export function MessagePairUser({ children }: { children: ReactNode }) {
  return (
    <MessagePrimitive.Root
      data-slot="message-pair-user"
      aria-label="你的消息"
      className="mb-5 flex w-full min-w-0 flex-col"
    >
      <div className="max-w-[85%] min-w-0 self-end rounded-2xl border border-widget bg-user px-3.5 py-2 text-user-foreground high-contrast:border-contrast">
        {children}
      </div>
    </MessagePrimitive.Root>
  );
}

export function MessagePairAssistant({
  children,
  actions,
}: {
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <MessagePrimitive.Root
      data-slot="message-pair-assistant"
      aria-label="助手回复"
      className="group/message mb-5 flex w-full min-w-0 flex-col items-start"
    >
      <div className="w-full min-w-0 leading-relaxed">{children}</div>
      {/* Keep actions in the tab order; keyboard focus reveals them as hover does. */}
      <ActionBarPrimitive.Root
        autohide="never"
        className="flex items-center gap-1 pt-1 opacity-0 transition-opacity group-focus-within/message:opacity-100 group-hover/message:opacity-100 motion-reduce:transition-none"
      >
        {actions}
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
