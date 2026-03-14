const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CURSOR_DIR = path.join(os.homedir(), ".cursor");
const HOOKS_DIR = path.join(CURSOR_DIR, "hooks");
const LOG_DIR = path.join(HOOKS_DIR, "climate-logs");
const CUMULATIVE_FILE = path.join(LOG_DIR, "cumulative.json");
const HOOKS_JSON = path.join(CURSOR_DIR, "hooks.json");
const CLIMATE_SCRIPT = path.join(HOOKS_DIR, "climate.py");

let statusBarItem;
let watcher;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  ensureHooksInstalled();

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
    updateStatusBar();
    vscode.window.showInformationMessage(
      `AI climate stats reset (base context ${(lastBase / 1000).toFixed(1)}K preserved).`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to reset: ${err.message}`);
  }
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
