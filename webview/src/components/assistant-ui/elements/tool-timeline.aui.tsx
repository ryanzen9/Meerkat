'use client';

import { useState, type FC } from 'react';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { ToolTimeline } from '@/components/assistant-ui/elements/tool-timeline';
import {
  formatUnknownValue,
  ToolFallbackArgs,
  ToolFallbackResult,
} from '@/components/assistant-ui/elements/tool-fallback.aui';
import {
  toolCallStats,
  toolCallStep,
  type ToolCallSummary,
} from '@/components/assistant-ui/utils/tool-timeline';

type ToolGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * A run of adjacent tool calls rendered as the `elements-tool-timeline` element:
 * one step per call, each naming what the agent did and what the Bridge
 * answered, with the changed lines the run read listed underneath.
 *
 * This is the way the Thread shows tool calls — a run of one included. Calls
 * that own their own UI never reach it: `thread.aui.tsx` keeps those out of the
 * group, so an approval gate keeps its controls and a registered tool UI keeps
 * its renderer.
 */

/** The trigger label while the run still has a call in flight. */
const ACTIVE_LABEL = 'Working…';

const restingLabel = (steps: number, failed: number, cancelled: number) =>
  [
    `Ran ${steps === 1 ? '1 step' : `${steps} steps`}`,
    failed > 0 ? `${failed} failed` : undefined,
    cancelled > 0 ? `${cancelled} cancelled` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

export const ToolCallTimelineGroup: FC<{ group: ToolGroupPart }> = ({ group }) => {
  const parts = useAuiState((s) => s.message.parts);
  const [open, setOpen] = useState(false);

  // The group's indices address this message's parts, in order, so a run keeps
  // streaming into the list as its calls arrive.
  const calls = group.indices.flatMap((index): ToolCallSummary[] => {
    const part = parts[index];
    return part?.type === 'tool-call'
      ? [
          {
            id: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
            argsText: part.argsText,
            result: part.result,
            isError: part.isError,
            status: part.status,
          },
        ]
      : [];
  });
  const steps = calls.map((call) => ({
    ...toolCallStep(call),
    detailsLabel: `查看 ${call.toolName} 调用详情`,
    details: <ToolCallDetails call={call} />,
  }));

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={calls.length}
      streaming={group.status.type === 'running'}
      open={open}
      onOpenChange={setOpen}
      restingLabel={restingLabel(
        calls.length,
        steps.filter((step) => step.status === 'failed').length,
        steps.filter((step) => step.status === 'cancelled').length,
      )}
      activeLabel={ACTIVE_LABEL}
      stats={toolCallStats(calls)}
    />
  );
};

const ToolCallDetails: FC<{ call: ToolCallSummary }> = ({ call }) => (
  <div data-slot="tool-timeline-details" className="flex min-w-0 flex-col gap-2 pt-2">
    <p className="text-xs wrap-anywhere text-muted-foreground">Tool: {call.toolName}</p>
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">Arguments:</p>
      <ToolFallbackArgs argsText={call.argsText || formatUnknownValue(call.args, 2)} />
    </div>
    <ToolFallbackResult result={call.result} />
    {call.status?.error !== undefined && (
      <pre className="rounded-md bg-surface/50 p-2.5 text-xs wrap-anywhere whitespace-pre-wrap text-destructive">
        {formatUnknownValue(call.status.error, 2)}
      </pre>
    )}
  </div>
);
