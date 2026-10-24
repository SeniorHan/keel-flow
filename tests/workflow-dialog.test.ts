import assert from "node:assert/strict";
import test from "node:test";
import { handleKey, initialDialogState, renderDialogLines, type WorkflowDialogItem } from "../src/workflow-dialog.js";

function item(overrides: Partial<WorkflowDialogItem> = {}): WorkflowDialogItem {
  return { id: "wf-1", name: "demo_workflow", running: true, time: "47s", ...overrides };
}

function settled(overrides: Partial<WorkflowDialogItem> = {}): WorkflowDialogItem {
  return item({ running: false, ok: true, time: "12.3s", ...overrides });
}

test("renderDialogLines: empty list shows the hint line", () => {
  assert.deepEqual(renderDialogLines([], 0), ["没有后台工作流"]);
});

test("renderDialogLines: running rows first, settled rows in reverse with ✓/✗", () => {
  const lines = renderDialogLines(
    [item({ id: "wf-2", name: "audit", time: "8s" }), settled({ id: "wf-1" }), settled({ id: "wf-0", ok: false })],
    0,
  );
  assert.match(lines[0], /^› ⏵ wf-2 \(audit\) · 8s$/);
  assert.match(lines[1], /^ {2}✓ wf-1 \(demo_workflow\) · 12\.3s$/);
  assert.match(lines[2], /^ {2}✗ wf-0 \(demo_workflow\) · 12\.3s$/, "errorCount>0 renders ✗");
});

test("renderDialogLines: only the selected row gets the › marker", () => {
  const lines = renderDialogLines([item({ id: "wf-1" }), item({ id: "wf-2", name: "b" })], 1);
  assert.match(lines[0], /^ {2}⏵/);
  assert.match(lines[1], /^› ⏵/);
});

test("handleKey: selection moves and clamps at both ends", () => {
  const start = initialDialogState(3);
  assert.equal(handleKey(start, "up").selected, 0, "clamped at top");
  assert.equal(handleKey(start, "down").selected, 1);
  const bottom = handleKey(handleKey(start, "down"), "down");
  assert.equal(bottom.selected, 2);
  assert.equal(handleKey(bottom, "down").selected, 2, "clamped at bottom");
});

test("handleKey: Enter opens detail, Esc returns to list, second Esc (or q) closes", () => {
  const start = initialDialogState(2);
  const detail = handleKey(start, "enter");
  assert.equal(detail.mode, "detail");
  assert.equal(detail.selected, 0, "selection survives the round trip");
  // 详情层 up/down/enter 不动状态;Esc 只回列表不退出
  assert.equal(handleKey(detail, "down").mode, "detail");
  assert.equal(handleKey(detail, "enter").mode, "detail");
  const back = handleKey(detail, "escape");
  assert.equal(back.mode, "list");
  assert.equal(handleKey(back, "q").mode, "closed");
  assert.equal(handleKey(initialDialogState(0), "escape").mode, "closed");
});

test("handleKey: q closes from the list; empty list swallows Enter; closed is terminal", () => {
  assert.equal(handleKey(initialDialogState(1), "q").mode, "closed");
  const empty = initialDialogState(0);
  assert.equal(handleKey(empty, "enter").mode, "list", "no rows → Enter does nothing");
  const closed = handleKey(initialDialogState(1), "escape");
  assert.deepEqual(handleKey(closed, "down"), closed, "closed ignores all keys");
});
