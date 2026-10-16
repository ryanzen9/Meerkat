'use client';

import { BanIcon, ChevronRightIcon, CircleAlertIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  CollapsibleRoot as Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible-root';
import { collapsePanel, ShimmerLabel, SwapLabel } from './surfaces';
import { take } from '../utils/range';

export interface TimelineStep {
  id?: string;
  verb: string;
  chip: string;
  icon: LucideIcon;
  status?: 'running' | 'complete' | 'failed' | 'cancelled';
  error?: string;
  details?: ReactNode;
  detailsLabel?: string;
}

export interface TimelineStat {
  file: string;
  added?: number;
  removed?: number;
}

export interface ToolTimelineProps {
  steps: readonly TimelineStep[];
  visibleSteps: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  activeLabel: string;
  stats: TimelineStat[];
  className?: string;
}

export function ToolTimeline({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  stats,
  className,
}: ToolTimelineProps) {
  return (
    <Collapsible
      data-slot="tool-timeline"
      open={open}
      onOpenChange={onOpenChange}
      aria-busy={streaming}
      className={cn('w-full min-w-0 max-w-sm', className)}
    >
      <CollapsibleTrigger className="group/trigger flex max-w-full min-w-0 items-center gap-1.5 rounded-md py-1 text-start text-[13.5px] text-muted-foreground transition-colors outline-none hover:text-foreground/90">
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-panel-open/trigger:rotate-90 group-data-open/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel active={streaming ? 0 : 1} className="text-start tabular-nums">
          <ShimmerLabel active={streaming} className="relative inline-block leading-none">
            {activeLabel}
          </ShimmerLabel>
          <>{restingLabel}</>
        </SwapLabel>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, 'outline-none')}>
        <div className="flex flex-col gap-2.5 ps-4 pt-2.5">
          {take(steps, visibleSteps).map((step, index, shown) => {
            const failed = step.status === 'failed';
            const cancelled = step.status === 'cancelled';
            const Icon = failed ? CircleAlertIcon : cancelled ? BanIcon : step.icon;
            const active =
              step.status === 'running' ||
              (step.status === undefined && streaming && index === shown.length - 1);

            return (
              <div
                key={step.id ? `id:${step.id}` : index}
                data-slot="tool-timeline-step"
                data-status={step.status}
                className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex min-w-0 items-start gap-2 text-[13.5px] text-muted-foreground duration-300 motion-reduce:animate-none"
              >
                <Icon
                  aria-hidden="true"
                  className={cn('mt-0.5 size-3.5 shrink-0', failed && 'text-destructive')}
                />
                <ShimmerLabel
                  active={active}
                  className="relative inline-block shrink-0 py-0.5 leading-none"
                >
                  {step.verb}
                </ShimmerLabel>
                <div className="min-w-0 flex-1">
                  <span
                    title={step.error ?? step.chip}
                    className={cn(
                      'inline-block max-w-full rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] wrap-anywhere text-foreground/70',
                      failed && 'text-destructive',
                    )}
                  >
                    {step.chip}
                  </span>
                  {step.error && (
                    <p
                      data-slot="tool-timeline-error"
                      className="mt-1 text-xs wrap-anywhere whitespace-pre-wrap text-destructive"
                    >
                      {step.error}
                    </p>
                  )}
                  {step.details && (
                    <Collapsible className="mt-1 min-w-0">
                      <CollapsibleTrigger
                        aria-label={step.detailsLabel ?? 'View tool details'}
                        className="group/detail inline-flex items-center gap-1 rounded-sm py-0.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="size-3 shrink-0 group-data-open/detail:rotate-90"
                        />
                        查看详情
                      </CollapsibleTrigger>
                      <CollapsibleContent
                        className={cn(collapsePanel, 'min-w-0 [&_pre]:wrap-anywhere')}
                      >
                        {step.details}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
                {(failed || cancelled) && (
                  <span className="sr-only">{failed ? 'Failed' : 'Cancelled'}</span>
                )}
              </div>
            );
          })}
          {stats.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {stats.map((stat) => (
                <span
                  key={stat.file}
                  className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground/70"
                >
                  <span title={stat.file} className="min-w-0 truncate">
                    {stat.file}
                  </span>
                  {stat.added !== undefined && (
                    <span className="shrink-0 text-added">+{stat.added}</span>
                  )}
                  {stat.removed !== undefined && (
                    <span className="shrink-0 text-deleted">−{stat.removed}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
