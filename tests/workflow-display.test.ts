import assert from "node:assert/strict";
import test from "node:test";
import {
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderStatusLine,
  renderWorkflowLines,
  renderWorkflowText,
  type StatusPeer,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "../src/display.js";

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
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

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: "scan repo",
    phase: "Scan",
    prompt: "Scan the repo",
    status: "done",
    ...overrides,
  };
}

test("createWorkflowSnapshot does not pre-render declared phases", () => {
  const value = createWorkflowSnapshot({
    name: "demo_workflow",
    description: "A useful workflow",
    phases: [{ title: "Scan" }, { title: "Review" }],
  });

  assert.deepEqual(value.phases, []);
});

test("renderWorkflowLines hides empty phase rows", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan", "Review"],
      agents: [agent()],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Scan 1/1")));
  assert.ok(!lines.some((line) => line.includes("Review 0/0")));
});

test("renderWorkflowLines keeps the current empty phase visible", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      currentPhase: "Scan",
    }),
  );

  assert.ok(lines.some((line) => line.includes("▶ Scan 0/0")));
});

test("renderWorkflowLines groups agents by phase even when the phase was not pre-recorded", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      agents: [agent({ id: 2, label: "review diff", phase: "Review" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Review 1/1")));
  assert.ok(!lines.some((line) => line.trim() === "Unphased"));
});

test("renderWorkflowLines renders runtime-created phases from the phase list", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Inspect API"],
      agents: [agent({ label: "inspect api", phase: "Inspect API" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Inspect API 1/1")));
});

test("renderWorkflowText respects log limits", () => {
  const text = renderWorkflowText(
    snapshot({
      logs: ["first", "second", "third"],
    }),
    true,
    { maxLogs: 1 },
  );

  assert.doesNotMatch(text, /日志: first/);
  assert.doesNotMatch(text, /日志: second/);
  assert.match(text, /日志: third/);
});

test("renderWorkflowLines separates logs from progress", () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent()],
      logs: ["finished scan"],
    }),
  );

  const logIndex = lines.findIndex((line) => line.includes("日志: finished scan"));
  assert.ok(logIndex > 0);
  assert.equal(lines[logIndex - 1], "");
});

function widgetCtx() {
  const calls: { status?: string | undefined; widget?: string[] | undefined } = {};
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => {
        calls.status = text;
      },
      setWidget: (_key: string, content: string[] | undefined) => {
        calls.widget = content;
      },
    },
  };
  return { calls, ctx: ctx as unknown as Parameters<typeof createWidgetWorkflowDisplay>[0] };
}

test("renderWorkflowLines appends elapsed to the header only while running", () => {
  const running = renderWorkflowLines(snapshot({ startedAt: Date.now() - 5200 }));
  assert.match(running[0], / · 5s$/);

  const finished = renderWorkflowLines(snapshot({ startedAt: Date.now() - 5200, durationMs: 5200 }));
  assert.doesNotMatch(finished[0], / · \d+s/);

  const neverStarted = renderWorkflowLines(snapshot());
  assert.doesNotMatch(neverStarted[0], / · \d+s/);
});

test("widget display shows the completed status line and honors showWidget:false", () => {
  const { calls, ctx } = widgetCtx();
  const done = snapshot({ agents: [agent()] });

  const display = createWidgetWorkflowDisplay(ctx, { key: "wf", showStatus: true, showWidget: false });
  display.complete(done);
  assert.equal(calls.status, "workflow ✓ demo_workflow 1/1");
  assert.equal(calls.widget, undefined, "showWidget:false skips setWidget");
});

test("widget display default shows the widget with the running status line", () => {
  const { calls, ctx } = widgetCtx();
  const display = createWidgetWorkflowDisplay(ctx, { key: "wf", showStatus: true });
  display.update(snapshot({ agents: [agent({ status: "running" })], startedAt: Date.now() - 5200 }));
  assert.match(calls.status ?? "", /workflow demo_workflow ● 1 运行中, 0\/1 完成 · 5s/);
  assert.ok(calls.widget?.[0].includes(" · 5s"));
});

test("renderWorkflowText renders Chinese headers and honors the detached override", () => {
  const running = renderWorkflowText(snapshot({ agents: [agent({ status: "running" })] }));
  assert.ok(running.startsWith("工作流运行中\n◆ 工作流: demo_workflow (0/1 完成, 1 运行中)"));

  const done = renderWorkflowText(snapshot({ agents: [agent()] }), true);
  assert.ok(done.startsWith("工作流已完成\n"));

  const detached = renderWorkflowText(snapshot({ agents: [agent({ status: "running" })] }), false, {
    header: "工作流已转后台 (wf-2)",
  });
  assert.ok(detached.startsWith("工作流已转后台 (wf-2)\n"));
});

test("renderStatusLine covers foreground, background, terminal and aggregate forms", () => {
  const running = snapshot({ agents: [agent({ status: "running" })], startedAt: Date.now() - 18_000 });
  assert.match(renderStatusLine(running, false), /^workflow demo_workflow ● 1 运行中, 0\/1 完成 · 18s$/);

  const background = snapshot({ agents: [agent({ status: "running" })], startedAt: Date.now() - 47_000 });
  assert.match(
    renderStatusLine(background, false, { backgroundId: "wf-2" }),
    /^workflow demo_workflow ⏵ wf-2 · 0\/1 完成 · 47s$/,
  );

  const done = snapshot({ agents: [agent()], durationMs: 76_400 });
  assert.equal(renderStatusLine(done, true), "workflow ✓ demo_workflow 1/1 · 76s");

  const failed = snapshot({ agents: [agent(), agent({ id: 2, status: "error", label: "boom" })] });
  assert.equal(renderStatusLine(failed, true), "workflow ✗ demo_workflow 1/2 · 1 错误");
});

test("renderStatusLine aggregates multiple background runs and folds beyond two", () => {
  const peers: StatusPeer[] = [
    { id: "wf-2", state: "running" },
    { id: "wf-1", state: "done" },
  ];
  const line = renderStatusLine(snapshot(), false, { backgroundId: "wf-2", peers });
  assert.equal(line, "workflow: 1 运行中 · wf-2 ⏵ · wf-1 ✓");

  const three: StatusPeer[] = [...peers, { id: "wf-0", state: "failed" }];
  assert.equal(
    renderStatusLine(snapshot(), false, { backgroundId: "wf-2", peers: three }),
    "workflow: 1 运行中 · wf-2 ⏵ · wf-1 ✓ · …+1",
  );
});
