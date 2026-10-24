import type { WorkflowRunResult } from "./workflow.js";

export interface BackgroundWorkflow {
  id: string;
  name: string;
  startedAt: number;
  controller: AbortController;
  run: Promise<WorkflowRunResult>;
  /** Live done/total agent counts, wired up by the tool; drives the /workflow list line. */
  progress?: () => string;
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

const NOTIFY_ERROR_CAP = 80;

export function settlementText(n: BackgroundSettlement): string {
  const seconds = (n.durationMs / 1000).toFixed(1);
  if (n.cancelled) return `后台工作流 ${n.id} (${n.name}) 已在 ${seconds} s 后取消。`;
  if (!n.ok) return `后台工作流 ${n.id} (${n.name}) 在 ${seconds} s 后失败:${n.error ?? "未知错误"}`;
  const json = truncateResultText(JSON.stringify(n.result ?? null, null, 2));
  return `后台工作流 ${n.id} (${n.name}) 已完成:${n.agentCount} 个子代理,耗时 ${seconds} s。\n\n结果:\n${json}`;
}

/** One-line settlement notification for the TUI (pi notify). */
export function settlementNotifyLine(n: BackgroundSettlement): string {
  const seconds = (n.durationMs / 1000).toFixed(1);
  if (n.cancelled) return `${n.id} (${n.name}) ⊘ 已取消 · ${seconds}s 后`;
  if (!n.ok) {
    const message = n.error ?? "未知错误";
    const error = message.length > NOTIFY_ERROR_CAP ? `${message.slice(0, NOTIFY_ERROR_CAP - 1)}…` : message;
    return `${n.id} (${n.name}) ✗ 失败: ${error}`;
  }
  return `${n.id} (${n.name}) ✓ 完成 · ${n.agentCount} 个子代理 · ${seconds}s`;
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
