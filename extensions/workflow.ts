import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@earendil-works/pi-coding-agent";
import {
  BackgroundRegistry,
  type BackgroundSettlement,
  settlementNotifyLine,
  settlementText,
} from "../src/background.js";
import { createWorkflowCancelTool, createWorkflowTool, type WorkflowToolExtras } from "../src/index.js";

export default function workflowExtension(pi: ExtensionAPI): void {
  const registry = new BackgroundRegistry();
  // Set once the workflow tool executes; lets onSettle notify the TUI from the
  // extension scope (settlements fire outside any tool call).
  const uiRef: { current?: Pick<ExtensionContext["ui"], "notify"> } = { current: undefined };

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
  };

  const tool = createWorkflowTool({ registry, onSettle, uiRef });
  pi.registerTool(tool);
  pi.registerTool(createWorkflowCancelTool(registry));
  pi.registerCommand("workflow", {
    description: "列出/取消后台 workflow",
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
      if (args.trim()) {
        ctx.ui.notify("用法:/workflow 列出运行 · /workflow cancel wf-N 请求取消", "warning");
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
