import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowSnapshot, recomputeWorkflowSnapshot } from "../src/display.js";
import { exportRunHtml } from "../src/export-html.js";

const NOW = 1_800_000_000_000;

function fixture() {
  const snapshot = createWorkflowSnapshot({ name: "audit-run", description: "测试" });
  snapshot.startedAt = NOW - 90_000;
  snapshot.phases.push("recon", "analyze");
  snapshot.agents = [
    {
      id: 1,
      label: "scan ports",
      phase: "recon",
      prompt: "扫描端口",
      status: "done",
      startedAt: NOW - 90_000,
      endedAt: NOW - 70_000,
      lastEventAt: NOW - 70_000,
    },
    {
      id: 2,
      label: "crash parser",
      phase: "recon",
      prompt: "会崩的解析",
      status: "error",
      error: "TypeError: <script>alert('xss')</script> & quotes",
      startedAt: NOW - 88_000,
      endedAt: NOW - 60_000,
      lastEventAt: NOW - 60_000,
    },
    {
      id: 3,
      label: "deep analyze",
      phase: "analyze",
      prompt: "分析",
      status: "running",
      startedAt: NOW - 20_000,
      lastEventAt: NOW - 5_000,
    },
    {
      id: 4,
      label: "queued tail",
      phase: "analyze",
      prompt: "排队",
      status: "queued",
      queuedAt: NOW - 1_000,
    },
  ];
  return recomputeWorkflowSnapshot({ ...snapshot, durationMs: 90_000 });
}

test("export: self-contained dark html with zh-CN and summary card", () => {
  const html = exportRunHtml(fixture(), { id: "wf-2", now: NOW });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /工作流 wf-2 · audit-run/);
  assert.match(html, /生成于 /);
  assert.match(html, /子代理完成/);
  assert.match(html, /1\/4/);
  assert.match(html, /审计|scan ports/);
});

test("export: gantt bars positioned by percentage of the run span", () => {
  const html = exportRunHtml(fixture(), { id: "wf-2", now: NOW });
  // agent 1: start t0, span 90s → left 0%, width ~22%
  assert.match(html, /style="left:0%;width:/);
  // percentage positions appear for every agent row
  const barCount = (html.match(/class="bar" style="left:/g) ?? []).length;
  assert.equal(barCount, 4);
});

test("export: failed agent error is escaped, no raw script tag", () => {
  const html = exportRunHtml(fixture(), { id: "wf-2", now: NOW });
  assert.match(html, /错误详情/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
});

test("export: no external resources whatsoever", () => {
  const html = exportRunHtml(fixture(), { id: "wf-2", now: NOW });
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<link|<script src|@import/);
});

test("export: structure tree and result included when present", () => {
  const snapshot = fixture();
  snapshot.nodes = [
    { id: "n1", kind: "parallel", label: "并行审计", parentId: undefined, thunkCount: 2 },
    { id: "n2", kind: "pipeline", label: "ingest", parentId: undefined, itemCount: 3 },
  ];
  snapshot.result = { verdict: "ok", score: 9 };
  const html = exportRunHtml(snapshot, { id: "wf-9", now: NOW });
  assert.match(html, /执行结构/);
  assert.match(html, /并行审计/);
  assert.match(html, /ingest/);
  assert.match(html, /运行结果/);
  assert.match(html, /verdict/);
});
