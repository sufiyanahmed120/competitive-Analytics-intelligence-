# RivalScope — Competitive Analysis MVP

Single-page app: type a business name + location and get a full marketing competitive analysis of its real local competitors.

## What you get
- **Overview** – executive summary, number of competitors, high-threat count, market position, overall rank, your rating vs. competitor average
- **Competitor profiles** – website, price tier, rating/reviews, USP, target audience, strengths, weaknesses, marketing channels, threat level + reason
- **Head-to-head comparison** – "you vs. best rival" bars for each area, color-coded score table (value, quality, brand, digital, customer experience, innovation)
- **SWOT** for your business
- **Market & gaps** – trends, customer segments, unserved needs
- **Marketing action plan** – prioritized moves with timeframe, channel and which competitor each one beats, plus keyword opportunities
- **Sources** – every web page the research used
- Export as JSON or PDF (print). The last 5 reports are kept in your browser (no database, no login).

## How it works
1. `POST /api/analyze` asks the AI to research the business with live **web search** (progress is streamed to the page).
2. A second call converts the research notes into a JSON report (`schema.js`), validated before the page renders it.

### AI providers and fallback
Two providers are supported: **Claude first, Gemini as backup**. Each step (research, report) runs on Claude; if Claude fails (bad key, quota, overload, timeout), the same step is retried on Gemini automatically. Add only one key and only that provider is used. The report header shows which AI produced it.

## Run it
```bash
npm install
cp .env.example .env      # then add ANTHROPIC_API_KEY and/or GEMINI_API_KEY
npm run dev               # open http://localhost:3000 (auto-restarts on code changes)
```
| `.env` setting | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Claude key (main provider) |
| `CLAUDE_MODEL` | `claude-opus-5` | Claude model |
| `MAX_WEB_SEARCHES` | `3` | Claude web-search limit per analysis (cost/time) |
| `GEMINI_API_KEY` | – | Gemini key (backup provider) |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model |

Without any API key the app runs in **demo mode** and shows a sample report with fictional businesses.

## Files
- `server.js` – Express server + provider fallback pipeline
- `providers/claude.js`, `providers/gemini.js` – one file per AI provider
- `providers/shared.js` – prompts and report parsing shared by both
- `schema.js` – report structure (Zod)
- `sample.js` – demo report
- `public/` – the single-page UI (`index.html`, `styles.css`, `app.js`)
