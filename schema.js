import { z } from "zod";

const Level = z.enum(["high", "medium", "low"]);
const PriceTier = z.enum(["budget", "mid-range", "premium", "luxury", "unknown"]);

// 1-10 comparative scores; the same axes are used for the target and every competitor.
const Scores = z.object({
  pricing_value: z.number().describe("1-10, higher = better value for money"),
  product_quality: z.number().describe("1-10"),
  brand_strength: z.number().describe("1-10"),
  digital_presence: z.number().describe("1-10, website/SEO/social"),
  customer_experience: z.number().describe("1-10, reviews/service"),
  innovation: z.number().describe("1-10"),
});

const Business = z.object({
  name: z.string(),
  website: z.string().nullable(),
  location: z.string(),
  description: z.string(),
  price_tier: PriceTier,
  target_audience: z.string(),
  usp: z.string().describe("Unique selling proposition"),
  rating: z.number().nullable().describe("Average public review rating out of 5, null if unknown"),
  review_count: z.string().nullable().describe("e.g. '1,200+ Google reviews'"),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  marketing_channels: z.array(z.string()),
  scores: Scores,
});

export const ReportSchema = z.object({
  executive_summary: z.string().describe("4-6 sentence overview of the competitive landscape and the target's position"),
  industry: z.string(),
  target: Business,
  competitors: z.array(Business.extend({
    type: z.enum(["direct", "indirect"]),
    threat_level: Level,
    threat_reason: z.string(),
  })),
  market: z.object({
    overview: z.string(),
    trends: z.array(z.string()),
    customer_segments: z.array(z.string()),
    market_gaps: z.array(z.string()).describe("Needs that no competitor serves well"),
  }),
  swot: z.object({
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    opportunities: z.array(z.string()),
    threats: z.array(z.string()),
  }),
  recommendations: z.array(z.object({
    title: z.string(),
    detail: z.string(),
    priority: Level,
    timeframe: z.enum(["0-30 days", "1-3 months", "3-6 months", "6-12 months"]),
    channel: z.string().describe("e.g. Local SEO, Instagram, Google Ads, Partnerships, Pricing"),
    counters: z.string().nullable().describe("Which competitor this move beats, if any"),
  })),
  keyword_opportunities: z.array(z.string()).describe("Search keywords/phrases the target should rank for"),
  overall_position: z.enum(["leader", "challenger", "follower", "niche"]),
});
