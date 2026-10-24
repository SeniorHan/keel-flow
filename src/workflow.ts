import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  concurrency?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: {
    label: string;
    phase?: string;
    prompt: string;
    /** When agent() was invoked (pre-limiter); drives the queued segment in timeline views. */
    queuedAt?: number;
    /** Structure node this agent was spawned under (parallel/pipeline scope). */
    parentId?: number;
  }) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown }) => void;
  /** Silent per-agent transcript event feed (drives lastEventAt staleness warnings). */
  onAgentEvent?: (event: { label: string; at: number; kind: string; text: string }) => void;
  /** Pipeline item progress: fired per item×stage transition. */
  onPipelineItem?: (event: {
    itemIndex: number;
    stageIndex: number;
    stageCount: number;
    status: PipelineItemStatus;
  }) => void;
  /** Full execution-structure snapshot; fired whenever nodes/items/queue depth change. */
  onStructure?: (structure: WorkflowStructure) => void;
}

export type PipelineItemStatus = "queued" | "running" | "done" | "failed";

/** One execution-scope node in the run's structure tree (agents reference it via parentId). */
export interface StructureNode {
  id: number;
  kind: "parallel" | "pipeline";
  label?: string;
  /** parallel: number of thunks; pipeline: number of items. */
  thunkCount?: number;
  itemCount?: number;
  stageCount?: number;
  /** Enclosing node, when a parallel/pipeline nests inside another scope. */
  parentId?: number;
}

export interface PipelineItemState {
  node: number;
  itemIndex: number;
  stageIndex: number;
  stageCount: number;
  status: PipelineItemStatus;
}

export interface WorkflowStructure {
  nodes: StructureNode[];
  pipelineItems: PipelineItemState[];
  /** Limiter queue depth: agent() calls admitted but not yet started. */
  queuedCount: number;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
  /** Report-only supervision timer in ms; 0 → 60s default. Logs an event; never stops the agent. */
  timeoutMs?: number;
  /** Input-token budget; 0 → 2,000,000 default. Over → the agent is aborted and returns null. */
  budgetTokens?: number;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  spent: number;
  /** Live execution-structure tree (parallel/pipeline scopes). */
  nodes: StructureNode[];
  pipelineItems: PipelineItemState[];
  /** Monotonic structure-node id sequence (ids survive node pops). */
  nodeSeq: number;
  /** Label → last transcript/activity timestamp; refreshed on any agent event. */
  lastEventAt: Map<string, number>;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

const AGENT_DEFAULT_TIMEOUT_MS = 60_000;
const AGENT_MAX_TIMEOUT_MS = 3_600_000;
const AGENT_DEFAULT_BUDGET_TOKENS = 2_000_000;

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = {
    logs: [],
    phases: [],
    agentCount: 0,
    spent: 0,
    nodes: [],
    pipelineItems: [],
    nodeSeq: 0,
    lastEventAt: new Map(),
  };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();

  const emitStructure = () => {
    if (!options.onStructure) return;
    options.onStructure({
      nodes: state.nodes.map((node) => ({ ...node })),
      pipelineItems: state.pipelineItems.map((item) => ({ ...item })),
      queuedCount: limiter.queued(),
    });
  };

  const pushNode = (node: Omit<StructureNode, "id">): StructureNode => {
    const created: StructureNode = { ...node, id: ++state.nodeSeq };
    state.nodes.push(created);
    emitStructure();
    return created;
  };

  const setPipelineItem = (
    node: number,
    itemIndex: number,
    stageIndex: number,
    stageCount: number,
    status: PipelineItemStatus,
  ) => {
    const existing = state.pipelineItems.find((item) => item.node === node && item.itemIndex === itemIndex);
    const next: PipelineItemState = { node, itemIndex, stageIndex, stageCount, status };
    if (existing) Object.assign(existing, next);
    else state.pipelineItems.push(next);
    options.onPipelineItem?.({ itemIndex, stageIndex, stageCount, status });
    emitStructure();
  };

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent)),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("workflow aborted");
  };

  const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted();
    if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
    const taskPrompt = requireString(prompt, "agent prompt");
    const normalizedOptions = normalizeAgentOptions(agentOptions);
    const timeoutMs = resolveAgentTimeout(normalizedOptions.timeoutMs);
    const budgetTokens = resolveAgentBudget(normalizedOptions.budgetTokens);
    const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
    const requestedLabel = normalizedOptions.label?.trim();
    const queuedAt = Date.now();
    const parentNode = [...state.nodes].reverse()[0];
    const run = limiter(async () => {
      state.agentCount++;
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
      state.lastEventAt.set(label, Date.now());
      options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt, queuedAt, parentId: parentNode?.id });
      emitStructure();
      const timeoutTimer =
        timeoutMs > 0
          ? setTimeout(() => {
              log(
                `agent ${label} timeout event after ${Math.round(timeoutMs / 1000)}s: still running (report-only; not stopped)`,
              );
            }, timeoutMs)
          : undefined;
      timeoutTimer?.unref?.();
      try {
        throwIfAborted();
        const result = await agentRunner.run(taskPrompt, {
          label,
          schema: normalizedOptions.schema,
          signal: options.signal,
          instructions: buildAgentInstructions(assignedPhase, normalizedOptions),
          timeoutMs,
          budgetTokens,
          onEvent: (event: { at: number; kind: string; text: string }) => {
            state.lastEventAt.set(label, event.at);
            options.onAgentEvent?.({ label, at: event.at, kind: event.kind, text: event.text });
          },
        } as any);
        throwIfAborted();
        state.spent += estimateTokens(result);
        state.lastEventAt.set(label, Date.now());
        options.onAgentEnd?.({ label, phase: assignedPhase, result });
        emitStructure();
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        state.lastEventAt.set(label, Date.now());
        log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        options.onAgentEnd?.({ label, phase: assignedPhase, result: null });
        emitStructure();
        return null;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
    });
    pendingAgentRuns.add(run);
    run.then(
      () => pendingAgentRuns.delete(run),
      () => pendingAgentRuns.delete(run),
    );
    return run;
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    const node = pushNode({ kind: "parallel", thunkCount: thunks.length, parentId: [...state.nodes].reverse()[0]?.id });
    try {
      return await Promise.all(
        thunks.map(async (thunk, index) => {
          try {
            return await thunk();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }),
      );
    } finally {
      emitStructure();
      state.nodes = state.nodes.filter((entry) => entry !== node);
      emitStructure();
    }
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    const node = pushNode({
      kind: "pipeline",
      label: `管线 ${items.length}×${stages.length}`,
      itemCount: items.length,
      stageCount: stages.length,
      parentId: [...state.nodes].reverse()[0]?.id,
    });
    try {
      return await Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item;
          for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
            try {
              throwIfAborted();
              setPipelineItem(node.id, index, stageIndex + 1, stages.length, "running");
              value = await stages[stageIndex](value, item, index);
              throwIfAborted();
              setPipelineItem(node.id, index, stageIndex + 1, stages.length, "done");
            } catch (error) {
              if (options.signal?.aborted) throw error;
              setPipelineItem(node.id, index, stageIndex + 1, stages.length, "failed");
              log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
              return null;
            }
          }
          return value;
        }),
      );
    } finally {
      emitStructure();
      state.nodes = state.nodes.filter((entry) => entry !== node);
      emitStructure();
    }
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  });

  const wrapped = `(async () => {\n${body}\n})()`;
  const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
  await Promise.allSettled([...pendingAgentRuns]);
  assertStructuredCloneable(result, "workflow result");
  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  assertDeterministicAst(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function assertDeterministicAst(node: AnyNode): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }

  for (const child of astChildren(node)) assertDeterministicAst(child);
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode));
    else if (isAstNode(value)) children.push(value);
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
  return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date";
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier" || node.object.name !== objectName) {
    return false;
  }
  return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringOf(node.left);
    const right = staticStringOf(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string")
    throw new Error("meta.whenToUse must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  let queued = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const wake = queue.shift();
    if (wake) queued--;
    wake?.();
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      queued++;
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
  (run as typeof run & { queued(): number }).queued = () => queued;
  return run as typeof run & { queued(): number };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!value || typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as AgentOptions;
  return {
    ...options,
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    model: optionalString(options.model, "agent model"),
    isolation: options.isolation,
    agentType: optionalString(options.agentType, "agent type"),
  };
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    );
  }
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  if (options.model) lines.push(`Requested model: ${options.model}`);
  return lines.length ? lines.join("\n") : undefined;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function resolveAgentTimeout(value: unknown): number {
  if (value === undefined || value === 0) return AGENT_DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > AGENT_MAX_TIMEOUT_MS) {
    throw new TypeError(
      `agent timeoutMs must be an integer between 0 and ${AGENT_MAX_TIMEOUT_MS}; 0 uses the 60s report-only default`,
    );
  }
  return value;
}

function resolveAgentBudget(value: unknown): number {
  if (value === undefined || value === 0) return AGENT_DEFAULT_BUDGET_TOKENS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("agent budgetTokens must be a non-negative integer; 0 uses the 2,000,000-token default");
  }
  return value;
}
