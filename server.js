import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleReport } from "./sample.js";
import { claude } from "./providers/claude.js";
import { gemini } from "./providers/gemini.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Tried in this order; a provider without an API key is skipped.
const PROVIDERS = [claude, gemini].filter((p) => p.enabled);

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(here, "public")));

// One NDJSON line per event so the browser can show live progress.
function sender(res) {
  return (event) => res.write(JSON.stringify(event) + "\n");
}

app.get("/api/status", (_req, res) => {
  res.json({
    live: PROVIDERS.length > 0,
    model: PROVIDERS[0]?.model ?? null,
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, model: p.model })),
  });
});

app.get("/api/sample", (_req, res) => {
  res.json(sampleReport);
});

// Runs one pipeline step on each provider in order until one returns a usable result.
async function withProviderFallback(step, run, send, signal) {
  const failures = [];
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i];
    let reason;
    try {
      const result = await run(p);
      if (result) return { provider: p, result };
      reason = "no usable result";
    } catch (err) {
      if (signal.aborted || p.isAbort(err)) throw err;
      console.error(`[${p.label}] ${step} failed:`, err);
      reason = p.describeError(err);
    }
    failures.push(`${p.label}: ${reason}`);
    const next = PROVIDERS[i + 1];
    if (next) send({ type: "progress", message: `⚠ ${p.label} failed (${reason}) — switching to ${next.label}...` });
  }
  const err = new Error(`All AI providers failed — ${failures.join(" · ")}`);
  err.userFacing = true;
  throw err;
}

app.post("/api/analyze", async (req, res) => {
  if (!PROVIDERS.length) {
    return res.status(503).json({ error: "No AI API key configured. Add ANTHROPIC_API_KEY and/or GEMINI_API_KEY to .env." });
  }

  const { business, location, industry, website, notes } = req.body || {};
  if (!business?.trim() || !location?.trim()) {
    return res.status(400).json({ error: "Business name and location are required." });
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = sender(res);

  const controller = new AbortController();
  const { signal } = controller;
  const started = Date.now();
  // Keep the connection alive (and the user informed) during long silent model calls.
  const heartbeat = setInterval(() => {
    send({ type: "heartbeat", elapsed: Math.round((Date.now() - started) / 1000) });
  }, 10_000);
  res.on("close", () => { if (!res.writableFinished) controller.abort(); clearInterval(heartbeat); });

  const brief = [
    `Target business: ${business.trim()}`,
    `Location: ${location.trim()}`,
    industry?.trim() && `Industry / category: ${industry.trim()}`,
    website?.trim() && `Website: ${website.trim()}`,
    notes?.trim() && `Extra context from the user: ${notes.trim()}`,
  ].filter(Boolean).join("\n");

  try {
    // ---------- Phase 1: live research with web search ----------
    send({ type: "stage", stage: "research", message: `Researching the business and its local market (${PROVIDERS[0].label})...` });

    const researched = await withProviderFallback("research", async (p) => {
      const found = await p.research(brief, send, signal);
      return found.notesText.trim() ? found : null;
    }, send, signal);
    if (signal.aborted) return;

    const { notesText, sources, searches, liveSearch } = researched.result;
    send({ type: "progress", message: liveSearch
      ? `Research complete via ${researched.provider.label}: ${searches} searches, ${sources.size} sources`
      : `Research complete via ${researched.provider.label} (from model knowledge)` });

    // ---------- Phase 2: structure into a report ----------
    send({ type: "stage", stage: "analysis", message: "Scoring competitors and building your strategy..." });

    const sourceList = [...sources.values()].slice(0, 40)
      .map((s, i) => `[${i + 1}] ${s.title}`).join("\n");

    const built = await withProviderFallback("report", async (p) => {
      const report = await p.buildReport(brief, notesText, sourceList, send, signal);
      if (report || signal.aborted) return report;
      send({ type: "progress", message: "Report needed a second pass, retrying..." });
      return p.buildReport(brief, notesText, sourceList, send, signal);
    }, send, signal);
    if (signal.aborted) return;

    send({
      type: "result",
      report: {
        ...built.result,
        live_search: liveSearch,
        ai: {
          research: `${researched.provider.label} (${researched.provider.model})`,
          report: `${built.provider.label} (${built.provider.model})`,
          fallback_used: researched.provider !== PROVIDERS[0] || built.provider !== PROVIDERS[0],
        },
        sources: [...sources.values()],
        generated_at: new Date().toISOString(),
        input: { business, location, industry, website },
      },
    });
  } catch (err) {
    if (signal.aborted) return;
    if (!err.userFacing) console.error(err);
    send({ type: "error", message: err.message || "Unexpected error" });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Competitive Analysis running at http://localhost:${PORT}`);
  if (PROVIDERS.length) {
    console.log(`AI providers (in fallback order): ${PROVIDERS.map((p) => `${p.label} [${p.model}]`).join(" -> ")}`);
    if (claude.enabled) console.log(`Claude max web searches: ${claude.maxSearches}`);
  } else {
    console.log("No ANTHROPIC_API_KEY or GEMINI_API_KEY found - the app will run in demo mode (sample report only).");
  }
});
