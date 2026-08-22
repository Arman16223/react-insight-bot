import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

type TraceEvent = {
  step: number;
  type: "decision" | "observation" | "error";
  message: string;
  tool?: string;
  query?: string;
  result_count?: number;
  status?: string;
};

type NexusResult = {
  report: string;
  trace: TraceEvent[];
  steps: number;
  confidence: number;
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEXUS — Autonomous Competitive Intelligence Agent" },
      {
        name: "description",
        content:
          "NEXUS runs an autonomous ReAct research loop across news, research, patents and competitor activity to produce a grounded intelligence report.",
      },
      { property: "og:title", content: "NEXUS — Autonomous Competitive Intelligence" },
      {
        property: "og:description",
        content:
          "Watch an autonomous agent reason, search and report live: news, research, patents and competitor activity in one intelligence brief.",
      },
    ],
  }),
  component: Nexus,
});

const REPORT_SECTIONS = [
  "EXECUTIVE SUMMARY",
  "KEY FINDINGS",
  "COMPETITIVE IMPACT",
  "PRIORITY",
  "RECOMMENDED ACTIONS",
  "CONFIDENCE",
  "SOURCES",
];

function Nexus() {
  const [target, setTarget] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [topic, setTopic] = useState("");
  const [goal, setGoal] = useState("");

  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<NexusResult | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [trace.length]);

  const handleChunk = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const chunk = payload as Record<string, unknown>;
    if (chunk["type"] === "trace" && chunk["event"]) {
      setTrace((prev) => [...prev, chunk["event"] as TraceEvent]);
    } else if (chunk["type"] === "result" && chunk["result"]) {
      const res = chunk["result"] as NexusResult;
      setResult(res);
      if (Array.isArray(res.trace) && res.trace.length) {
        setTrace((prev) => (prev.length ? prev : res.trace));
      }
    }
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    setTrace([]);
    setResult(null);

    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: goal.trim(),
          target: target.trim(),
          topic: topic.trim(),
          competitors: competitors
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Request failed (${response.status}): ${detail.slice(0, 300) || response.statusText}`,
        );
      }

      const contentType = response.headers.get("content-type") ?? "";

      // Non-streaming fallback: whole payload at once.
      if (!contentType.includes("text/event-stream") || !response.body) {
        const text = await response.text();
        try {
          handleChunk({ type: "result", result: JSON.parse(text) });
        } catch {
          parseSseText(text, handleChunk);
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        if (value) buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (consumeSseBlock(part, handleChunk)) {
            done = true;
          }
        }
      }
      if (buffer.trim()) consumeSseBlock(buffer, handleChunk);
    } catch (e) {
      setTrace((prev) => [
        ...prev,
        {
          step: prev.length + 1,
          type: "error",
          message: e instanceof Error ? e.message : String(e),
          status: "error",
        },
      ]);
    } finally {
      setRunning(false);
    }
  };

  const canRun = goal.trim().length > 0 && !running;

  return (
    <main className="min-h-screen px-4 py-6 sm:px-8">
      <header className="mx-auto mb-6 flex max-w-7xl flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="font-mono text-3xl font-bold tracking-[0.35em] text-foreground">
            NEXUS
          </h1>
          <p className="label-caps mt-1">Autonomous Competitive Intelligence</p>
        </div>
        <div
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${
            running
              ? "border-primary/60 bg-primary/10 text-primary"
              : "border-border bg-secondary text-muted-foreground"
          }`}
        >
          <span
            className={`size-2 rounded-full ${running ? "animate-pulse bg-primary" : "bg-accent"}`}
          />
          <span className="font-mono text-[0.65rem] tracking-[0.2em] uppercase">
            {running ? "Agent Active" : "System Ready"}
          </span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        {/* Form */}
        <section className="panel h-fit p-5">
          <h2 className="panel-title mb-5 border-b border-border pb-3">
            Investigation Parameters
          </h2>
          <div className="space-y-4">
            <Field label="Target">
              <input
                className={inputClass}
                placeholder="Target company"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={running}
              />
            </Field>
            <Field label="Competitors (comma-separated)">
              <input
                className={inputClass}
                placeholder="AMD, Google, Microsoft"
                value={competitors}
                onChange={(e) => setCompetitors(e.target.value)}
                disabled={running}
              />
            </Field>
            <Field label="Topic">
              <input
                className={inputClass}
                placeholder="Generative AI"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                disabled={running}
              />
            </Field>
            <Field label="Investigation Goal">
              <textarea
                className={`${inputClass} min-h-32 resize-y`}
                placeholder="What should NEXUS find out?"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                disabled={running}
              />
            </Field>
            <button
              onClick={run}
              disabled={!canRun}
              className="w-full rounded-md bg-primary px-4 py-3 font-mono text-xs tracking-[0.2em] text-primary-foreground uppercase transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              style={running ? undefined : { boxShadow: "var(--glow)" }}
            >
              {running ? "NEXUS Investigating..." : "Run Investigation"}
            </button>
          </div>
        </section>

        {/* Activity */}
        <section className="panel flex max-h-[calc(100vh-9rem)] min-h-96 flex-col p-5">
          <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
            <h2 className="panel-title">Live Agent Activity</h2>
            <span className="label-caps">
              {new Set(trace.map((t) => t.step)).size} Steps
            </span>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto pr-1">
            {trace.length === 0 && !running && (
              <p className="py-16 text-center text-sm text-muted-foreground">
                NEXUS is ready to investigate.
              </p>
            )}
            {trace.length === 0 && running && (
              <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
                <span className="size-2 animate-pulse rounded-full bg-primary" />
                Initializing autonomous investigation...
              </div>
            )}
            {trace.map((event, i) => (
              <TraceCard key={`${event.step}-${event.type}-${i}`} event={event} />
            ))}
            <div ref={bottomRef} />
          </div>
        </section>
      </div>

      {result && (
        <section className="panel mx-auto mt-6 max-w-7xl p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <h2 className="panel-title">Intelligence Report</h2>
            <span className="rounded-full border border-accent/50 bg-accent/10 px-3 py-1 font-mono text-[0.65rem] tracking-[0.18em] text-accent uppercase">
              {result.confidence}% Confidence
            </span>
          </div>
          <div className="space-y-2 text-sm leading-relaxed text-foreground/90">
            {result.report.split("\n").map((line, i) => {
              const clean = line.replace(/[*#`]/g, "").trim();
              if (!clean) return <div key={i} className="h-2" />;
              if (REPORT_SECTIONS.includes(clean.toUpperCase())) {
                return (
                  <h3
                    key={i}
                    className="panel-title pt-4 text-primary first:pt-0"
                  >
                    {clean.toUpperCase()}
                  </h3>
                );
              }
              return (
                <p key={i} className="whitespace-pre-wrap">
                  {clean}
                </p>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:ring-1 focus:ring-ring focus:outline-none disabled:opacity-60";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label-caps mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function TraceCard({ event }: { event: TraceEvent }) {
  const tone =
    event.type === "error"
      ? "border-destructive/50 text-destructive"
      : event.type === "decision"
        ? "border-primary/50 text-primary"
        : "border-accent/50 text-accent";

  return (
    <article className="rounded-md border border-border bg-card/60 p-4">
      <div className="mb-2 flex items-center gap-3">
        <span className="label-caps">Step {event.step}</span>
        <span
          className={`rounded-sm border px-2 py-0.5 font-mono text-[0.6rem] tracking-[0.18em] uppercase ${tone}`}
        >
          {event.type}
        </span>
        {typeof event.result_count === "number" && (
          <span className="label-caps ml-auto">{event.result_count} results</span>
        )}
      </div>
      <p className="text-sm text-foreground/90">{event.message}</p>
      {event.tool && (
        <div className="mt-3 space-y-1 border-t border-border pt-2">
          <p className="font-mono text-xs text-accent">{event.tool}</p>
          {event.query && (
            <p className="font-mono text-xs break-words text-muted-foreground">
              "{event.query}"
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/** Returns true when the [DONE] sentinel was seen. */
function consumeSseBlock(block: string, onChunk: (payload: unknown) => void) {
  let done = false;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      onChunk(JSON.parse(data));
    } catch {
      /* ignore malformed frame */
    }
  }
  return done;
}

function parseSseText(text: string, onChunk: (payload: unknown) => void) {
  for (const block of text.split("\n\n")) consumeSseBlock(block, onChunk);
}
