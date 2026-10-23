import assert from "node:assert/strict";
import test from "node:test";
import { startBudgetWatch, sumUsage } from "../src/agent.js";
import { runWorkflow } from "../src/workflow.js";

const SUPERVISION_SCRIPT = (opts: string) => `
export const meta = { name: 'supervision', description: 'supervision probe' }
return await agent('task', ${opts})
`;

function capturingAgent(release?: Promise<void>) {
  const seen: Array<{ timeoutMs?: number; budgetTokens?: number }> = [];
  return {
    seen,
    async run(_prompt: string, opts: { timeoutMs?: number; budgetTokens?: number }) {
      seen.push({ timeoutMs: opts.timeoutMs, budgetTokens: opts.budgetTokens });
      if (release) await release;
      return "ok";
    },
  };
}

test("agent supervision defaults: 0 resolves to 60s report-only and 2M budget", async () => {
  const agent = capturingAgent();
  await runWorkflow(SUPERVISION_SCRIPT("{ timeoutMs: 0, budgetTokens: 0 }"), { agent });
  assert.equal(agent.seen[0].timeoutMs, 60_000);
  assert.equal(agent.seen[0].budgetTokens, 2_000_000);
});

test("agent supervision defaults apply when opts are omitted", async () => {
  const agent = capturingAgent();
  await runWorkflow(SUPERVISION_SCRIPT("{}"), { agent });
  assert.equal(agent.seen[0].timeoutMs, 60_000);
  assert.equal(agent.seen[0].budgetTokens, 2_000_000);
});

test("agent supervision explicit values pass through", async () => {
  const agent = capturingAgent();
  await runWorkflow(SUPERVISION_SCRIPT("{ timeoutMs: 120000, budgetTokens: 5000 }"), { agent });
  assert.equal(agent.seen[0].timeoutMs, 120_000);
  assert.equal(agent.seen[0].budgetTokens, 5000);
});

test("invalid supervision values are rejected", async () => {
  await assert.rejects(
    runWorkflow(SUPERVISION_SCRIPT("{ timeoutMs: -1 }"), { agent: capturingAgent() }),
    /timeoutMs must be an integer between 0 and 3600000/,
  );
  await assert.rejects(
    runWorkflow(SUPERVISION_SCRIPT("{ timeoutMs: 3600001 }"), { agent: capturingAgent() }),
    /between 0 and 3600000/,
  );
  await assert.rejects(
    runWorkflow(SUPERVISION_SCRIPT("{ budgetTokens: 1.5 }"), { agent: capturingAgent() }),
    /non-negative integer/,
  );
});

test("timeout event is report-only: logged while the agent keeps running to completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowAgent = {
    async run(_prompt: string, _opts: unknown) {
      await gate;
      return "slow-ok";
    },
  };
  const workflowPromise = runWorkflow(SUPERVISION_SCRIPT("{ timeoutMs: 50, label: 'slow' }"), {
    agent: slowAgent,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  const result = await workflowPromise;
  assert.equal(result.result, "slow-ok");
  assert.ok(
    result.logs.some((line) => line.includes("timeout event") && line.includes("report-only")),
    `expected a report-only timeout log, got: ${JSON.stringify(result.logs)}`,
  );
});

test("sumUsage totals assistant usage only", () => {
  const totals = sumUsage([
    { role: "user", content: "hi" },
    { role: "assistant", usage: { input: 10, output: 3 } },
    { role: "assistant", usage: { input: 5, output: 2 } },
    { role: "assistant" },
  ]);
  assert.deepEqual(totals, { input: 15, output: 5 });
});

test("startBudgetWatch fires once over budget and stops", async () => {
  let usage = { input: 0, output: 0 };
  const overs: number[] = [];
  const watch = startBudgetWatch(
    () => usage,
    100,
    (spent) => overs.push(spent.input + spent.output),
    10,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(overs.length, 0);
  usage = { input: 150, output: 0 };
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(overs.length, 1);
  watch.stop();
  usage = { input: 999, output: 0 };
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(overs.length, 1);
});
