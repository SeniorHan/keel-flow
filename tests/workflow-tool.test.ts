import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowTool } from "../src/workflow-tool.js";

test("createWorkflowTool describes phases as optional and dynamic", () => {
  const tool = createWorkflowTool();
  const scriptDesc =
    (tool.parameters as unknown as { properties: { script: { description?: string } } }).properties.script
      .description ?? "";

  assert.match(scriptDesc, /export const meta = \{ name, description \}/);
  assert.match(scriptDesc, /meta\.phases is docs only/);
  assert.doesNotMatch(scriptDesc, /phases: \[/);
  assert.ok(tool.promptGuidelines?.some((line) => line.includes("勿预声明投机 phase")));
});
