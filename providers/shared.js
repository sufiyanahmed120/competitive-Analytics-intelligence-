import { z } from "zod";
import { ReportSchema } from "../schema.js";

// Plain JSON Schema for the report (without zod's $schema marker).
const { $schema, ...reportJsonSchema } = z.toJSONSchema(ReportSchema);
export const REPORT_JSON_OBJECT = reportJsonSchema;
export const REPORT_JSON_SCHEMA = JSON.stringify(reportJsonSchema);

export const RESEARCH_SYSTEM = `You are a senior marketing strategist and competitive-intelligence analyst.
Your job: research a business and its real competitors in a specific location using web search, then write detailed research notes.

Research method:
1. Identify the target business: what it sells, positioning, price tier, reputation (Google/Yelp/Trustpilot ratings if available), website, social presence.
2. Find 4-6 REAL competitors that operate in or serve the same location (direct competitors first, then 1-2 notable indirect/online alternatives). Never invent businesses; only include ones you found evidence for.
3. For each competitor gather: website, offering, pricing signals, target audience, unique selling proposition, review ratings and review themes, marketing channels (SEO, social, ads, local listings, partnerships), and any recent news.
4. Research the local market: demand trends, customer segments, seasonality, and gaps nobody is serving well.

Be specific and factual. When a figure is an estimate, say so. Prefer recent sources.
Write thorough plain-text research notes covering everything above, organized by business.`;

export const FORMAT_SYSTEM = `You convert competitive research notes into a structured marketing competitive analysis report.
Rules:
- Use only facts present in the notes; when a value is unknown use null (or "Unknown" for required text) rather than inventing it.
- Scores are 1-10 comparative judgments across the target and its competitors on the same scale, justified by the notes.
- Recommendations must be concrete, actionable marketing moves for the TARGET business that exploit specific competitor weaknesses or market gaps. Give 5-8 of them.
- Write concisely: short sentences, no filler.`;

export function researchPrompt(brief, useSearch, maxSearches) {
  if (!useSearch) {
    return `${brief}\n\nWeb search is unavailable, so use your own knowledge. Only name competitors you are confident really exist in this location, and flag anything uncertain. Write the research notes now.`;
  }
  const limit = maxSearches
    ? ` You have at most ${maxSearches} web searches, so make each query broad enough to cover several competitors at once.`
    : "";
  return `${brief}\n\nResearch this business and its competitors now.${limit}`;
}

export const reportPrompt = (brief, notesText, sourceList) =>
  `${brief}\n\n<research_notes>\n${notesText}\n</research_notes>\n\n<sources>\n${sourceList}\n</sources>\n\nProduce the competitive analysis report.`;

// Pulls the JSON object out of a model reply and validates it; null if unusable.
export function parseReport(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    console.warn("Report reply had no JSON object. Starts with:", text.slice(0, 200));
    return null;
  }
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    console.warn("Report JSON did not parse:", err.message);
    return null;
  }
  const result = ReportSchema.safeParse(data);
  if (!result.success) console.warn("Report failed validation:", result.error.issues.slice(0, 3));
  return result.success ? result.data : null;
}
