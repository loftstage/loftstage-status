// Smoke check for the live status page: loads https://status.loftstage.com in
// headless Chromium and fails if the page did not render real data. Catches a
// broken Pages deploy, an Upptime data-layout change the page can't parse, a
// JS error, or the raw CDN being unreachable. Run by .github/workflows/smoke.yml.
import { chromium } from "playwright";

const URL = process.env.STATUS_URL || "https://status.loftstage.com/";
const MIN_COMPONENTS = 5; // the monitors listed in .upptimerc.yml
const MIN_BARS = 30; // phones show 30, tablets 60, desktop 90

const failures = [];
const consoleErrors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

try {
  const res = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (!res || res.status() !== 200) failures.push(`HTTP ${res ? res.status() : "no response"} for ${URL}`);

  // The banner leaves the loading state once history/ has been read and rendered.
  await page.waitForFunction(() => !document.querySelector("#banner").classList.contains("banner--loading"), null, { timeout: 30_000 }).catch(() => {
    failures.push("banner never left the loading state (history/ fetch or render hung)");
  });

  const snapshot = await page.evaluate(() => {
    const banner = document.querySelector("#banner");
    const tone = [...banner.classList].find((c) => c.startsWith("banner--"))?.slice(8) ?? null;
    const components = [...document.querySelectorAll(".bars")].map((el) => ({
      slug: el.dataset.slug,
      bars: el.querySelectorAll(".bar[data-level]").length,
      withData: el.querySelectorAll('.bar[data-level]:not([data-level="none"])').length,
    }));
    const incidentDays = document.querySelectorAll("#incident-days > *").length;
    const incidentFallback = !!document.querySelector('#incidents a[href*="github.com"]');
    return { tone, title: document.querySelector("#banner-title").textContent.trim(), components, incidentDays, incidentFallback };
  });

  if (!["up", "degraded", "partial", "major"].includes(snapshot.tone)) failures.push(`banner tone is "${snapshot.tone}" ("${snapshot.title}")`);
  if (snapshot.components.length < MIN_COMPONENTS) failures.push(`only ${snapshot.components.length} components rendered (expected ≥ ${MIN_COMPONENTS})`);
  for (const c of snapshot.components) {
    if (c.bars < MIN_BARS) failures.push(`${c.slug}: ${c.bars} bars (expected ≥ ${MIN_BARS})`);
    if (c.withData === 0) failures.push(`${c.slug}: every bar is "no data" — summary.json not parsed`);
  }
  // Incidents come from the unauthenticated GitHub API (60/h per IP, shared on
  // Actions runners), so the fallback link is acceptable; an empty section is not.
  if (snapshot.incidentDays === 0 && !snapshot.incidentFallback) failures.push("incident section is empty with no fallback link");

  const realErrors = consoleErrors.filter((e) => !/api\.github\.com|rate limit|403/i.test(e));
  if (realErrors.length) failures.push(`console errors:\n  ${realErrors.join("\n  ")}`);

  console.log(JSON.stringify({ url: URL, ...snapshot, consoleErrors }, null, 2));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nSTATUS PAGE SMOKE FAILED (${URL}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nstatus page smoke OK");
