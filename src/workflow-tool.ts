import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { WorkflowAgent } from "./agent.js";
import type { BackgroundRegistry, BackgroundSettlement, BackgroundWorkflow } from "./background.js";
import {
  createToolUpdateWorkflowDisplay,
  createWidgetWorkflowDisplay,
  createWorkflowSnapshot,
  preview,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type StatusPeer,
  type StatusPeerState,
  type WorkflowDisplay,
  type WorkflowDisplayOptions,
  type WorkflowSnapshot,
} from "./display.js";
import { parseWorkflowScript, runWorkflow, type WorkflowRunOptions, type WorkflowRunResult } from "./workflow.js";
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
  showStatus: true,
  showWidget: false,
} as const;

/** Detached/background-start transcript blocks freeze the tree under a dedicated header. */
function freezeSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  return {
    ...snapshot,
    phases: [...snapshot.phases],
    logs: [...snapshot.logs],
    agents: snapshot.agents.map((agent) => ({ ...agent })),
  };
}

/** One in-flight synchronous run that can still be adopted into the background registry. */
export interface SyncRunHandle {
  /** Adopt the run: register it in the registry and resolve the tool call with the detached text. Idempotent once detached/completed. */
  detach(): BackgroundWorkflow | undefined;
}

/** Extra surface on the workflow tool for tap-to-background wiring. */
export interface WorkflowToolExtras {
  /** In-flight synchronous runs, present only between tool start and settle/detach. */
  syncRuns: Set<SyncRunHandle>;
}

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** 测试注入口:替换 WorkflowAgent。 */
  agent?: Pick<WorkflowAgent, "run">;
  /** background:true 时必传:结算回调(扩展层接 pi.sendMessage 注入唤醒)。 */
  onSettle?: (settlement: BackgroundSettlement) => void;
  /** background:true 时必传:后台注册表(与 workflow_cancel 共享)。 */
  registry?: BackgroundRegistry;
  /** 扩展层传入的 ui 引用:execute 时写入 ctx.ui,结算由扩展层 notify TUI。 */
  uiRef?: { current?: Pick<ExtensionContext["ui"], "notify"> };
}

export function createWorkflowTool(
  options: WorkflowToolOptions = {},
): ToolDefinition<typeof workflowToolSchema, any> & WorkflowToolExtras {
  const syncRuns = new Set<SyncRunHandle>();
  // Recently settled background runs keep their terminal state visible in the multi-workflow
  // aggregate status line (the registry drops entries on settle). Capped; ids sorted numerically.
  const settledPeers = new Map<string, StatusPeerState>();
  const onSettle: ((settlement: BackgroundSettlement) => void) | undefined = options.onSettle
    ? (settlement) => {
        settledPeers.set(settlement.id, settlement.cancelled ? "cancelled" : settlement.ok ? "done" : "failed");
        if (settledPeers.size > 8) {
          const oldest = settledPeers.keys().next().value;
          if (oldest !== undefined) settledPeers.delete(oldest);
        }
        options.onSettle?.(settlement);
      }
    : undefined;
  const tool = defineTool({
    name: "workflow",
    label: "Workflow",
    description:
      "运行确定性 JavaScript workflow,编排多个子代理(agent/parallel/pipeline)。同步默认;`background: true` 分离运行(立即返回 wf-N,完成自动唤醒下回合,长任务适用)。脚本规则见 script 参数描述。",
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
      snapshot.startedAt = Date.now();
      if (options.uiRef) options.uiRef.current = ctx.ui;
      const display = createToolUpdateWorkflowDisplay(onUpdate, ctx, {
        ...workflowDisplayOptions,
        statusOptions: () => ({ backgroundId: statusInfo.backgroundId, peers: collectPeers() }),
      });
      // Widgets shown only while a run is in the background (detach / background: true).
      const extraDisplays: WorkflowDisplay[] = [];
      const statusInfo: { backgroundId?: string } = {};
      const collectPeers = (): StatusPeer[] | undefined => {
        if (!options.registry || !statusInfo.backgroundId) return undefined;
        const peers: StatusPeer[] = options.registry
          .list()
          .map((entry): StatusPeer => ({ id: entry.id, state: "running" }));
        for (const [id, state] of settledPeers) {
          if (!peers.some((peer) => peer.id === id)) peers.push({ id, state });
        }
        return peers.sort((a, b) => peerNumber(b.id) - peerNumber(a.id));
      };
      const attachBackgroundWidget = (): void => {
        if (!ctx.hasUI) return;
        const widget = createWidgetWorkflowDisplay(ctx, {
          key: workflowDisplayOptions.key,
          placement: "belowEditor",
          maxAgents: workflowDisplayOptions.maxAgents,
          maxLogs: workflowDisplayOptions.maxLogs,
          showStatus: false,
          showWidget: true,
        });
        extraDisplays.push(widget);
        widget.update(snapshot);
      };
      const finishAdopted = (): void => {
        snapshot = recomputeWorkflowSnapshot(snapshot);
        display.complete(snapshot);
        for (const widget of extraDisplays) widget.complete(snapshot);
        for (const widget of extraDisplays) widget.clear();
        extraDisplays.length = 0;
      };

      // In-place recompute: keep the snapshot object identity stable so the shared
      // makeCallbacks closures stay live after a detach hands the run to the background.
      const update = () => {
        Object.assign(snapshot, recomputeWorkflowSnapshot(snapshot));
        display.update(snapshot);
        for (const widget of extraDisplays) widget.update(snapshot);
      };

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
          ...makeCallbacks(snapshot, update),
        });
        const entry = adoptRun(
          options.registry,
          onSettle,
          parsed.meta.name,
          run,
          controller,
          () => signal?.removeEventListener("abort", onAbort),
          finishAdopted,
          () => `${snapshot.doneCount}/${snapshot.agentCount}`,
          () => snapshot,
        );
        statusInfo.backgroundId = entry.id;
        attachBackgroundWidget();
        return {
          content: [
            {
              type: "text",
              text: `工作流 ${entry.id} (${parsed.meta.name}) 已后台启动。结算会自动上报并开启你的下一回合:没有别的事就结束回合,勿轮询;/workflow 列出运行,workflow_cancel 取消。`,
            },
          ],
          details: {
            ...freezeSnapshot(snapshot),
            background: true,
            id: entry.id,
          },
        };
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      let resolveDetached!: (entry: BackgroundWorkflow) => void;
      const detached = new Promise<BackgroundWorkflow>((resolve) => {
        resolveDetached = resolve;
      });
      const work = runWorkflow(script, {
        cwd: options.cwd ?? ctx.cwd,
        args: params.args,
        signal: controller.signal,
        concurrency: options.concurrency,
        agent: options.agent,
        session: {
          modelRegistry: ctx.modelRegistry,
          model: ctx.model,
        },
        ...makeCallbacks(snapshot, update, () => {
          if (signal?.aborted) throw new Error("Workflow was aborted");
        }),
      });
      // If the run detaches, nobody awaits `work` anymore; keep a late rejection from
      // surfacing as an unhandled rejection (the race has a handler only until detach).
      void work.catch(() => {});
      const handle: SyncRunHandle = {
        detach() {
          if (!syncRuns.delete(handle)) return undefined;
          if (!options.registry) return undefined;
          const entry = adoptRun(
            options.registry,
            onSettle,
            parsed.meta.name,
            work,
            controller,
            () => signal?.removeEventListener("abort", onAbort),
            finishAdopted,
            () => `${snapshot.doneCount}/${snapshot.agentCount}`,
            () => snapshot,
          );
          statusInfo.backgroundId = entry.id;
          attachBackgroundWidget();
          resolveDetached(entry);
          return entry;
        },
      };
      syncRuns.add(handle);
      let result: WorkflowRunResult;
      try {
        const raced = await Promise.race([work, detached]);
        syncRuns.delete(handle);
        if ("controller" in raced) {
          const entry = raced;
          return {
            content: [
              {
                type: "text",
                text: `你发来了消息,本次运行已转入后台 (${entry.id})。请先回复用户;结算会自动上报。这不是 bash 任务——bash_output/bash_tasks/bash_kill 找不到 ${entry.id};取消用 workflow_cancel。`,
              },
            ],
            details: {
              ...freezeSnapshot(snapshot),
              background: true,
              id: entry.id,
              detached: true,
            },
          };
        }
        result = raced;
        signal?.removeEventListener("abort", onAbort);
      } catch (error) {
        syncRuns.delete(handle);
        signal?.removeEventListener("abort", onAbort);
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
      const snapshot = result.details as
        | (WorkflowSnapshot & { background?: boolean; id?: string; detached?: boolean })
        | undefined;
      if (snapshot?.name) {
        let options: WorkflowDisplayOptions = workflowDisplayOptions;
        if (!isPartial && snapshot.background && snapshot.id) {
          options = {
            ...options,
            header: snapshot.detached ? `工作流已转后台 (${snapshot.id})` : `工作流已后台启动 (${snapshot.id})`,
          };
        }
        return new Text(renderWorkflowText(snapshot, !isPartial, options), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  }) as ToolDefinition<typeof workflowToolSchema, any> & WorkflowToolExtras;
  tool.syncRuns = syncRuns;
  return tool;
}

/** Snapshot-mutating progress callbacks shared by the sync and background run paths. */
function makeCallbacks(
  snapshot: WorkflowSnapshot,
  update: () => void,
  beforeAgentStart?: () => void,
): Pick<
  WorkflowRunOptions,
  "onLog" | "onPhase" | "onAgentStart" | "onAgentEnd" | "onAgentEvent" | "onPipelineItem" | "onStructure"
> {
  const recordPhase = (title: string | undefined) => {
    if (!title) return;
    if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
  };
  return {
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
      beforeAgentStart?.();
      recordPhase(event.phase);
      snapshot.agents.push({
        id: snapshot.agents.length + 1,
        label: event.label,
        phase: event.phase,
        prompt: event.prompt,
        status: "running",
        parentId: event.parentId,
        queuedAt: event.queuedAt,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        transcriptTail: [],
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
        agent.endedAt = Date.now();
        agent.lastEventAt = agent.endedAt;
      }
      update();
    },
    onAgentEvent(event) {
      const agent = [...snapshot.agents].reverse().find((item) => item.label === event.label);
      if (!agent) return;
      agent.lastEventAt = event.at;
      const tail = agent.transcriptTail ?? (agent.transcriptTail = []);
      const prefix = event.kind === "tool" ? "⚙" : event.kind === "error" ? "✗" : "·";
      tail.push(`${prefix} ${event.text}`);
      if (tail.length > 5) tail.splice(0, tail.length - 5);
      update();
    },
    onStructure(structure) {
      snapshot.nodes = structure.nodes;
      snapshot.pipelineItems = structure.pipelineItems;
      snapshot.queuedCount = structure.queuedCount;
      update();
    },
  };
}

function peerNumber(id: string): number {
  return Number.parseInt(id.replace("wf-", ""), 10) || 0;
}

/** Shared adoption path: register a live run in the registry and deliver its settlement via onSettle. */
function adoptRun(
  registry: BackgroundRegistry,
  onSettle: ((settlement: BackgroundSettlement) => void) | undefined,
  name: string,
  run: Promise<WorkflowRunResult>,
  controller: AbortController,
  cleanup?: () => void,
  onDone?: () => void,
  progress?: () => string,
  getSnapshot?: () => WorkflowSnapshot,
): BackgroundWorkflow {
  const entry = registry.add(name, run, controller);
  if (progress) entry.progress = progress;
  if (getSnapshot) entry.getSnapshot = getSnapshot;
  void run
    .then(
      (result): BackgroundSettlement => ({
        id: entry.id,
        name,
        ok: true,
        cancelled: false,
        durationMs: result.durationMs,
        agentCount: result.agentCount,
        result: result.result,
      }),
      (error: unknown): BackgroundSettlement => ({
        id: entry.id,
        name,
        ok: false,
        cancelled: controller.signal.aborted,
        durationMs: Date.now() - entry.startedAt,
        agentCount: 0,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((settlement) => {
      cleanup?.();
      onDone?.();
      registry.settle(entry.id);
      onSettle?.(settlement);
    });
  return entry;
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
          content: [{ type: "text", text: running.length ? `后台工作流:${running.join(", ")}` : "没有后台工作流。" }],
          details: { cancelled: false, running, id: undefined } as WorkflowCancelDetails,
        };
      }
      const cancelled = registry.cancel(params.id);
      if (!cancelled) {
        throw new Error(
          running.length
            ? `未知的工作流 id: ${params.id}(在跑:${running.join(", ")})`
            : `未知的工作流 id: ${params.id}`,
        );
      }
      return {
        content: [{ type: "text", text: "已请求取消;结算会自动上报。" }],
        details: { cancelled: true, running: [], id: params.id } as WorkflowCancelDetails,
      };
    },
  });
}
