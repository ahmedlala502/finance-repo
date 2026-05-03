(function () {
  const PERF_ROUTE = "/sales-rep-performance";
  const TARGET_ROUTE = "/sales-team";
  const TARGET_ALIAS = "/sales-targets";
  const OVERLAY_ID = "trygc-sales-route-surface";
  const QUOTA = 750000;
  const STAGE_WON = 6;
  const STAGE_LOST = 7;
  const KEYS = {
    period: "repPerfPeriod",
    rep: "repPerfRep",
    state: "repPerfStatus",
    market: "repPerfMarket",
    service: "repPerfService",
    targets: "FS_SALES_TARGETS",
    targetPeriod: "salesTargetPeriod"
  };

  const DEFAULT_DEALS = [];

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function money(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: Math.abs(value || 0) >= 1000000 ? "compact" : "standard",
      maximumFractionDigits: 0
    }).format(value || 0);
  }

  function pct(value) {
    return `${Math.round(value || 0)}%`;
  }

  function normalize(path) {
    return String(path || "").replace(/\/$/, "") || "/";
  }

  function getDeals() {
    const deals = readJson("FS_DEALS", null);
    return Array.isArray(deals) ? deals : DEFAULT_DEALS;
  }

  function getTargets(reps) {
    const stored = readJson(KEYS.targets, {});
    const targets = stored && typeof stored === "object" ? stored : {};
    reps.forEach(function (rep) {
      if (!targets[rep]) targets[rep] = { target: QUOTA, period: localStorage.getItem(KEYS.targetPeriod) || "Current", note: "" };
    });
    return targets;
  }

  function inPeriod(deal, period) {
    if (period === "all") return true;
    const created = Number(deal.createdAt || 0);
    if (!created) return true;
    const now = Date.now();
    if (period === "30") return created >= now - 30 * 86400000;
    if (period === "90") return created >= now - 90 * 86400000;
    if (period === "year") return created >= new Date(new Date().getFullYear(), 0, 1).getTime();
    return true;
  }

  function isWon(deal) {
    return deal.status === "Won" || Number(deal.stage) === STAGE_WON;
  }

  function isLost(deal) {
    return deal.status === "Lost" || Number(deal.stage) === STAGE_LOST;
  }

  function isOverdue(deal) {
    return deal.nextActionDate && Number(deal.nextActionDate) < Date.now() && !isWon(deal) && !isLost(deal);
  }

  function filteredDeals() {
    const period = localStorage.getItem(KEYS.period) || "all";
    const rep = localStorage.getItem(KEYS.rep) || "all";
    const state = localStorage.getItem(KEYS.state) || "all";
    const market = localStorage.getItem(KEYS.market) || "all";
    const service = localStorage.getItem(KEYS.service) || "all";
    return getDeals().filter(function (deal) {
      if (!inPeriod(deal, period)) return false;
      if (rep !== "all" && (deal.salesOwner || "Unassigned") !== rep) return false;
      if (market !== "all" && (deal.market || "Unknown") !== market) return false;
      if (service !== "all" && (deal.serviceLine || "Unknown") !== service) return false;
      if (state === "active" && (isWon(deal) || isLost(deal))) return false;
      if (state === "won" && !isWon(deal)) return false;
      if (state === "risk" && !isOverdue(deal)) return false;
      return true;
    });
  }

  function aggregate(deals, targets) {
    const rows = new Map();
    deals.forEach(function (deal) {
      const name = deal.salesOwner || "Unassigned";
      const row = rows.get(name) || {
        name,
        revenue: 0,
        collected: 0,
        pipeline: 0,
        weighted: 0,
        profit: 0,
        pending: 0,
        deals: 0,
        won: 0,
        lost: 0,
        active: 0,
        overdue: 0,
        closingSoon: 0,
        markets: new Set(),
        services: new Set()
      };
      const value = Number(deal.dealValue || 0);
      const stage = Math.min(Math.max(Number(deal.stage || 1), 1), 5);
      row.revenue += value;
      row.collected += Number(deal.collectedAmount || 0);
      row.pending += Number(deal.pendingAmount || 0);
      row.profit += Number(deal.grossProfit || 0);
      row.deals += 1;
      if (deal.market) row.markets.add(deal.market);
      if (deal.serviceLine) row.services.add(deal.serviceLine);
      if (isWon(deal)) row.won += 1;
      else if (isLost(deal)) row.lost += 1;
      else {
        row.active += 1;
        row.pipeline += value;
        row.weighted += value * stage / 5;
        if (isOverdue(deal)) row.overdue += 1;
        const closeDays = deal.expectedClosingDate ? Math.ceil((new Date(deal.expectedClosingDate).getTime() - Date.now()) / 86400000) : null;
        if (closeDays != null && closeDays >= 0 && closeDays <= 30) row.closingSoon += 1;
      }
      rows.set(name, row);
    });

    Object.keys(targets).forEach(function (name) {
      if (!rows.has(name)) rows.set(name, {
        name,
        revenue: 0,
        collected: 0,
        pipeline: 0,
        weighted: 0,
        profit: 0,
        pending: 0,
        deals: 0,
        won: 0,
        lost: 0,
        active: 0,
        overdue: 0,
        closingSoon: 0,
        markets: new Set(),
        services: new Set()
      });
    });

    return Array.from(rows.values()).map(function (row) {
      const target = Number((targets[row.name] && targets[row.name].target) || QUOTA);
      const targetGap = Math.max(0, target - row.collected);
      const attainment = target ? row.collected / target * 100 : 0;
      const coverage = targetGap ? row.weighted / targetGap * 100 : 100;
      const closed = row.won + row.lost;
      const winRate = closed ? row.won / closed * 100 : 0;
      const margin = row.revenue ? row.profit / row.revenue * 100 : 0;
      const score = Math.max(0, attainment * 0.34 + winRate * 0.22 + Math.min(coverage, 180) * 0.18 + margin * 0.14 + Math.min(row.won * 4, 12) - Math.min(row.overdue * 6, 18));
      return {
        ...row,
        target,
        targetGap,
        attainment,
        coverage,
        winRate,
        margin,
        score,
        avgDeal: row.deals ? row.revenue / row.deals : 0,
        markets: Array.from(row.markets),
        services: Array.from(row.services)
      };
    }).sort(function (a, b) {
      return b.score - a.score;
    });
  }

  function kpi(label, value, sub, tone) {
    return `<div class="rep-perf__card ${tone ? `rep-perf__card--${tone}` : ""}"><p class="rep-perf__card-label">${label}</p><p class="rep-perf__card-value">${value}</p><p class="rep-perf__card-sub">${sub}</p></div>`;
  }

  function badge(text, tone) {
    return `<span class="rep-perf__badge rep-perf__badge--${tone}">${text}</span>`;
  }

  function panel(label, title, body) {
    return `<section class="rep-perf__panel"><div class="rep-perf__panel-head"><p class="rep-perf__panel-label">${label}</p><h3 class="rep-perf__panel-title">${title}</h3></div>${body}</section>`;
  }

  function renderPerformance(surface) {
    const allDeals = getDeals();
    const allReps = Array.from(new Set(allDeals.map(function (deal) { return deal.salesOwner || "Unassigned"; }))).sort();
    const allMarkets = Array.from(new Set(allDeals.map(function (deal) { return deal.market || "Unknown"; }))).sort();
    const allServices = Array.from(new Set(allDeals.map(function (deal) { return deal.serviceLine || "Unknown"; }))).sort();
    const targets = getTargets(allReps);
    const deals = filteredDeals();
    const reps = aggregate(deals, targets);
    const totals = reps.reduce(function (acc, rep) {
      acc.target += rep.target;
      acc.collected += rep.collected;
      acc.weighted += rep.weighted;
      acc.pipeline += rep.pipeline;
      acc.profit += rep.profit;
      acc.won += rep.won;
      acc.overdue += rep.overdue;
      acc.closingSoon += rep.closingSoon;
      return acc;
    }, { target: 0, collected: 0, weighted: 0, pipeline: 0, profit: 0, won: 0, overdue: 0, closingSoon: 0 });
    const best = reps[0];
    const weakest = reps.slice().sort(function (a, b) { return a.coverage - b.coverage; })[0];
    const margin = reps.slice().sort(function (a, b) { return b.margin - a.margin; })[0];
    const risk = reps.slice().sort(function (a, b) { return b.overdue - a.overdue; })[0];
    const maxScore = Math.max.apply(null, reps.map(function (rep) { return rep.score; }).concat([1]));
    const topDeals = deals.slice().sort(function (a, b) { return Number(b.dealValue || 0) - Number(a.dealValue || 0); }).slice(0, 5);

    surface.innerHTML = `
      <div class="rep-perf">
        <div class="rep-perf__header">
          <div>
            <p class="rep-perf__eyebrow">Sales Performance</p>
            <h2 class="rep-perf__title">Representative Performance Command Center</h2>
            <p class="rep-perf__sub">Target attainment, coverage, margin, risk, ranking, and opportunity quality in one operational view.</p>
          </div>
        </div>

        <div class="rep-perf__filter-bar">
          <label class="rep-perf__filter"><span>Period</span><select class="rep-perf__select" id="repPerfPeriod">
            <option value="all"${(localStorage.getItem(KEYS.period) || "all") === "all" ? " selected" : ""}>All time</option>
            <option value="30"${localStorage.getItem(KEYS.period) === "30" ? " selected" : ""}>Last 30 days</option>
            <option value="90"${localStorage.getItem(KEYS.period) === "90" ? " selected" : ""}>Last 90 days</option>
            <option value="year"${localStorage.getItem(KEYS.period) === "year" ? " selected" : ""}>This year</option>
          </select></label>
          <label class="rep-perf__filter"><span>Rep</span><select class="rep-perf__select" id="repPerfRep">
            <option value="all">All reps</option>
            ${allReps.map(function (rep) { return `<option value="${esc(rep)}"${localStorage.getItem(KEYS.rep) === rep ? " selected" : ""}>${esc(rep)}</option>`; }).join("")}
          </select></label>
          <label class="rep-perf__filter"><span>Status</span><select class="rep-perf__select" id="repPerfState">
            <option value="all"${(localStorage.getItem(KEYS.state) || "all") === "all" ? " selected" : ""}>All states</option>
            <option value="active"${localStorage.getItem(KEYS.state) === "active" ? " selected" : ""}>Active only</option>
            <option value="won"${localStorage.getItem(KEYS.state) === "won" ? " selected" : ""}>Won only</option>
            <option value="risk"${localStorage.getItem(KEYS.state) === "risk" ? " selected" : ""}>Overdue risk</option>
          </select></label>
          <label class="rep-perf__filter"><span>Market</span><select class="rep-perf__select" id="repPerfMarket">
            <option value="all">All markets</option>
            ${allMarkets.map(function (market) { return `<option value="${esc(market)}"${localStorage.getItem(KEYS.market) === market ? " selected" : ""}>${esc(market)}</option>`; }).join("")}
          </select></label>
          <label class="rep-perf__filter"><span>Service</span><select class="rep-perf__select" id="repPerfService">
            <option value="all">All services</option>
            ${allServices.map(function (service) { return `<option value="${esc(service)}"${localStorage.getItem(KEYS.service) === service ? " selected" : ""}>${esc(service)}</option>`; }).join("")}
          </select></label>
        </div>

        <div class="rep-perf__analysis-strip">
          ${kpi("Best Momentum", best ? esc(best.name) : "N/A", best ? `${best.won} wins - ${pct(best.coverage)} coverage` : "No data", "green")}
          ${kpi("Coverage Gap", weakest ? esc(weakest.name) : "N/A", weakest ? `${pct(weakest.coverage)} coverage - ${money(weakest.targetGap)} gap` : "No data", "orange")}
          ${kpi("Margin Leader", margin ? esc(margin.name) : "N/A", margin ? `${pct(margin.margin)} margin - ${money(margin.profit)} profit` : "No data", "blue")}
          ${kpi("Action Risk", risk ? esc(risk.name) : "N/A", risk ? `${risk.overdue} overdue - ${risk.closingSoon} closing soon` : "No data", "red")}
        </div>

        <div class="rep-perf__grid rep-perf__kpis">
          ${kpi("Total Attainment", pct(totals.target ? totals.collected / totals.target * 100 : 0), `${money(totals.collected)} collected`)}
          ${kpi("Weighted Coverage", pct((totals.target - totals.collected) > 0 ? totals.weighted / (totals.target - totals.collected) * 100 : 100), `${money(totals.weighted)} weighted pipeline`)}
          ${kpi("Open Pipeline", money(totals.pipeline), `${totals.closingSoon} deals closing within 30 days`)}
          ${kpi("Deals Won", String(totals.won), "closed won opportunities")}
          ${kpi("Gross Profit", money(totals.profit), `${pct(totals.collected ? totals.profit / totals.collected * 100 : 0)} on collected`)}
          ${kpi("Overdue Actions", String(totals.overdue), "follow-ups requiring attention")}
        </div>

        <div class="rep-perf__grid rep-perf__main">
          ${panel("Ranked Performance", "Rep Leaderboard", reps.length ? `
            <div class="rep-perf__table-wrap"><table class="rep-perf__table">
              <thead><tr><th>Rank</th><th>Rep</th><th class="rep-perf__num">Score</th><th class="rep-perf__num">Target</th><th class="rep-perf__num">Collected</th><th class="rep-perf__num">Win</th><th class="rep-perf__num">Coverage</th><th>Status</th></tr></thead>
              <tbody>${reps.map(function (rep, index) {
                const status = rep.attainment >= 100 ? badge("Quota Hit", "green") : rep.overdue ? badge("Risk", "red") : rep.coverage >= 100 ? badge("Covered", "blue") : badge("Needs Pipeline", "orange");
                return `<tr>
                  <td><span class="rep-perf__rank">#${index + 1}</span></td>
                  <td><div class="rep-perf__rep"><span class="rep-perf__avatar">${esc(rep.name.split(/\s+/).map(function (part) { return part[0]; }).join("").slice(0, 2).toUpperCase())}</span><div><p class="rep-perf__rep-name">${esc(rep.name)}</p><p class="rep-perf__rep-meta">${rep.deals} deals - ${rep.markets.length} markets - ${rep.services.length} services</p></div></div></td>
                  <td class="rep-perf__num"><strong>${pct(rep.score)}</strong><div class="rep-perf__progress"><span style="width:${Math.min(rep.score, 100)}%"></span></div></td>
                  <td class="rep-perf__num">${pct(rep.attainment)}</td>
                  <td class="rep-perf__num">${money(rep.collected)}</td>
                  <td class="rep-perf__num">${pct(rep.winRate)}</td>
                  <td class="rep-perf__num">${pct(rep.coverage)}</td>
                  <td>${status}</td>
                </tr>`;
              }).join("")}</tbody>
            </table></div>` : '<div class="rep-perf__empty">No sales performance data found for these filters.</div>')}

          <div class="rep-perf__side">
            ${panel("Priority Coaching", "Who Needs Attention First", `<div class="rep-perf__list">${reps.slice().sort(function (a, b) { return (b.targetGap + b.overdue * 125000) - (a.targetGap + a.overdue * 125000); }).slice(0, 4).map(function (rep) {
              return `<div class="rep-perf__item"><div><p class="rep-perf__item-title">${esc(rep.name)}</p><p class="rep-perf__item-sub">${money(rep.targetGap)} gap - ${rep.overdue} overdue - ${pct(rep.coverage)} coverage</p></div><div class="rep-perf__item-value">${pct(rep.score)}</div></div>`;
            }).join("")}</div>`)}
            ${panel("Largest Opportunities", "Deals That Can Move the Ranking", `<div class="rep-perf__list">${topDeals.map(function (deal) {
              return `<div class="rep-perf__item"><div><p class="rep-perf__item-title">${esc(deal.name || "Untitled Deal")}</p><p class="rep-perf__item-sub">${esc(deal.salesOwner || "Unassigned")} - ${esc(deal.clientName || "No client")}</p></div><div class="rep-perf__item-value">${money(Number(deal.dealValue || 0))}</div></div>`;
            }).join("")}</div>`)}
          </div>
        </div>

      </div>
    `;

    bindFilter(surface, "#repPerfPeriod", KEYS.period);
    bindFilter(surface, "#repPerfRep", KEYS.rep);
    bindFilter(surface, "#repPerfState", KEYS.state);
    bindFilter(surface, "#repPerfMarket", KEYS.market);
    bindFilter(surface, "#repPerfService", KEYS.service);
  }

  function bindFilter(surface, selector, key) {
    const control = surface.querySelector(selector);
    if (!control) return;
    control.addEventListener("change", function () {
      localStorage.setItem(key, control.value);
      renderPerformance(surface);
    });
  }

  function renderTargets(surface) {
    const deals = getDeals();
    const reps = Array.from(new Set(deals.map(function (deal) { return deal.salesOwner || "Unassigned"; }))).sort();
    const targets = getTargets(reps);
    const rows = aggregate(deals, targets);
    surface.innerHTML = `
      <div class="rep-perf rep-perf--targets">
        <div class="rep-perf__header"><div><p class="rep-perf__eyebrow">Sales Targets</p><h2 class="rep-perf__title">Representative Targets</h2><p class="rep-perf__sub">Targets, attainment, gaps, and pipeline coverage for each representative.</p></div></div>
        ${panel("Target Register", "Targets by Sales Representative", `<div class="rep-perf__table-wrap"><table class="rep-perf__table rep-perf__table--targets"><thead><tr><th>Rep</th><th class="rep-perf__num">Target</th><th class="rep-perf__num">Collected</th><th class="rep-perf__num">Attainment</th><th class="rep-perf__num">Gap</th><th class="rep-perf__num">Coverage</th></tr></thead><tbody>${rows.map(function (rep) {
          return `<tr><td>${esc(rep.name)}</td><td class="rep-perf__num">${money(rep.target)}</td><td class="rep-perf__num">${money(rep.collected)}</td><td class="rep-perf__num">${pct(rep.attainment)}</td><td class="rep-perf__num">${money(rep.targetGap)}</td><td class="rep-perf__num">${pct(rep.coverage)}</td></tr>`;
        }).join("")}</tbody></table></div>`)}
      </div>`;
    writeJson(KEYS.targets, targets);
  }

  function ensureSurface() {
    let surface = document.getElementById(OVERLAY_ID);
    if (!surface) {
      surface = document.createElement("div");
      surface.id = OVERLAY_ID;
      surface.setAttribute("aria-live", "polite");
      document.body.appendChild(surface);
    }
    positionSurface(surface);
    return surface;
  }

  function positionSurface(surface) {
    const main = document.querySelector("main");
    const rect = main ? main.getBoundingClientRect() : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
    surface.style.setProperty("--sales-top", `${Math.max(0, rect.top)}px`);
    surface.style.setProperty("--sales-left", `${Math.max(0, rect.left)}px`);
    surface.style.setProperty("--sales-width", `${Math.max(320, rect.width)}px`);
    surface.style.setProperty("--sales-height", `${Math.max(320, window.innerHeight - Math.max(0, rect.top))}px`);
  }

  function removeSurface() {
    const surface = document.getElementById(OVERLAY_ID);
    if (surface) surface.remove();
  }

  function sync() {
    const path = normalize(window.location.pathname);
    if (path !== PERF_ROUTE && path !== TARGET_ROUTE && path !== TARGET_ALIAS) {
      removeSurface();
      return;
    }
    const surface = ensureSurface();
    if (path === PERF_ROUTE) renderPerformance(surface);
    else renderTargets(surface);
  }

  function patchHistory(method) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      setTimeout(sync, 80);
      return result;
    };
  }

  patchHistory("pushState");
  patchHistory("replaceState");
  window.addEventListener("popstate", function () { setTimeout(sync, 80); });
  window.addEventListener("resize", function () {
    const surface = document.getElementById(OVERLAY_ID);
    if (surface) positionSurface(surface);
  });
  window.addEventListener("load", sync);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();
})();
