const $ = (sel) => document.querySelector(sel);
const views = { search: $("#searchView"), progress: $("#progressView"), report: $("#reportView") };
const SCORE_LABELS = {
  pricing_value: "Value for money",
  product_quality: "Product quality",
  brand_strength: "Brand strength",
  digital_presence: "Digital presence",
  customer_experience: "Customer experience",
  innovation: "Innovation",
};
const RECENT_KEY = "rivalscope.recent";

let liveMode = false;
let controller = null;

// ---------- utils ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const list = (items) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p class="muted">None found</p>`);
const cap = (s) => { const t = String(s ?? ""); return t.charAt(0).toUpperCase() + t.slice(1); };
const avg = (o) => { const v = Object.values(o || {}); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
const safeUrl = (u) => {
  if (!u) return null;
  const full = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try { const url = new URL(full); return url.protocol.startsWith("http") ? url.href : null; } catch { return null; }
};

function show(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
  window.scrollTo({ top: 0 });
}

// ---------- theme ----------
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem("rivalscope.theme")); } catch {}
$("#themeBtn").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("rivalscope.theme", next); } catch {}
  if (currentReport) renderReport(currentReport);
});

// ---------- status ----------
fetch("/api/status").then((r) => r.json()).then((s) => {
  liveMode = s.live;
  const pill = $("#modePill");
  const chain = (s.providers || []).map((p) => p.label).join(" → ");
  pill.textContent = s.live ? `Live AI · ${chain}` : "Demo mode";
  pill.title = (s.providers || []).map((p) => `${p.label}: ${p.model}`).join("\n");
  pill.className = `pill ${s.live ? "live" : "demo"}`;
  $("#modeHint").textContent = s.live
    ? `Uses live web search. A full analysis takes about 1–3 minutes.${s.providers.length > 1 ? ` If ${s.providers[0].label} fails, ${s.providers.slice(1).map((p) => p.label).join(", ")} takes over automatically.` : ""}`
    : "Demo mode: add ANTHROPIC_API_KEY and/or GEMINI_API_KEY to your .env file and restart the server to analyze real businesses. You can still view the sample report.";
}).catch(() => { $("#modePill").textContent = "Offline"; });

// ---------- recent (browser-only convenience) ----------
function loadRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
function saveRecent(report) {
  try {
    const key = `${report.input.business}|${report.input.location}`.toLowerCase();
    const items = [{ key, report }, ...loadRecent().filter((i) => i.key !== key)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {}
  renderRecent();
}
function renderRecent() {
  const items = loadRecent();
  $("#recentWrap").classList.toggle("hidden", !items.length);
  $("#recentList").innerHTML = items.map((i, idx) =>
    `<button class="chip" data-idx="${idx}">${esc(i.report.input.business)} · ${esc(i.report.input.location)}</button>`).join("");
  $("#recentList").querySelectorAll(".chip").forEach((b) =>
    b.addEventListener("click", () => renderReport(items[+b.dataset.idx].report)));
}
renderRecent();

// ---------- analysis flow ----------
function logLine(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  $("#log").appendChild(div);
  $("#log").scrollTop = $("#log").scrollHeight;
}
function setStep(stage) {
  const order = ["research", "analysis", "done"];
  const idx = order.indexOf(stage);
  order.forEach((s, i) => {
    const el = $(`#step-${s}`);
    el.classList.toggle("done", i < idx || stage === "done");
    el.classList.toggle("active", i === idx && stage !== "done");
  });
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (!liveMode) {
    alert("Demo mode: add ANTHROPIC_API_KEY and/or GEMINI_API_KEY in the .env file and restart the server to run live analyses. Showing the sample report instead.");
    return showSample();
  }
  await runAnalysis(data);
});

async function runAnalysis(data) {
  show("progress");
  $("#log").innerHTML = "";
  $("#progressTitle").textContent = `Analyzing ${data.business}…`;
  setStep("research");
  controller = new AbortController();

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let report = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "stage") { setStep(ev.stage); logLine(`<b>${esc(ev.message)}</b>`); }
        else if (ev.type === "search") logLine(`🔎 ${esc(ev.query)}`);
        else if (ev.type === "progress") logLine(esc(ev.message));
        else if (ev.type === "error") throw new Error(ev.message);
        else if (ev.type === "result") report = ev.report;
        else if (ev.type === "heartbeat") $("#progressSub").textContent = `Still working… ${Math.floor(ev.elapsed / 60)}m ${ev.elapsed % 60}s elapsed`;
      }
    }
    if (!report) throw new Error("The analysis ended without a report. Please try again.");
    setStep("done");
    saveRecent(report);
    renderReport(report);
  } catch (err) {
    if (err.name === "AbortError") return show("search");
    showError(err.message);
  } finally {
    controller = null;
  }
}

$("#cancelBtn").addEventListener("click", () => controller?.abort());
$("#sampleBtn").addEventListener("click", showSample);
$("#homeLink").addEventListener("click", (e) => { e.preventDefault(); show("search"); });

async function showSample() {
  const report = await fetch("/api/sample").then((r) => r.json());
  renderReport(report);
}

function showError(message) {
  views.report.innerHTML = `
    <div class="card error-box">
      <h2>Analysis failed</h2>
      <p>${esc(message)}</p>
      <button class="btn primary" id="retryBtn">Back to search</button>
    </div>`;
  show("report");
  $("#retryBtn").addEventListener("click", () => show("search"));
}

// ---------- report rendering ----------
let currentReport = null;

function stars(r) { return r == null ? `<span class="muted">No rating</span>` : `<span class="stars">★ ${Number(r).toFixed(1)}</span>`; }

function bizCard(b, { target = false } = {}) {
  const url = safeUrl(b.website);
  return `
    <article class="card biz ${target ? "target" : ""}">
      <div class="biz-top">
        <div>
          <h3>${esc(b.name)}</h3>
          <div class="meta">${esc(b.location)}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">website ↗</a>` : ""}</div>
        </div>
        <div class="badges">
          ${target ? `<span class="badge accent">Your business</span>` : `<span class="badge ${b.threat_level}">${esc(cap(b.threat_level))} threat</span>`}
        </div>
      </div>
      <div class="badges">
        ${!target ? `<span class="badge">${esc(cap(b.type))}</span>` : ""}
        <span class="badge">${esc(cap(b.price_tier))}</span>
        <span class="badge">${stars(b.rating)}${b.review_count ? ` · ${esc(b.review_count)}` : ""}</span>
      </div>
      <p style="margin:0;font-size:14px">${esc(b.description)}</p>
      <div class="usp"><b>USP:</b> ${esc(b.usp)}</div>
      <div class="meta"><b>Audience:</b> ${esc(b.target_audience)}</div>
      <div class="twocol">
        <div class="mini pos"><h4>Strengths</h4>${list(b.strengths)}</div>
        <div class="mini neg"><h4>Weaknesses</h4>${list(b.weaknesses)}</div>
      </div>
      <div class="chips">${(b.marketing_channels || []).map((c) => `<span class="chip static">${esc(c)}</span>`).join("")}</div>
      ${!target && b.threat_reason ? `<div class="threat-note">${esc(b.threat_reason)}</div>` : ""}
    </article>`;
}

function renderReport(r) {
  currentReport = r;

  const THREAT = ["high", "medium", "low"];
  const byThreat = [...r.competitors].sort((a, b) => THREAT.indexOf(a.threat_level) - THREAT.indexOf(b.threat_level));
  const all = [{ ...r.target, _target: true }, ...byThreat];
  const highThreats = r.competitors.filter((c) => c.threat_level === "high").length;
  const rated = r.competitors.filter((c) => c.rating != null);
  const avgRating = rated.length ? rated.reduce((a, c) => a + c.rating, 0) / rated.length : null;
  const ranked = [...all].sort((a, b) => avg(b.scores) - avg(a.scores));
  const rank = ranked.findIndex((b) => b._target) + 1;
  const date = new Date(r.generated_at).toLocaleString();

  const recs = [...r.recommendations].sort((a, b) =>
    ["high", "medium", "low"].indexOf(a.priority) - ["high", "medium", "low"].indexOf(b.priority));

  views.report.innerHTML = `
    <div class="report-head">
      <div>
        <div class="eyebrow">Competitive analysis</div>
        <h1>${esc(r.input.business)}</h1>
        <div class="sub">${esc(r.input.location)}<span class="dot">·</span>${esc(cap(r.industry))}<span class="dot">·</span>Generated ${esc(date)}${r.ai ? `<span class="dot">·</span>AI: ${esc(r.ai.research === r.ai.report ? r.ai.research : `research ${r.ai.research}, report ${r.ai.report}`)}` : ""}</div>
      </div>
      <div class="actions">
        <button class="btn sm ghost" id="newBtn">← New analysis</button>
        <button class="btn sm ghost" id="jsonBtn">Download JSON</button>
        <button class="btn sm primary" id="printBtn">Save as PDF</button>
      </div>
    </div>
    ${r.demo ? `<div class="demo-banner">Sample report with fictional businesses — add your API key to analyze real companies.</div>` : ""}
    ${r.ai?.fallback_used ? `<div class="demo-banner">ℹ The main AI provider failed, so the backup took over (${esc(r.ai.research === r.ai.report ? r.ai.research : `research: ${r.ai.research}, report: ${r.ai.report}`)}).</div>` : ""}
    ${r.live_search === false ? `<div class="demo-banner">⚠ Built from the AI's own knowledge — web search isn't enabled for this API key, so details weren't verified live. Double-check names, ratings and prices.</div>` : ""}

    <nav class="secnav">
      <a href="#s-overview">Overview</a><a href="#s-competitors">Competitors</a><a href="#s-compare">Compare</a>
      <a href="#s-swot">SWOT</a><a href="#s-market">Market & Gaps</a><a href="#s-plan">Action Plan</a>
      ${r.sources?.length ? `<a href="#s-sources">Sources</a>` : ""}
    </nav>

    <section class="section" id="s-overview">
      <div class="kpis">
        <div class="card kpi"><div class="l">Competitors found</div><div class="v">${r.competitors.length}</div></div>
        <div class="card kpi"><div class="l">High-threat rivals</div><div class="v" style="color:${highThreats ? "var(--high)" : "inherit"}">${highThreats}</div></div>
        <div class="card kpi"><div class="l">Market position</div><div class="v">${esc(r.overall_position)}</div></div>
        <div class="card kpi"><div class="l">Overall rank</div><div class="v">#${rank} <span class="muted" style="font-size:13px;font-weight:400">out of ${all.length}</span></div></div>
        <div class="card kpi"><div class="l">Your rating</div><div class="v">${r.target.rating != null ? `★ ${r.target.rating.toFixed(1)}` : "–"} <span class="muted" style="font-size:13px;font-weight:400">avg ${avgRating != null ? avgRating.toFixed(1) : "–"}</span></div></div>
      </div>
      <div class="card pad summary"><div class="l">Executive summary</div>${esc(r.executive_summary)}</div>
    </section>

    <section class="section" id="s-competitors">
      <h2>Competitor profiles <small>your business first, then rivals by threat</small></h2>
      <div class="grid-cards">
        ${bizCard(r.target, { target: true })}
        ${byThreat.map((c) => bizCard(c)).join("")}
      </div>
    </section>

    <section class="section" id="s-compare">
      <h2>Head-to-head comparison <small>Your score out of 10 in each area, next to the best competitor in that area</small></h2>
      <div class="card pad cmp">${compareRows(r.target, r.competitors)}</div>
      <div class="card table-wrap">
        <table>
          <thead><tr><th>Business</th>${Object.values(SCORE_LABELS).map((l) => `<th>${l}</th>`).join("")}<th>Overall</th><th>Rating</th><th>Price</th></tr></thead>
          <tbody>
            ${ranked.map((b) => `
              <tr class="${b._target ? "is-target" : ""}">
                <td>${esc(b.name)}${b._target ? " (you)" : ""}</td>
                ${Object.keys(SCORE_LABELS).map((k) => scoreCell(b.scores[k])).join("")}
                ${scoreCell(avg(b.scores), 1)}
                <td>${b.rating != null ? b.rating.toFixed(1) : "–"}</td>
                <td style="text-transform:capitalize">${esc(b.price_tier)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>

    <section class="section" id="s-swot">
      <h2>SWOT analysis <small>for ${esc(r.target.name)}</small></h2>
      <div class="swot">
        <div class="card s"><h3>Strengths</h3>${list(r.swot.strengths)}</div>
        <div class="card w"><h3>Weaknesses</h3>${list(r.swot.weaknesses)}</div>
        <div class="card o"><h3>Opportunities</h3>${list(r.swot.opportunities)}</div>
        <div class="card t"><h3>Threats</h3>${list(r.swot.threats)}</div>
      </div>
    </section>

    <section class="section" id="s-market">
      <h2>Market & gaps</h2>
      <div class="card pad">${esc(r.market.overview)}</div>
      <div class="market-grid">
        <div class="card"><h3>📈 Trends</h3>${list(r.market.trends)}</div>
        <div class="card"><h3>👥 Customer segments</h3>${list(r.market.customer_segments)}</div>
        <div class="card" style="border:2px solid var(--accent-2)"><h3>🎯 Gaps to exploit</h3><div class="gap-list">${list(r.market.market_gaps)}</div></div>
      </div>
    </section>

    <section class="section" id="s-plan">
      <h2>Marketing action plan</h2>
      <div class="plan">
        ${recs.map((rec, i) => `
          <div class="card rec">
            <div class="num">${i + 1}</div>
            <div>
              <h3>${esc(rec.title)}</h3>
              <p>${esc(rec.detail)}</p>
              <div class="badges">
                <span class="badge ${rec.priority}">${esc(cap(rec.priority))} priority</span>
                <span class="badge">⏱ ${esc(rec.timeframe)}</span>
                <span class="badge accent">${esc(rec.channel)}</span>
                ${rec.counters ? `<span class="badge">vs ${esc(rec.counters)}</span>` : ""}
              </div>
            </div>
          </div>`).join("")}
      </div>
      ${r.keyword_opportunities?.length ? `
        <div class="card pad" style="margin-top:16px">
          <h3 style="margin:0 0 10px;font-size:15px">🔑 Keyword opportunities</h3>
          <div class="chips">${r.keyword_opportunities.map((k) => `<span class="chip static">${esc(k)}</span>`).join("")}</div>
        </div>` : ""}
    </section>

    ${r.sources?.length ? `
    <section class="section sources" id="s-sources">
      <h2>Sources <small>${r.sources.length} pages researched</small></h2>
      <div class="card pad"><ol>${r.sources.map((s) => {
        const u = safeUrl(s.url);
        return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>` : esc(s.title)}</li>`;
      }).join("")}</ol></div>
    </section>` : ""}
  `;

  show("report");
  $("#newBtn").addEventListener("click", () => show("search"));
  $("#printBtn").addEventListener("click", () => window.print());
  $("#jsonBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `competitive-analysis-${r.input.business.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function compareRows(target, competitors) {
  return Object.entries(SCORE_LABELS).map(([k, label]) => {
    const you = Number(target.scores[k]) || 0;
    const best = competitors.reduce((a, c) => ((c.scores[k] || 0) > (a?.scores[k] || 0) ? c : a), null);
    const them = Number(best?.scores[k]) || 0;
    const diff = you - them;
    const verdict = diff > 0 ? `<span class="badge low">You lead</span>`
      : diff < 0 ? `<span class="badge high">Behind by ${-diff}</span>`
      : `<span class="badge">Tied</span>`;
    const bar = (name, v, cls) => `
      <div class="bar-line">
        <span class="bar-label">${name}</span>
        <div class="bar"><i class="${cls}" style="width:${v * 10}%"></i></div>
        <b>${v}</b>
      </div>`;
    return `
      <div class="cmp-row">
        <div class="cmp-head"><span>${label}</span>${verdict}</div>
        ${bar("You", you, "you")}
        ${best ? bar(esc(best.name), them, "rival") : ""}
      </div>`;
  }).join("");
}

function scoreCell(v, digits = 0) {
  const n = Number(v) || 0;
  const pct = Math.max(0, Math.min(1, (n - 1) / 9));
  // red → amber → green background by score
  const hue = Math.round(pct * 130);
  return `<td class="score" style="background:hsla(${hue},60%,50%,0.13)">${n.toFixed(digits)}</td>`;
}

