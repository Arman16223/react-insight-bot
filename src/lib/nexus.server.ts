/**
 * NEXUS — autonomous competitive intelligence agent (ReAct loop).
 * Server-only module: reads TAVILY_API_KEY / LOVABLE_API_KEY inside functions.
 */

export type SourceResult = { title: string; url: string; content: string };

export type TraceEvent = {
  step: number;
  type: "decision" | "observation" | "error";
  message: string;
  tool?: string;
  query?: string;
  result_count?: number;
  status?: string;
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
// AGENT LOOP
// ============================================================

export type NexusResult = {
  report: string;
  trace: TraceEvent[];
  steps: number;
  confidence: number;
};

export async function* runNexus(
  input: NexusInput,
): AsyncGenerator<
  { type: "trace"; event: TraceEvent } | { type: "result"; result: NexusResult },
  void,
  unknown
> {
  const state = {
    goal: input.goal,
    target: input.target,
    competitors: input.competitors,
    topic: input.topic,
    step_count: 0,
    actions_taken: [] as Array<{ step: number; tool: string; query: string }>,
    observations: [] as Array<{ step: number; tool: string; observation: string }>,
    sources: [] as SourceResult[],
    task_complete: false,
    confidence: 0,
  };

  const trace: TraceEvent[] = [];
  const emit = (event: TraceEvent) => {
    trace.push(event);
    return { type: "trace" as const, event };
  };

  while (!state.task_complete && state.step_count < MAX_STEPS) {
    state.step_count += 1;

    const context = JSON.stringify(
      {
        goal: state.goal,
        target: state.target,
        competitors: state.competitors,
        topic: state.topic,
        step: state.step_count,
        max_steps: MAX_STEPS,
        actions_taken: state.actions_taken.slice(-5),
        recent_observations: state.observations.slice(-4),
        sources_found: state.sources.length,
      },
      null,
      2,
    );

    let decision: Record<string, unknown>;
    try {
      const raw = await callLLM(
        `${SYSTEM_PROMPT}\n\nCURRENT INVESTIGATION STATE:\n\n${context}\n\nDecide the next best action.\n\nRemember:\n- Select ONE tool OR finish.\n- Do not repeat an identical search unless verification is necessary.\n- Prefer information that increases confidence in the final answer.`,
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

    const action = decision["action"];
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
