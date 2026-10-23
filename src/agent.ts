import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /** Report-only supervision timer (ms); the workflow layer resolves 0 → 60s default. Informational here. */
  timeoutMs?: number;
  /** Input-token budget; unset/0 disables. Over → the session is aborted and the run throws. */
  budgetTokens?: number;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export interface UsageTotals {
  input: number;
  output: number;
}

/** Sum usage across assistant messages (pi AssistantMessage.usage). */
export function sumUsage(messages: unknown[]): UsageTotals {
  let input = 0;
  let output = 0;
  for (const message of messages) {
    const candidate = message as { role?: string; usage?: { input?: number; output?: number } } | undefined;
    if (candidate?.role !== "assistant" || !candidate.usage) continue;
    input += Math.max(0, candidate.usage.input ?? 0);
    output += Math.max(0, candidate.usage.output ?? 0);
  }
  return { input, output };
}

/** Poll `read()` until input+output exceeds `budget`, then call `onOver` once and stop polling. */
export function startBudgetWatch(
  read: () => UsageTotals,
  budget: number,
  onOver: (spent: UsageTotals) => void,
  intervalMs = 500,
): { stop: () => void } {
  let stopped = false;
  const timer = setInterval(() => {
    const spent = read();
    if (spent.input + spent.output > budget) {
      stop();
      onOver(spent);
    }
  }, intervalMs);
  timer.unref?.();
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }
  return { stop };
}

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const customTools: ToolDefinition[] = [...this.baseTools, ...(options.tools ?? [])];

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    const agentDir = getAgentDir();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(this.cwd),
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
    });

    let removeAbortListener: (() => void) | undefined;
    let budgetWatch: { stop: () => void } | undefined;
    let budgetAbort: { spent: UsageTotals } | undefined;
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.budgetTokens && options.budgetTokens > 0) {
        budgetWatch = startBudgetWatch(
          () => sumUsage(session.messages),
          options.budgetTokens,
          (spent) => {
            budgetAbort = { spent };
            void session.abort();
          },
        );
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
      if (budgetAbort) {
        throw new Error(
          `Subagent exceeded budgetTokens (${budgetAbort.spent.input + budgetAbort.spent.output} > ${options.budgetTokens}); aborted`,
        );
      }
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      if (options.schema) {
        if (!capture.called) {
          throw new Error("Subagent finished without calling structured_output");
        }
        return capture.value as AgentRunResult<TSchemaDef>;
      }

      return this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
    } finally {
      budgetWatch?.stop();
      removeAbortListener?.();
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
