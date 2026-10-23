import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BackgroundRegistry,
  settlementText,
  type BackgroundSettlement,
} from "./background.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import type { WorkflowAgent } from "./agent.js";
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
  background: Type.Optional(
    Type.Boolean({
      description:
        "true = 分离运行:立即返回 wf-N,完成/失败/取消以事件自动唤醒下回合;长任务用它腾出回合,勿轮询。取消用 workflow_cancel。",
    }),
  ),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
  background?: boolean;
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
  /** 测试注入口:替换 WorkflowAgent。 */
  agent?: Pick<WorkflowAgent, "run">;
  /** background:true 时必传:结算回调(扩展层接 pi.sendMessage 注入唤醒)。 */
  onSettle?: (settlement: BackgroundSettlement) => void;
  /** background:true 时必传:后台注册表(与 workflow_cancel 共享)。 */
  registry?: BackgroundRegistry;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: "运行确定性 JavaScript workflow,编排多个子代理(agent/parallel/pipeline)。同步默认;`background: true` 分离运行(立即返回 wf-N,完成自动唤醒下回合,长任务适用)。脚本规则见 script 参数描述。",
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

      if (params.background === true) {
        if (!options.registry || !options.onSettle) {
          throw new Error("background workflows require a registry and an onSettle callback (extension wiring)");
        }
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        const run = runWorkflow(script, {
          cwd: options.cwd ?? ctx.cwd,
          args: params.args,
          signal: controller.signal,
          concurrency: options.concurrency,
          agent: options.agent,
          session: {
            modelRegistry: ctx.modelRegistry,
            model: ctx.model,
          },
        });
        const entry = options.registry.add(parsed.meta.name, run, controller);
        void run
          .then(
            (result): BackgroundSettlement => ({
              id: entry.id,
              name: parsed.meta.name,
              ok: true,
              cancelled: false,
              durationMs: result.durationMs,
              agentCount: result.agentCount,
              result: result.result,
            }),
            (error: unknown): BackgroundSettlement => ({
              id: entry.id,
              name: parsed.meta.name,
              ok: false,
              cancelled: controller.signal.aborted,
              durationMs: Date.now() - entry.startedAt,
              agentCount: 0,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          .then((settlement) => {
            signal?.removeEventListener("abort", onAbort);
            options.registry?.settle(entry.id);
            options.onSettle?.(settlement);
          });
        return {
          content: [
            {
              type: "text",
              text: `Workflow ${entry.id} (${parsed.meta.name}) started in the background. Its completion is reported automatically and starts your next turn: if nothing else is left to do, end your turn now instead of polling; cancel with workflow_cancel.`,
            },
          ],
          details: {
            ...createWorkflowSnapshot(parsed.meta),
            background: true,
            id: entry.id,
          },
        };
      }

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

export interface WorkflowCancelDetails {
  cancelled: boolean;
  running: string[];
  id?: string;
}

export function createWorkflowCancelTool(registry: BackgroundRegistry): ToolDefinition {
  return defineTool({
    name: "workflow_cancel",
    label: "Workflow Cancel",
    description: "取消后台 workflow(background: true 启动的);同步运行用 Esc;无参列出在跑的后台任务。",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "wf-N;省略=仅列出在跑的后台任务。" })),
    }),
    async execute(_toolCallId, params) {
      const running = registry.list().map((entry) => `${entry.id} (${entry.name})`);
      if (params.id === undefined) {
        return {
          content: [
            {
              type: "text",
              text: running.length
                ? `Running background workflows: ${running.join(", ")}`
                : "No background workflows.",
            },
          ],
          details: { cancelled: false, running, id: undefined } as WorkflowCancelDetails,
        };
      }
      const cancelled = registry.cancel(params.id);
      if (!cancelled) {
        throw new Error(
          running.length
            ? `Unknown workflow id ${params.id}; running: ${running.join(", ")}`
            : `Unknown workflow id ${params.id}; no background workflows are running`,
        );
      }
      return {
        content: [{ type: "text", text: `Workflow ${params.id} cancel requested; its settlement is reported automatically.` }],
        details: { cancelled: true, running: [], id: params.id } as WorkflowCancelDetails,
      };
    },
  });
}
