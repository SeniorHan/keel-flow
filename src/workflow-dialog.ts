import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BackgroundRegistry } from "./background.js";
import { renderWorkflowView, type WorkflowSnapshot } from "./display.js";

/**
 * Crew 式两层对话框:`/workflow` 无参时的交互皮肤。
 * 列表层(运行中 + 已结算,↑↓/jk 选择,Enter 围观,Esc/q 关闭)→
 * 详情层(renderWorkflowView 全视图,运行中每 1s 重渲染,Esc 回列表)。
 */

export type WorkflowDialogKey = "up" | "down" | "enter" | "escape" | "q";
export type WorkflowDialogMode = "list" | "detail" | "closed";

export interface WorkflowDialogState {
  mode: WorkflowDialogMode;
  /** Selected row index in the list layer. */
  selected: number;
  /** Live row count; the component refreshes it as runs start/settle. */
  count: number;
}

export function initialDialogState(count = 0): WorkflowDialogState {
  return { mode: "list", selected: 0, count };
}

/**
 * Pure state machine: list ↑↓ moves (clamped), Enter opens detail, Esc/q close;
 * detail Esc (or q) returns to the list — only the list layer exits the dialog.
 */
export function handleKey(state: WorkflowDialogState, key: WorkflowDialogKey): WorkflowDialogState {
  if (state.mode === "closed") return state;
  if (state.mode === "detail") {
    return key === "escape" || key === "q" ? { ...state, mode: "list" } : state;
  }
  if (key === "up") return { ...state, selected: Math.max(0, state.selected - 1) };
  if (key === "down") return { ...state, selected: Math.min(Math.max(0, state.count - 1), state.selected + 1) };
  if (key === "enter") return state.count > 0 ? { ...state, mode: "detail" } : state;
  return { ...state, mode: "closed" };
}

export interface WorkflowDialogItem {
  id: string;
  name: string;
  running: boolean;
  /** Running: elapsed so far; settled: total duration. Preformatted, e.g. "47s" / "12.3s". */
  time: string;
  /** Settled runs only: false when the snapshot recorded errors. */
  ok?: boolean;
}

/** Pure list-layer rows: `› ⏵ wf-2 (name) · 47s`; empty list still renders a hint line. */
export function renderDialogLines(items: WorkflowDialogItem[], selectedIndex: number): string[] {
  if (items.length === 0) return ["没有后台工作流"];
  return items.map((item, index) => {
    const marker = index === selectedIndex ? "›" : " ";
    const icon = item.running ? "⏵" : item.ok === false ? "✗" : "✓";
    return `${marker} ${icon} ${item.id} (${item.name}) · ${item.time}`;
  });
}

export const WORKFLOW_DIALOG_LIST_FOOTER = "↑↓ 选择 · Enter 围观 · Esc 关闭";
export const WORKFLOW_DIALOG_DETAIL_FOOTER = "Esc 返回列表";

export interface WorkflowDialogDeps {
  registry: BackgroundRegistry;
  /** Settled-run snapshots (newest last); rendered 倒序 below the running rows. */
  history: Map<string, WorkflowSnapshot>;
  /**
   * Export hook shared with the `/workflow export` subcommand. The detail layer
   * deliberately binds no export key (out of scope) — it points at the command instead.
   */
  exportRun?: (id: string) => void | Promise<void>;
}

interface DialogHost {
  requestRender(force?: boolean): void;
  terminal?: { rows: number };
}

function dialogHeight(host: DialogHost): number {
  const rows = host.terminal?.rows ?? 24;
  return Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.9)));
}

/** Bounded overlay frame (keel-crew dialog shell): title, body clipped to height, footer hint. */
function frameDialog(
  theme: Theme,
  width: number,
  height: number,
  title: string,
  body: string[],
  footer: string,
): string[] {
  if (width <= 0 || height <= 0) return [];
  const fit = (text: string, columns: number) => {
    const clipped = truncateToWidth(text, Math.max(0, columns), "", true);
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
  };
  if (width < 4 || height < 4) return [fit(title, width)];
  const inner = width - 2;
  const line = (text: string) => theme.fg("border", "│") + fit(text, inner) + theme.fg("border", "│");
  const heading = truncateToWidth(` ${title} `, inner, "");
  const top =
    theme.fg("border", "╭") +
    theme.fg("border", heading) +
    theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(heading))) + "╮");
  const budget = height - 4;
  const padded = body.slice(0, budget);
  while (padded.length < budget) padded.push("");
  return [
    top,
    ...padded.map(line),
    theme.fg("border", "├" + "─".repeat(inner) + "┤"),
    line(theme.fg("dim", footer)),
    theme.fg("border", "╰" + "─".repeat(inner) + "╯"),
  ];
}

const DIALOG_OPTIONS = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
} as const;

const DETAIL_REFRESH_MS = 1000;

class WorkflowDialog implements Component {
  private state: WorkflowDialogState = initialDialogState();
  private items: WorkflowDialogItem[] = [];
  private snapshots: Array<WorkflowSnapshot | undefined> = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private host: DialogHost,
    private theme: Theme,
    private deps: WorkflowDialogDeps,
    private done: (value: undefined) => void,
  ) {
    this.refresh();
    this.timer = setInterval(() => {
      this.refresh();
      this.host.requestRender();
    }, DETAIL_REFRESH_MS);
  }

  /** Rebuild rows: running first (registry order), then settled history 倒序. */
  private refresh(): void {
    const items: WorkflowDialogItem[] = [];
    const snapshots: Array<WorkflowSnapshot | undefined> = [];
    for (const entry of this.deps.registry.list()) {
      items.push({
        id: entry.id,
        name: entry.name,
        running: true,
        time: `${Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000))}s`,
      });
      snapshots.push(entry.getSnapshot?.());
    }
    for (const [id, snapshot] of [...this.deps.history.entries()].reverse()) {
      items.push({
        id,
        name: snapshot.name,
        running: false,
        ok: snapshot.errorCount === 0,
        time: snapshot.durationMs !== undefined ? `${Math.max(0, snapshot.durationMs / 1000).toFixed(1)}s` : "—",
      });
      snapshots.push(snapshot);
    }
    this.items = items;
    this.snapshots = snapshots;
    this.state.count = items.length;
    this.state.selected = Math.min(this.state.selected, Math.max(0, items.length - 1));
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    let key: WorkflowDialogKey | undefined;
    if (keys.matches(data, "tui.select.cancel")) key = "escape";
    else if (keys.matches(data, "tui.select.confirm")) key = "enter";
    else if (keys.matches(data, "tui.select.up")) key = "up";
    else if (keys.matches(data, "tui.select.down")) key = "down";
    else if (data === "j") key = "down";
    else if (data === "k") key = "up";
    else if (data === "q") key = "q";
    if (!key) return;
    this.state = handleKey(this.state, key);
    if (this.state.mode === "closed") {
      this.close();
      return;
    }
    this.host.requestRender();
  }

  private close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.done(undefined);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = dialogHeight(this.host);
    if (this.state.mode === "list") {
      const body = renderDialogLines(this.items, this.state.selected).map((line, index) => {
        const clipped = truncateToWidth(line, Math.max(0, width - 4), "", true);
        return index === this.state.selected ? this.theme.fg("accent", clipped) : clipped;
      });
      return frameDialog(this.theme, width, height, "后台工作流", body, WORKFLOW_DIALOG_LIST_FOOTER);
    }
    const inner = Math.max(1, width - 4);
    const snapshot = this.snapshots[this.state.selected];
    if (!snapshot) {
      return frameDialog(
        this.theme,
        width,
        height,
        "后台工作流",
        ["该运行没有可用快照。"],
        WORKFLOW_DIALOG_DETAIL_FOOTER,
      );
    }
    const item = this.items[this.state.selected];
    const body = renderWorkflowView(snapshot, { now: Date.now(), width: inner }).map((line) =>
      truncateToWidth(line, inner, "", true),
    );
    if (item && !item.running) {
      body.push("", truncateToWidth(`提示: /workflow export ${item.id} 导出 HTML 报告`, inner, "", true));
    }
    return frameDialog(this.theme, width, height, `围观 ${item?.id ?? ""}`, body, WORKFLOW_DIALOG_DETAIL_FOOTER);
  }
}

/**
 * Open the two-layer dialog. Falls back to a no-op outside interactive TUI
 * (the command handler keeps its notify listing for headless modes).
 */
export async function openWorkflowDialog(ctx: ExtensionContext, deps: WorkflowDialogDeps): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") return;
  await ctx.ui.custom<undefined>(
    (host, theme, _keys, done) => new WorkflowDialog(host, theme, deps, done),
    DIALOG_OPTIONS,
  );
}
