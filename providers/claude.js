import Anthropic from "@anthropic-ai/sdk";
import { RESEARCH_SYSTEM, FORMAT_SYSTEM, REPORT_JSON_SCHEMA, researchPrompt, reportPrompt, parseReport } from "./shared.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
// Server key (local/private deployments). Visitors can also send their own key per request.
const SERVER_KEY = process.env.ANTHROPIC_API_KEY;
// Each web search adds its result pages to the input, so this is the main cost/time lever.
const MAX_SEARCHES = Math.max(1, Number(process.env.MAX_WEB_SEARCHES) || 3);

// Overloaded or server-side failures are worth another try (the SDK already retries twice).
const isOverloaded = (err) =>
  err instanceof Anthropic.APIConnectionTimeoutError ||
  (err instanceof Anthropic.APIError && [500, 502, 503, 504, 529].includes(err.status));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, send) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isOverloaded(err)) throw err;
      lastErr = err;
      send({ type: "progress", message: "Claude is busy, retrying..." });
      await sleep(attempt === 0 ? 3000 : 8000);
    }
  }
  throw lastErr;
}

async function researchOnce(ai, brief, useSearch, send, signal) {
  const messages = [{ role: "user", content: researchPrompt(brief, useSearch, MAX_SEARCHES) }];

  const sources = new Map();
  let searches = 0;
  let notesText = "";

  // Server-side web search can pause a long turn (pause_turn); resume it a few times.
  for (let turn = 0; turn < 5; turn++) {
    const stream = ai.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: RESEARCH_SYSTEM,
      messages,
      ...(useSearch && { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }] }),
    }, { signal });

    let lastReport = notesText.length;
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        // web_search also runs internal code-execution steps; count only real searches.
        if (block.type === "server_tool_use" && block.name === "web_search") {
          searches++;
          send({ type: "progress", message: `Searching the web (${searches})...` });
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.url && !sources.has(r.url)) sources.set(r.url, { title: r.title || r.url, url: r.url });
          }
        }
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        notesText += event.delta.text;
        if (notesText.length - lastReport > 1500) {
          lastReport = notesText.length;
          send({ type: "progress", message: `Writing research notes… (${sources.size} sources so far)` });
        }
      }
    }

    const message = await stream.finalMessage();
    for (const block of message.content) {
      if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) send({ type: "search", query: block.input.query });
    }
    if (message.stop_reason === "refusal") {
      throw new Error("Claude declined this request. Try rephrasing the business details.");
    }
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }
  return { notesText, sources, searches };
}

async function research(ai, brief, send, signal) {
  try {
    const found = await withRetry(() => researchOnce(ai, brief, true, send, signal), send);
    return { ...found, liveSearch: true };
  } catch (err) {
    // Web search can be switched off for an organization in the Claude Console; plain calls still work.
    if (!(err instanceof Anthropic.BadRequestError && /web.?search/i.test(err.message))) throw err;
    console.warn("Claude web search unavailable. Falling back to model knowledge:", err.message);
    send({ type: "progress", message: "⚠ Web search isn't enabled for this Claude key — continuing with Claude's own knowledge (not live-verified)." });
    const found = await withRetry(() => researchOnce(ai, brief, false, send, signal), send);
    return { ...found, liveSearch: false };
  }
}

// The report schema is too large for strict structured outputs (grammar size limit),
// so the schema goes in the prompt and the JSON is validated with Zod afterwards.
async function buildReportOnce(ai, brief, notesText, sourceList, signal) {
  const response = await ai.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    // Formatting existing notes needs little reasoning; keeps this step fast.
    output_config: { effort: "low" },
    system: `${FORMAT_SYSTEM}\n\nRespond with ONLY a single JSON object (no markdown fences, no commentary) that matches this JSON Schema exactly:\n${REPORT_JSON_SCHEMA}`,
    messages: [{ role: "user", content: reportPrompt(brief, notesText, sourceList) }],
  }, { signal }).finalMessage();
  if (response.stop_reason === "refusal") throw new Error("Claude declined to build this report.");

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const report = parseReport(text);
  if (!report) console.warn("Claude report unusable, stop_reason:", response.stop_reason);
  return report;
}

const buildReport = (ai, brief, notesText, sourceList, send, signal) =>
  withRetry(() => buildReportOnce(ai, brief, notesText, sourceList, signal), send);

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key";
  if (err instanceof Anthropic.PermissionDeniedError) return "This Anthropic key doesn't have access to this model or feature";
  if (err instanceof Anthropic.NotFoundError) return `Model "${MODEL}" not found (check CLAUDE_MODEL in .env)`;
  if (err instanceof Anthropic.RateLimitError) return "Claude rate limit / quota reached (429)";
  if (isOverloaded(err)) return "Claude is overloaded right now";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err.message || "Unexpected error";
}

export const claudeInfo = { id: "claude", label: "Claude", model: MODEL, hasServerKey: Boolean(SERVER_KEY), maxSearches: MAX_SEARCHES };

// Builds a provider bound to one API key: the visitor's key if given, otherwise the server's.
export function createClaude(userKey) {
  const apiKey = userKey || SERVER_KEY;
  if (!apiKey) return null;
  const ai = new Anthropic({ apiKey });
  return {
    ...claudeInfo,
    usesVisitorKey: Boolean(userKey),
    research: (brief, send, signal) => research(ai, brief, send, signal),
    buildReport: (brief, notesText, sourceList, send, signal) => buildReport(ai, brief, notesText, sourceList, send, signal),
    describeError,
    isAbort: (err) => err instanceof Anthropic.APIUserAbortError,
  };
}
