import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry, settlementText, type BackgroundSettlement } from "../src/background.js";
import { createWorkflowCancelTool, createWorkflowTool } from "../src/index.js";

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

  pi.registerTool(createWorkflowTool({ registry, onSettle }));
  pi.registerTool(createWorkflowCancelTool(registry));
}
