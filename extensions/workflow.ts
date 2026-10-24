import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@earendil-works/pi-coding-agent";
import {
  BackgroundRegistry,
  type BackgroundSettlement,
  settlementNotifyLine,
  settlementText,
} from "../src/background.js";
import { renderWorkflowView } from "../src/display.js";
import { exportRunHtml } from "../src/export-html.js";
import { createWorkflowCancelTool, createWorkflowTool, type WorkflowToolExtras } from "../src/index.js";

const VIEW_WIDGET_KEY = "workflow-view";
/** 围观 widget auto-refresh cadence; Esc can't be intercepted in widget mode, so this keeps it live. */
const VIEW_REFRESH_MS = 60_000;

export default function workflowExtension(pi: ExtensionAPI): void {
  const registry = new BackgroundRegistry();
  // Set once the workflow tool executes; lets onSettle notify the TUI from the
  // extension scope (settlements fire outside any tool call).
  const uiRef: { current?: Pick<ExtensionContext["ui"], "notify"> } = { current: undefined };
  // 围观 state: which run is on screen + the auto-refresh timer (cleared on settle/toggle).
  const view: { id?: string; timer?: ReturnType<typeof setInterval> } = {};

  const closeView = (ctx: Pick<ExtensionContext, "ui" | "hasUI">, reason?: string): void => {
    if (view.timer) clearInterval(view.timer);
    view.timer = undefined;
    view.id = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(VIEW_WIDGET_KEY, undefined);
    if (reason) ctx.ui.notify(reason);
  };

  const renderView = (ctx: Pick<ExtensionContext, "ui" | "hasUI">): void => {
    if (!ctx.hasUI || view.id === undefined) return;
    const entry = registry.get(view.id);
    if (!entry?.getSnapshot) {
      closeView(ctx, `${view.id} 已结束,围观视图已清除。`);
      return;
    }
    ctx.ui.setWidget(
      VIEW_WIDGET_KEY,
      renderWorkflowView(entry.getSnapshot()).map((line) => `  ${line}`),
      { placement: "aboveEditor" },
    );
  };

  const onSettle = (settlement: BackgroundSettlement): void => {
    // Same shape as keel-crew's settlement notifications: hidden custom message
    // in model context, wake the main thread for done/failed/cancelled.
    pi.sendMessage(
      {
        customType: "keel-flow:update",
        content: settlementText(settlement),
        display: false,
        details: { backgroundId: settlement.id, ok: settlement.ok, cancelled: settlement.cancelled },
      },
      { triggerTurn: true },
    );
    uiRef.current?.notify(settlementNotifyLine(settlement));
    if (view.id === settlement.id && uiRef.current) {
      closeView({ ui: uiRef.current, hasUI: true }, `${settlement.id} 已结束,围观视图已清除。`);
    }
  };

  const history = new Map<string, import("../src/display.js").WorkflowSnapshot>();
  const tool = createWorkflowTool({ registry, onSettle, uiRef, history });
  pi.registerTool(tool);
  pi.registerTool(createWorkflowCancelTool(registry));
  pi.registerCommand("workflow", {
    description: "列出/取消/围观后台 workflow",
    async handler(args, ctx) {
      const cancelMatch = args.match(/^cancel\s+(wf-\d+)$/);
      if (cancelMatch) {
        if (registry.cancel(cancelMatch[1])) {
          ctx.ui.notify("已请求取消;结算会自动上报。");
        } else {
          ctx.ui.notify(`未知的工作流 id: ${cancelMatch[1]}`, "warning");
        }
        return;
      }
      const viewMatch = args.match(/^view(?:\s+(wf-\d+))?$/);
      if (viewMatch) {
        if (view.id !== undefined && (!viewMatch[1] || viewMatch[1] === view.id)) {
          closeView(ctx, "已关闭围观视图。");
          return;
        }
        const target = viewMatch[1] ?? registry.list().at(-1)?.id;
        if (!target || !registry.get(target)?.getSnapshot) {
          closeView(ctx);
          const running = registry.list().map((entry) => entry.id);
          ctx.ui.notify(
            running.length ? `没有可围观的 ${target ?? ""};运行中:${running.join(", ")}` : "没有后台工作流可围观。",
            "warning",
          );
          return;
        }
        view.id = target;
        renderView(ctx);
        if (view.timer) clearInterval(view.timer);
        view.timer = setInterval(() => renderView(ctx), VIEW_REFRESH_MS);
        ctx.ui.notify(`围观 ${target}:/workflow view 关闭,60s 自动刷新,结束自动清除。`);
        return;
      }
      const exportMatch = args.match(/^export\s+(wf-\d+)$/);
      if (exportMatch) {
        const snapshot = history.get(exportMatch[1]);
        if (!snapshot) {
          ctx.ui.notify(`${exportMatch[1]} 无已结算快照(未知 id、尚未结束或已被清出历史)。`, "warning");
          return;
        }
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");
        const path = join(tmpdir(), `keel-flow-${exportMatch[1]}.html`);
        writeFileSync(path, exportRunHtml(snapshot, { id: exportMatch[1] }));
        ctx.ui.notify(`已导出: ${path}`);
        return;
      }
      if (args.trim()) {
        ctx.ui.notify(
          "用法:/workflow 列出运行 · /workflow view [wf-N] 围观 · /workflow cancel wf-N 取消 · /workflow export wf-N 导出报告",
          "warning",
        );
        return;
      }
      const running = registry.list();
      if (running.length === 0) {
        ctx.ui.notify("没有后台工作流。");
        return;
      }
      const lines = running.map((entry) => {
        const elapsed = Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000));
        return `${entry.id}  ${entry.name}  ⏵ 运行中  ${entry.progress?.() ?? "…"} · ${elapsed}s`;
      });
      ctx.ui.notify(lines.join("\n"));
    },
  });
  // Tap-to-background: a message queued while a synchronous workflow runs detaches
  // every in-flight sync run so the turn frees up for the user. Only eavesdrop —
  // "continue" keeps the queueing pipeline untouched; the detached tool result and
  // the settlement message explain the move. Deliberate waits (`followUp`) do not.
  pi.on("input", (event): InputEventResult => {
    if (event.streamingBehavior !== "steer") return { action: "continue" };
    for (const handle of [...(tool as WorkflowToolExtras).syncRuns]) {
      const entry = handle.detach();
      if (!entry) continue;
      pi.sendMessage(
        {
          customType: "keel-flow:update",
          content: `你发来了消息,本次运行已转入后台 (${entry.id})。请先回复用户;结算会自动上报。这不是 bash 任务——bash_output/bash_tasks/bash_kill 找不到 ${entry.id};取消用 workflow_cancel。`,
          display: false,
          details: { backgroundId: entry.id, detached: true },
        },
        { triggerTurn: true },
      );
    }
    return { action: "continue" };
  });
}
