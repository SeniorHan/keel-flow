import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundRegistry } from "../src/background.js";
import {
  createWorkflowCancelTool,
  createWorkflowTool,
  type SyncRunHandle,
  type WorkflowToolExtras,
} from "../src/workflow-tool.js";

const BG_SCRIPT = `
export const meta = { name: 'bg_probe', description: 'background probe' }
return { r: await agent('task') }
`;

const TOOL_CTX = { cwd: "/tmp/keel-flow-test", modelRegistry: undefined, model: undefined } as never;

function blockingAgent() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    async run() {
      await gate;
      return "ok";
    },
  };
}

async function runTool(
  tool: {
    execute: (
      ...a: unknown[]
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
  },
  params: object,
) {
  return tool.execute("call-1", params, undefined, undefined, TOOL_CTX) as ReturnType<typeof tool.execute>;
}

test("background: true returns immediately with a wf id; completion delivers settlement", async () => {
  const registry = new BackgroundRegistry();
  const settlements: Array<{ id: string; ok: boolean; cancelled: boolean; result?: unknown }> = [];
  const tool = createWorkflowTool({
    agent: { run: async () => "ok" },
    registry,
    onSettle: (n) => settlements.push(n),
  });

  const started = await runTool(tool, { script: BG_SCRIPT, background: true });
  const text = started.content[0]?.text ?? "";
  assert.match(text, /started in the background/);
  assert.match(text, /NOT a bash task/);
  const id = (started.details as { id?: string }).id ?? "";
  assert.match(id, /^wf-\d+$/);
  assert.equal(registry.list().length, 1);

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].id, id);
  assert.equal(settlements[0].ok, true);
  assert.deepEqual((settlements[0].result as { r: string }).r, "ok");
  assert.equal(registry.list().length, 0, "settled entries leave the registry");
});

test("cancel aborts a running background workflow and settles as cancelled", async () => {
  const registry = new BackgroundRegistry();
  const settlements: Array<{ id: string; ok: boolean; cancelled: boolean }> = [];
  const agent = blockingAgent();
  const tool = createWorkflowTool({ agent, registry, onSettle: (n) => settlements.push(n) });

  const started = await runTool(tool, { script: BG_SCRIPT, background: true });
  const id = (started.details as { id?: string }).id ?? "";

  assert.equal(registry.cancel(id), true);
  agent.release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].cancelled, true);
  assert.equal(registry.list().length, 0);
});

test("workflow_cancel tool: lists, cancels, rejects unknown ids", async () => {
  const registry = new BackgroundRegistry();
  const cancelTool = createWorkflowCancelTool(registry);

  const empty = await runTool(cancelTool, {});
  assert.match(empty.content[0]?.text ?? "", /No background workflows/);

  const agent = blockingAgent();
  const workflowTool = createWorkflowTool({ agent, registry, onSettle: () => {} });
  const started = await runTool(workflowTool, { script: BG_SCRIPT, background: true });
  const id = (started.details as { id?: string }).id ?? "";

  const listed = await runTool(cancelTool, {});
  assert.match(listed.content[0]?.text ?? "", new RegExp(id));

  const cancelled = await runTool(cancelTool, { id });
  assert.match(cancelled.content[0]?.text ?? "", /cancel requested/);

  agent.release();
  await assert.rejects(runTool(cancelTool, { id: "wf-999" }), /Unknown workflow id/);
});

test("detach detaches an in-flight sync run: tool resolves detached, settlement still arrives", async () => {
  const registry = new BackgroundRegistry();
  const settlements: Array<{ id: string; ok: boolean; cancelled: boolean; result?: unknown }> = [];
  const agent = blockingAgent();
  const tool = createWorkflowTool({ agent, registry, onSettle: (n) => settlements.push(n) });

  const pending = runTool(tool, { script: BG_SCRIPT });
  const handle = (tool as WorkflowToolExtras).syncRuns.values().next().value as SyncRunHandle | undefined;
  assert.ok(handle, "an in-flight sync run is registered while the tool call is pending");
  const entry = handle.detach();
  assert.ok(entry);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]?.id, entry.id);

  const result = await pending;
  const text = result.content[0]?.text ?? "";
  assert.match(text, /detached to the background because you sent a message/);
  assert.match(text, /NOT a bash task/);
  assert.match(text, /cancellation is workflow_cancel/);
  assert.equal((result.details as { id?: string }).id, entry.id);

  agent.release();
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(settlements.length, 1, "settlement is delivered after the detached run settles");
  assert.equal(settlements[0].id, entry.id);
  assert.equal(settlements[0].ok, true);
  assert.equal(settlements[0].cancelled, false);
  assert.deepEqual((settlements[0].result as { r: string }).r, "ok");
  assert.equal(registry.list().length, 0, "settled entry leaves the registry");
  assert.equal((tool as WorkflowToolExtras).syncRuns.size, 0);
});

test("detach with no in-flight sync run is a no-op", async () => {
  const registry = new BackgroundRegistry();
  const settlements: Array<{ id: string }> = [];
  const tool = createWorkflowTool({ agent: { run: async () => "ok" }, registry, onSettle: (n) => settlements.push(n) });

  assert.equal((tool as WorkflowToolExtras).syncRuns.size, 0);
  for (const handle of [...(tool as WorkflowToolExtras).syncRuns]) handle.detach();
  assert.equal(registry.list().length, 0);

  const result = await runTool(tool, { script: BG_SCRIPT });
  assert.match(result.content[0]?.text ?? "", /completed with 1 agent/);
  assert.equal((tool as WorkflowToolExtras).syncRuns.size, 0, "completed sync runs leave no stale handle");
  for (const handle of [...(tool as WorkflowToolExtras).syncRuns]) handle.detach();
  await new Promise((r) => setImmediate(r));
  assert.equal(registry.list().length, 0);
  assert.deepEqual(settlements, [], "no-op detach never fabricates a settlement");
});

test("workflow tool description advertises background and sync default", () => {
  const tool = createWorkflowTool();
  assert.match(tool.description, /background: true/);
  assert.match(tool.description, /同步默认/);
  const backgroundDesc = (tool.parameters as unknown as { properties: { background: { description?: string } } })
    .properties.background.description;
  assert.match(backgroundDesc ?? "", /wf-N/);
});
