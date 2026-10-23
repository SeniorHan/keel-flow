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
          ctx.ui.notify(`${cancelMatch[1]} cancel requested; settlement is reported automatically`);
        } else {
          ctx.ui.notify(`Unknown workflow id ${cancelMatch[1]}; no background workflow is running`, "warning");
        }
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("Usage: /workflow (list running) · /workflow cancel wf-N (request cancel)", "warning");
        return;
      }
      const running = registry.list();
      if (running.length === 0) {
        ctx.ui.notify("No background workflows.");
        return;
      }
      const lines = running.map(
        (entry) =>
          `${entry.id} (${entry.name}) · ${Math.max(0, Math.round((Date.now() - entry.startedAt) / 1000))}s elapsed`,
      );
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
          content: `Workflow ${entry.id} (${entry.name}) detached to the background because you sent a message: reply to the user first; settlement is reported automatically. This is NOT a bash task — bash_output/bash_tasks/bash_kill will not find ${entry.id}; cancellation is workflow_cancel.`,
          display: false,
          details: { backgroundId: entry.id, detached: true },
        },
        { triggerTurn: true },
      );
    }
    return { action: "continue" };
  });
}
