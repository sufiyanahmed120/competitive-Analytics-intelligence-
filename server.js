import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sampleReport } from "./sample.js";
import { claudeInfo, createClaude } from "./providers/claude.js";
import { geminiInfo, createGemini } from "./providers/gemini.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Fallback order. Each entry builds a provider for a given key (or the server key when none is given).
const PROVIDER_TYPES = [
  { info: claudeInfo, create: createClaude },
  { info: geminiInfo, create: createGemini },
];
const HAS_SERVER_KEYS = PROVIDER_TYPES.some((t) => t.info.hasServerKey);

const cleanKey = (k) => (typeof k === "string" ? k.trim().slice(0, 400) : "");

// Visitor keys are used for this request only and never stored or logged.
// If the visitor sends any key, server keys are NOT mixed in, so the owner's keys are never spent on their behalf.
function buildProviders(apiKeys = {}) {
  const visitor = { claude: cleanKey(apiKeys.claude), gemini: cleanKey(apiKeys.gemini) };
  const usingVisitorKeys = Boolean(visitor.claude || visitor.gemini);
  return PROVIDER_TYPES
    .map(({ info, create }) => {
      if (usingVisitorKeys) return visitor[info.id] ? create(visitor[info.id]) : null;
      return create();
    })
    .filter(Boolean);
}

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(here, "public")));

// One NDJSON line per event so the browser can show live progress.
function sender(res) {
  return (event) => res.write(JSON.stringify(event) + "\n");
}

app.get("/api/status", (_req, res) => {
  const serverProviders = PROVIDER_TYPES.filter((t) => t.info.hasServerKey).map((t) => t.info);
  res.json({
    live: HAS_SERVER_KEYS,
    model: serverProviders[0]?.model ?? null,
    providers: serverProviders.map((p) => ({ id: p.id, label: p.label, model: p.model })),
    // Every provider the page can accept a visitor key for.
    supported: PROVIDER_TYPES.map((t) => ({ id: t.info.id, label: t.info.label, model: t.info.model })),
  });
});

app.get("/api/sample", (_req, res) => {
  res.json(sampleReport);
});

// Runs one pipeline step on each provider in order until one returns a usable result.
async function withProviderFallback(providers, step, run, send, signal) {
  const failures = [];
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
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
    const next = providers[i + 1];
    if (next) send({ type: "progress", message: `⚠ ${p.label} failed (${reason}) — switching to ${next.label}...` });
  }
  const err = new Error(`All AI providers failed — ${failures.join(" · ")}`);
  err.userFacing = true;
  throw err;
}

app.post("/api/analyze", async (req, res) => {
  const { business, location, industry, website, notes, apiKeys } = req.body || {};
  const providers = buildProviders(apiKeys);
  if (!providers.length) {
    return res.status(400).json({ error: "Add your Claude or Gemini API key in the \"Your API keys\" section to run a live analysis." });
  }
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
    send({ type: "stage", stage: "research", message: `Researching the business and its local market (${providers[0].label}${providers[0].usesVisitorKey ? ", your key" : ""})...` });

    const researched = await withProviderFallback(providers, "research", async (p) => {
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

    const built = await withProviderFallback(providers, "report", async (p) => {
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
          fallback_used: researched.provider !== providers[0] || built.provider !== providers[0],
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
  const serverProviders = PROVIDER_TYPES.filter((t) => t.info.hasServerKey).map((t) => t.info);
  if (serverProviders.length) {
    console.log(`Server AI keys (in fallback order): ${serverProviders.map((p) => `${p.label} [${p.model}]`).join(" -> ")}`);
  } else {
    console.log("No server API keys - visitors must enter their own Claude/Gemini key in the page.");
  }
  console.log(`Claude max web searches: ${claudeInfo.maxSearches}`);
});
