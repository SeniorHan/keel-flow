import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";

export interface ExportRunHtmlOptions {
  /** 工作流 id（如 wf-2），用于标题与文件名提示；缺省省略。 */
  id?: string;
  /** 生成时刻；默认 Date.now()。纯函数测试时传入固定值。 */
  now?: number;
}

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STATUS_LABEL: Record<WorkflowAgentSnapshot["status"], string> = {
  queued: "排队",
  running: "运行中",
  done: "完成",
  error: "失败",
  skipped: "跳过",
};

const STATUS_COLOR: Record<WorkflowAgentSnapshot["status"], string> = {
  queued: "#5b616e",
  running: "#3b82f6",
  done: "#22c55e",
  error: "#ef4444",
  skipped: "#8b5cf6",
};

const fmtSec = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** 自包含静态运行报告：时间轴甘特 + 泳道 + 结构侧栏 + 汇总卡。零外部依赖。 */
export function exportRunHtml(snapshot: WorkflowSnapshot, options: ExportRunHtmlOptions = {}): string {
  const now = options.now ?? Date.now();
  const title = options.id ? `工作流 ${options.id} · ${snapshot.name}` : `工作流 ${snapshot.name}`;
  const generated = new Date(now).toISOString().replace("T", " ").slice(0, 19);

  const t0Candidates = snapshot.agents
    .map((agent) => agent.queuedAt ?? agent.startedAt)
    .filter((value): value is number => typeof value === "number");
  if (typeof snapshot.startedAt === "number") t0Candidates.push(snapshot.startedAt);
  const t0 = t0Candidates.length ? Math.min(...t0Candidates) : now;
  const t1Candidates = snapshot.agents
    .map((agent) => agent.endedAt ?? agent.lastEventAt)
    .filter((value): value is number => typeof value === "number");
  if (typeof snapshot.durationMs === "number" && typeof snapshot.startedAt === "number")
    t1Candidates.push(snapshot.startedAt + snapshot.durationMs);
  const t1 = Math.max(now, ...(t1Candidates.length ? t1Candidates : [now + 1]));
  const span = Math.max(1, t1 - t0);
  const pct = (value: number): string => `${((value - t0) / span) * 100}%`;

  const ticks: string[] = [];
  const tickCount = 5;
  for (let i = 0; i <= tickCount; i += 1) {
    const at = t0 + (span * i) / tickCount;
    ticks.push(`<span class="tick" style="left:${(i / tickCount) * 100}%">${fmtSec(at - t0)}</span>`);
  }

  const phases: Array<{ name: string; agents: WorkflowAgentSnapshot[] }> = [];
  for (const agent of snapshot.agents) {
    const name = agent.phase ?? "未分组";
    let lane = phases.find((entry) => entry.name === name);
    if (!lane) {
      lane = { name, agents: [] };
      phases.push(lane);
    }
    lane.agents.push(agent);
  }

  const laneHtml = phases
    .map((lane) => {
      const rows = lane.agents
        .map((agent) => {
          const start = agent.queuedAt ?? agent.startedAt ?? t0;
          const end =
            agent.status === "running" ? Math.max(now, start + 1) : (agent.endedAt ?? agent.lastEventAt ?? start + 1);
          const left = Math.min(100, Math.max(0, ((start - t0) / span) * 100));
          const width = Math.min(100 - left, Math.max(0.8, ((end - start) / span) * 100));
          const errorBlock =
            agent.status === "error" && agent.error
              ? `<details class="err"><summary>错误详情</summary><pre>${esc(agent.error)}</pre></details>`
              : "";
          const tail =
            agent.transcriptTail && agent.transcriptTail.length
              ? `<div class="tail">${agent.transcriptTail.map((line) => `<div>${esc(line)}</div>`).join("")}</div>`
              : "";
          return `<div class="row"><div class="agent-label" title="${esc(agent.prompt)}">#${agent.id} ${esc(
            agent.label,
          )}</div><div class="track"><div class="bar" style="left:${left}%;width:${width}%;background:${
            STATUS_COLOR[agent.status]
          }" title="${STATUS_LABEL[agent.status]} · ${fmtSec((end ?? now) - start)}"></div></div><div class="agent-meta">${
            STATUS_LABEL[agent.status]
          }</div>${errorBlock}${tail}</div>`;
        })
        .join("\n");
      return `<section class="lane"><h3>${esc(lane.name)}</h3>${rows}</section>`;
    })
    .join("\n");

  const nodeTree = (parentId: string | number | undefined, depth: number): string => {
    const nodes = (snapshot.nodes ?? []).filter((node) => node.parentId === parentId);
    if (!nodes.length) return "";
    return `<ul>${nodes
      .map((node) => {
        const children = nodeTree(node.id, depth + 1);
        const kindLabel =
          node.kind === "parallel" ? `并行 ${node.thunkCount ?? ""} thunk` : `管线 ${node.itemCount ?? ""} item`;
        return `<li><code>${esc(node.label ?? `${node.kind}#${node.id}`)}</code> <span class="muted">${esc(kindLabel)}</span>${children}</li>`;
      })
      .join("")}</ul>`;
  };

  const resultJson =
    snapshot.result === undefined
      ? ""
      : `<details class="result"><summary>运行结果</summary><pre>${esc(
          typeof snapshot.result === "string" ? snapshot.result : JSON.stringify(snapshot.result, null, 2),
        )}</pre></details>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { background: #0d1117; color: #e6edf3; font: 14px/1.5 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h3 { font-size: 14px; margin: 18px 0 8px; color: #9fb1c1; border-bottom: 1px solid #21262d; padding-bottom: 4px; }
  .meta { color: #8b949e; font-size: 12px; margin-bottom: 16px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0 20px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 10px 16px; min-width: 110px; }
  .card b { display: block; font-size: 20px; }
  .card span { color: #8b949e; font-size: 12px; }
  .axis { position: relative; height: 20px; margin-left: 220px; margin-right: 90px; border-bottom: 1px solid #21262d; }
  .tick { position: absolute; transform: translateX(-50%); color: #8b949e; font-size: 11px; }
  .lane { margin-bottom: 8px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .agent-label { width: 212px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track { flex: 1; position: relative; height: 16px; background: #161b22; border-radius: 4px; }
  .bar { position: absolute; top: 2px; bottom: 2px; border-radius: 3px; min-width: 4px; }
  .agent-meta { width: 70px; flex: none; color: #8b949e; font-size: 12px; text-align: right; }
  details.err { margin: 4px 0 4px 220px; }
  summary { cursor: pointer; color: #f85149; }
  pre { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 10px; overflow: auto; white-space: pre-wrap; }
  .tail { margin: 2px 0 6px 220px; color: #8b949e; font-size: 12px; }
  details.result, details.side { margin-top: 16px; }
  code { color: #79c0ff; }
  .muted { color: #8b949e; }
  ul { margin: 4px 0; padding-left: 20px; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<div class="meta">生成于 ${esc(generated)} · keel-flow 运行报告（静态导出）</div>
<div class="cards">
  <div class="card"><b>${snapshot.doneCount}/${snapshot.agentCount}</b><span>子代理完成</span></div>
  <div class="card"><b>${snapshot.errorCount}</b><span>失败</span></div>
  <div class="card"><b>${fmtSec(snapshot.durationMs ?? now - (snapshot.startedAt ?? now))}</b><span>总耗时</span></div>
  <div class="card"><b>${snapshot.phases.length || 1}</b><span>阶段</span></div>
</div>
<div class="axis">${ticks.join("")}</div>
${laneHtml}
<details class="side"><summary>执行结构</summary>${nodeTree(undefined, 0) || "<p class='muted'>（无结构节点）</p>"}</details>
${resultJson}
</body>
</html>`;
}
