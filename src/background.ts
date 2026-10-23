import type { WorkflowRunResult } from "./workflow.js";

export interface BackgroundWorkflow {
  id: string;
  name: string;
  startedAt: number;
  controller: AbortController;
  run: Promise<WorkflowRunResult>;
}

export interface BackgroundSettlement {
  id: string;
  name: string;
  ok: boolean;
  cancelled: boolean;
  durationMs: number;
  agentCount: number;
  result?: unknown;
  error?: string;
}

const RESULT_TEXT_CAP = 4000;

export function truncateResultText(json: string): string {
  return json.length > RESULT_TEXT_CAP ? `${json.slice(0, RESULT_TEXT_CAP)}\n…(truncated)` : json;
}

export function settlementText(n: BackgroundSettlement): string {
  const seconds = (n.durationMs / 1000).toFixed(1);
  if (n.cancelled) return `Background workflow ${n.id} (${n.name}) was cancelled after ${seconds} s.`;
  if (!n.ok) return `Background workflow ${n.id} (${n.name}) failed after ${seconds} s: ${n.error ?? "unknown error"}`;
  const json = truncateResultText(JSON.stringify(n.result ?? null, null, 2));
  return `Background workflow ${n.id} (${n.name}) completed with ${n.agentCount} agent(s) in ${seconds} s.\n\nResult:\n${json}`;
}

/** One-line settlement notification for the TUI (pi notify). */
export function settlementNotifyLine(n: BackgroundSettlement): string {
  const seconds = (n.durationMs / 1000).toFixed(1);
  if (n.cancelled) return `${n.id} (${n.name}) ⊘ cancelled after ${seconds}s`;
  if (!n.ok) return `${n.id} (${n.name}) ✗ failed: ${n.error ?? "unknown error"}`;
  const agents = `${n.agentCount} agent${n.agentCount === 1 ? "" : "s"}`;
  return `${n.id} (${n.name}) ✓ completed · ${agents} · ${seconds}s`;
}

/**
 * Session-scoped registry of detached workflows (background: true).
 * Entries are removed on settle; ids keep incrementing for the session's lifetime.
 */
export class BackgroundRegistry {
  private readonly workflows = new Map<string, BackgroundWorkflow>();
  private counter = 0;

  add(name: string, run: Promise<WorkflowRunResult>, controller: AbortController): BackgroundWorkflow {
    this.counter += 1;
    const entry: BackgroundWorkflow = {
      id: `wf-${this.counter}`,
      name,
      startedAt: Date.now(),
      controller,
      run,
    };
    this.workflows.set(entry.id, entry);
    return entry;
  }

  get(id: string): BackgroundWorkflow | undefined {
    return this.workflows.get(id);
  }

  list(): BackgroundWorkflow[] {
    return [...this.workflows.values()];
  }

  cancel(id: string): boolean {
    const entry = this.workflows.get(id);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  /** Remove a settled entry; returns the entry so the caller can build the notification. */
  settle(id: string): BackgroundWorkflow | undefined {
    const entry = this.workflows.get(id);
    this.workflows.delete(id);
    return entry;
  }
}
