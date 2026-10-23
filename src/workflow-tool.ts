import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunResult } from "./workflow.js";

const workflowToolSchema = Type.Object({
  script: Type.String({
    description: [
      "Raw JavaScript only, no Markdown fences.",
      "First statement must be `export const meta = { name, description }` (non-empty); meta.phases is docs only; progress groups come from phase(title) calls.",
      "Globals: phase, agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), log, args, cwd, process.cwd(), budget — call agent() at least once, never phases-only.",
      "parallel takes thunks not promises: `parallel(items.map(item => () => agent(...)))`; results in input order.",
      "Per-agent supervision: opts.timeoutMs (0 = 60s report-only default; logs an event, never stops the agent) and opts.budgetTokens (0 = 2,000,000 default; over → agent aborted, call returns null).",
      "Machine-readable output: opts.schema takes a JSON Schema (not TS/TypeBox); agent() returns the validated object.",
    ].join(" "),
  }),
  args: Type.Optional(Type.Any({ description: "可选 JSON 值,作为脚本全局 `args`。" })),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
};

const workflowDisplayOptions = {
  key: "workflow",
  streamToolUpdates: true,
  maxAgents: 4,
  maxLogs: 1,
  showResultPreviews: false,
} as const;

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: "运行确定性 JavaScript workflow,编排多个子代理(agent/parallel/pipeline);脚本规则见 script 参数描述。",
    promptSnippet: "运行确定性 JS workflow(多子代理编排);规则见 script 参数描述。",
    promptGuidelines: [
      "仅当用户明确要求 workflow/编排/fan-out/多代理时用;单一快速读写或普通工具够用则不用。步骤确定带门禁的执行计划最合适;探索式需转向的委派用交互式子代理工具。",
      "meta 后纯 JS:禁 TS 语法、import、require()、fs、Date.now()、Math.random()。",
      "新工作组分界处 phase(title);名可条件/循环生成,勿预声明投机 phase。",
      "适用:可分解工作——盘点、独立检查、多视角评审、扇出合流。",
      "pipeline 各 item 顺序过站、item 间并发;stage 收 (previousValue, originalItem, index)。",
      "agent() 带唯一短 label(2-5 词),状态报错可读。",
      "失败返 null 并记日志(中止除外),合成前查 null;多结果合并加最终 synthesis agent,返紧凑 JSON(ok/verdict+关键输出)。",
      "子代理不继承父上下文:prompt 自包含,写清背景与路径。",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, workflowDisplayOptions);

      const update = () => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.update(snapshot);
      };

      const recordPhase = (title: string | undefined) => {
        if (!title) return;
        if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
      };

      let result: WorkflowRunResult;
      try {
        result = await runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          signal,
          concurrency: options.concurrency,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
          onLog(message) {
            snapshot.logs.push(message);
            update();
          },
          onPhase(title) {
            snapshot.currentPhase = title;
            recordPhase(title);
            update();
          },
          onAgentStart(event) {
            if (signal?.aborted) throw new Error("Workflow was aborted");
            recordPhase(event.phase);
            snapshot.agents.push({
              id: snapshot.agents.length + 1,
              label: event.label,
              phase: event.phase,
              prompt: event.prompt,
              status: "running",
            });
            update();
          },
          onAgentEnd(event) {
            const agent = [...snapshot.agents]
              .reverse()
              .find((item) => item.label === event.label && item.status === "running");
            if (agent) {
              agent.status = event.result === null ? "error" : "done";
              agent.resultPreview = preview(event.result);
            }
            update();
          },
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      return {
        content: [
          {
            type: "text",
            text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(result.result, null, 2)}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial, workflowDisplayOptions), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
