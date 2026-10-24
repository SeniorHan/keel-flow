import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PipelineItemState, StructureNode, WorkflowMeta, WorkflowStructure } from "./workflow.js";

export type { PipelineItemState, PipelineItemStatus, StructureNode, WorkflowStructure } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  /** Structure node this agent was spawned under (parallel/pipeline scope). */
  parentId?: number;
  /** When agent() was invoked (pre-limiter). */
  queuedAt?: number;
  /** When the agent actually started running. */
  startedAt?: number;
  /** When the agent finished (done/error/skipped). */
  endedAt?: number;
  /** Last transcript/activity timestamp; a running agent silent >30s is flagged 挂死. */
  lastEventAt?: number;
  /** Most recent transcript lines (text/tool/error), newest last, capped. */
  transcriptTail?: string[];
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
  /** Live execution-structure tree; absent → views fall back to phase grouping. */
  nodes?: StructureNode[];
  pipelineItems?: PipelineItemState[];
  /** Limiter queue depth (agent() calls waiting to start). */
  queuedCount?: number;
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
  /** Clock for elapsed/silence math; defaults to Date.now(). */
  now?: number;
  /** Per-render status-line context (background id, peer runs); called lazily so detached state shows up. */
  statusOptions?: () => WorkflowStatusOptions;
}

export type StatusPeerState = "running" | "done" | "failed" | "cancelled";

/** A running agent whose last event is older than this is flagged ⚠ 静默 in the 围观 view. */
export const HANG_WARN_MS = 30_000;

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
  const now = options.now ?? Date.now();
  const elapsed =
    snapshot.startedAt !== undefined && snapshot.durationMs === undefined
      ? ` · ${Math.max(0, Math.round((now - snapshot.startedAt) / 1000))}s`
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
      lines.push(
        `    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${silenceSuffix(agent, now)}${result}`,
      );
    }
    if (agents.length > visibleAgents.length) lines.push(`    … ${agents.length - visibleAgents.length} 更早的子代理`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  未分组");
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(
        `    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${silenceSuffix(agent, now)}${result}`,
      );
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

/** Format a wall-clock timestamp as HH:MM:SS (local time). */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** ⚠ 静默 Ns suffix for a running agent silent >30s; empty string when healthy. */
export function silenceSuffix(agent: WorkflowAgentSnapshot, now: number): string {
  if (agent.status !== "running") return "";
  const last = agent.lastEventAt ?? agent.startedAt;
  if (last === undefined) return "";
  const silentMs = now - last;
  if (silentMs <= HANG_WARN_MS) return "";
  return ` ⚠ 静默 ${Math.round(silentMs / 1000)}s`;
}

/** True when any running agent has been silent >30s (drives the 疑似挂死 header flag). */
export function hasHungAgents(snapshot: WorkflowSnapshot, now: number): boolean {
  return snapshot.agents.some((agent) => silenceSuffix(agent, now) !== "");
}

function padToWidth(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return text + " ".repeat(pad);
}

/**
 * Execution-structure tree: parallel/pipeline scopes with per-node progress and child agent rows.
 * Exported for the 围观 view and tests; falls back to phase grouping when the snapshot has no nodes.
 */
export function renderStructureTree(
  nodes: StructureNode[],
  pipelineItems: PipelineItemState[] | undefined,
  queuedCount: number | undefined,
  agents: WorkflowAgentSnapshot[],
  now = Date.now(),
): string[] {
  const lines: string[] = [];
  if ((queuedCount ?? 0) > 0) lines.push(`  排队中: ${queuedCount}`);
  const agentLine = (agent: WorkflowAgentSnapshot, indent: string): string =>
    `${indent}#${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 40)}${silenceSuffix(agent, now)}`;
  const renderNode = (node: StructureNode, depth: number, last: boolean): void => {
    const indent = "  ".repeat(depth);
    const branch = depth === 0 ? "▾" : last ? "└─" : "├─";
    const children = nodes.filter((entry) => entry.parentId === node.id);
    const childAgents = agents.filter((agent) => agent.parentId === node.id);
    const running = childAgents.filter((agent) => agent.status === "running").length;
    const started = childAgents.length;
    const name = node.label ?? `${node.kind}#${node.id}`;
    if (node.kind === "parallel") {
      const thunkCount = node.thunkCount ?? childAgents.length;
      const queued = Math.max(0, thunkCount - started);
      const parts = [`运行 ${running}`];
      if (queued > 0) parts.push(`排队 ${queued}`);
      const finished = thunkCount > 0 && started === thunkCount && running === 0 && queued === 0;
      lines.push(`${indent}${branch} ${finished ? "✓" : "▶"} ${name} · ${thunkCount} thunk(${parts.join(" · ")})`);
    } else {
      const items = (pipelineItems ?? []).filter((item) => item.node === node.id);
      const itemsDone = items.filter((item) => item.status === "done").length;
      const total = node.itemCount ?? items.length;
      lines.push(
        `${indent}${branch} ${itemsDone === total && total > 0 ? "✓" : "▶"} 管线 ${name} · ${itemsDone}/${total} 完成`,
      );
      for (const item of items) {
        const icon = item.status === "done" ? "✓" : item.status === "failed" ? "✗" : "●";
        lines.push(`${indent}   ${icon} item ${item.itemIndex} 阶段 ${item.stageIndex}/${item.stageCount}`);
      }
    }
    for (const agent of childAgents) lines.push(agentLine(agent, `${indent}   `));
    for (const [index, child] of children.entries()) renderNode(child, depth + 1, index === children.length - 1);
  };
  const roots = nodes.filter((node) => node.parentId === undefined);
  for (const [index, node] of roots.entries()) renderNode(node, 0, index === roots.length - 1);
  const orphans = agents.filter((agent) => agent.parentId === undefined);
  if (orphans.length) {
    lines.push("  未分组");
    for (const agent of orphans) lines.push(agentLine(agent, "    "));
  }
  return lines;
}

export interface WorkflowViewOptions {
  /** Clock for elapsed/silence math; defaults to Date.now(). */
  now?: number;
  /** Total widget width; defaults to 96 columns. */
  width?: number;
  /** Right-hand log-stream depth; defaults to 20. */
  maxLogs?: number;
  /** Transcript tail agent label; defaults to the most recently started agent. */
  tailAgent?: string;
}

/**
 * Read-only full-screen-style 围观 view: header + structure tree (left) + live log stream (right)
 * + selected agent's transcript tail. Pure function; the extension renders it into a large widget.
 */
export function renderWorkflowView(snapshot: WorkflowSnapshot, options: WorkflowViewOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const width = options.width ?? 96;
  const maxLogs = options.maxLogs ?? 20;
  const leftWidth = Math.max(24, width - 39);
  const rightWidth = width - leftWidth - 1;

  const elapsed =
    snapshot.startedAt !== undefined ? Math.max(0, Math.round((now - snapshot.startedAt) / 1000)) : undefined;
  const state = snapshot.runningCount > 0 ? "运行中" : snapshot.errorCount > 0 ? "已完成 · 有错误" : "已完成";
  const hung = hasHungAgents(snapshot, now);
  const header = `◆ ${snapshot.name} · ${state} · ${snapshot.doneCount}/${snapshot.agentCount} 完成${elapsed !== undefined ? ` · ${elapsed}s` : ""}${hung ? " · 疑似挂死" : ""}`;

  const treeLines = snapshot.nodes?.length
    ? renderStructureTree(snapshot.nodes, snapshot.pipelineItems, snapshot.queuedCount, snapshot.agents, now)
    : renderWorkflowLines(snapshot, { maxAgents: 6, maxLogs: 0, now }).slice(1);

  const logLines = snapshot.logs
    .slice(-maxLogs)
    .map((log) => truncateToWidth(`[${formatClock(now)}] ${log}`, rightWidth));
  const logHeader = `最近日志${snapshot.logs.length > maxLogs ? `(末 ${maxLogs} 条)` : ""}`;

  const rows = Math.max(treeLines.length, logLines.length);
  const lines: string[] = [header, "─".repeat(width)];
  lines.push(
    `${padToWidth(truncateToWidth("执行结构", leftWidth), leftWidth)}│${truncateToWidth(logHeader, rightWidth)}`,
  );
  for (let i = 0; i < rows; i++) {
    const left = truncateToWidth(treeLines[i] ?? "", leftWidth);
    const right = logLines[i] ?? "";
    lines.push(`${padToWidth(left, leftWidth)}│${right}`);
  }

  const tail = selectTailAgent(snapshot, options.tailAgent);
  if (tail?.transcriptTail?.length) {
    lines.push("─".repeat(width));
    lines.push(truncateToWidth(`─ ${tail.label} · 转录尾部`, width));
    for (const entry of tail.transcriptTail.slice(-5)) lines.push(truncateToWidth(`  ${entry}`, width));
  }
  return lines;
}

function selectTailAgent(snapshot: WorkflowSnapshot, label?: string): WorkflowAgentSnapshot | undefined {
  if (label) return snapshot.agents.find((agent) => agent.label === label);
  const running = snapshot.agents.filter((agent) => agent.status === "running");
  const pool = running.length ? running : snapshot.agents;
  return pool.length ? pool.reduce((latest, agent) => (agent.id > latest.id ? agent : latest)) : undefined;
}
