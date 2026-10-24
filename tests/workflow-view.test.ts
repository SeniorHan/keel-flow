import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptRing } from "../src/agent.js";
import {
  hasHungAgents,
  renderStructureTree,
  renderWorkflowView,
  recomputeWorkflowSnapshot,
  silenceSuffix,
  type StructureNode,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "../src/display.js";
import { runWorkflow } from "../src/workflow.js";

const NOW = 1_000_000_000_000;

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: "scan repo",
    phase: "Scan",
    prompt: "Scan the repo",
    status: "running",
    startedAt: NOW - 10_000,
    lastEventAt: NOW - 1000,
    ...overrides,
  };
}

function viewSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: "demo_workflow",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides,
  });
}

function parallelNode(overrides: Partial<StructureNode> = {}): StructureNode {
  return { id: 1, kind: "parallel", thunkCount: 4, ...overrides };
}

test("TranscriptRing keeps the newest 200 events", () => {
  const ring = new TranscriptRing(200);
  for (let i = 0; i < 250; i++) ring.push({ at: i, kind: "text", text: `e${i}` });
  assert.equal(ring.size, 200);
  const recent = ring.recent();
  assert.equal(recent[0].text, "e50", "oldest events beyond the cap are dropped");
  assert.equal(recent.at(-1)?.text, "e249");
});

test("renderStructureTree shows parallel thunk counts with running and queued splits", () => {
  const lines = renderStructureTree(
    [parallelNode()],
    undefined,
    2,
    [
      agent({ id: 1, parentId: 1, status: "running" }),
      agent({ id: 2, parentId: 1, status: "running", label: "audit deps" }),
    ],
    NOW,
  );
  const header = lines.find((line) => line.includes("parallel#1"));
  assert.ok(header, "parallel node line rendered");
  assert.match(header!, /4 thunk/);
  assert.match(header!, /运行 2/);
  assert.match(header!, /排队 2/, "unstarted thunks surface as queued");
  assert.ok(lines.some((line) => line.includes("#1 ● scan repo")));
});

test("renderStructureTree shows pipeline items with stage progress", () => {
  const node: StructureNode = { id: 3, kind: "pipeline", label: "评审 3×2", itemCount: 3, stageCount: 2 };
  const lines = renderStructureTree(
    [node],
    [
      { node: 3, itemIndex: 0, stageIndex: 2, stageCount: 2, status: "done" },
      { node: 3, itemIndex: 1, stageIndex: 1, stageCount: 2, status: "running" },
    ],
    0,
    [],
    NOW,
  );
  const header = lines.find((line) => line.includes("管线 评审 3×2"));
  assert.ok(header, "pipeline node line rendered");
  assert.match(header!, /1\/3 完成/);
  assert.ok(lines.some((line) => line.includes("✓ item 0 阶段 2/2")));
  assert.ok(lines.some((line) => line.includes("● item 1 阶段 1/2")));
});

test("renderWorkflowView falls back to phase grouping when there are no structure nodes", () => {
  const lines = renderWorkflowView(
    viewSnapshot({ phases: ["Scan"], agents: [agent({ id: 1 })] }),
    { now: NOW },
  );
  assert.ok(lines.some((line) => line.includes("Scan 1/1") || line.includes("▶ Scan 0/1")), lines.join("\n"));
});

test("挂死预警: running agent silent >30s gets ⚠ 静默 and the header flags 疑似挂死; recovery clears it", () => {
  const hung = agent({ id: 1, lastEventAt: NOW - 45_000 });
  assert.match(silenceSuffix(hung, NOW), /⚠ 静默 45s/);
  const fresh = agent({ id: 2, label: "fresh", lastEventAt: NOW - 5000 });
  assert.equal(silenceSuffix(fresh, NOW), "");
  assert.equal(silenceSuffix({ ...hung, status: "done" }, NOW), "", "finished agents are never flagged");

  const snapshot = viewSnapshot({ agents: [hung] });
  assert.equal(hasHungAgents(snapshot, NOW), true);
  const view = renderWorkflowView(snapshot, { now: NOW });
  assert.match(view[0], /疑似挂死/);
  assert.ok(view.some((line) => line.includes("⚠ 静默 45s")));

  // 恢复活动自动消除
  const recovered = viewSnapshot({ agents: [{ ...hung, lastEventAt: NOW - 2000 }] });
  const after = renderWorkflowView(recovered, { now: NOW });
  assert.equal(hasHungAgents(recovered, NOW), false);
  assert.doesNotMatch(after[0], /疑似挂死/);
  assert.ok(!after.some((line) => line.includes("⚠ 静默")));
});

test("runWorkflow emits structure updates: parallel node, pipeline items, queued depth", async () => {
  const structures: Array<{ nodes: unknown[]; pipelineItems: unknown[]; queuedCount: number }> = [];
  const started: Array<{ label: string; parentId?: number }> = [];
  let sequential = 0;
  await runWorkflow(
    `
export const meta = { name: 'structure_probe', description: 'probe' }
phase('扫描')
const [a, b] = await parallel([
  () => agent('a', { label: 'left' }),
  () => agent('b', { label: 'right' }),
])
await pipeline([1, 2], (item) => agent('stage1 ' + item, { label: 'p' + item }), (prev) => prev)
return { a, b }
`,
    {
      cwd: "/tmp/keel-flow-test",
      agent: {
        run: async (prompt: string) => {
          sequential++;
          if (prompt.startsWith("stage1")) await new Promise((r) => setTimeout(r, 5));
          return `ok:${prompt}`;
        },
      },
      concurrency: 1,
      onStructure: (s) => structures.push(JSON.parse(JSON.stringify(s))),
      onAgentStart: (e) => started.push({ label: e.label, parentId: e.parentId }),
    },
  );

  const parallelNodes = structures.flatMap((s) => s.nodes).filter((n: any) => n.kind === "parallel");
  assert.ok(parallelNodes.length >= 1, "parallel scope recorded");
  assert.equal((parallelNodes[0] as any).thunkCount, 2);
  const pipelineNodes = structures.flatMap((s) => s.nodes).filter((n: any) => n.kind === "pipeline");
  assert.ok(pipelineNodes.length >= 1, "pipeline scope recorded");
  assert.equal((pipelineNodes[0] as any).stageCount, 2);
  const withItems = structures.filter((s) => s.pipelineItems.length > 0);
  assert.ok(withItems.length > 0, "pipeline item transitions recorded");
  assert.deepEqual(
    withItems.at(-1)!.pipelineItems.map((i: any) => i.status),
    ["done", "done"],
  );
  assert.ok(structures.some((s) => s.queuedCount > 0), "concurrency 1 forces limiter queueing");
  const left = started.find((s) => s.label === "left");
  assert.ok(left?.parentId, "agents record the parallel node as parent");
});

test("runWorkflow feeds agent events through onAgentEvent (lastEventAt source)", async () => {
  const events: Array<{ label: string; kind: string }> = [];
  await runWorkflow(
    `
export const meta = { name: 'event_probe', description: 'probe' }
await agent('hello', { label: 'chatty' })
return 1
`,
    {
      cwd: "/tmp/keel-flow-test",
      agent: {
        run: async (_prompt: string, options?: { onEvent?: (e: { at: number; kind: string; text: string }) => void }) => {
          options?.onEvent?.({ at: Date.now(), kind: "tool", text: "read" });
          options?.onEvent?.({ at: Date.now(), kind: "text", text: "thinking" });
          return "ok";
        },
      },
      onAgentEvent: (e) => events.push({ label: e.label, kind: e.kind }),
    },
  );
  assert.deepEqual(events, [
    { label: "chatty", kind: "tool" },
    { label: "chatty", kind: "text" },
  ]);
});
