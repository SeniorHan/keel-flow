import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  /** Wall-clock start of the run; drives the running elapsed in the header line. */
  startedAt?: number;
  result?: unknown;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  /** Default true; false keeps the footer status line but skips setWidget. */
  showWidget?: boolean;
  showResultPreviews?: boolean;
  /** Overrides the default 工作流运行中/工作流已完成 transcript header (e.g. detached/background start). */
  header?: string;
  /** Per-render status-line context (background id, peer runs); called lazily so detached state shows up. */
  statusOptions?: () => WorkflowStatusOptions;
}

export type StatusPeerState = "running" | "done" | "failed" | "cancelled";

export interface StatusPeer {
  id: string;
  state: StatusPeerState;
}

export interface WorkflowStatusOptions {
  /** Set once this run lives in the background registry; switches the status line to the ⏵ wf-N form. */
  backgroundId?: string;
  /** All session background runs (live + recently settled); >1 collapses into the aggregate line. */
  peers?: StatusPeer[];
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;
  const showWidget = options.showWidget ?? true;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, renderStatusLine(snapshot, completed, options.statusOptions?.() ?? {}));
    if (showWidget) ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      if (showWidget) ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} 错误`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} 运行中`
        : "";
  const elapsed =
    snapshot.startedAt !== undefined && snapshot.durationMs === undefined
      ? ` · ${Math.max(0, Math.round((Date.now() - snapshot.startedAt) / 1000))}s`
      : "";
  const lines = [`◆ 工作流: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} 完成${state})${elapsed}`];

  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} 运行中` : ""}${errors ? ` · ${errors} 错误` : ""}${skipped ? ` · ${skipped} 跳过` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
    }
    if (agents.length > visibleAgents.length) lines.push(`    … ${agents.length - visibleAgents.length} 更早的子代理`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  未分组");
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
    }
  }

  const visibleLogs = snapshot.logs.slice(-maxLogs);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push("");
    for (const log of visibleLogs) lines.push(`  日志: ${log}`);
  }
  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  const header = options.header ?? (completed ? "工作流已完成" : "工作流运行中");
  return [header, ...renderWorkflowLines(snapshot, options)].join("\n");
}

/** Pure footer status line: foreground running, background running, terminal and multi-workflow aggregate forms. */
export function renderStatusLine(
  snapshot: WorkflowSnapshot,
  completed: boolean,
  status: WorkflowStatusOptions = {},
): string {
  if (completed) {
    if (snapshot.errorCount > 0)
      return `workflow ✗ ${snapshot.name} ${snapshot.doneCount}/${snapshot.agentCount} · ${snapshot.errorCount} 错误`;
    const seconds =
      snapshot.durationMs !== undefined ? ` · ${Math.max(0, Math.round(snapshot.durationMs / 1000))}s` : "";
    return `workflow ✓ ${snapshot.name} ${snapshot.doneCount}/${snapshot.agentCount}${seconds}`;
  }
  const peers = status.peers ?? [];
  if (status.backgroundId && peers.length > 1) {
    const marks: Record<StatusPeerState, string> = { running: "⏵", done: "✓", failed: "✗", cancelled: "⊘" };
    const sorted = [...peers].sort((a, b) => peerId(b.id) - peerId(a.id));
    const shown = sorted.slice(0, 2).map((peer) => `${peer.id} ${marks[peer.state]}`);
    const rest = sorted.length - shown.length;
    return `workflow: ${peers.length} 后台 · ${shown.join(" · ")}${rest > 0 ? ` · …+${rest}` : ""}`;
  }
  const elapsed =
    snapshot.startedAt !== undefined ? ` · ${Math.max(0, Math.round((Date.now() - snapshot.startedAt) / 1000))}s` : "";
  if (status.backgroundId)
    return `workflow ${snapshot.name} ⏵ ${status.backgroundId} · ${snapshot.doneCount}/${snapshot.agentCount} 完成${elapsed}`;
  return `workflow ${snapshot.name} ● ${snapshot.runningCount} 运行中, ${snapshot.doneCount}/${snapshot.agentCount} 完成${elapsed}`;
}

function peerId(id: string): number {
  return Number.parseInt(id.replace("wf-", ""), 10) || 0;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
