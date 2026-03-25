const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CURSOR_DIR = path.join(os.homedir(), ".cursor");
const HOOKS_DIR = path.join(CURSOR_DIR, "hooks");
const LOG_DIR = path.join(HOOKS_DIR, "climate-logs");
const CUMULATIVE_FILE = path.join(LOG_DIR, "cumulative.json");
const IMPACT_FILE = path.join(LOG_DIR, "impact.jsonl");
const HOOKS_JSON = path.join(CURSOR_DIR, "hooks.json");
const CLIMATE_SCRIPT = path.join(HOOKS_DIR, "climate.py");

let statusBarItem;
let watcher;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  ensureHooksInstalled();
  maybeResetStatsForNewMonth(context);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBarItem.command = "aiClimate.showDetails";
  statusBarItem.tooltip =
    "AI Climate Impact — click for details";
  context.subscriptions.push(statusBarItem);

  updateStatusBar();

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    watcher = fs.watch(LOG_DIR, (_, filename) => {
      if (filename === "cumulative.json") updateStatusBar();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch (_) {
    const interval = setInterval(updateStatusBar, 5000);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("aiClimate.showDetails", showDetails),
    vscode.commands.registerCommand("aiClimate.reset", resetStats),
    vscode.commands.registerCommand("aiClimate.showHeatMap", showHeatMap),
    vscode.commands.registerCommand("aiClimate.installHooks", () => {
      ensureHooksInstalled(true);
    })
  );

  statusBarItem.show();
}

// ---------------------------------------------------------------------------
// Auto-install hooks
// ---------------------------------------------------------------------------

function ensureHooksInstalled(force = false) {
  try {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const scriptExists = fs.existsSync(CLIMATE_SCRIPT);
    if (!scriptExists || force) {
      fs.writeFileSync(CLIMATE_SCRIPT, CLIMATE_PY_SOURCE, { mode: 0o755 });
    }

    let hooksConfig = { version: 1, hooks: {} };
    if (fs.existsSync(HOOKS_JSON)) {
      try {
        hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON, "utf8"));
      } catch (_) {}
    }
    if (!hooksConfig.hooks) hooksConfig.hooks = {};

    const climateHook = {
      command: "python3 ./hooks/climate.py",
      timeout: 3,
    };

    let changed = false;
    for (const event of ["beforeReadFile", "beforeSubmitPrompt", "preCompact", "stop"]) {
      const existing = hooksConfig.hooks[event] || [];
      const hasClimate = existing.some(
        (h) => h.command && h.command.includes("climate.py")
      );
      if (!hasClimate) {
        hooksConfig.hooks[event] = [...existing, climateHook];
        changed = true;
      }
    }

    if (changed || force) {
      fs.writeFileSync(HOOKS_JSON, JSON.stringify(hooksConfig, null, 2));
    }

    if (force) {
      vscode.window.showInformationMessage(
        "AI Climate hooks installed. Restart Cursor to activate."
      );
    }
  } catch (err) {
    vscode.window.showWarningMessage(
      `AI Climate: could not install hooks — ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function readCumulative() {
  try {
    return JSON.parse(fs.readFileSync(CUMULATIVE_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heat map: read impact log and aggregate by day
// ---------------------------------------------------------------------------

function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getMonthRangeFor(year, monthIndex0) {
  const start = new Date(year, monthIndex0, 1);
  const end = new Date(year, monthIndex0 + 1, 0);
  const monthLabel = start.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });
  return {
    startDate: toLocalDateStr(start),
    endDate: toLocalDateStr(end),
    monthLabel,
    year,
    month: monthIndex0 + 1,
  };
}

function getCurrentMonthRange() {
  const now = new Date();
  return getMonthRangeFor(now.getFullYear(), now.getMonth());
}

function readImpactLogForRange(monthStart, monthEnd) {
  try {
    if (!fs.existsSync(IMPACT_FILE)) return [];
    const content = fs.readFileSync(IMPACT_FILE, "utf8");
    const byDate = Object.create(null);
    const lines = content.split("\n").filter((line) => line.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = entry && entry.ts;
        if (typeof ts !== "string") continue;
        const date = ts.slice(0, 10);
        if (date < monthStart || date > monthEnd) continue;
        if (entry.hook !== "beforeSubmitPrompt") continue;
        const gco2 = entry.gco2;
        if (typeof gco2 !== "number" || gco2 < 0) continue;
        if (!byDate[date]) {
          byDate[date] = { gco2: 0, water_l: 0, tokens: 0, requests: 0 };
        }
        const row = byDate[date];
        row.gco2 += gco2;
        row.water_l += typeof entry.water_l === "number" ? entry.water_l : 0;
        row.tokens +=
          typeof entry.estimated_total_tokens === "number"
            ? entry.estimated_total_tokens
            : 0;
        row.requests += 1;
      } catch (_) {
        // skip malformed lines
      }
    }
    const days = [];
    for (const date of Object.keys(byDate)) {
      days.push({ date, ...byDate[date] });
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    return days;
  } catch (_) {
    return [];
  }
}

function readImpactLog() {
  const { startDate, endDate } = getCurrentMonthRange();
  return readImpactLogForRange(startDate, endDate);
}

function monthOrdinal(year, monthIndex0) {
  return year * 12 + monthIndex0;
}

function heatMapNavBounds(historyMonths) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM0 = now.getMonth();
  const earliest = new Date(curY, curM0, 1);
  earliest.setMonth(earliest.getMonth() - (historyMonths - 1));
  return {
    curY,
    curM0,
    earY: earliest.getFullYear(),
    earM0: earliest.getMonth(),
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.max(0, (p / 100) * sortedValues.length - 0.5);
  const i = Math.floor(idx);
  const frac = idx - i;
  const a = sortedValues[Math.min(i, sortedValues.length - 1)];
  const b = sortedValues[Math.min(i + 1, sortedValues.length - 1)];
  return a + frac * (b - a);
}

function computeHeatMapThresholds(days) {
  const config = vscode.workspace.getConfiguration("aiClimate");
  const fixedGreenMax = config.get("heatMapGreenMax");
  const fixedYellowMax = config.get("heatMapYellowMax");
  let greenMax;
  let yellowMax;
  if (
    typeof fixedGreenMax === "number" &&
    typeof fixedYellowMax === "number" &&
    fixedGreenMax < fixedYellowMax
  ) {
    greenMax = fixedGreenMax;
    yellowMax = fixedYellowMax;
  } else {
    const values = days.map((d) => d.gco2).filter((v) => v > 0).sort((a, b) => a - b);
    if (values.length === 0) {
      greenMax = 10;
      yellowMax = 50;
    } else if (values.length === 1) {
      greenMax = values[0] * 0.5;
      yellowMax = values[0];
    } else {
      greenMax = percentile(values, 33);
      yellowMax = percentile(values, 66);
      if (greenMax >= yellowMax) {
        greenMax = values[0];
        yellowMax = values[values.length - 1];
      }
    }
  }
  return { greenMax, yellowMax };
}

function getHeatMapData() {
  const days = readImpactLog();
  return { days, thresholds: computeHeatMapThresholds(days) };
}

function buildHeatMapPayload(viewYear, viewMonthIndex0) {
  const config = vscode.workspace.getConfiguration("aiClimate");
  let historyMonths = Number(config.get("heatMapHistoryMonths"));
  if (!Number.isFinite(historyMonths)) historyMonths = 12;
  historyMonths = Math.max(1, Math.min(36, Math.floor(historyMonths)));
  const b = heatMapNavBounds(historyMonths);
  const v = monthOrdinal(viewYear, viewMonthIndex0);
  const cur = monthOrdinal(b.curY, b.curM0);
  const ear = monthOrdinal(b.earY, b.earM0);
  const clamped = Math.max(ear, Math.min(cur, v));
  const cY = Math.floor(clamped / 12);
  const cM0 = clamped - cY * 12;
  const range = getMonthRangeFor(cY, cM0);
  const days = readImpactLogForRange(range.startDate, range.endDate);
  const { greenMax, yellowMax } = computeHeatMapThresholds(days);
  const dailyStats = Object.create(null);
  for (const d of days) {
    dailyStats[d.date] = {
      gco2: d.gco2,
      water_l: d.water_l,
      tokens: d.tokens,
      requests: d.requests,
    };
  }
  const ord = monthOrdinal(cY, cM0);
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    monthLabel: range.monthLabel,
    viewYear: cY,
    viewMonth: cM0 + 1,
    dailyStats,
    greenMax,
    yellowMax,
    canPrev: ord > ear,
    canNext: ord < cur,
    historyMonths,
  };
}

function updateStatusBar() {
  const data = readCumulative();
  if (!data || data.request_count === 0) {
    statusBarItem.text = "$(globe) 0 gCO\u2082";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBar.background"
    );
    return;
  }

  const gco2 = data.total_gco2;
  let co2Display;
  if (gco2 < 1) {
    co2Display = `${(gco2 * 1000).toFixed(0)} mgCO\u2082`;
  } else if (gco2 < 1000) {
    co2Display = `${gco2.toFixed(1)} gCO\u2082`;
  } else {
    co2Display = `${(gco2 / 1000).toFixed(2)} kgCO\u2082`;
  }

  const tokens = data.total_tokens;
  let tokenDisplay;
  if (tokens < 1000) {
    tokenDisplay = `${tokens}`;
  } else if (tokens < 1_000_000) {
    tokenDisplay = `${(tokens / 1000).toFixed(1)}K`;
  } else {
    tokenDisplay = `${(tokens / 1_000_000).toFixed(2)}M`;
  }

  const waterL = data.total_water_l ?? 0;
  let waterDisplay;
  if (waterL < 0.001) {
    waterDisplay = "< 1 mL";
  } else if (waterL < 1) {
    waterDisplay = `${(waterL * 1000).toFixed(0)} mL`;
  } else if (waterL < 1000) {
    waterDisplay = `${waterL.toFixed(2)} L`;
  } else {
    waterDisplay = `${(waterL / 1000).toFixed(2)}k L`;
  }

  statusBarItem.text = `$(globe) ${co2Display} \u00b7 ~${tokenDisplay} tokens \u00b7 ${waterDisplay} water \u00b7 ${data.request_count} reqs`;

  if (gco2 < 10) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBar.background"
    );
  } else if (gco2 < 100) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function showDetails() {
  const data = readCumulative();
  if (!data || data.request_count === 0) {
    vscode.window.showInformationMessage("No AI climate data recorded yet.");
    return;
  }

  const gco2 = data.total_gco2;
  const mDriven = ((gco2 / 121) * 1000).toFixed(0);
  const charges = (gco2 / 8.22).toFixed(2);
  const ledMin = (gco2 / ((0.01 * 390) / 60)).toFixed(0);

  const pcCount = data.precompact_count || 0;
  const baseCtx = data.last_precompact_context || 0;

  const waterL = data.total_water_l ?? 0;
  const waterStr =
    waterL < 1
      ? `${(waterL * 1000).toFixed(0)} mL`
      : `${waterL.toFixed(2)} L`;
  const bottles = waterL >= 0.5 ? (waterL / 0.5).toFixed(0) : "0";

  const msg = [
    `Requests: ${data.request_count}`,
    `Tokens: ~${data.total_tokens.toLocaleString()}`,
    `Energy: ${(data.total_wh * 1000).toFixed(1)} mWh`,
    `CO\u2082: ${gco2.toFixed(2)} g`,
    `Water: ${waterStr}`,
    pcCount > 0 ? `Base ctx: ${(baseCtx / 1000).toFixed(1)}K (${pcCount} samples)` : `Base ctx: 5K (default)`,
    `\u2248 ${mDriven} m driven`,
    `\u2248 ${charges} phone charges`,
    `\u2248 ${ledMin} min LED`,
    bottles !== "0" ? `\u2248 ${bottles} 500 mL bottles` : null,
  ]
    .filter(Boolean)
    .join("  \u00b7  ");

  vscode.window.showInformationMessage(msg, "Reset").then((choice) => {
    if (choice === "Reset") resetStats();
  });
}

function resetStats() {
  try {
    writeCumulativeReset();
    updateStatusBar();
    const existing = readCumulative();
    const lastBase = existing ? existing.last_precompact_context || 0 : 0;
    vscode.window.showInformationMessage(
      `AI climate stats reset (base context ${(lastBase / 1000).toFixed(1)}K preserved).`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to reset: ${err.message}`);
  }
}

function writeCumulativeReset() {
  let lastBase = 0;
  let pcCount = 0;
  const existing = readCumulative();
  if (existing) {
    lastBase = existing.last_precompact_context || 0;
    pcCount = existing.precompact_count || 0;
  }
  fs.writeFileSync(
    CUMULATIVE_FILE,
    JSON.stringify(
      {
        total_tokens: 0,
        total_wh: 0,
        total_gco2: 0,
        total_water_l: 0,
        request_count: 0,
        last_precompact_context: lastBase,
        last_estimate: 0,
        last_model: "unknown",
        precompact_count: pcCount,
      },
      null,
      2
    )
  );
}

function resetStatsQuiet() {
  try {
    writeCumulativeReset();
    updateStatusBar();
  } catch (_) {}
}

const LAST_STATS_MONTH_KEY = "aiClimate.lastStatsMonthKey";

function getCurrentMonthKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

async function maybeResetStatsForNewMonth(context) {
  try {
    const on = vscode.workspace
      .getConfiguration("aiClimate")
      .get("resetStatsOnNewMonth");
    if (!on) return;
    const cur = getCurrentMonthKey();
    const prev = context.globalState.get(LAST_STATS_MONTH_KEY);
    if (prev != null && prev !== cur) {
      resetStatsQuiet();
    }
    await context.globalState.update(LAST_STATS_MONTH_KEY, cur);
  } catch (_) {}
}

function showHeatMap() {
  const now = new Date();
  const payload = buildHeatMapPayload(now.getFullYear(), now.getMonth());
  const panel = vscode.window.createWebviewPanel(
    "aiClimate.heatMap",
    `CO2 heat map — ${payload.monthLabel}`,
    vscode.ViewColumn.One,
    { enableScripts: true }
  );
  const w = panel.webview;
  w.html = getHeatMapHtml(w, payload);
  w.onDidReceiveMessage((msg) => {
    if (msg.type !== "setMonth") return;
    let y = Number(msg.year);
    let m1 = Number(msg.month);
    const d = Number(msg.delta);
    if (!Number.isFinite(y) || !Number.isFinite(m1) || m1 < 1 || m1 > 12) return;
    if (d === -1) {
      m1 -= 1;
      if (m1 < 1) {
        m1 = 12;
        y -= 1;
      }
    } else if (d === 1) {
      m1 += 1;
      if (m1 > 12) {
        m1 = 1;
        y += 1;
      }
    } else {
      return;
    }
    const next = buildHeatMapPayload(y, m1 - 1);
    panel.title = `CO2 heat map — ${next.monthLabel}`;
    w.postMessage({ type: "heatMap", payload: next });
  });
}

function heatMapNonce() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function getHeatMapHtml(webview, payload) {
  const nonce = heatMapNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  const cspAttr = csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const monthTitleEsc = String(payload.monthLabel || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${cspAttr}">
  <title>CO2 heat map — ${monthTitleEsc}</title>
  <style>
    html {
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 1rem;
      margin: 0;
      display: block !important;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      align-items: unset !important;
      justify-content: unset !important;
    }
    .page {
      display: block;
      width: 100%;
      margin: 0;
      padding: 0;
    }
    h2 { margin-top: 0; }
    .legend { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
    .legend span { display: flex; align-items: center; gap: 0.35rem; }
    .legend .box { width: 14px; height: 14px; border-radius: 2px; box-sizing: border-box; flex-shrink: 0; }
    .legend .box.none { background: #ffffff; border: 1px solid var(--vscode-widget-border); }
    .legend .box.low { background: #2da44e; }
    .legend .box.med { background: #d4a72c; }
    .legend .box.high { background: #cf222e; }
    .grid-wrap {
      display: inline-block;
      vertical-align: top;
      margin: 0;
      padding: 0;
    }
    .cal-grid {
      display: grid;
      grid-template-columns: repeat(7, 26px);
      gap: 4px 6px;
      justify-content: start;
      align-content: start;
      width: max-content;
      max-width: 100%;
    }
    .wk-head {
      font-size: 10px;
      line-height: 1.1;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      padding-bottom: 2px;
      font-weight: 500;
    }
    .day-slot {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      min-height: 30px;
    }
    .day-slot.pad {
      pointer-events: none;
    }
    .day-slot.pad .day-num,
    .day-slot.pad .cell {
      visibility: hidden;
    }
    .day-num {
      font-size: 10px;
      line-height: 1;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .cell {
      width: 14px;
      height: 14px;
      border-radius: 2px;
      box-sizing: border-box;
      border: 1px solid transparent;
      flex-shrink: 0;
    }
    .cell.none { background: #ffffff; border-color: var(--vscode-widget-border); }
    .cell.low { background: #2da44e; }
    .cell.med { background: #d4a72c; }
    .cell.high { background: #cf222e; }
    .empty { font-size: 0.9rem; color: var(--vscode-descriptionForeground); margin-top: 0.75rem; }
    .day-slot:not(.pad) { cursor: default; }
    .day-popover {
      display: none;
      position: fixed;
      z-index: 100000;
      min-width: 200px;
      max-width: 300px;
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-editorWidget-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
      font-size: 12px;
      line-height: 1.45;
      pointer-events: none;
    }
    .day-popover.visible {
      display: block;
      pointer-events: auto;
    }
    .pop-title { font-weight: 600; margin-bottom: 8px; }
    .pop-line { display: flex; justify-content: space-between; gap: 16px; margin-top: 5px; }
    .pop-k { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .pop-v { font-variant-numeric: tabular-nums; text-align: right; word-break: break-all; }
    .pop-foot { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--vscode-widget-border); font-size: 11px; color: var(--vscode-descriptionForeground); }
    .month-nav {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .month-nav button {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      padding: 4px 10px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
    }
    .month-nav button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .month-nav #nav-label {
      font-weight: 600;
      min-width: 10em;
    }
    .month-nav .nav-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      width: 100%;
      margin-top: 2px;
    }
  </style>
</head>
<body>
  <h2 id="heat-heading">Daily CO\u2082 heat map — ${monthTitleEsc}</h2>
  <div class="month-nav">
    <button type="button" id="btn-prev" aria-label="Previous month">\u25C0</button>
    <span id="nav-label"></span>
    <button type="button" id="btn-next" aria-label="Next month">\u25B6</button>
    <span class="nav-hint" id="nav-hint"></span>
  </div>
  <div class="page">
  <div class="legend">
    <span><span class="box none"></span> No data</span>
    <span><span class="box low"></span> Low</span>
    <span><span class="box med"></span> Medium</span>
    <span><span class="box high"></span> High</span>
  </div>
  <div class="grid-wrap">
  <div id="grid" class="cal-grid"></div>
  </div>
  <p id="empty" class="empty" style="display:none;">No daily data yet. Use the AI to generate some activity.</p>
  </div>
  <div id="day-popover" class="day-popover" role="tooltip" aria-hidden="true">
    <div class="pop-title" id="pop-title"></div>
    <div id="pop-body"></div>
  </div>
  <script type="application/json" id="heatmap-payload" nonce="${nonce}">${data}</script>
  <script nonce="${nonce}">
    (function () {
    const vscode = acquireVsCodeApi();
    let state = JSON.parse(document.getElementById("heatmap-payload").textContent);
    const grid = document.getElementById("grid");
    const emptyEl = document.getElementById("empty");
    const heatHeading = document.getElementById("heat-heading");
    const navLabel = document.getElementById("nav-label");
    const navHint = document.getElementById("nav-hint");
    const btnPrev = document.getElementById("btn-prev");
    const btnNext = document.getElementById("btn-next");
    const pop = document.getElementById("day-popover");
    const popTitle = document.getElementById("pop-title");
    const popBody = document.getElementById("pop-body");
    const parse = (s) => { const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
    const format = (d) => d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    function fmtGco2(g) {
      if (g < 1) return (g * 1000).toFixed(0) + " mg CO\u2082";
      if (g < 1000) return g.toFixed(2) + " g CO\u2082";
      return (g / 1000).toFixed(2) + " kg CO\u2082";
    }
    function fmtWater(l) {
      if (l < 0.001) return "< 1 mL";
      if (l < 1) return (l * 1000).toFixed(0) + " mL";
      return l.toFixed(2) + " L";
    }
    function fmtTokens(n) {
      if (n < 1000) return "~" + Math.round(n).toLocaleString();
      if (n < 1e6) return "~" + (n / 1000).toFixed(1) + "K";
      return "~" + (n / 1e6).toFixed(2) + "M";
    }
    function line(k, v) {
      const row = document.createElement("div");
      row.className = "pop-line";
      const a = document.createElement("span");
      a.className = "pop-k";
      a.textContent = k;
      const b = document.createElement("span");
      b.className = "pop-v";
      b.textContent = v;
      row.appendChild(a);
      row.appendChild(b);
      return row;
    }
    let hideTimer = null;
    function hidePop() {
      pop.classList.remove("visible");
      pop.setAttribute("aria-hidden", "true");
    }
    function positionPop(slot) {
      const r = slot.getBoundingClientRect();
      requestAnimationFrame(() => {
        const pw = pop.offsetWidth;
        const ph = pop.offsetHeight;
        let left = r.left + r.width / 2 - pw / 2;
        let top = r.bottom + 6;
        if (left + pw > innerWidth - 8) left = innerWidth - pw - 8;
        if (left < 8) left = 8;
        if (top + ph > innerHeight - 8) top = r.top - ph - 6;
        if (top < 8) top = 8;
        pop.style.left = left + "px";
        pop.style.top = top + "px";
      });
    }
    function showPop(slot, dateStr, dayDate, dailyStats) {
      clearTimeout(hideTimer);
      popTitle.textContent = dayDate.toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      popBody.textContent = "";
      const st = dailyStats[dateStr];
      if (!st || !st.requests) {
        const p = document.createElement("div");
        p.className = "pop-foot";
        p.style.borderTop = "none";
        p.style.marginTop = "0";
        p.style.paddingTop = "0";
        p.textContent = "No prompts logged this day.";
        popBody.appendChild(p);
      } else {
        popBody.appendChild(line("CO\u2082", fmtGco2(st.gco2)));
        popBody.appendChild(line("Water", fmtWater(st.water_l)));
        popBody.appendChild(line("Tokens (est.)", fmtTokens(st.tokens)));
        const foot = document.createElement("div");
        foot.className = "pop-foot";
        foot.textContent = st.requests === 1 ? "1 prompt" : st.requests + " prompts";
        popBody.appendChild(foot);
      }
      pop.classList.add("visible");
      pop.setAttribute("aria-hidden", "false");
      positionPop(slot);
    }
    function bindPop(slot, dateStr, dayDate, dailyStats) {
      slot.addEventListener("mouseenter", () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => showPop(slot, dateStr, dayDate, dailyStats), 120);
      });
      slot.addEventListener("mouseleave", () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hidePop, 180);
      });
    }
    pop.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    pop.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(hidePop, 180);
    });
    function renderHeatMap() {
      hidePop();
      const dailyStats = state.dailyStats || {};
      const startDate = state.startDate;
      const endDate = state.endDate;
      const greenMax = state.greenMax;
      const yellowMax = state.yellowMax;
      heatHeading.textContent = "Daily CO\u2082 heat map — " + state.monthLabel;
      document.title = "CO2 heat map — " + state.monthLabel;
      navLabel.textContent = state.monthLabel;
      btnPrev.disabled = !state.canPrev;
      btnNext.disabled = !state.canNext;
      navHint.textContent = "Sliding window: " + state.historyMonths + " month" + (state.historyMonths === 1 ? "" : "s") + " ending this month.";
      grid.textContent = "";
      const refSun = new Date(2024, 0, 7);
      for (let i = 0; i < 7; i++) {
        const h = document.createElement("div");
        h.className = "wk-head";
        h.textContent = new Date(refSun.getTime() + i * 86400000).toLocaleDateString(undefined, { weekday: "short" });
        grid.appendChild(h);
      }
      const first = parse(startDate);
      const last = parse(endDate);
      let pad = first.getDay();
      for (let i = 0; i < pad; i++) {
        const slot = document.createElement("div");
        slot.className = "day-slot pad";
        const pn = document.createElement("span");
        pn.className = "day-num";
        const pc = document.createElement("div");
        pc.className = "cell none";
        slot.appendChild(pn);
        slot.appendChild(pc);
        grid.appendChild(slot);
      }
      let count = 0;
      let dayCount = 0;
      for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
        dayCount++;
        const date = format(d);
        const dayCopy = new Date(d.getTime());
        const stats = dailyStats[date];
        const g = stats ? stats.gco2 : null;
        const slot = document.createElement("div");
        slot.className = "day-slot";
        const num = document.createElement("span");
        num.className = "day-num";
        num.textContent = String(d.getDate());
        const cell = document.createElement("div");
        cell.className = "cell";
        if (stats && stats.requests > 0 && g != null && g >= 0) {
          count++;
          if (g <= greenMax) cell.classList.add("low");
          else if (g <= yellowMax) cell.classList.add("med");
          else cell.classList.add("high");
          cell.title = "Hover for details";
          slot.title = "Hover for details";
        } else {
          cell.classList.add("none");
          cell.title = "Hover for details";
          slot.title = "Hover for details";
          cell.setAttribute("aria-label", date + " — no data");
        }
        bindPop(slot, date, dayCopy, dailyStats);
        slot.appendChild(num);
        slot.appendChild(cell);
        grid.appendChild(slot);
      }
      const tail = (7 - ((pad + dayCount) % 7)) % 7;
      for (let i = 0; i < tail; i++) {
        const slot = document.createElement("div");
        slot.className = "day-slot pad";
        const pn = document.createElement("span");
        pn.className = "day-num";
        const pc = document.createElement("div");
        pc.className = "cell none";
        slot.appendChild(pn);
        slot.appendChild(pc);
        grid.appendChild(slot);
      }
      emptyEl.style.display = count === 0 ? "block" : "none";
    }
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (m && m.type === "heatMap" && m.payload) {
        state = m.payload;
        renderHeatMap();
      }
    });
    btnPrev.addEventListener("click", () => {
      if (!state.canPrev) return;
      vscode.postMessage({
        type: "setMonth",
        year: state.viewYear,
        month: state.viewMonth,
        delta: -1,
      });
    });
    btnNext.addEventListener("click", () => {
      if (!state.canNext) return;
      vscode.postMessage({
        type: "setMonth",
        year: state.viewYear,
        month: state.viewMonth,
        delta: 1,
      });
    });
    renderHeatMap();
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

function deactivate() {
  if (watcher) watcher.close();
}

// ---------------------------------------------------------------------------
// Embedded hook script
// ---------------------------------------------------------------------------

const CLIMATE_PY_SOURCE = `#!/usr/bin/env python3
"""
Cursor hook: estimates the climate impact of each AI prompt.

Tracks energy consumption and CO2 emissions per request, per session,
and cumulatively. Uses beforeReadFile to capture context file tokens
and preCompact to provide ground-truth corrections.

Energy estimates based on Luccioni et al. 2023, IEA 2024.
"""

import json
import os
import sys
import time
from pathlib import Path

CHARS_PER_TOKEN = 3.8

ENERGY_WH_PER_1K_TOKENS = {
    "opus":   0.0060,
    "sonnet": 0.0030,
    "haiku":  0.0010,
    "gpt-4":  0.0055,
    "gpt-5":  0.0055,
    "o3":     0.0050,
    "o4":     0.0050,
    "gemini": 0.0035,
    "grok":   0.0040,
    "cursor": 0.0030,
    "default": 0.0035,
}

CARBON_INTENSITY_G_PER_KWH = 390

# Water per request (mL). Li et al. arXiv:2304.03271: ~10–25 mL/query; ChatGPT water footprint: ~15–30 mL/query.
WATER_ML_PER_REQUEST = 15

LOG_DIR = Path.home() / ".cursor" / "hooks" / "climate-logs"
LOG_FILE = LOG_DIR / "impact.jsonl"
CUMULATIVE_FILE = LOG_DIR / "cumulative.json"
CONTEXT_FILE = LOG_DIR / "context-accum.json"

DEFAULT_CUMULATIVE = {
    "total_tokens": 0,
    "total_wh": 0.0,
    "total_gco2": 0.0,
    "total_water_l": 0.0,
    "request_count": 0,
    "last_precompact_context": 0,
    "last_estimate": 0,
    "last_model": "unknown",
    "precompact_count": 0,
}

DEFAULT_BASE_CONTEXT = 5000


def estimate_tokens(text):
    return max(1, int(len(text) / CHARS_PER_TOKEN))


def get_energy_rate(model):
    model_lower = model.lower()
    for key, rate in ENERGY_WH_PER_1K_TOKENS.items():
        if key in model_lower:
            return rate
    return ENERGY_WH_PER_1K_TOKENS["default"]


def load_cumulative():
    try:
        data = json.loads(CUMULATIVE_FILE.read_text())
        for k, v in DEFAULT_CUMULATIVE.items():
            data.setdefault(k, v)
        # One-time backfill: pre-upgrade cumulative had no total_water_l; estimate from request_count.
        if data["total_water_l"] == 0 and data["request_count"] > 0:
            data["total_water_l"] = data["request_count"] * (WATER_ML_PER_REQUEST / 1000.0)
            save_cumulative(data)
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(DEFAULT_CUMULATIVE)


def save_cumulative(data):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    CUMULATIVE_FILE.write_text(json.dumps(data, indent=2))


def append_log(entry):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\\n")


def load_context_accum():
    try:
        return json.loads(CONTEXT_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_context_accum(data):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    CONTEXT_FILE.write_text(json.dumps(data))


def accum_file_tokens(generation_id, tokens):
    accum = load_context_accum()
    entry = accum.get(generation_id, {"file_tokens": 0, "files_read": 0})
    entry["file_tokens"] += tokens
    entry["files_read"] += 1
    accum[generation_id] = entry
    if len(accum) > 20:
        keys = sorted(accum.keys())
        for k in keys[:-20]:
            del accum[k]
    save_context_accum(accum)


def pop_context_accum(generation_id):
    accum = load_context_accum()
    entry = accum.pop(generation_id, {"file_tokens": 0, "files_read": 0})
    save_context_accum(accum)
    return entry["file_tokens"], entry["files_read"]


def read_attachment_tokens(attachments):
    total = 0
    count_read = 0
    for att in attachments:
        fp = att.get("filePath", "")
        if not fp:
            continue
        try:
            text = Path(fp).read_text(errors="replace")
            total += estimate_tokens(text)
            count_read += 1
        except (OSError, PermissionError):
            total += 500
    return total, count_read


def handle_before_read_file(payload):
    file_path = payload.get("filePath", "")
    generation_id = payload.get("generation_id", payload.get("conversation_id", "unknown"))
    if file_path:
        try:
            text = Path(file_path).read_text(errors="replace")
            tokens = estimate_tokens(text)
        except (OSError, PermissionError):
            tokens = 500
        accum_file_tokens(generation_id, tokens)
    return {"continue": True}


def handle_before_submit(payload):
    prompt = payload.get("prompt", "")
    model = payload.get("model", "unknown")
    attachments = payload.get("attachments", [])
    generation_id = payload.get("generation_id", payload.get("conversation_id", "unknown"))

    prompt_tokens = estimate_tokens(prompt)
    attachment_tokens, files_read = read_attachment_tokens(attachments)
    context_file_tokens, context_files_read = pop_context_accum(generation_id)
    new_content = prompt_tokens + attachment_tokens + context_file_tokens

    cum = load_cumulative()
    base = cum.get("last_precompact_context", 0) or DEFAULT_BASE_CONTEXT
    estimated_input = base + new_content
    estimated_output = min(new_content * 2, 8000)
    estimated_total = estimated_input + estimated_output

    rate = get_energy_rate(model)
    energy_wh = (estimated_total / 1000) * rate
    gco2 = (energy_wh / 1000) * CARBON_INTENSITY_G_PER_KWH

    water_l = WATER_ML_PER_REQUEST / 1000.0
    cum["total_tokens"] += estimated_total
    cum["total_wh"] += energy_wh
    cum["total_gco2"] += gco2
    cum["total_water_l"] = cum.get("total_water_l", 0.0) + water_l
    cum["request_count"] += 1
    cum["last_estimate"] = estimated_total
    cum["last_model"] = model
    save_cumulative(cum)

    append_log({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "hook": "beforeSubmitPrompt",
        "model": model,
        "prompt_tokens": prompt_tokens,
        "attachment_tokens": attachment_tokens,
        "context_file_tokens": context_file_tokens,
        "new_content": new_content,
        "base_context": base,
        "estimated_total_tokens": estimated_total,
        "energy_wh": round(energy_wh, 6),
        "gco2": round(gco2, 4),
        "water_l": round(water_l, 6),
        "conversation_id": payload.get("conversation_id", ""),
    })
    return {"continue": True}


def handle_precompact(payload):
    actual_context = payload.get("context_tokens", 0)
    model = payload.get("model", "unknown")

    cum = load_cumulative()
    last_est = cum.get("last_estimate", 0)
    correction_delta = 0

    if actual_context > 0:
        actual_total = int(actual_context * 1.6)

        if last_est > 0:
            correction_delta = actual_total - last_est
            if correction_delta != 0:
                rate = get_energy_rate(cum.get("last_model", model))
                delta_wh = (correction_delta / 1000) * rate
                delta_gco2 = (delta_wh / 1000) * CARBON_INTENSITY_G_PER_KWH
                cum["total_tokens"] += correction_delta
                cum["total_wh"] += delta_wh
                cum["total_gco2"] += delta_gco2

        cum["last_precompact_context"] = actual_context
        cum["last_estimate"] = 0
        cum["precompact_count"] = cum.get("precompact_count", 0) + 1
        save_cumulative(cum)

    append_log({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "hook": "preCompact",
        "context_tokens": actual_context,
        "context_window_size": payload.get("context_window_size"),
        "context_usage_percent": payload.get("context_usage_percent"),
        "model": model,
        "last_estimate": last_est,
        "correction_delta_tokens": correction_delta,
        "new_base": actual_context,
    })
    return {}


def handle_stop(payload):
    append_log({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "hook": "stop",
        "status": payload.get("status"),
        "loop_count": payload.get("loop_count"),
        "model": payload.get("model", "unknown"),
        "conversation_id": payload.get("conversation_id", ""),
    })
    return {}


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        print(json.dumps({"continue": True}))
        return

    hook = payload.get("hook_event_name", "")

    if hook == "beforeReadFile":
        result = handle_before_read_file(payload)
    elif hook == "beforeSubmitPrompt":
        result = handle_before_submit(payload)
    elif hook == "preCompact":
        result = handle_precompact(payload)
    elif hook == "stop":
        result = handle_stop(payload)
    else:
        result = {"continue": True}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
`;

module.exports = { activate, deactivate };
