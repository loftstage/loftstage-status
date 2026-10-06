// Loftstage Status — renders Upptime data from this repo, live, in the browser.
//
// Sources (all public, CORS-enabled):
//   history/summary.json   per-monitor dailyMinutesDown (rebuilt daily by summary.yml)
//   history/<slug>.yml     live status + monitoring start (committed by uptime.yml on change)
//   GitHub issues          incidents: label "status" + the monitor's slug label
"use strict";

const OWNER = "minimondocode";
const REPO = "loftstage-status";
const BRANCH = "master";
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

// Display order, public names and descriptions. Monitors in summary.json that
// aren't listed here still render, after these, under their Upptime name.
const COMPONENTS = [
  {
    slug: "loftstage-app-and-api",
    name: "Dashboard & API",
    description: "app.loftstage.com: the venue dashboard, the door scanner's API and every API route.",
  },
  {
    slug: "loftstage-checkout-stack-strict",
    name: "Checkout & payments",
    description: "Ticket checkout end to end: database, payment processing and seat holds all healthy.",
  },
  {
    slug: "loftstage-venue-pages",
    name: "Venue pages",
    description: "Public venue pages where fans browse upcoming shows.",
  },
  {
    slug: "loftstage-event-pages-edge",
    name: "Event pages",
    description: "Public event and ticket pages, served from our edge network.",
  },
  {
    slug: "loftstage-marketing-site",
    name: "Website",
    description: "loftstage.com, including pricing and sign-up.",
  },
];

const DAY_MS = 86_400_000;
const PAST_INCIDENT_DAYS = 15;
const REFRESH_MS = 5 * 60_000;
// A day with any downtime is a partial outage; this much or more is major.
const MAJOR_MINUTES = 30;

const STATE_LABEL = { up: "Operational", degraded: "Degraded performance", down: "Outage" };
const LEVEL_LABEL = { up: "No downtime recorded", partial: "Partial outage", major: "Major outage", none: "No data for this day" };
const LEVEL_COLOR = { up: "var(--up)", partial: "var(--partial)", major: "var(--major)", none: "var(--border-strong)" };

const $ = (sel) => document.querySelector(sel);

const state = {
  components: [],
  incidents: [],
  incidentsError: false,
  showHistory: false,
  commentCache: new Map(),
};

// ---------- formatting ----------

const fmtDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDayLong = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtMonth = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtStamp = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const utcMidnight = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const stamp = (iso) => `${fmtStamp.format(new Date(iso))} UTC`;

function duration(minutes) {
  const m = Math.max(1, Math.round(minutes));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  return [d && `${d}d`, h && `${h}h`, min && `${min}m`].filter(Boolean).slice(0, 2).join(" ");
}

function relative(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Minimal, safe markdown for hand-written incident updates: escape first, then
// **bold**, `code`, [text](https://…) links and bare https URLs.
function md(text) {
  return esc(text.trim())
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<a href="$2" rel="noopener">$2</a>')
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

// ---------- data ----------

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// raw.githubusercontent.com caches ~5 min; a per-minute key keeps it fresh
// without defeating the CDN for every visitor.
const bust = () => `?t=${Math.floor(Date.now() / 60_000)}`;

function parseHistoryYml(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function loadComponents() {
  const summary = await getJSON(`${RAW}/history/summary.json${bust()}`);
  const known = new Map(COMPONENTS.map((c, i) => [c.slug, { ...c, order: i }]));
  const list = summary.map((s, i) => {
    const meta = known.get(s.slug) || {
      name: s.name.replace(/^Loftstage\s+/, ""),
      description: "",
      order: COMPONENTS.length + i,
    };
    return {
      slug: s.slug,
      name: meta.name,
      description: meta.description,
      order: meta.order,
      status: s.status,
      dailyMinutesDown: { ...(s.dailyMinutesDown || {}) },
      startTime: null,
      lastUpdated: null,
    };
  });
  list.sort((a, b) => a.order - b.order);

  // Live status comes from history/<slug>.yml — summary.json is only rebuilt daily.
  await Promise.all(
    list.map(async (c) => {
      try {
        const h = parseHistoryYml(await getText(`${RAW}/history/${c.slug}.yml${bust()}`));
        if (h.status) c.status = h.status;
        c.startTime = h.startTime || null;
        c.lastUpdated = h.lastUpdated || null;
      } catch {
        /* keep summary.json's status */
      }
    })
  );
  return list;
}

async function loadIncidents() {
  const issues = await getJSON(`${API}/issues?labels=status&state=all&per_page=100&sort=created&direction=desc`);
  const slugs = new Set(state.components.map((c) => c.slug));
  return issues
    .filter((i) => !i.pull_request)
    .map((i) => {
      const slug = i.labels.map((l) => l.name).find((n) => slugs.has(n)) || null;
      const auto = /was \*\*down\*\*|was \*\*degraded\*\*/.test(i.body || "");
      return {
        number: i.number,
        url: i.html_url,
        slug,
        auto,
        degraded: /degraded/i.test(i.title),
        title: i.title.replace(/^[\p{Extended_Pictographic}️\s]+/u, ""),
        body: i.body || "",
        createdAt: i.created_at,
        closedAt: i.closed_at,
        updatedAt: i.updated_at,
        commentCount: i.comments,
        comments: null,
      };
    });
}

async function loadComments(incident) {
  if (!incident.commentCount) return [];
  const key = `${incident.number}@${incident.updatedAt}`;
  if (!state.commentCache.has(key)) {
    state.commentCache.set(
      key,
      getJSON(`${API}/issues/${incident.number}/comments?per_page=100`).catch(() => null)
    );
  }
  return state.commentCache.get(key);
}

// ---------- derived ----------

function componentName(slug) {
  const c = state.components.find((x) => x.slug === slug);
  return c ? c.name : null;
}

function incidentTitle(inc) {
  const name = componentName(inc.slug);
  if (inc.auto && name) return inc.degraded ? `${name}: degraded performance` : `${name} unavailable`;
  return inc.title;
}

function incidentMinutes(inc) {
  const end = inc.closedAt ? new Date(inc.closedAt) : new Date();
  return (end - new Date(inc.createdAt)) / 60_000;
}

function impactOf(inc) {
  if (inc.degraded) return "partial";
  return incidentMinutes(inc) >= MAJOR_MINUTES ? "major" : "partial";
}

// Open incidents keep accruing downtime after summary.json was built.
function addOpenIncidentMinutes(components, incidents) {
  const todayStart = utcMidnight(new Date());
  for (const inc of incidents) {
    if (inc.closedAt || !inc.slug) continue;
    const c = components.find((x) => x.slug === inc.slug);
    if (!c) continue;
    const from = Math.max(new Date(inc.createdAt).getTime(), todayStart);
    const mins = Math.round((Date.now() - from) / 60_000);
    const key = dayKey(todayStart);
    c.dailyMinutesDown[key] = Math.min(1440, Math.max(c.dailyMinutesDown[key] || 0, mins));
  }
}

function daysToShow() {
  const w = window.innerWidth;
  if (w < 480) return 30;
  if (w < 720) return 60;
  return 90;
}

function buildDays(c, n) {
  const today = utcMidnight(new Date());
  const start = c.startTime ? utcMidnight(new Date(c.startTime)) : null;
  const days = [];
  let monitored = 0;
  let down = 0;
  for (let i = n - 1; i >= 0; i--) {
    const t = today - i * DAY_MS;
    const key = dayKey(t);
    const mins = c.dailyMinutesDown[key] || 0;
    let level;
    if (start !== null && t < start) {
      level = "none";
    } else {
      level = mins === 0 ? "up" : mins >= MAJOR_MINUTES ? "major" : "partial";
      const dayStart = Math.max(t, c.startTime ? new Date(c.startTime).getTime() : t);
      const dayEnd = Math.min(t + DAY_MS, Date.now());
      monitored += Math.max(0, (dayEnd - dayStart) / 60_000);
      down += mins;
    }
    days.push({ t, key, mins, level });
  }
  const uptime = monitored > 0 ? Math.max(0, 100 * (1 - down / monitored)) : null;
  return { days, uptime };
}

function relatedIncidents(slug, t) {
  return state.incidents.filter((inc) => {
    if (inc.slug !== slug) return false;
    const s = new Date(inc.createdAt).getTime();
    const e = inc.closedAt ? new Date(inc.closedAt).getTime() : Date.now();
    return s < t + DAY_MS && e >= t;
  });
}

// ---------- render ----------

function renderBanner() {
  const el = $("#banner");
  const comps = state.components;
  const down = comps.filter((c) => c.status === "down");
  const degraded = comps.filter((c) => c.status === "degraded");
  let tone, title;
  if (down.length === comps.length) {
    tone = "major";
    title = "Major outage";
  } else if (down.length) {
    tone = "partial";
    title = down.length === 1 ? `${down[0].name} is unavailable` : "Partial outage";
  } else if (degraded.length) {
    tone = "degraded";
    title = "Degraded performance";
  } else {
    tone = "up";
    title = "All systems operational";
  }
  el.className = `banner banner--${tone}`;
  $("#banner-title").textContent = title;
  const last = comps.map((c) => c.lastUpdated).filter(Boolean).sort().pop();
  $("#banner-sub").textContent = last ? `Updated ${relative(last)}` : "";
}

function renderActive() {
  const el = $("#active-incidents");
  const open = state.incidents.filter((i) => !i.closedAt);
  el.hidden = open.length === 0;
  el.innerHTML = open
    .map((inc) => {
      const tone = impactOf(inc) === "major" ? "var(--major)" : "var(--partial)";
      return `<article class="active-card" style="--tone:${tone}">
        <h3><a href="#incident-${inc.number}">${esc(incidentTitle(inc))}</a></h3>
        <p class="muted" style="margin:4px 0 0;font-size:14px">Investigating since ${esc(stamp(inc.createdAt))} · ongoing for ${duration(incidentMinutes(inc))}</p>
      </article>`;
    })
    .join("");
}

function renderComponents() {
  const n = daysToShow();
  document.querySelectorAll("[data-days-label]").forEach((e) => (e.textContent = n));
  $("#components").innerHTML = state.components
    .map((c) => {
      const { days, uptime } = buildDays(c, n);
      const st = STATE_LABEL[c.status] ? c.status : "up";
      const pct = uptime === null ? "No data" : `${uptime >= 99.995 ? "100" : uptime.toFixed(2)}% uptime`;
      return `<li class="component">
        <div class="component-head">
          <span class="component-name">${esc(c.name)}${
            c.description
              ? ` <button class="info" type="button" aria-label="About ${esc(c.name)}" data-info="${esc(c.description)}">?</button>`
              : ""
          }</span>
          <span class="component-status" data-state="${st}">${STATE_LABEL[st]}</span>
        </div>
        <div class="bars" data-slug="${esc(c.slug)}" role="img" aria-label="${esc(`${c.name}: ${pct} over the past ${n} days`)}">
          ${days.map((d) => `<span class="bar" data-level="${d.level}" data-t="${d.t}" data-mins="${d.mins}"></span>`).join("")}
        </div>
        <div class="bar-foot"><span>${n} days ago</span><span class="rule"></span><span class="pct">${pct}</span><span class="rule"></span><span>Today</span></div>
      </li>`;
    })
    .join("");
}

function autoUpdates(inc) {
  const name = componentName(inc.slug) || "This service";
  const ups = [];
  if (inc.closedAt) {
    ups.push({
      label: "Resolved",
      html: esc(`${name} is back up after ${duration(incidentMinutes(inc))} of downtime.`),
      at: inc.closedAt,
    });
  }
  ups.push({
    label: "Investigating",
    html: esc(inc.degraded ? `${name} is responding slowly or partially. We're looking into it.` : `Our checks detected that ${name} wasn't responding. We're looking into it.`),
    at: inc.createdAt,
  });
  return ups;
}

function incidentUpdates(inc) {
  if (inc.auto) {
    // Upptime's own comments are the machine "Resolved:" note; anything else is
    // a hand-written update and is shown verbatim.
    const human = (inc.comments || [])
      .filter((c) => !/^\*\*Resolved:\*\*.+is back up in \[/s.test(c.body || ""))
      .map((c) => ({ label: "Update", html: md(c.body || ""), at: c.created_at }));
    return [...human, ...autoUpdates(inc)].sort((a, b) => new Date(b.at) - new Date(a.at));
  }
  const ups = (inc.comments || []).map((c) => ({ label: "Update", html: md(c.body || ""), at: c.created_at }));
  if (inc.body.trim()) ups.push({ label: "Investigating", html: md(inc.body), at: inc.createdAt });
  if (inc.closedAt) ups.push({ label: "Resolved", html: "This incident has been resolved.", at: inc.closedAt });
  return ups.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function renderIncident(inc) {
  const impact = impactOf(inc);
  const ups = incidentUpdates(inc);
  return `<article class="incident" id="incident-${inc.number}">
    <a class="incident-title" data-impact="${impact}" href="${esc(inc.url)}" rel="noopener">${esc(incidentTitle(inc))}</a>
    ${ups
      .map(
        (u) => `<div class="update"><p><strong>${u.label}</strong> – ${u.html}</p><time datetime="${esc(u.at)}">${esc(stamp(u.at))}</time></div>`
      )
      .join("")}
  </article>`;
}

function renderIncidents() {
  const root = $("#incident-days");
  const toggle = $("#history-toggle");
  if (state.incidentsError && !state.incidents.length) {
    root.innerHTML = `<p class="notice">Incident details are temporarily unavailable. See the <a href="https://github.com/${OWNER}/${REPO}/issues?q=label%3Astatus" rel="noopener">incident log on GitHub</a>.</p>`;
    toggle.hidden = true;
    return;
  }
  const today = utcMidnight(new Date());
  const cutoff = today - (PAST_INCIDENT_DAYS - 1) * DAY_MS;
  const byDay = new Map();
  for (const inc of state.incidents) {
    const k = dayKey(utcMidnight(new Date(inc.createdAt)));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(inc);
  }

  let html = "";
  for (let i = 0; i < PAST_INCIDENT_DAYS; i++) {
    const t = today - i * DAY_MS;
    const list = byDay.get(dayKey(t)) || [];
    html += `<div class="day"><h3>${fmtDay.format(t)}</h3>${
      list.length ? list.map(renderIncident).join("") : `<p class="empty">No incidents reported${i === 0 ? " today" : ""}.</p>`
    }</div>`;
  }

  const older = state.incidents.filter((inc) => new Date(inc.createdAt).getTime() < cutoff);
  if (state.showHistory) {
    let month = "";
    for (const inc of older) {
      const m = fmtMonth.format(new Date(inc.createdAt));
      if (m !== month) {
        month = m;
        html += `<h3 class="month-heading">${m}</h3>`;
      }
      html += `<div class="day"><h3>${fmtDay.format(new Date(inc.createdAt))}</h3>${renderIncident(inc)}</div>`;
    }
    if (!older.length) html += `<p class="notice">No earlier incidents.</p>`;
  }
  root.innerHTML = html;
  toggle.hidden = false;
  toggle.textContent = state.showHistory ? "Hide incident history" : `Show full incident history${older.length ? ` (${older.length} earlier)` : ""}`;
}

function renderUpdatedAt() {
  $("#updated-at").textContent = `Page refreshed ${fmtStamp.format(new Date())} UTC`;
}

// ---------- tooltip ----------

const tooltip = $("#tooltip");
let activeBar = null;

function placeTooltip(anchor) {
  const r = anchor.getBoundingClientRect();
  tooltip.hidden = false;
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));
  let top = r.top - th - 10;
  if (top < 72) top = r.bottom + 10;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function showBarTooltip(bar) {
  if (activeBar) activeBar.classList.remove("is-active");
  activeBar = bar;
  bar.classList.add("is-active");
  const slug = bar.parentElement.dataset.slug;
  const t = Number(bar.dataset.t);
  const mins = Number(bar.dataset.mins);
  const level = bar.dataset.level;
  const related = level === "none" ? [] : relatedIncidents(slug, t);
  const label = level === "up" || level === "none" ? LEVEL_LABEL[level] : `${LEVEL_LABEL[level]} · ${duration(mins)}`;
  tooltip.innerHTML = `<div class="tt-date">${fmtDayLong.format(t)}</div>
    <div class="tt-row"><span class="dot" style="background:${LEVEL_COLOR[level]}"></span>${esc(label)}</div>
    ${
      related.length
        ? `<div class="tt-related"><h4>Related</h4>${related
            .map((inc) => `<a href="#incident-${inc.number}">${esc(incidentTitle(inc))}</a>`)
            .join("")}</div>`
        : ""
    }`;
  placeTooltip(bar);
}

function showInfoTooltip(btn) {
  tooltip.innerHTML = esc(btn.dataset.info);
  placeTooltip(btn);
}

function hideTooltip() {
  tooltip.hidden = true;
  tooltip.classList.remove("is-sticky");
  if (activeBar) activeBar.classList.remove("is-active");
  activeBar = null;
}

function wireTooltips() {
  const comps = $("#components");
  comps.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const bar = e.target.closest(".bar");
    const info = e.target.closest(".info");
    if (bar) showBarTooltip(bar);
    else if (info) showInfoTooltip(info);
  });
  comps.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && !tooltip.classList.contains("is-sticky")) hideTooltip();
  });
  comps.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse" || tooltip.classList.contains("is-sticky")) return;
    if (!e.relatedTarget || !e.relatedTarget.closest(".bar, .info")) hideTooltip();
  });

  // Touch / click: tap a bar to pin its tooltip (links inside become tappable).
  comps.addEventListener("click", (e) => {
    const bar = e.target.closest(".bar");
    const info = e.target.closest(".info");
    if (!bar && !info) return;
    e.stopPropagation();
    if (bar && bar === activeBar && tooltip.classList.contains("is-sticky")) return hideTooltip();
    if (bar) showBarTooltip(bar);
    else showInfoTooltip(info);
    tooltip.classList.add("is-sticky");
  });
  // Keyboard users reach descriptions through the focusable info buttons.
  comps.addEventListener("focusin", (e) => {
    const info = e.target.closest(".info");
    if (info) showInfoTooltip(info);
  });
  comps.addEventListener("focusout", () => {
    if (!tooltip.classList.contains("is-sticky")) hideTooltip();
  });
  document.addEventListener("click", (e) => {
    if (!tooltip.contains(e.target)) hideTooltip();
  });
  tooltip.addEventListener("click", (e) => {
    if (e.target.closest("a")) hideTooltip();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && hideTooltip());
  // The tooltip is position: fixed, so it would detach from its bar on scroll.
  window.addEventListener("scroll", hideTooltip, { passive: true });
}

// ---------- boot ----------

async function refresh() {
  try {
    state.components = await loadComponents();
  } catch (err) {
    console.error(err);
    if (!state.components.length) {
      $("#banner").className = "banner banner--error";
      $("#banner-title").textContent = "Status data is temporarily unavailable";
      $("#banner-sub").innerHTML = `Try again in a minute, or check the <a href="https://github.com/${OWNER}/${REPO}" rel="noopener">monitor repository</a>.`;
      $("#components").innerHTML = "";
      return;
    }
  }

  try {
    const incidents = await loadIncidents();
    const shown = Date.now() - PAST_INCIDENT_DAYS * DAY_MS;
    await Promise.all(
      incidents.map(async (inc) => {
        const recent = !inc.closedAt || new Date(inc.createdAt).getTime() >= shown || state.showHistory;
        inc.comments = recent ? await loadComments(inc) : null;
      })
    );
    state.incidents = incidents;
    state.incidentsError = false;
  } catch (err) {
    // Unauthenticated GitHub API: 60 requests/hour per visitor IP.
    console.error(err);
    state.incidentsError = true;
  }

  addOpenIncidentMinutes(state.components, state.incidents);
  hideTooltip();
  renderBanner();
  renderActive();
  renderComponents();
  renderIncidents();
  renderUpdatedAt();
}

$("#history-toggle").addEventListener("click", () => {
  state.showHistory = !state.showHistory;
  if (state.showHistory) {
    refresh();
  } else {
    renderIncidents();
  }
});

let lastDays = daysToShow();
window.addEventListener("resize", () => {
  const n = daysToShow();
  if (n !== lastDays && state.components.length) {
    lastDays = n;
    hideTooltip();
    renderComponents();
  }
});

wireTooltips();
refresh();
setInterval(() => document.visibilityState === "visible" && refresh(), REFRESH_MS);
