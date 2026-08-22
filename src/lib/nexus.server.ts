/**
 * NEXUS — autonomous competitive intelligence agent (ReAct loop).
 * Server-only module: reads TAVILY_API_KEY / LOVABLE_API_KEY inside functions.
 */

export type SourceResult = { title: string; url: string; content: string };

export type TraceEvent = {
  step: number;
  type: "decision" | "observation" | "error" | "memory";
  message: string;
  tool?: string;
  query?: string;
  result_count?: number;
  status?: string;
};

export type PriorInvestigation = {
  target: string;
  topic: string | null;
  summary: string;
  confidence: number | null;
  created_at: string;
};


export type NexusInput = {
  goal: string;
  target: string;
  competitors: string[];
  topic: string;
};

const MAX_STEPS = 8;
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

const TOOL_NAMES = [
  "search_news",
  "search_research",
  "search_patents",
  "search_competitor_activity",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

// ============================================================
// TAVILY TOOLS
// ============================================================

async function tavilySearch(
  query: string,
  domains?: string[],
): Promise<SourceResult[]> {
  const apiKey = process.env["TAVILY_API_KEY"];
  if (!apiKey) throw new Error("TAVILY_API_KEY is not configured.");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 5,
      ...(domains ? { include_domains: domains } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Tavily search failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { results?: unknown };
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      title: typeof r["title"] === "string" ? r["title"] : "",
      url: typeof r["url"] === "string" ? r["url"] : "",
      content: typeof r["content"] === "string" ? r["content"] : "",
    };
  });
}

const TOOLS: Record<ToolName, (query: string) => Promise<SourceResult[]>> = {
  search_news: (q) => tavilySearch(q),
  search_research: (q) =>
    tavilySearch(q, [
      "arxiv.org",
      "nature.com",
      "science.org",
      "research.google",
      "ai.google",
      "openreview.net",
    ]),
  search_patents: (q) =>
    tavilySearch(`${q} patents patent filing intellectual property`, [
      "patents.google.com",
    ]),
  search_competitor_activity: (q) => tavilySearch(q),
};

// ============================================================
// LLM
// ============================================================

async function callLLM(prompt: string): Promise<string> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured.");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429)
      throw new Error("AI rate limit reached. Please retry in a moment.");
    if (res.status === 402)
      throw new Error(
        "AI credits exhausted for this workspace. Add credits to continue.",
      );
    throw new Error(`AI request failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error("The model returned an empty response.");
  return text;
}

function cleanJsonResponse(text: string): string {
  let out = text.trim();
  if (out.startsWith("```")) {
    const lines = out.split("\n");
    if (lines[0]?.startsWith("```")) lines.shift();
    if (lines[lines.length - 1]?.trim() === "```") lines.pop();
    out = lines.join("\n").trim();
  }
  return out;
}

const SYSTEM_PROMPT = `You are NEXUS, an autonomous competitive intelligence agent.

Your job is to investigate a user's question by gathering evidence from multiple
information sources and producing actionable intelligence.

You operate using a ReAct-style loop:
1. Examine the current investigation state.
2. Decide the best NEXT ACTION.
3. Select exactly ONE available tool OR finish.
4. Observe the tool result.
5. Re-evaluate the evidence.
6. Continue if more evidence is needed, finish when sufficient evidence exists.

AVAILABLE TOOLS:
- search_news: recent news and industry developments.
- search_research: scientific and technical research.
- search_patents: patent-related information.
- search_competitor_activity: competitor announcements and strategic activity.

IMPORTANT RULES:
- Do NOT blindly call every tool. Choose tools based on the current evidence.
- If evidence conflicts, perform another search to verify it.
- Never invent sources or facts.
- Do not expose private chain-of-thought; return only a concise public summary.
- You MUST respond with valid JSON only. No markdown. No code fences.

For a tool action return:
{"action":"tool","tool":"search_news","query":"specific search query","decision_summary":"Short public explanation of why this action is needed."}

For finishing return:
{"action":"final","decision_summary":"Short public explanation of why the evidence is sufficient.","confidence":85}

The "tool" field must be exactly one of: search_news, search_research, search_patents, search_competitor_activity.`;

// ============================================================
// LONG-TERM MEMORY (persistent store)
// ============================================================

async function loadPriorInvestigations(target: string): Promise<PriorInvestigation[]> {
  if (!target) return [];
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("investigation_history")
    .select("target, topic, summary, confidence, created_at")
    .ilike("target", target)
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) throw new Error(error.message);
  return (data ?? []) as PriorInvestigation[];
}

async function savePriorInvestigation(row: {
  target: string;
  topic: string;
  summary: string;
  confidence: number;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("investigation_history").insert({
    target: row.target || "Unspecified",
    topic: row.topic,
    summary: row.summary,
    confidence: row.confidence,
  });
  if (error) throw new Error(error.message);
}

function formatPriorInvestigations(history: PriorInvestigation[]): string {
  if (!history.length) return "";
  const lines = history.map((h) => {
    const date = new Date(h.created_at).toISOString().slice(0, 10);
    return `- [${date}] (confidence ${h.confidence ?? "n/a"}%) ${h.summary}`;
  });
  return `PRIOR INVESTIGATIONS ON THIS TARGET:\n${lines.join("\n")}\n\nUse these as background. Note in the final report whether anything has changed since then.`;
}

// ============================================================
// SHORT-TERM MEMORY (context window management)
// ============================================================

const FULL_DETAIL_STEPS = 3;
const FULL_DETAIL_STEPS_COMPRESSED = 2;
const COMPRESS_AFTER_STEP = 5;

type AgentAction = { step: number; tool: string; query: string };
type AgentObservation = {
  step: number;
  tool: string;
  observation: string;
  result_count: number;
};

function condenseStep(action: AgentAction, obs?: AgentObservation): string {
  const count = obs ? obs.result_count : 0;
  return `Step ${action.step}: used ${action.tool} for "${action.query}", found ${count} results`;
}

async function compressWorkingMemory(state: {
  goal: string;
  target: string;
  topic: string;
  working_memory: string;
  observations: AgentObservation[];
}): Promise<string> {
  const evidence = state.observations
    .map((o) => `Step ${o.step} (${o.tool}):\n${o.observation.slice(0, 1200)}`)
    .join("\n\n");

  const prompt = `Compress the state of an ongoing intelligence investigation into a short
"working memory" note of 3-5 sentences.

GOAL: ${state.goal}
TARGET: ${state.target}
TOPIC: ${state.topic}

${state.working_memory ? `PREVIOUS WORKING MEMORY:\n${state.working_memory}\n` : ""}
EVIDENCE GATHERED SO FAR:
${evidence || "(none)"}

Cover: what has been established, what is still uncertain, and what has not been
checked yet. Plain text only, no markdown, no headers, no invented facts.`;

  return (await callLLM(prompt)).trim();
}

// ============================================================
// AGENT LOOP
// ============================================================

export type NexusResult = {
  report: string;
  trace: TraceEvent[];
  steps: number;
  confidence: number;
  working_memory: string;
};

export async function* runNexus(
  input: NexusInput,
): AsyncGenerator<
  | { type: "trace"; event: TraceEvent }
  | { type: "memory"; working_memory: string }
  | { type: "result"; result: NexusResult },
  void,
  unknown
> {
  const state = {
    goal: input.goal,
    target: input.target,
    competitors: input.competitors,
    topic: input.topic,
    step_count: 0,
    actions_taken: [] as AgentAction[],
    observations: [] as AgentObservation[],
    sources: [] as SourceResult[],
    task_complete: false,
    confidence: 0,
    working_memory: "",
  };

  const trace: TraceEvent[] = [];
  const emit = (event: TraceEvent) => {
    trace.push(event);
    return { type: "trace" as const, event };
  };

  // ---- long-term memory: recall ----
  let priorContext = "";
  try {
    const history = await loadPriorInvestigations(state.target);
    if (history.length) {
      priorContext = formatPriorInvestigations(history);
      yield emit({
        step: 0,
        type: "memory",
        message: `Found ${history.length} previous investigation${history.length > 1 ? "s" : ""} on ${state.target} — using as background context.`,
        status: "recalled",
      });
    }
  } catch (e) {
    yield emit({
      step: 0,
      type: "error",
      message: `Long-term memory unavailable: ${e instanceof Error ? e.message : String(e)}`,
      status: "error",
    });
  }

  while (!state.task_complete && state.step_count < MAX_STEPS) {
    state.step_count += 1;

    // ---- short-term memory: compress history once past COMPRESS_AFTER_STEP ----
    if (state.step_count > COMPRESS_AFTER_STEP && state.observations.length) {
      try {
        state.working_memory = await compressWorkingMemory(state);
        yield emit({
          step: state.step_count,
          type: "memory",
          message: `Compressed ${state.observations.length} steps of history into working memory.`,
          status: "compressed",
        });
        yield { type: "memory", working_memory: state.working_memory };
      } catch (e) {
        yield emit({
          step: state.step_count,
          type: "error",
          message: `Memory compression failed: ${e instanceof Error ? e.message : String(e)}`,
          status: "error",
        });
      }
    }

    const detailCount = state.working_memory
      ? FULL_DETAIL_STEPS_COMPRESSED
      : FULL_DETAIL_STEPS;
    const recentActions = state.actions_taken.slice(-detailCount);
    const recentSteps = new Set(recentActions.map((a) => a.step));
    const olderSummary = state.actions_taken
      .filter((a) => !recentSteps.has(a.step))
      .map((a) => condenseStep(a, state.observations.find((o) => o.step === a.step)));

    const context = JSON.stringify(
      {
        goal: state.goal,
        target: state.target,
        competitors: state.competitors,
        topic: state.topic,
        step: state.step_count,
        max_steps: MAX_STEPS,
        working_memory: state.working_memory || undefined,
        earlier_steps_summary: olderSummary,
        recent_actions: recentActions,
        recent_observations: state.observations.filter((o) => recentSteps.has(o.step)),
        sources_found: state.sources.length,
      },
      null,
      2,
    );


    let decision: Record<string, unknown>;
    try {
      const raw = await callLLM(
        `${SYSTEM_PROMPT}\n\n${priorContext ? `${priorContext}\n\n` : ""}CURRENT INVESTIGATION STATE:\n\n${context}\n\nDecide the next best action.\n\nRemember:\n- Select ONE tool OR finish.\n- Do not repeat an identical search unless verification is necessary.\n- Prefer information that increases confidence in the final answer.`,
      );

      const parsed: unknown = JSON.parse(cleanJsonResponse(raw));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Model response was not a JSON object.");
      }
      decision = parsed as Record<string, unknown>;
    } catch (e) {
      yield emit({
        step: state.step_count,
        type: "error",
        message: e instanceof Error ? e.message : String(e),
        status: "error",
      });
      break;
    }

    const rawAction = decision["action"];
    // Tolerate models that put the tool name directly in "action".
    const action =
      typeof rawAction === "string" && TOOL_NAMES.includes(rawAction as ToolName)
        ? ((decision["tool"] = decision["tool"] ?? rawAction), "tool")
        : rawAction;

    const decisionSummary =
      typeof decision["decision_summary"] === "string"
        ? decision["decision_summary"]
        : "Agent selected the next action.";

    if (action === "final") {
      state.task_complete = true;
      const conf = Number(decision["confidence"]);
      state.confidence = Number.isFinite(conf) ? Math.round(conf) : 75;
      yield emit({
        step: state.step_count,
        type: "decision",
        message: decisionSummary,
        status: "complete",
      });
      break;
    }

    if (action !== "tool") {
      yield emit({
        step: state.step_count,
        type: "error",
        message: `Invalid action selected: ${String(action)}`,
        status: "error",
      });
      break;
    }

    const toolName = decision["tool"];
    const query = typeof decision["query"] === "string" ? decision["query"] : "";

    if (typeof toolName !== "string" || !TOOL_NAMES.includes(toolName as ToolName)) {
      yield emit({
        step: state.step_count,
        type: "error",
        message: `Invalid tool selected: ${String(toolName)}`,
        status: "error",
      });
      break;
    }

    if (!query) {
      yield emit({
        step: state.step_count,
        type: "error",
        message: "Agent selected a tool without a query.",
        status: "error",
      });
      break;
    }

    state.actions_taken.push({ step: state.step_count, tool: toolName, query });
    yield emit({
      step: state.step_count,
      type: "decision",
      message: decisionSummary,
      tool: toolName,
      query,
      status: "running",
    });

    let results: SourceResult[];
    try {
      results = (await TOOLS[toolName as ToolName](query)) ?? [];
    } catch (e) {
      const observation = `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
      state.observations.push({
        step: state.step_count,
        tool: toolName,
        observation,
        result_count: 0,
      });

      yield emit({
        step: state.step_count,
        type: "observation",
        tool: toolName,
        message: observation,
        status: "error",
      });
      continue;
    }

    const observation = results.length
      ? JSON.stringify(
          results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content.slice(0, 500),
          })),
          null,
          2,
        )
      : "No useful results were found.";

    state.observations.push({ step: state.step_count, tool: toolName, observation });
    state.sources.push(...results);

    yield emit({
      step: state.step_count,
      type: "observation",
      tool: toolName,
      result_count: results.length,
      message: `${results.length} relevant results found.`,
      status: "completed",
    });
  }

  let report: string;
  try {
    report = await generateFinalReport(state);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    report = `NEXUS investigation completed, but the final report could not be generated.\n\nError: ${message}`;
    yield emit({
      step: state.step_count,
      type: "error",
      message,
      status: "error",
    });
  }

  yield {
    type: "result",
    result: {
      report,
      trace,
      steps: state.step_count,
      confidence: state.confidence,
    },
  };
}

async function generateFinalReport(state: {
  goal: string;
  target: string;
  competitors: string[];
  topic: string;
  sources: SourceResult[];
}): Promise<string> {
  const sourceText = JSON.stringify(state.sources.slice(-20), null, 2);

  const prompt = `You are preparing the final report for an autonomous competitive
intelligence investigation.

USER GOAL:
${state.goal}

TARGET:
${state.target}

COMPETITORS:
${state.competitors.join(", ")}

TOPIC:
${state.topic}

EVIDENCE:
${sourceText}

Write a concise actionable intelligence report as PLAIN TEXT (no markdown, no
asterisks, no code fences). Use exactly these section headers, each alone on its
own line, in this order:

EXECUTIVE SUMMARY
KEY FINDINGS
COMPETITIVE IMPACT
PRIORITY
RECOMMENDED ACTIONS
CONFIDENCE
SOURCES

Under PRIORITY, output exactly one of LOW, MEDIUM, or HIGH.

Rules:
- Only use information supported by the evidence above.
- Do not invent facts or sources.
- Clearly distinguish uncertain findings.
- Focus on what the organization should do next.
- Do not expose private chain-of-thought.
- Keep the report concise.`;

  return (await callLLM(prompt)).trim();
}
