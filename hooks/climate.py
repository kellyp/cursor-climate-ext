#!/usr/bin/env python3
"""
Cursor hook: estimates the climate impact of each AI prompt.

Tracks energy consumption and CO2 emissions per request, per session,
and cumulatively. Writes a running log and prints a one-line summary
as user_message so it appears in the Cursor UI.

Energy estimates are based on published research (Luccioni et al. 2023,
IEA 2024) and are approximate — actual figures depend on hardware,
data center PUE, and grid carbon intensity.
"""

import json
import os
import sys
import time
from pathlib import Path

CHARS_PER_TOKEN = 3.8

# Watt-hours per 1,000 tokens (input + output combined estimate).
# Sources: Luccioni et al. 2023, IEA 2024, Strubell et al. 2019.
# These are rough central estimates; real numbers vary by provider/hardware.
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

# US average grid carbon intensity (gCO2 per kWh).
# Conservative; cloud providers often use partial renewables.
CARBON_INTENSITY_G_PER_KWH = 390

# Water per request (mL). Option B: token/request-based estimate.
# Li et al. "Making AI Less Thirsty" (arXiv:2304.03271): ~10–25 mL/query; ChatGPT water footprint: ~15–30 mL/query by location.
WATER_ML_PER_REQUEST = 15

LOG_DIR = Path.home() / ".cursor" / "hooks" / "climate-logs"
LOG_FILE = LOG_DIR / "impact.jsonl"
CUMULATIVE_FILE = LOG_DIR / "cumulative.json"
CONTEXT_FILE = LOG_DIR / "context-accum.json"  # per-generation file read accumulator


def estimate_tokens(text: str) -> int:
    return max(1, int(len(text) / CHARS_PER_TOKEN))


def get_energy_rate(model: str) -> float:
    """Return Wh per 1K tokens for the given model string."""
    model_lower = model.lower()
    for key, rate in ENERGY_WH_PER_1K_TOKENS.items():
        if key in model_lower:
            return rate
    return ENERGY_WH_PER_1K_TOKENS["default"]


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


def load_cumulative() -> dict:
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


def save_cumulative(data: dict):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    CUMULATIVE_FILE.write_text(json.dumps(data, indent=2))


def append_log(entry: dict):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")


def format_equivalence(gco2: float) -> str:
    """Convert gCO2 to a relatable equivalence."""
    if gco2 < 0.01:
        return ""
    km_driven = gco2 / 121  # avg car: 121 gCO2/km
    phone_charges = gco2 / 8.22  # ~8.22 gCO2 per smartphone charge (US avg)
    led_minutes = gco2 / (0.01 * CARBON_INTENSITY_G_PER_KWH / 60)  # 10W LED

    parts = []
    if km_driven >= 0.001:
        if km_driven >= 1:
            parts.append(f"{km_driven:.1f} km driven")
        else:
            parts.append(f"{km_driven * 1000:.0f} m driven")
    if phone_charges >= 0.01:
        parts.append(f"{phone_charges:.2f} phone charges")
    if led_minutes >= 1:
        parts.append(f"{led_minutes:.0f} min of LED light")
    return " · ".join(parts) if parts else "negligible"


def load_context_accum() -> dict:
    """Load the per-generation context accumulator."""
    try:
        return json.loads(CONTEXT_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_context_accum(data: dict):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    CONTEXT_FILE.write_text(json.dumps(data))


def accum_file_tokens(generation_id: str, tokens: int):
    """Add tokens from a file read to the current generation's accumulator."""
    accum = load_context_accum()
    entry = accum.get(generation_id, {"file_tokens": 0, "files_read": 0})
    entry["file_tokens"] += tokens
    entry["files_read"] += 1
    accum[generation_id] = entry
    # Prune old entries (keep last 20 to avoid unbounded growth)
    if len(accum) > 20:
        keys = sorted(accum.keys())
        for k in keys[:-20]:
            del accum[k]
    save_context_accum(accum)


def pop_context_accum(generation_id: str) -> tuple[int, int]:
    """Retrieve and clear accumulated file tokens for this generation."""
    accum = load_context_accum()
    entry = accum.pop(generation_id, {"file_tokens": 0, "files_read": 0})
    save_context_accum(accum)
    return entry["file_tokens"], entry["files_read"]


def read_attachment_tokens(attachments: list) -> tuple[int, int]:
    """Read attachment files from disk and estimate their token counts."""
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
            total += 500  # fallback for unreadable files
    return total, count_read


def handle_before_read_file(payload: dict) -> dict:
    """Track tokens from files Cursor reads as context for the current generation."""
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


def handle_before_submit(payload: dict) -> dict:
    """Estimate impact using last known context size as a stable base."""
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


def handle_precompact(payload: dict) -> dict:
    """Use Cursor's real context_tokens to correct our last estimate and improve future ones."""
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


def handle_stop(payload: dict) -> dict:
    """Log session end."""
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "hook": "stop",
        "status": payload.get("status"),
        "loop_count": payload.get("loop_count"),
        "model": payload.get("model", "unknown"),
        "conversation_id": payload.get("conversation_id", ""),
    }
    append_log(entry)
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
