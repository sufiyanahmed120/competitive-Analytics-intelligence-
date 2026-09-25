import { GoogleGenAI, ApiError, ThinkingLevel } from "@google/genai";
import { RESEARCH_SYSTEM, FORMAT_SYSTEM, REPORT_JSON_OBJECT, researchPrompt, reportPrompt, parseReport } from "./shared.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const RESEARCH_TIMEOUT_MS = 240_000;
const REPORT_TIMEOUT_MS = 150_000;

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

const isOverloaded = (err) =>
  (err instanceof ApiError && [500, 503, 504].includes(err.status)) ||
  err?.name === "TimeoutError" || /timed? ?out/i.test(err?.message || "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, send) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isOverloaded(err)) throw err;
      lastErr = err;
      send({ type: "progress", message: "Gemini is busy, retrying..." });
      await sleep(attempt === 0 ? 3000 : 8000);
    }
  }
  throw lastErr;
}

async function researchOnce(brief, useSearch, send, signal) {
  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: researchPrompt(brief, useSearch),
    config: {
      systemInstruction: RESEARCH_SYSTEM,
      ...(useSearch && { tools: [{ googleSearch: {} }] }),
      maxOutputTokens: 16000,
      abortSignal: signal,
      httpOptions: { timeout: RESEARCH_TIMEOUT_MS },
    },
  });

  const sources = new Map();
  const queries = new Set();
  let notesText = "";
  let lastReport = 0;

  for await (const chunk of stream) {
    if (signal.aborted) break;
    if (chunk.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked this request (${chunk.promptFeedback.blockReason})`);
    }
    const meta = chunk.candidates?.[0]?.groundingMetadata;
    for (const q of meta?.webSearchQueries || []) {
      if (!queries.has(q)) { queries.add(q); send({ type: "search", query: q }); }
    }
    for (const g of meta?.groundingChunks || []) {
      if (g.web?.uri && !sources.has(g.web.uri)) sources.set(g.web.uri, { title: g.web.title || g.web.uri, url: g.web.uri });
    }
    if (chunk.text) notesText += chunk.text;
    if (notesText.length - lastReport > 1500) {
      lastReport = notesText.length;
      send({ type: "progress", message: `Writing research notes… (${sources.size} sources so far)` });
    }
  }
  return { notesText, sources, searches: queries.size };
}

async function research(brief, send, signal) {
  try {
    const found = await withRetry(() => researchOnce(brief, true, send, signal), send);
    return { ...found, liveSearch: true };
  } catch (err) {
    // 429 on a grounded request usually means this key has no Google Search quota; plain calls still work.
    if (!(err instanceof ApiError && err.status === 429)) throw err;
    console.warn("Gemini Google Search rejected (429). Falling back to model knowledge:", err.message);
    send({ type: "progress", message: "⚠ Google Search isn't enabled for this Gemini key — continuing with Gemini's own knowledge (not live-verified)." });
    const found = await withRetry(() => researchOnce(brief, false, send, signal), send);
    return { ...found, liveSearch: false };
  }
}

async function buildReportOnce(brief, notesText, sourceList, signal) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: reportPrompt(brief, notesText, sourceList),
    config: {
      systemInstruction: FORMAT_SYSTEM,
      responseMimeType: "application/json",
      responseJsonSchema: REPORT_JSON_OBJECT,
      maxOutputTokens: 16000,
      // Formatting existing notes needs little reasoning; keeps this step fast.
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      abortSignal: signal,
      httpOptions: { timeout: REPORT_TIMEOUT_MS },
    },
  });
  return response.text ? parseReport(response.text) : null;
}

const buildReport = (brief, notesText, sourceList, send, signal) =>
  withRetry(() => buildReportOnce(brief, notesText, sourceList, signal), send);

function describeError(err) {
  if (err instanceof ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) return "Invalid Gemini API key (check GEMINI_API_KEY in .env)";
    if (err.status === 403) return "This Gemini key doesn't have access";
    if (err.status === 404) return `Gemini model "${MODEL}" not found (check GEMINI_MODEL in .env)`;
    if (err.status === 429) return "Gemini quota reached (429) — check your key's tier at https://aistudio.google.com/usage";
    if (isOverloaded(err)) return "Gemini is overloaded right now";
    return `Gemini API error ${err.status}`;
  }
  if (isOverloaded(err)) return "Gemini timed out";
  return err.message || "Unexpected error";
}

export const gemini = {
  id: "gemini",
  label: "Gemini",
  model: MODEL,
  enabled: Boolean(ai),
  research,
  buildReport,
  describeError,
  isAbort: (err) => err?.name === "AbortError",
};
