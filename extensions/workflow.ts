import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry, type BackgroundSettlement, settlementText } from "../src/background.js";
import { createWorkflowCancelTool, createWorkflowTool, type WorkflowToolExtras } from "../src/index.js";

export default function workflowExtension(pi: ExtensionAPI): void {
  const registry = new BackgroundRegistry();

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
  };

  const tool = createWorkflowTool({ registry, onSettle });
  pi.registerTool(tool);
  pi.registerTool(createWorkflowCancelTool(registry));
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
