import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  type AgentSessionEvent,
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

/** One observed subagent transcript event (assistant text / tool name / error). Memory only, never persisted. */
export interface AgentTranscriptEvent {
  at: number;
  kind: "text" | "tool" | "error";
  text: string;
}

/** Ring buffer of recent transcript events; keeps the newest `cap` entries. */
export class TranscriptRing {
  private readonly events: AgentTranscriptEvent[] = [];

  constructor(private readonly cap = 200) {}

  push(event: AgentTranscriptEvent): void {
    this.events.push(event);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
  }

  recent(count = this.cap): AgentTranscriptEvent[] {
    return this.events.slice(-count);
  }

  get size(): number {
    return this.events.length;
  }
}

const TRANSCRIPT_SNIPPET_CAP = 200;
/** Per-label rings kept on a WorkflowAgent instance; oldest labels are dropped past this many. */
const TRANSCRIPT_LABEL_CAP = 50;

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /** Silent observer for transcript events (workflow layer feeds lastEventAt/围观); not exposed to scripts. */
  onEvent?: (event: AgentTranscriptEvent) => void;
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
    let spent: UsageTotals;
    try {
      spent = read();
    } catch {
      return; // a throwing read() must not kill the interval tick
    }
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

/** Map a session event to a transcript record; undefined = not worth surfacing. */
function transcriptEventOf(event: AgentSessionEvent): Omit<AgentTranscriptEvent, "at"> | undefined {
  if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
    const content = (event.message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) return undefined;
    return {
      kind: "text",
      text: text.length > TRANSCRIPT_SNIPPET_CAP ? `${text.slice(0, TRANSCRIPT_SNIPPET_CAP - 1)}…` : text,
    };
  }
  if (event.type === "tool_execution_start") return { kind: "tool", text: event.toolName };
  if (event.type === "tool_execution_end" && event.isError) {
    const raw = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
    return {
      kind: "error",
      text: raw.length > TRANSCRIPT_SNIPPET_CAP ? `${raw.slice(0, TRANSCRIPT_SNIPPET_CAP - 1)}…` : raw,
    };
  }
  return undefined;
}

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly transcripts = new Map<string, TranscriptRing>();

  /** Recent transcript events for a label (ring buffer, cap 200, memory only). */
  observeTranscript(label: string): AgentTranscriptEvent[] {
    return this.transcripts.get(label)?.recent() ?? [];
  }

  private transcriptRing(label: string): TranscriptRing {
    let ring = this.transcripts.get(label);
    if (!ring) {
      if (this.transcripts.size >= TRANSCRIPT_LABEL_CAP) {
        const oldest = this.transcripts.keys().next().value;
        if (oldest !== undefined) this.transcripts.delete(oldest);
      }
      ring = new TranscriptRing();
      this.transcripts.set(label, ring);
    }
    return ring;
  }

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
    let removeTranscriptListener: (() => void) | undefined;
    if (options.label) {
      const ring = this.transcriptRing(options.label);
      const onTranscript = (event: AgentSessionEvent) => {
        const record = transcriptEventOf(event);
        if (!record) return;
        const stamped: AgentTranscriptEvent = { at: Date.now(), ...record };
        ring.push(stamped);
        options.onEvent?.(stamped);
      };
      removeTranscriptListener = session.subscribe(onTranscript);
    }
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
      if (!budgetAbort && options.budgetTokens && options.budgetTokens > 0) {
        // Sync reconciliation: a fast agent can finish before the next poll tick
        // sees its usage — the check above would then race the poller and lose.
        const spent = sumUsage(session.messages);
        if (spent.input + spent.output > options.budgetTokens) budgetAbort = { spent };
      }
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
      removeTranscriptListener?.();
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
